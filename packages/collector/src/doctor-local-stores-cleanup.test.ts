// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { cleanupMarker, closeFixture, type ProbeOwner } from "../test/doctor-cleanup-fixtures.js";
import { DoctorLocalStores } from "./doctor-local-stores.js";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";

afterEach(() => vi.useRealTimers());

test.each([false, true])(
  "local-store marker cannot become an empty inventory (nested:%s)",
  async (nested) => {
    const failure = cleanupMarker(nested);
    const runner = new DoctorLocalStores();
    const owner = runner as DoctorLocalStores & ProbeOwner;
    try {
      await expect(
        runner.collect(
          [
            {
              sourceId: "fictional",
              instance: {
                probeLocalStores: async () => {
                  throw failure;
                },
              },
            },
          ],
          new AbortController().signal,
        ),
      ).rejects.toBe(failure);
      expect(owner.cleanupFailure?.()).toBe(failure);
    } finally {
      await closeFixture(owner, failure);
    }
  },
);

test.each([false, true])(
  "late local-store marker remains owned after the empty timeout projection (nested:%s)",
  async (nested) => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<LocalStoreProbeResult[]>();
    const failure = cleanupMarker(nested);
    const runner = new DoctorLocalStores(10);
    const owner = runner as DoctorLocalStores & ProbeOwner;
    const source = { sourceId: "fictional", instance: { probeLocalStores: () => gate.promise } };
    try {
      const running = runner.collect([source], new AbortController().signal);
      await vi.advanceTimersByTimeAsync(11);
      const result = await running;
      expect(result).toEqual([]);
      expect(owner.cleanupFailure?.()).toMatchObject({ cleanupPending: true });
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.cleanupFailure?.()).toBe(failure);
      expect(result).toEqual([]);
      await expect(runner.collect([source], new AbortController().signal)).rejects.toBe(failure);
    } finally {
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      await closeFixture(owner, failure);
    }
  },
);

test("local-store timeout retains instance and global capacity until raw probes join", async () => {
  vi.useFakeTimers();
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<LocalStoreProbeResult[]>());
  const probes = gates.map((gate) => vi.fn(() => gate.promise));
  const sources = probes.map((probe, index) => ({
    sourceId: `fictional-${index}`,
    instance: { probeLocalStores: probe },
  }));
  const runner = new DoctorLocalStores(10);
  const owner = runner as DoctorLocalStores & ProbeOwner;
  try {
    const first = runner.collect(sources, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toEqual([]);
    const retry = runner.collect(sources, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(11);
    expect(await retry).toEqual([]);
    for (const probe of probes) expect(probe).toHaveBeenCalledOnce();
    const fresh = vi.fn(async (): Promise<LocalStoreProbeResult[]> => []);
    await runner.collect(
      [{ sourceId: "new", instance: { probeLocalStores: fresh } }],
      new AbortController().signal,
    );
    expect(fresh).not.toHaveBeenCalled();
    for (const gate of gates) gate.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    await runner.collect(
      [{ sourceId: "new", instance: { probeLocalStores: fresh } }],
      new AbortController().signal,
    );
    expect(fresh).toHaveBeenCalledOnce();
  } finally {
    for (const gate of gates) gate.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    await closeFixture(owner);
  }
});
