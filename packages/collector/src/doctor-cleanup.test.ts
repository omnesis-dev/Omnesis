// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SecurityData, SystemInfoResult } from "@omnesis/core/doctor";
import { CollectorDoctor, type CollectorDoctorDeps } from "./doctor.js";
import { cleanupMarker, closeFixture, type ProbeOwner } from "../test/doctor-cleanup-fixtures.js";

afterEach(() => vi.useRealTimers());
const SYSTEM: SystemInfoResult = {
  platform: "linux",
  arch: "x64",
  totalRamGb: 16,
  freeRamGb: 8,
  modelsDir: "fictional",
  modelsDirFreeGb: 20,
  dataDir: "fictional",
  dataDirFreeGb: 20,
};
function fixture(
  overrides: Partial<CollectorDoctorDeps> & { onOwnershipChanged?: () => void } = {},
) {
  const emit = vi.fn<CollectorDoctorDeps["emitResult"]>();
  const system = vi.fn(async () => SYSTEM);
  const security = vi.fn(async (): Promise<SecurityData> => {
    throw new Error("Invented joined unavailable security");
  });
  const deps: CollectorDoctorDeps & { onOwnershipChanged?: () => void } = {
    configDir: join(tmpdir(), "fictional-doctor-config"),
    getIdentity: () => null,
    getConfigStatus: () => ({
      ok: true,
      version: 1,
      lastLoadedAt: 1,
      lastWrittenAt: null,
      lastError: null,
    }),
    getSourceStatuses: () => [],
    getReadAccessSources: () => [],
    getProcessVitals: () => ({
      eventLoop: { current: { p50Ms: 1, p95Ms: 1, p99Ms: 1 } },
      memory: { current: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 } },
    }),
    getSystemInfo: system,
    collectSecurity: security,
    emitResult: emit,
    runTimeoutMs: 10,
    ...overrides,
  };
  const doctor = new CollectorDoctor(deps);
  return { doctor, owner: doctor as CollectorDoctor & ProbeOwner, emit, system, security };
}

test("timed-out raw collection blocks a new run until it actually settles", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<SystemInfoResult>();
  const system = vi.fn(() => gate.promise);
  const { doctor, owner, emit } = fixture({ getSystemInfo: system });
  try {
    expect(doctor.start("held")).toEqual({ accepted: true });
    await vi.advanceTimersByTimeAsync(11);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]![0]).toMatchObject({ runId: "held", error: expect.any(String) });
    expect(doctor.start("overlap")).toMatchObject({ accepted: false });
    expect(system).toHaveBeenCalledOnce();
    gate.resolve(SYSTEM);
    await vi.advanceTimersByTimeAsync(0);
    expect(doctor.start("joined")).toEqual({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(system).toHaveBeenCalledTimes(2);
  } finally {
    gate.resolve(SYSTEM);
    await vi.advanceTimersByTimeAsync(20);
    await closeFixture(owner);
  }
});

test.each([false, true])(
  "late security receipt holds the doctor without replacing its timeout (nested:%s)",
  async (nested) => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<SecurityData>();
    const failure = cleanupMarker(nested);
    const { doctor, owner, emit } = fixture({ collectSecurity: () => gate.promise });
    try {
      doctor.start("late");
      await vi.advanceTimersByTimeAsync(11);
      const original = structuredClone(emit.mock.calls[0]![0]);
      expect(original).toMatchObject({ runId: "late", error: expect.any(String) });
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.cleanupFailure?.()).toBe(failure);
      expect(doctor.start("unsafe-retry")).toMatchObject({ accepted: false });
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]![0]).toEqual(original);
    } finally {
      gate.reject(failure);
      await vi.advanceTimersByTimeAsync(20);
      await closeFixture(owner, failure);
    }
  },
);

test("doctor close joins injected raw work and suppresses late emission and replay", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<SystemInfoResult>();
  const { doctor, owner, emit } = fixture({ getSystemInfo: () => gate.promise });
  let closing: Promise<void> | undefined;
  try {
    doctor.start("closing");
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(11);
    expect(joined).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    gate.resolve(SYSTEM);
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(doctor.start("closing")).toMatchObject({ accepted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).not.toHaveBeenCalled();
  } finally {
    gate.resolve(SYSTEM);
    await vi.advanceTimersByTimeAsync(20);
    await (closing ?? owner.close?.());
  }
});

test("ownership admission callback can refuse a run before either raw producer is invoked", async () => {
  vi.useFakeTimers();
  const refused = new Error("Invented watchdog claim already held");
  const notify = vi.fn(() => {
    throw refused;
  });
  const { doctor, owner, system, security } = fixture({ onOwnershipChanged: notify });
  try {
    doctor.start("claimed");
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
    expect(security).not.toHaveBeenCalled();
  } finally {
    await vi.advanceTimersByTimeAsync(20);
    await closeFixture(owner, refused);
  }
});

test("joined ordinary unavailable security remains retryable", async () => {
  vi.useFakeTimers();
  const { doctor, owner, emit, security } = fixture();
  try {
    doctor.start("ordinary");
    await vi.advanceTimersByTimeAsync(0);
    expect(emit.mock.calls[0]![0]).toMatchObject({ runId: "ordinary", report: expect.any(Object) });
    expect(doctor.start("retry")).toEqual({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(security).toHaveBeenCalledTimes(2);
    expect(owner.cleanupFailure?.()).toBeUndefined();
  } finally {
    await closeFixture(owner);
  }
});
