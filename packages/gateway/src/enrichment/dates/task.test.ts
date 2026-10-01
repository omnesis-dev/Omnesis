// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, afterEach, vi } from "vitest";
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
function buildTask(opts: { enabled: boolean; onApplied?: () => void }) {
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
    ...(opts.onApplied ? { onApplied: opts.onApplied } : {}),
    log,
  });
  return { task, seen };
}

describe("dateExtractionTask — contention guarantee", () => {
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

  it("reports a tick that stored documents, so the worth gate can judge them", async () => {
    let applied = 0;
    const { task } = buildTask({ enabled: true, onApplied: () => applied++ });
    await task.run();
    expect(applied).toBe(1);
  });

  it("does no work (no sub-op calls) when the enabled knob is off", async () => {
    const { task, seen } = buildTask({ enabled: false });
    await task.run();
    expect(seen).toEqual([]);
  });

  it("runs whether or not experimental mode is on", async () => {
    for (const flag of ["0", "1"]) {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", flag);
      const { task, seen } = buildTask({ enabled: true });
      await task.run();
      expect(seen.length).toBe(3);
    }
  });
});

describe("dateExtractionTask — content still due to be replaced", () => {
  function build(opts: { pending: Set<string>; waitMs?: number }) {
    const extracted: string[] = [];
    const asked: number[] = [];
    const task = dateExtractionTask({
      ioGate: {
        fetchDateExtractionBatch: async () => [
          { id: "voice-day", content: "dentist on friday", anchorAt: "2026-09-30T10:00:00Z" },
          { id: "email", content: "meet tomorrow", anchorAt: "2026-09-30T10:00:00Z" },
        ],
      } as unknown as IoGate,
      cpuGate: {
        extractDatesFromDocs: async (rows: unknown) => {
          const docs = rows as { id: string }[];
          extracted.push(...docs.map((r) => r.id));
          return docs.map((r) => ({ id: r.id, dates: [] }));
        },
      } as unknown as CpuGate,
      writeGate: {
        applyExtractedDates: async (results: unknown[]) => ({
          applied: results.length,
          datesWritten: 0,
        }),
      } as unknown as WriteGate,
      getSettings: () => ({
        ...DATE_ENRICHMENT_DEFAULTS,
        enabled: true,
        ...(opts.waitMs !== undefined ? { pendingContentWaitMs: opts.waitMs } : {}),
      }),
      tracker: new QueueTracker(),
      contentPending: (docIds, maxWaitMs) => {
        asked.push(maxWaitMs);
        return new Set(docIds.filter((id) => opts.pending.has(id)));
      },
      log,
    });
    return { task, extracted, asked };
  }

  it("leaves a document awaiting its transcript unread and reads the rest", async () => {
    const { task, extracted, asked } = build({ pending: new Set(["voice-day"]) });
    const outcome = await task.run(undefined);
    expect(extracted).toEqual(["email"]);
    expect(asked).toEqual([DATE_ENRICHMENT_DEFAULTS.pendingContentWaitMs]);
    expect(outcome).toMatchObject({ kind: "done", value: { idle: false } });
  });

  it("idles when every fetched document is awaiting its transcript", async () => {
    const { task, extracted } = build({ pending: new Set(["voice-day", "email"]) });
    const outcome = await task.run(undefined);
    expect(extracted).toEqual([]);
    expect(outcome).toMatchObject({ kind: "done", value: { idle: true } });
  });

  it("a zero wait reads everything without asking", async () => {
    const { task, extracted, asked } = build({ pending: new Set(["voice-day"]), waitMs: 0 });
    await task.run(undefined);
    expect(extracted).toEqual(["voice-day", "email"]);
    expect(asked).toEqual([]);
  });
});
