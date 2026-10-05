// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DeviceId, Scope, TokenId } from "@omnesis/types";
import { BrowserFindStreamService } from "./BrowserFindStreamService.js";
import type { AuthContext } from "../routes/types.js";
import type { FindSearchExecution } from "../../search/find/types.js";

const auth: AuthContext = {
  authMethod: "bearer",
  deviceId: DeviceId("00000000-0000-4000-8000-000000000001"),
  tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
  scopes: [Scope("read")],
};

describe("browser Find stream lifetime", () => {
  test("rechecks the browser grant before a new model call", async () => {
    let active = true;
    let prevented = false;
    const transport = new BrowserFindStreamService({
      authority: {
        requireActive: () => {
          if (!active) throw new Error("revoked");
        },
      },
      runner: {
        search: async (_input, context) => {
          context.beforeModelCall?.();
          active = false;
          try {
            context.beforeModelCall?.();
          } catch {
            prevented = true;
          }
        },
      },
    });
    await transport.stream(auth, { text: "orbit" }, new AbortController().signal).text();
    expect(prevented).toBe(true);
  });
  test("frames results and completion without persisting a conversation", async () => {
    const transport = new BrowserFindStreamService({
      authority: { requireActive: () => ({ enabled: true, canonicalizers: [], sourceLabels: {} }) },
      runner: {
        search: async (_input, { emit }) => {
          emit({
            type: "find.decision",
            payload: {
              mode: "direct",
              status: "not_configured",
              reason: "Decision model is not configured",
            },
          });
          emit({ type: "find.results", payload: { results: [], complete: true } });
          emit({ type: "find.complete", payload: { mode: "direct" } });
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).toContain('"type":"find.complete"');
  });
  test("consumer cancellation aborts research but retains admission until the runner stops", async () => {
    let execution: FindSearchExecution | undefined;
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport = new BrowserFindStreamService({
      maxConcurrent: 1,
      authority: { requireActive: () => ({ enabled: true, canonicalizers: [], sourceLabels: {} }) },
      runner: {
        search: async (_input, context) => {
          execution = context;
          await pending;
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    await response.body!.cancel();
    expect(execution?.signal.aborted).toBe(true);
    expect(() => transport.stream(auth, { text: "other" }, new AbortController().signal)).toThrow(
      "still running",
    );
    finish();
    await pending;
    await Promise.resolve();
    const next = transport.stream(auth, { text: "other" }, new AbortController().signal);
    await next.text();
  });
  test("revocation suppresses pending result data and aborts the search", async () => {
    let active = true;
    let execution: FindSearchExecution | undefined;
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport = new BrowserFindStreamService({
      authority: {
        requireActive: () => {
          if (!active) throw new Error("revoked");
          return { enabled: true, canonicalizers: [], sourceLabels: {} };
        },
      },
      runner: {
        search: async (_input, context) => {
          execution = context;
          await pending;
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    active = false;
    execution!.emit({
      type: "find.results",
      payload: {
        results: [
          {
            id: "secret",
            title: "Withheld destination",
            sourceId: "example",
            chunkText: "withheld evidence",
          },
        ],
        complete: true,
      },
    });
    const text = await response.text();
    expect(text).toContain('"type":"find.error"');
    expect(text).not.toContain("Withheld destination");
    expect(execution!.signal.aborted).toBe(true);
    finish();
    await pending;
  });
  test("server deadline aborts research and retains admission until its runner settles", async () => {
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let execution: FindSearchExecution | undefined;
    const transport = new BrowserFindStreamService({
      timeoutMs: 10,
      maxConcurrent: 1,
      authority: { requireActive: () => {} },
      runner: {
        search: async (_input, context) => {
          execution = context;
          await pending;
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    const body = await response.text();
    expect(body).toContain("exceeded its time limit");
    expect(body).toContain("FIND_TIMEOUT");
    expect(execution!.signal.aborted).toBe(true);
    execution!.emit({ type: "find.complete", payload: { mode: "direct" } });
    expect(body).not.toContain("find.complete");
    expect(() => transport.stream(auth, { text: "other" }, new AbortController().signal)).toThrow(
      "still running",
    );
    finish();
    await pending;
    await Promise.resolve();
    await transport.stream(auth, { text: "other" }, new AbortController().signal).text();
  });
  test("excess buffered output cancels research rather than clipping a tool event", async () => {
    let execution: FindSearchExecution | undefined;
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport = new BrowserFindStreamService({
      maxBufferedBytes: 256,
      authority: { requireActive: () => {} },
      runner: {
        search: async (_input, context) => {
          execution = context;
          await pending;
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    execution!.emit({ type: "find.error", payload: { message: "x".repeat(1000) } });
    await expect(response.text()).rejects.toThrow("buffered output limit");
    expect(execution!.signal.aborted).toBe(true);
    finish();
    await pending;
  });
  test("the deadline reports a revoked grant before its timeout", async () => {
    let active = true;
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport = new BrowserFindStreamService({
      timeoutMs: 10,
      authority: {
        requireActive: () => {
          if (!active) throw new Error("revoked");
        },
      },
      runner: {
        search: async () => {
          await pending;
        },
      },
    });
    const response = transport.stream(auth, { text: "orbit" }, new AbortController().signal);
    active = false;
    const body = await response.text();
    expect(body).toContain("FIND_PERMISSION_REVOKED");
    expect(body).not.toContain("FIND_TIMEOUT");
    finish();
    await pending;
  });
});
