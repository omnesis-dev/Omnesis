// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger } from "@omnesis/core";

import { getActivePriority, runWithPriority, type Priority } from "../../priority.js";
import { QueueTracker } from "../../background-jobs/trackers.js";
import { dateExtractionTask } from "./task.js";
import { DATE_ENRICHMENT_DEFAULTS } from "./config.js";
import type { IoGate } from "../../scheduler/io-ops.js";
import type { CpuGate } from "../../scheduler/cpu-ops.js";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("test");

/** Build the task with gates that record the ALS priority active at call time. */
function buildTask(opts: { enabled: boolean }) {
  const seen: Priority[] = [];
  const recordPrio = () => {
    seen.push(getActivePriority() ?? ("__none__" as Priority));
  };
  const ioGate = {
    fetchDateExtractionBatch: async () => {
      recordPrio();
      return [{ id: "d1", content: "meet tomorrow", anchorAt: "2022-01-21T10:00:00Z" }];
    },
  } as unknown as IoGate;
  const cpuGate = {
    extractDatesFromDocs: async (rows: unknown) => {
      recordPrio();
      return (rows as { id: string }[]).map((r) => ({ id: r.id, dates: [] }));
    },
  } as unknown as CpuGate;
  const writeGate = {
    applyExtractedDates: async () => {
      recordPrio();
      return { applied: 1, datesWritten: 0 };
    },
  } as unknown as WriteGate;

  const task = dateExtractionTask({
    ioGate,
    cpuGate,
    writeGate,
    getSettings: () => ({ ...DATE_ENRICHMENT_DEFAULTS, enabled: opts.enabled }),
    tracker: new QueueTracker(),
    log,
  });
  return { task, seen };
}

describe("dateExtractionTask — contention guarantee", () => {
  beforeEach(() => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs its io/cpu/writer sub-ops at background priority even when dispatched inside a realtime scope", async () => {
    const { task, seen } = buildTask({ enabled: true });
    // Simulate a kick from the collector's realtime ingest scope.
    await runWithPriority("realtime", () => task.run());
    expect(seen.length).toBe(3); // io fetch, cpu extract, writer apply
    for (const p of seen) expect(p).toBe("background");
  });

  it("does no work (no sub-op calls) when the enabled knob is off", async () => {
    const { task, seen } = buildTask({ enabled: false });
    await task.run();
    expect(seen).toEqual([]);
  });

  it("does no work when experimental mode is off", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    const { task, seen } = buildTask({ enabled: true });
    await task.run();
    expect(seen).toEqual([]);
  });
});
