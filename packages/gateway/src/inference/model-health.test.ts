// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InferenceHealth } from "./model-health.js";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { ResolvedAssignment } from "@omnesis/core";

const resolved: ResolvedAssignment = { role: "decision", kind: "replay" };
const selection = {
  identity: "1",
  fingerprint: "config-one",
  assignment: "typesafe/example-model",
};
const folders: string[] = [];
afterEach(() =>
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture(statePath?: string) {
  let current = { ...selection };
  const health = new InferenceHealth(() => current, statePath);
  let error: unknown = new Error("HTTP 429: quota exhausted; private request content");
  const provider = health.observe(
    resolved,
    {
      async decide(_opts?: { signal?: AbortSignal }) {
        if (error) throw error;
        return "result";
      },
    },
    ["decide"],
  );
  return {
    health,
    provider,
    setError: (value: unknown) => {
      error = value;
    },
    select: (identity: string) => {
      current = { ...current, identity, fingerprint: identity };
    },
  };
}

async function failures(provider: { decide(): Promise<unknown> }, count = 3) {
  for (let i = 0; i < count; i++) await expect(provider.decide()).rejects.toBeDefined();
}

describe("InferenceHealth", () => {
  it("warns after repeated logical failures and clears on recovery", async () => {
    const f = fixture();
    await failures(f.provider, 2);
    expect(f.health.snapshot().warnings).toEqual([]);
    await failures(f.provider, 1);
    expect(f.health.snapshot().warnings).toEqual([
      expect.objectContaining({ role: "decision", category: "quota", consecutiveFailures: 3 }),
    ]);
    expect(JSON.stringify(f.health.snapshot())).not.toContain("private request content");
    f.setError(null);
    await expect(f.provider.decide()).resolves.toBe("result");
    expect(f.health.snapshot().warnings).toEqual([]);
    f.setError(new Error("network unavailable"));
    await failures(f.provider, 2);
    expect(f.health.snapshot().warnings).toEqual([]);
  });

  it("excludes cancellations without clearing an unresolved warning", async () => {
    const f = fixture();
    await failures(f.provider);
    const controller = new AbortController();
    controller.abort();
    await expect(f.provider.decide({ signal: controller.signal })).rejects.toBeDefined();
    f.setError(new DOMException("Canceled", "AbortError"));
    await failures(f.provider);
    expect(f.health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
  });

  it("invalidates old providers and their in-flight results after reassignment", async () => {
    const f = fixture();
    await failures(f.provider);
    f.select("2");
    expect(f.health.snapshot().warnings).toEqual([]);
    await failures(f.provider);
    expect(f.health.snapshot().warnings).toEqual([]);
  });

  it("does not let a slow failure overwrite a newer successful request", async () => {
    const f = fixture();
    await failures(f.provider);
    let reject!: (error: Error) => void;
    const provider = f.health.observe(
      resolved,
      {
        decide: () =>
          new Promise((_resolve, r) => {
            reject = r;
          }),
      },
      ["decide"],
    );
    const slow = provider.decide();
    f.setError(null);
    await f.provider.decide();
    reject(new Error("HTTP 503"));
    await expect(slow).rejects.toThrow();
    expect(f.health.snapshot().warnings).toEqual([]);
  });

  it("restores safe unresolved evidence across restarts and persists recovery", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-health-"));
    folders.push(folder);
    const path = join(folder, "health.json");
    const f = fixture(path);
    await failures(f.provider);
    await f.health.flush();
    expect(readFileSync(path, "utf8")).not.toContain("private request content");
    const next = fixture(path);
    expect(next.health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
    next.setError(null);
    await next.provider.decide();
    await next.health.flush();
    expect(fixture(path).health.snapshot().warnings).toEqual([]);
  });

  it("preserves structured provider failures when terminal text is generic", async () => {
    const health = new InferenceHealth(() => selection);
    const backend: ChatBackend = {
      name: "fixture",
      model: "example-model",
      async *runTurn() {
        yield {
          type: "agent.error",
          payload: {
            sessionId: "s",
            code: "provider_error",
            message: "Request failed",
            provider: { status: 429, code: "insufficient_quota" },
          },
        };
        yield {
          type: "agent.message.end",
          payload: { sessionId: "s", messageId: "m", stopReason: "error" },
        };
      },
    };
    const observed = health.observeBackend(resolved, backend);
    for (let i = 0; i < 3; i++) {
      for await (const event of observed.runTurn({} as TurnInput)) {
        if (event.type === "agent.message.end") break;
      }
    }
    expect(health.snapshot().warnings[0]?.category).toBe("quota");
  });

  it("ignores evidence from a provider created before a configuration ABA", async () => {
    const f = fixture();
    await failures(f.provider);
    f.select("2");
    f.select("3");
    await failures(f.provider);
    expect(f.health.snapshot().warnings).toEqual([]);
  });

  it("counts concurrent failures in reverse completion order without reviving failures before recovery", () => {
    const health = new InferenceHealth(() => selection);
    const olderSuccess = health.beginCall("decision");
    const calls = Array.from({ length: 3 }, () => health.beginCall("decision"));
    for (const call of calls.reverse()) call.failure(new Error("HTTP 429"));
    expect(health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
    olderSuccess.success();
    expect(health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
    const slowFailure = health.beginCall("decision");
    health.beginCall("decision").success();
    slowFailure.failure(new Error("HTTP 429"));
    expect(health.snapshot().warnings).toEqual([]);
  });

  it("an overlapping older success prunes only failures that started before it", () => {
    const health = new InferenceHealth(() => selection);
    const a = health.beginCall("decision");
    const b = health.beginCall("decision");
    const c = health.beginCall("decision");
    const d = health.beginCall("decision");
    a.failure(new Error("quota exhausted"));
    c.failure(new Error("HTTP 503"));
    b.success();
    d.failure(new Error("HTTP 401"));
    expect(health.snapshot().warnings).toEqual([]);
    health.beginCall("decision").failure(new Error("quota exhausted"));
    expect(health.snapshot().warnings[0]).toMatchObject({
      consecutiveFailures: 3,
      category: "quota",
    });
  });

  it("bounds repeated failure witnesses while retaining the newest request's category", () => {
    const health = new InferenceHealth(() => selection);
    for (let i = 0; i < 20; i++) health.beginCall("decision").failure(new Error("quota exhausted"));
    const older = health.beginCall("decision");
    const newest = health.beginCall("decision");
    newest.failure(new Error("HTTP 401"));
    older.failure(new Error("HTTP 503"));
    expect(health.snapshot().warnings[0]).toMatchObject({
      consecutiveFailures: 3,
      category: "authentication",
    });
  });

  it.each([1, 2])(
    "restores %i failures below the threshold and clears them on success",
    async (count) => {
      const folder = mkdtempSync(join(tmpdir(), "model-health-"));
      folders.push(folder);
      const path = join(folder, "health.json");
      const first = fixture(path);
      await failures(first.provider, count);
      await first.health.flush();
      const restored = fixture(path);
      expect(restored.health.snapshot().warnings).toEqual([]);
      await failures(restored.provider, 3 - count);
      expect(restored.health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
      await restored.health.flush();
      const recovered = fixture(path);
      recovered.setError(null);
      await recovered.provider.decide();
      expect(recovered.health.snapshot().warnings).toEqual([]);
      await recovered.health.flush();
    },
  );

  it.each([
    ["HTTP 401", "authentication"],
    ["HTTP 404 model missing", "configuration"],
    ["HTTP 503", "unavailable"],
    ["Completion timed out", "timeout"],
    ["unexpected failure", "unknown"],
  ])("classifies %s with a fixed description", async (error, category) => {
    const f = fixture();
    f.setError(new Error(error));
    await failures(f.provider);
    expect(f.health.snapshot().warnings[0]?.category).toBe(category);
  });

  it("tracks failed agent terminal events, and clears after a successful stream", async () => {
    const health = new InferenceHealth(() => selection);
    let failed = true;
    const backend: ChatBackend = {
      name: "fixture",
      model: "example-model",
      async *runTurn() {
        yield {
          type: "agent.message.end",
          payload: { sessionId: "s", messageId: "m", stopReason: failed ? "error" : "end_turn" },
        };
      },
    };
    const observed = health.observeBackend({ role: "background-agent", kind: "replay" }, backend);
    const run = async () => {
      for await (const event of observed.runTurn({} as TurnInput)) {
        if (event.type === "agent.message.end") break;
      }
    };
    await run();
    await run();
    await run();
    expect(health.snapshot().warnings[0]?.role).toBe("background-agent");
    failed = false;
    await run();
    expect(health.snapshot().warnings).toEqual([]);
  });
});
