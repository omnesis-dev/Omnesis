// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultWorkerPoolSizes, IO_POOL_MAX, SEARCH_POOL_MAX } from "./worker-pool-sizing.js";
import { resolveRuntimeSettings } from "./runtime-settings.js";

const GIB = 1024 ** 3;

describe("defaultWorkerPoolSizes", () => {
  test("a 7 GiB, 3-core machine gets the smallest pools", () => {
    expect(defaultWorkerPoolSizes({ memoryBytes: 7 * GIB, cores: 3 })).toEqual({
      io: 2,
      search: 1,
      cpu: 1,
    });
  });

  test("an 8 GiB, 8-core laptop keeps a little more", () => {
    expect(defaultWorkerPoolSizes({ memoryBytes: 8 * GIB, cores: 8 })).toEqual({
      io: 3,
      search: 1,
      cpu: 2,
    });
  });

  test("from 16 GiB the pools are at their full sizes", () => {
    // 15.6 GiB is what a 16 GB machine reports once the firmware has its share.
    for (const memoryBytes of [15.6 * GIB, 16 * GIB, 64 * GIB, 128 * GIB]) {
      const pools = defaultWorkerPoolSizes({ memoryBytes, cores: 4 });
      expect(pools.io).toBe(IO_POOL_MAX);
      expect(pools.search).toBe(SEARCH_POOL_MAX);
    }
  });

  test("on a large machine the cpu pool follows the cores", () => {
    expect(defaultWorkerPoolSizes({ memoryBytes: 128 * GIB, cores: 20 }).cpu).toBe(8);
    expect(defaultWorkerPoolSizes({ memoryBytes: 128 * GIB, cores: 4 }).cpu).toBe(2);
  });

  test("a tiny budget still leaves every pool a worker, and io its reserved slot", () => {
    expect(defaultWorkerPoolSizes({ memoryBytes: 1 * GIB, cores: 1 })).toEqual({
      io: 2,
      search: 1,
      cpu: 1,
    });
  });
});

describe("resolveRuntimeSettings — worker pools", () => {
  const ENVS = [
    "OMNESIS_IO_CONCURRENCY",
    "OMNESIS_SEARCH_WORKER_CONCURRENCY",
    "OMNESIS_CPU_CONCURRENCY",
    "OMNESIS_MEMORY_LIMIT_MB",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const small = { memoryBytes: 7 * GIB, cores: 3 };

  test("absent from config, the pools are sized for the host", () => {
    const rt = resolveRuntimeSettings(undefined, small);
    expect([rt.ioConcurrency, rt.searchWorkerConcurrency, rt.cpuConcurrency]).toEqual([2, 1, 1]);
  });

  test("an explicit size in config replaces the host default", () => {
    const rt = resolveRuntimeSettings(
      { gateway: { ioConcurrency: 5, cpuConcurrency: 3, searchWorker: { concurrency: 0 } } },
      small,
    );
    expect([rt.ioConcurrency, rt.searchWorkerConcurrency, rt.cpuConcurrency]).toEqual([5, 0, 3]);
  });

  test("the environment wins over config", () => {
    process.env.OMNESIS_IO_CONCURRENCY = "4";
    process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY = "2";
    process.env.OMNESIS_CPU_CONCURRENCY = "2";
    const rt = resolveRuntimeSettings({ gateway: { ioConcurrency: 5 } }, small);
    expect([rt.ioConcurrency, rt.searchWorkerConcurrency, rt.cpuConcurrency]).toEqual([4, 2, 2]);
  });

  test("gateway.memoryLimitMb sizes the pools when no host is passed", () => {
    const rt = resolveRuntimeSettings({ gateway: { memoryLimitMb: 4096 } });
    expect(rt.memoryBudget).toEqual({ bytes: 4 * GIB, source: "config" });
    expect(rt.ioConcurrency).toBe(2);
    expect(rt.searchWorkerConcurrency).toBe(1);
    expect(rt.cpuConcurrency).toBe(1);
  });
});
