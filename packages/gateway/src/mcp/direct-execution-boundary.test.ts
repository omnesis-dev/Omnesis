// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { LogLevel, setLogLevel } from "@omnesis/core";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIRECT_MCP_TOOL_NAMES, DirectMcpService } from "../agent/direct-mcp.js";
import { GatewayTimeoutError } from "../http/errors.js";
import {
  DirectMcpBusyError,
  DirectMcpExecutionBoundary,
  DirectMcpRateLimitError,
  type DirectMcpInvocationContext,
} from "./direct-execution-boundary.js";
import type { ToolResult } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";

const success: ToolResult = {
  kind: "structured",
  resultType: "test.result",
  data: { ok: true },
};

function createService(invoke: ToolHandle["invoke"] = async () => success): DirectMcpService {
  return new DirectMcpService(
    DIRECT_MCP_TOOL_NAMES.map((name) => ({
      name,
      description: `Canonical ${name}`,
      schema:
        name === "fetch_many"
          ? z.object({ documents: z.array(z.object({ documentId: z.string() })) }).strict()
          : z.object({ value: z.string().optional() }).strict(),
      invoke,
    })),
  );
}

function context(
  admissionKey: string,
  overrides: Partial<DirectMcpInvocationContext> = {},
): DirectMcpInvocationContext {
  return {
    clientIp: "shared-proxy",
    requestId: `request-${admissionKey}`,
    tokenId: null,
    deviceId: null,
    admissionKey,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A tool whose first `pending` calls never settle on their own. */
function gatedInvoke(pending: number, onAbort?: (reject: (error: Error) => void) => void) {
  let calls = 0;
  const invoke = vi.fn<ToolHandle["invoke"]>(async (_args, toolContext) => {
    calls += 1;
    if (calls > pending) return success;
    return await new Promise<ToolResult>((_resolve, reject) => {
      if (onAbort) {
        toolContext.abortSignal?.addEventListener("abort", () => onAbort(reject), { once: true });
      }
    });
  });
  return { invoke, calls: () => calls };
}

describe("Direct MCP execution boundary", () => {
  beforeEach(() => {
    setLogLevel(LogLevel.INFO);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel(LogLevel.WARN);
  });

  it("dispatches a valid invocation and carries request context", async () => {
    const invoke = vi.fn<ToolHandle["invoke"]>(async () => success);
    const boundary = new DirectMcpExecutionBoundary(createService(invoke));

    await expect(
      boundary.invoke(
        "run_sql",
        { value: "SELECT 1" },
        context("credential-a", { requestId: "direct-request", timeZone: "Europe/London" }),
      ),
    ).resolves.toEqual(success);
    expect(invoke).toHaveBeenCalledWith(
      { value: "SELECT 1" },
      expect.objectContaining({
        sessionId: "mcp-direct",
        messageId: "direct-request",
        timeZone: "Europe/London",
      }),
    );
  });

  it("isolates concurrency budgets by principal credential", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn<ToolHandle["invoke"]>(async () => {
      await gate;
      return success;
    });
    const boundary = new DirectMcpExecutionBoundary(createService(invoke));
    const call = (admissionKey: string) => boundary.invoke("run_sql", {}, context(admissionKey));
    const firstCredential = [call("credential-a"), call("credential-a")];
    await vi.waitUntil(() => invoke.mock.calls.length === 2);

    await expect(call("credential-a")).rejects.toBeInstanceOf(DirectMcpBusyError);
    const sibling = call("credential-b");
    await vi.waitUntil(() => invoke.mock.calls.length === 3);
    release();
    await expect(Promise.all([...firstCredential, sibling])).resolves.toHaveLength(3);
  });

  it("keeps a gateway-wide ceiling across distinct principal credentials", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn<ToolHandle["invoke"]>(async () => {
      await gate;
      return success;
    });
    const boundary = new DirectMcpExecutionBoundary(createService(invoke));
    const call = (index: number) => boundary.invoke("run_sql", {}, context(`credential-${index}`));
    const active = Array.from({ length: 16 }, (_, index) => call(index));
    await vi.waitUntil(() => invoke.mock.calls.length === 16);

    await expect(call(17)).rejects.toBeInstanceOf(DirectMcpBusyError);
    release();
    await expect(Promise.all(active)).resolves.toHaveLength(16);
  });

  it("isolates rate budgets by principal credential", async () => {
    setLogLevel(LogLevel.WARN);
    const boundary = new DirectMcpExecutionBoundary(createService());
    const call = (admissionKey: string) => boundary.invoke("run_sql", {}, context(admissionKey));

    for (let attempt = 0; attempt < 120; attempt += 1) await call("credential-a");
    await expect(call("credential-a")).rejects.toBeInstanceOf(DirectMcpRateLimitError);
    await expect(call("credential-b")).resolves.toEqual(success);
  });

  it("charges the limiter once when the route already did", async () => {
    setLogLevel(LogLevel.WARN);
    const boundary = new DirectMcpExecutionBoundary(createService());
    for (let attempt = 0; attempt < 120; attempt += 1) boundary.charge("credential-a");
    expect(() => boundary.charge("credential-a")).toThrow(DirectMcpRateLimitError);
    await expect(
      boundary.invoke("run_sql", {}, context("credential-a", { rateAlreadyCharged: true })),
    ).resolves.toEqual(success);
  });

  it("keeps timed-out non-cooperative work counted so zombies cannot accumulate", async () => {
    const { invoke } = gatedInvoke(2);
    const boundary = new DirectMcpExecutionBoundary(createService(invoke), {
      invocationTimeoutMs: 20,
    });
    const call = () => boundary.invoke("run_sql", {}, context("credential-a"));

    const timedOut = await Promise.allSettled([call(), call()]);
    expect(timedOut.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    for (const outcome of timedOut) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(GatewayTimeoutError);
    }
    await expect(call()).rejects.toBeInstanceOf(DirectMcpBusyError);
  });

  it("releases timed-out slots after abort-cooperative work settles", async () => {
    const { invoke, calls } = gatedInvoke(2, (reject) => reject(new Error("synthetic abort")));
    const boundary = new DirectMcpExecutionBoundary(createService(invoke), {
      invocationTimeoutMs: 20,
    });
    const call = () => boundary.invoke("run_sql", {}, context("credential-a"));

    const timedOut = await Promise.allSettled([call(), call()]);
    expect(timedOut.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    await vi.waitUntil(() => calls() === 2);
    await expect(call()).resolves.toEqual(success);
  });

  it("releases externally cancelled slots only after abort-cooperative work settles", async () => {
    let finishCancellation = (): void => undefined;
    const cancellationCleanup = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const { invoke, calls } = gatedInvoke(2, (reject) => {
      void cancellationCleanup.then(() => {
        const error = new Error("synthetic cancellation");
        error.name = "AbortError";
        reject(error);
      });
    });
    const boundary = new DirectMcpExecutionBoundary(createService(invoke));
    const controllers = [new AbortController(), new AbortController()];
    const call = (signal: AbortSignal) =>
      boundary.invoke("run_sql", {}, context("credential-a", { signal }));
    const active = controllers.map((controller) => call(controller.signal));
    const settlements = Promise.allSettled(active);
    await vi.waitUntil(() => calls() === 2);

    controllers.forEach((controller) => controller.abort());
    await expect(call(new AbortController().signal)).rejects.toBeInstanceOf(DirectMcpBusyError);

    finishCancellation();
    expect((await settlements).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(call(new AbortController().signal)).resolves.toEqual(success);
  });

  it("always audits raw Direct egress without logging arguments, results, or full ids", async () => {
    const privateMarker = "PRIVATE-MARKER-MUST-NOT-ENTER-AUDIT";
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    const boundary = new DirectMcpExecutionBoundary(
      createService(async () => ({
        kind: "structured",
        resultType: "test.result",
        data: { value: privateMarker },
      })),
    );

    await boundary.invoke(
      "run_sql",
      { value: privateMarker },
      context("credential-a", {
        tokenId: "direct-token-identifier",
        deviceId: "direct-device-identifier",
      }),
    );

    const audit = lines.filter((line) => line.includes("gateway:mcp-direct:audit"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain("tool=run_sql outcome=ok bytes=");
    expect(audit[0]).toContain("tok=direct");
    expect(audit[0]).toContain("dev=direct-d");
    expect(audit[0]).not.toContain(privateMarker);
    expect(audit[0]).not.toContain("direct-token-identifier");
    expect(audit[0]).not.toContain("direct-device-identifier");
  });
});
