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

  test("the cpu pool keeps its memory cap past 16 GiB on a many-core machine", () => {
    expect(defaultWorkerPoolSizes({ memoryBytes: 16 * GIB, cores: 20 }).cpu).toBe(4);
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

  // A 7 GiB budget gives io 2, search 1 and cpu 1 whatever the cores.
  const sevenGib = { memoryLimitMb: 7 * 1024 };
  const pools = (rt: ReturnType<typeof resolveRuntimeSettings>) => [
    rt.ioConcurrency,
    rt.searchWorkerConcurrency,
    rt.cpuConcurrency,
  ];

  test("gateway.memoryLimitMb is the budget the pools are sized from", () => {
    const rt = resolveRuntimeSettings({ gateway: sevenGib });
    expect(rt.memoryBudget).toEqual({ bytes: 7 * GIB, source: "config" });
    expect(pools(rt)).toEqual([2, 1, 1]);
  });

  test("OMNESIS_MEMORY_LIMIT_MB sizes the pools too", () => {
    process.env.OMNESIS_MEMORY_LIMIT_MB = "4096";
    const rt = resolveRuntimeSettings(undefined);
    expect(rt.memoryBudget).toEqual({ bytes: 4 * GIB, source: "config" });
    expect(pools(rt)).toEqual([2, 1, 1]);
  });

  test("an explicit size in config replaces the budget's default", () => {
    const rt = resolveRuntimeSettings({
      gateway: {
        ...sevenGib,
        ioConcurrency: 5,
        cpuConcurrency: 3,
        searchWorker: { concurrency: 0 },
      },
    });
    expect(pools(rt)).toEqual([5, 0, 3]);
  });

  test("the environment wins over config", () => {
    process.env.OMNESIS_IO_CONCURRENCY = "4";
    process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY = "2";
    process.env.OMNESIS_CPU_CONCURRENCY = "2";
    const rt = resolveRuntimeSettings({ gateway: { ...sevenGib, ioConcurrency: 5 } });
    expect(pools(rt)).toEqual([4, 2, 2]);
  });
});
