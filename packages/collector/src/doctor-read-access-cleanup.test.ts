// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { cleanupMarker, closeFixture, type ProbeOwner } from "../test/doctor-cleanup-fixtures.js";
import { DoctorReadAccess } from "./doctor-read-access.js";
import type { SourceReadAccessResult } from "@omnesis/source-sdk";

afterEach(() => vi.useRealTimers());

test.each([false, true])(
  "read-access marker cannot become unavailable (nested:%s)",
  async (nested) => {
    const failure = cleanupMarker(nested);
    const runner = new DoctorReadAccess();
    const owner = runner as DoctorReadAccess & ProbeOwner;
    try {
      await expect(
        runner.collect(
          [
            {
              sourceId: "fictional",
              instance: {
                probeReadAccess: async () => {
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
  "late read-access marker retains raw ownership and cannot replace its timed-out result (nested:%s)",
  async (nested) => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<SourceReadAccessResult>();
    const failure = cleanupMarker(nested);
    const probe = vi.fn(() => gate.promise);
    const runner = new DoctorReadAccess({ probeMs: 10, scanMs: 50 });
    const owner = runner as DoctorReadAccess & ProbeOwner;
    const sources = [{ sourceId: "fictional", instance: { probeReadAccess: probe } }];
    const running = runner.collect(sources, new AbortController().signal);
    try {
      await vi.advanceTimersByTimeAsync(11);
      const result = await running;
      expect(result).toEqual([{ sourceId: "fictional", status: "unavailable" }]);
      expect(owner.cleanupFailure?.()).toMatchObject({ cleanupPending: true });
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.cleanupFailure?.()).toBe(failure);
      expect(result).toEqual([{ sourceId: "fictional", status: "unavailable" }]);
      await expect(runner.collect(sources, new AbortController().signal)).rejects.toBe(failure);
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      await closeFixture(owner, failure);
    }
  },
);

test("read-access close joins a timed-out raw probe before clearing its pending receipt", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<SourceReadAccessResult>();
  const runner = new DoctorReadAccess({ probeMs: 10, scanMs: 50 });
  const owner = runner as DoctorReadAccess & ProbeOwner;
  const running = runner.collect(
    [{ sourceId: "fictional", instance: { probeReadAccess: () => gate.promise } }],
    new AbortController().signal,
  );
  let closing: Promise<void> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(11);
    await running;
    closing = owner.close?.();
    expect(closing).toBeInstanceOf(Promise);
    let joined = false;
    void closing!.then(
      () => {
        joined = true;
      },
      () => {
        joined = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(joined).toBe(false);
    expect(owner.cleanupFailure?.()).toMatchObject({ cleanupPending: true });
    gate.resolve({ status: "readable" });
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(owner.cleanupFailure?.()).toBeUndefined();
  } finally {
    gate.resolve({ status: "readable" });
    await vi.advanceTimersByTimeAsync(0);
    await (closing ?? owner.close?.());
  }
});
