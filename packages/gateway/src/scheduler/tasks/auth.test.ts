// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { Scheduler } from "../scheduler.js";
import { MainTaskRunner } from "../runners/main.js";
import { createPrincipalCredentialUsageBuffer, principalCredentialUsageFlushTask } from "./auth.js";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("test:principal-credential-usage");

afterEach(() => {
  vi.useRealTimers();
});

function makeScheduler(): Scheduler {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(new MainTaskRunner({ concurrency: 1 }));
  return scheduler;
}

describe("principal credential usage maintenance", () => {
  test("buffer rate-limits repeated credential use and allows a later beacon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const buffer = createPrincipalCredentialUsageBuffer();

    buffer.note("credential-1");
    buffer.note("credential-1");
    expect(buffer.drain()).toEqual([
      { credentialId: "credential-1", observedAt: Date.parse("2026-01-01T00:00:00Z") },
    ]);

    buffer.note("credential-1");
    expect(buffer.size()).toBe(0);
    vi.advanceTimersByTime(60_000);
    buffer.note("credential-1");
    expect(buffer.drain()).toEqual([
      { credentialId: "credential-1", observedAt: Date.parse("2026-01-01T00:01:00Z") },
    ]);
  });

  test("flush sends one background writer batch and idles once drained", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const buffer = createPrincipalCredentialUsageBuffer();
    buffer.note("credential-1");
    buffer.note("credential-2");
    const batches: Array<ReadonlyArray<{ credentialId: string; observedAt: number }>> = [];
    const writeGate = new Proxy({} as WriteGate, {
      get(_target, prop) {
        if (prop === "touchPrincipalCredentialUsageBatch") {
          return async (rows: ReadonlyArray<{ credentialId: string; observedAt: number }>) => {
            batches.push(rows);
          };
        }
        return () => {
          throw new Error(`unexpected WriteGate.${String(prop)}() call`);
        };
      },
    });
    const bundle = principalCredentialUsageFlushTask({ buffer, writeGate, log }, makeScheduler());
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };

    const active = await bundle.task.run(undefined, ctx);
    expect((active as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
    const observedAt = Date.parse("2026-01-01T00:00:00Z");
    expect(batches).toEqual([
      [
        { credentialId: "credential-1", observedAt },
        { credentialId: "credential-2", observedAt },
      ],
    ]);

    const idle = await bundle.task.run(undefined, ctx);
    expect((idle as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
  });

  test("buffer remains bounded under credential churn", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const buffer = createPrincipalCredentialUsageBuffer();
    for (let index = 0; index < 600; index += 1) {
      buffer.note(`credential-${index}`);
    }
    expect(buffer.size()).toBe(500);
    expect(buffer.drain()).toHaveLength(500);
  });

  test("restores a drained batch after a transient writer failure", async () => {
    const buffer = createPrincipalCredentialUsageBuffer();
    buffer.note("credential-retry");
    const writeGate = new Proxy({} as WriteGate, {
      get(_target, prop) {
        if (prop === "touchPrincipalCredentialUsageBatch") {
          return async () => {
            throw new Error("transient writer failure");
          };
        }
        return () => {
          throw new Error(`unexpected WriteGate.${String(prop)}() call`);
        };
      },
    });
    const bundle = principalCredentialUsageFlushTask({ buffer, writeGate, log }, makeScheduler());
    await bundle.task.run(undefined, {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    });
    expect(buffer.drain()).toEqual([
      { credentialId: "credential-retry", observedAt: expect.any(Number) },
    ]);
  });
});
