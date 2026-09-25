// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the backend re-probe periodic task (#1267). The recovery
 * schedule + backoff live in InferenceRegistry.reprobeUnavailable (covered in
 * inference/registry.test.ts); here we only assert the task wrapper: it drives
 * the registry, reports idle when nothing is down and reconciliation succeeds,
 * stays active while a backend is down or reconciliation needs retry, and
 * swallows errors.
 */

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { Scheduler } from "../scheduler.js";
import { MainTaskRunner } from "../runners/main.js";
import { createBackendReprobeTask } from "./backend-reprobe.js";
import type { InferenceRegistry } from "../../inference/registry.js";

const log = createLogger("test:backend-reprobe");

const ctx = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

function makeScheduler(): Scheduler {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(new MainTaskRunner({ concurrency: 4 }));
  return scheduler;
}

/** Stub registry exposing only reprobeUnavailable. */
function stubRegistry(
  result: { down: number; probed: number; recovered: number } | (() => never),
): { registry: InferenceRegistry; calls: number[] } {
  const state = { calls: [] as number[] };
  const registry = {
    async reprobeUnavailable(nowMs: number) {
      state.calls.push(nowMs);
      if (typeof result === "function") return result();
      return result;
    },
  } as unknown as InferenceRegistry;
  return { registry, calls: state.calls };
}

describe("createBackendReprobeTask (#1267)", () => {
  test("names the task and job", () => {
    const { registry } = stubRegistry({ down: 0, probed: 0, recovered: 0 });
    const bundle = createBackendReprobeTask({ registry, log }, makeScheduler());
    expect(bundle.tasks.map((t) => t.name)).toEqual(["inference.reprobeUnavailable.tick"]);
    expect(bundle.jobs).toHaveLength(1);
  });

  test("reports idle when nothing is down", async () => {
    const stub = stubRegistry({ down: 0, probed: 0, recovered: 0 });
    const bundle = createBackendReprobeTask({ registry: stub.registry, log }, makeScheduler());
    const out = await bundle.tasks[0].run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  test("stays active (not idle) while a backend is still down", async () => {
    const stub = stubRegistry({ down: 1, probed: 1, recovered: 0 });
    const bundle = createBackendReprobeTask({ registry: stub.registry, log }, makeScheduler());
    const out = await bundle.tasks[0].run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
  });

  test("stays active after a partial recovery", async () => {
    const stub = stubRegistry({ down: 2, probed: 2, recovered: 1 });
    const bundle = createBackendReprobeTask({ registry: stub.registry, log }, makeScheduler());
    const out = await bundle.tasks[0].run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
  });

  test("passes the injected clock through to the registry", async () => {
    const stub = stubRegistry({ down: 0, probed: 0, recovered: 0 });
    const bundle = createBackendReprobeTask(
      { registry: stub.registry, log, now: () => 42 },
      makeScheduler(),
    );
    await bundle.tasks[0].run(undefined, ctx);
    expect(stub.calls).toEqual([42]);
  });

  test("swallows a registry error and idles", async () => {
    const stub = stubRegistry(() => {
      throw new Error("boom");
    });
    const bundle = createBackendReprobeTask({ registry: stub.registry, log }, makeScheduler());
    const out = await bundle.tasks[0].run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
  });

  test("awaits agent reconciliation after probing and then idles after recovery", async () => {
    const stub = stubRegistry({ down: 1, probed: 1, recovered: 1 });
    let release!: () => void;
    const handoffMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcileAgent = vi.fn(async () => handoffMayFinish);
    const bundle = createBackendReprobeTask(
      { registry: stub.registry, log, reconcileAgent },
      makeScheduler(),
    );

    let settled = false;
    const run = bundle.tasks[0].run(undefined, ctx).then((out) => {
      settled = true;
      return out;
    });
    await vi.waitFor(() => expect(reconcileAgent).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    release();
    const out = await run;
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
  });

  test("reconciles even without a new recovery edge so failed/manual recovery can heal", async () => {
    const stub = stubRegistry({ down: 0, probed: 0, recovered: 0 });
    const reconcileAgent = vi.fn(async () => {});
    const bundle = createBackendReprobeTask(
      { registry: stub.registry, log, reconcileAgent },
      makeScheduler(),
    );

    await bundle.tasks[0].run(undefined, ctx);

    expect(reconcileAgent).toHaveBeenCalledOnce();
  });

  test("a reconciliation failure does not hide a backend that remains down", async () => {
    const stub = stubRegistry({ down: 1, probed: 1, recovered: 0 });
    const bundle = createBackendReprobeTask(
      {
        registry: stub.registry,
        log,
        reconcileAgent: async () => {
          throw new Error("lifecycle busy");
        },
      },
      makeScheduler(),
    );

    const out = await bundle.tasks[0].run(undefined, ctx);

    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
  });

  test("a reconciliation failure after full recovery stays active for a prompt retry", async () => {
    const stub = stubRegistry({ down: 1, probed: 1, recovered: 1 });
    const bundle = createBackendReprobeTask(
      {
        registry: stub.registry,
        log,
        reconcileAgent: () => Promise.reject(new Error("construction failed")),
      },
      makeScheduler(),
    );

    const out = await bundle.tasks[0].run(undefined, ctx);

    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
  });
});
