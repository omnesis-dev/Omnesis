// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { CollectorDoctor, type CollectorDoctorDeps } from "./doctor.js";
import type { SecurityData } from "@omnesis/core/doctor";

const scanner = vi.hoisted(() => ({
  collect: vi.fn<() => Promise<SecurityData>>(),
  close: vi.fn<() => Promise<void>>(),
  legacy: vi.fn(),
  receipt: undefined as unknown,
  options: undefined as { onOwnershipChanged?: () => void } | undefined,
}));
vi.mock("@omnesis/core/doctor", async (original) => ({
  ...(await original<typeof import("@omnesis/core/doctor")>()),
  collectSecurityDataInWorker: scanner.legacy,
  DoctorSecurityScanner: class {
    constructor(options: { onOwnershipChanged?: () => void }) {
      scanner.options = options;
    }
    collect() {
      return scanner.collect();
    }
    cleanupFailure() {
      return scanner.receipt;
    }
    close() {
      return scanner.close();
    }
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  scanner.receipt = undefined;
  scanner.options = undefined;
  vi.useRealTimers();
});

test("default scanner ownership survives its bounded result until actual scanner close joins", async () => {
  vi.useFakeTimers();
  const joined = Promise.withResolvers<void>();
  scanner.collect.mockImplementation(async () => {
    scanner.receipt = { cleanupFailure: undefined, cleanupPending: true };
    scanner.options?.onOwnershipChanged?.();
    throw new Error("Invented scanner observation deadline");
  });
  scanner.close.mockImplementation(async () => {
    await joined.promise;
    scanner.receipt = undefined;
    scanner.options?.onOwnershipChanged?.();
  });
  const emit = vi.fn<CollectorDoctorDeps["emitResult"]>();
  const doctor = new CollectorDoctor({
    configDir: "fictional-config",
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
    getSystemInfo: async () => ({
      platform: "linux",
      arch: "x64",
      totalRamGb: 16,
      freeRamGb: 8,
      modelsDir: "fictional",
      modelsDirFreeGb: 20,
      dataDir: "fictional",
      dataDirFreeGb: 20,
    }),
    emitResult: emit,
  });
  let closing: Promise<void> | undefined;
  try {
    doctor.start("scanner");
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledOnce();
    expect(scanner.collect).toHaveBeenCalledOnce();
    expect(scanner.legacy).not.toHaveBeenCalled();
    expect(doctor.cleanupFailure()).toMatchObject({ cleanupPending: true });
    expect(doctor.start("overlap")).toMatchObject({ accepted: false });
    closing = doctor.close();
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    joined.resolve();
    await closing;
    expect(doctor.cleanupFailure()).toBeUndefined();
    expect(scanner.close).toHaveBeenCalledOnce();
  } finally {
    joined.resolve();
    await (closing ?? doctor.close());
  }
});
