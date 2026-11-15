// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { DoctorReadAccess } from "./doctor-read-access.js";
import { DoctorLocalStores } from "./doctor-local-stores.js";
import { CollectorDoctor, type CollectorDoctorDeps } from "./doctor.js";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";
import type { SecurityData } from "@omnesis/core/doctor";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function clock() {
  // Timer callbacks never dispatch; only explicit monotonic time moves.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return (value: number) => {
    now = value;
  };
}
const STORE: LocalStoreProbeResult = {
  keyName: "fictional-key",
  label: "Fictional store",
  state: "absent",
};

test.each([false, true])(
  "read-access accepts a positive result only inside the actual probe deadline (late:%s)",
  async (late) => {
    const advance = clock();
    const runner = new DoctorReadAccess({ probeMs: 5, scanMs: 20 });
    try {
      const result = await runner.collect(
        [
          {
            sourceId: "fictional",
            instance: {
              probeReadAccess: async () => {
                advance(late ? 6 : 4);
                return { status: "readable" };
              },
            },
          },
        ],
        new AbortController().signal,
      );
      expect(result).toEqual([
        { sourceId: "fictional", status: late ? "unavailable" : "readable" },
      ]);
    } finally {
      await runner.close();
    }
  },
);

test.each([false, true])(
  "local stores accept an inventory only inside the actual probe deadline (late:%s)",
  async (late) => {
    const advance = clock();
    const runner = new DoctorLocalStores(5);
    try {
      const result = await runner.collect(
        [
          {
            sourceId: "fictional",
            instance: {
              probeLocalStores: async () => {
                advance(late ? 6 : 4);
                return [STORE];
              },
            },
          },
        ],
        new AbortController().signal,
      );
      expect(result).toEqual(late ? [] : [{ ...STORE, sourceId: "fictional" }]);
    } finally {
      await runner.close();
    }
  },
);

test("read-access does not launch after ownership notification consumes the probe budget", async () => {
  const advance = clock();
  const probe = vi.fn(async () => ({ status: "readable" as const }));
  const runner = new DoctorReadAccess({ probeMs: 5, scanMs: 20 }, () => advance(6));
  try {
    expect(
      await runner.collect(
        [{ sourceId: "fictional", instance: { probeReadAccess: probe } }],
        new AbortController().signal,
      ),
    ).toEqual([{ sourceId: "fictional", status: "unavailable" }]);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    await runner.close();
  }
});

test("local stores do not launch after ownership notification consumes the probe budget", async () => {
  const advance = clock();
  const probe = vi.fn(async () => [STORE]);
  const runner = new DoctorLocalStores(5, () => advance(6));
  try {
    expect(
      await runner.collect(
        [{ sourceId: "fictional", instance: { probeLocalStores: probe } }],
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    await runner.close();
  }
});

test("the scan deadline rejects a late result and prevents the next admitted source from launching", async () => {
  const advance = clock();
  const later = vi.fn(async () => ({ status: "readable" as const }));
  const runner = new DoctorReadAccess({ probeMs: 100, scanMs: 20 });
  try {
    const result = await runner.collect(
      [
        {
          sourceId: "first",
          instance: {
            probeReadAccess: async () => {
              advance(21);
              return { status: "readable" };
            },
          },
        },
        { sourceId: "second", instance: { probeReadAccess: later } },
      ],
      new AbortController().signal,
    );
    expect(result.every((entry) => entry.status === "unavailable")).toBe(true);
    expect(later).not.toHaveBeenCalled();
  } finally {
    await runner.close();
  }
});

function doctor(overrides: Partial<CollectorDoctorDeps> = {}) {
  const emit = vi.fn<CollectorDoctorDeps["emitResult"]>();
  const system = vi.fn(async () => ({
    platform: "linux",
    arch: "x64",
    totalRamGb: 16,
    freeRamGb: 8,
    modelsDir: "fictional",
    modelsDirFreeGb: 20,
    dataDir: "fictional",
    dataDirFreeGb: 20,
  }));
  const security = vi.fn(async (): Promise<SecurityData> => {
    throw new Error("Invented joined unavailable security");
  });
  const config = () => ({
    ok: true,
    version: 1,
    lastLoadedAt: 1,
    lastWrittenAt: null,
    lastError: null,
  });
  const instance = new CollectorDoctor({
    configDir: "fictional",
    getIdentity: () => null,
    getConfigStatus: config,
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
  });
  return { instance, emit, system, security, config };
}
async function flushObservation(emit: ReturnType<typeof vi.fn>) {
  for (let turn = 0; !emit.mock.calls.length && turn < 40; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("overall run budget starts before ownership notification and cannot launch after it expires", async () => {
  const advance = clock();
  const f = doctor({ onOwnershipChanged: () => advance(11) });
  try {
    f.instance.start("expired-admission");
    await flushObservation(f.emit);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit.mock.calls[0]![0]).toHaveProperty("error");
    expect(f.system).not.toHaveBeenCalled();
    expect(f.security).not.toHaveBeenCalled();
  } finally {
    await f.instance.close();
  }
});

test("a complete report arriving after its monotonic deadline cannot beat an overdue timer", async () => {
  const advance = clock();
  const f = doctor({
    getConfigStatus: () => {
      advance(11);
      return { ok: true, version: 1, lastLoadedAt: 1, lastWrittenAt: null, lastError: null };
    },
  });
  try {
    f.instance.start("late-report");
    await flushObservation(f.emit);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit.mock.calls[0]![0]).toHaveProperty("error");
  } finally {
    await f.instance.close();
  }
});
