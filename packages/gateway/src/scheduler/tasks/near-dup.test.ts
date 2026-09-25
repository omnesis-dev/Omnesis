// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the three near-dup periodic tasks
 * (`backfill.nearDupCompute`, `.nearDupDfRefresh`, `.nearDupAlgoSweep`).
 *
 * We exercise each task's `run()` directly against stub gates rather
 * than the real scheduler — the periodic-task wiring itself is tested
 * by `scheduler.test.ts`. The focus here is on the task body
 * semantics: idle vs active branches, readiness gates, error swallow.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import Database from "better-sqlite3";
import { Scheduler } from "../scheduler.js";
import { MainTaskRunner } from "../runners/main.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "../../near-dupes/config.js";
import { runSchemaSetup } from "../../data/schema.js";
import { runMigrations } from "../../data/migrations.js";
import { createBackfillTasks } from "./backfill.js";
import type { IoGate } from "../io-ops.js";
import type { CpuGate } from "../cpu-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { NearDupApplyBatch, NearDupDfSnapshot } from "../../near-dupes/types.js";
import type { ResolvedNearDupConfig } from "../../near-dupes/config.js";
import type { IdleResult } from "./backfill-helpers.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

const log = createLogger("test:near-dup-tasks");

interface NearDupStubState {
  /** What `nearDupDfBuiltAt` returns. null = drip should park. */
  dfBuiltAt: number | null;
  /** Set of inbox rows the compute pass produces per call. */
  batches: NearDupApplyBatch[];
  /** Counters incremented as the stub gates are called. */
  computeBatchCalls: number;
  applyBatchCalls: number;
  applyDfCalls: number;
  algoSweepCalls: number;
  /** Eligible-doc count the DF refresh sees (drives the chunk loop). */
  /** DF doc-content chunks; each fetchDfDocChunk call consumes one. */
  dfDocChunks?: string[][];
  /** Whether a file-like document arrived since the last DF build. */
  dfFilesArrived?: boolean;
  /** Captures the snapshot handed to applyNearDupDfSnapshot. */
  lastDfSnapshot?: NearDupDfSnapshot;
  /** What the writer was asked to apply, and the rows it would have read. */
  lastDfStaging?: { totalDocs: number; minDf: number; algoVersion: string };
  stagedRows?: Array<{ shingle: string; df: number }>;
}

function stubGates(state: NearDupStubState): { compute: IoGate; write: WriteGate; cpu: CpuGate } {
  const compute: Partial<IoGate> = {
    nearDupDfBuiltAt: async (_algo: string) => state.dfBuiltAt,
    nearDupFetchInbox: async (_batchSize: number, _eligibleDocTypes: string[]) => {
      state.computeBatchCalls += 1;
      const batch = state.batches.shift();
      if (!batch || batch.processedInboxIds.length === 0) {
        return { inboxRows: [], docs: [], deleteDocIds: [] };
      }
      return {
        inboxRows: batch.processedInboxIds.map((id) => ({
          id,
          docId: `doc-${id}`,
          reason: "insert" as const,
          enqueuedAt: 0,
        })),
        docs: batch.signatureDeletes.map((docId) => ({
          inboxId: 1,
          docId,
          reason: "insert" as const,
          content: "test content",
          contentHash: null,
          extractedContentHash: null,
          metadata: '{"documentType":"email"}',
        })),
        deleteDocIds: [],
      };
    },
    nearDupFetchDfData: async (_algo: string) => ({
      totalDocs: 0,
      entries: [],
    }),
    nearDupFetchCandidates: async () => ({
      candidates: {},
      candidateIdsByDoc: {},
      existingEdges: {},
    }),
    nearDupDfMeta: async () => ({
      dirtyVersion: 0,
      lastAppliedVersion: -1,
      lastAppliedAt: null,
    }),
    nearDupDfSnapshot: async (_config: ResolvedNearDupConfig) => ({
      algoVersion: _config.algorithm.algoVersion,
      totalDocs: 0,
      entries: [],
      uniqueShingles: 0,
      capturedVersion: 0,
    }),
    captureDfOccVersion: async () => 0,
    fetchDfDocChunk: async () =>
      (state.dfDocChunks?.shift() ?? []).map((content, index) => ({
        id: `doc-${index}-${content.slice(0, 8)}`,
        content,
      })),
    nearDupFileLikeDocsSince: async () => state.dfFilesArrived ?? true,
    fetchMergeCandidatesData: async () => ({
      aliasRows: [],
      scoreRows: [],
      decidedKeys: [],
      tokenLabels: [],
      blockedEmails: [],
    }),
    fetchLinksForBatch: async () => [],
  };
  const write: Partial<WriteGate> = {
    applyNearDupBatch: async (_b: NearDupApplyBatch) => {
      state.applyBatchCalls += 1;
      return {
        inboxConsumed: _b.processedInboxIds.length,
        signaturesUpserted: 0,
        bucketsUpserted: 0,
        edgesUpserted: 0,
        edgesDeleted: 0,
      };
    },
    applyNearDupDfSnapshot: async (_s: NearDupDfSnapshot) => {
      state.applyDfCalls += 1;
      state.lastDfSnapshot = _s;
      return { rebuilt: _s.entries.length };
    },
    // The real writer attaches this file. Reading it here asserts on
    // exactly the rows the writer would see, rather than on a payload
    // that no longer crosses the boundary.
    applyNearDupDfFromStaging: async (input: {
      stagingPath: string;
      algoVersion: string;
      totalDocs: number;
      minDf: number;
      capturedVersion: number;
    }) => {
      state.applyDfCalls += 1;
      state.lastDfStaging = {
        totalDocs: input.totalDocs,
        minDf: input.minDf,
        algoVersion: input.algoVersion,
      };
      const staged = new Database(input.stagingPath, { readonly: true });
      try {
        state.stagedRows = staged
          .prepare<
            [number],
            { shingle: string; df: number }
          >("SELECT shingle, df FROM df WHERE df >= ? ORDER BY shingle")
          .all(input.minDf);
      } finally {
        staged.close();
      }
      return { rebuilt: state.stagedRows.length };
    },
    nearDupAlgoSweepStep: async (_c: ResolvedNearDupConfig) => {
      state.algoSweepCalls += 1;
      return { cleared: 0, done: true };
    },
  };
  const cpu: Partial<CpuGate> = {
    nearDupSignBatch: async (docs) =>
      docs.map((d) => ({
        docId: d.docId,
        inboxId: d.inboxId,
        reason: d.reason,
        signatureBytes: null,
        shingleCount: 0,
        bands: null,
        shingles: null,
        docType: "email",
        threadId: null,
        senderAddress: null,
        contentHash: null,
        extractedContentHash: null,
        shouldDelete: true,
      })),
    nearDupVerifyBatch: async () => [],
    scoreMergeCandidates: async () => [],
    extractLinksFromDocs: async () => [],
    extractDfChunk: async (input) => {
      if (input.contents.includes("synthetic extraction failure")) {
        throw new Error("synthetic extraction failure");
      }
      return {
        docsProcessed: input.contents.length,
        // Treat each whitespace-separated token as a pseudo-shingle (one
        // occurrence each), so tests control cross-document DF by the content
        // they feed. Test contents avoid intra-doc repeats, matching the real
        // extractor's per-doc dedup.
        shingleCounts: input.contents.flatMap((c) =>
          c
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => [w, 1] as [string, number]),
        ),
      };
    },
  };
  const handler: ProxyHandler<object> = {
    get(target, prop) {
      const v = (target as Record<string | symbol, unknown>)[prop];
      if (v === undefined) {
        return () => {
          throw new Error(`unexpected gate call: ${String(prop)}`);
        };
      }
      return v;
    },
  };
  return {
    compute: new Proxy(compute, handler) as IoGate,
    write: new Proxy(write, handler) as WriteGate,
    cpu: new Proxy(cpu, handler) as CpuGate,
  };
}

function buildTasks(state: NearDupStubState): {
  nearDupCompute: PeriodicTask<unknown, IdleResult>;
  nearDupDfRefresh: PeriodicTask<unknown, IdleResult>;
  nearDupAlgoSweep: PeriodicTask<unknown, IdleResult>;
  scheduler: Scheduler;
} {
  const { compute, write, cpu } = stubGates(state);
  // In-memory DB with the schema applied — the drip task does query
  // it directly (for the `countNearDupInbox` read that feeds the
  // BackgroundJob tracker) so the table must exist.
  const readDb = new Database(":memory:") as unknown as import("../../data/types.js").Db;
  runSchemaSetup(readDb);
  runMigrations(readDb);
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(new MainTaskRunner({ concurrency: 1 }));
  const bundle = createBackfillTasks(
    {
      writeGate: write,
      ioGate: compute,
      cpuGate: cpu,
      log,
      linkBackfillIntervalMs: 1_000_000,
      linkIdleDelayMs: 1_000_000,
      linkReconcileIntervalMs: 1_000_000,
      linkReconcileBatchSize: 500,
      peopleBatchSize: 0,
      peopleBatchIntervalMs: 1_000_000,
      peopleIdleDelayMs: 1_000_000,
      peopleCountsRefreshIntervalMs: 1_000_000,
      statsRefreshIntervalMs: 1_000_000,
      catalogRefreshIntervalMs: 1_000_000,
      linkStatsRefreshIntervalMs: 1_000_000,
      linkStatsIdleDelayMs: 1_000_000,
      interactionScoresRefreshIntervalMs: 1_000_000,
      interactionScoresIdleDelayMs: 1_000_000,
      mergeRulesEvalIntervalMs: 1_000_000,
      mergeRulesEvalIdleDelayMs: 1_000_000,
      autoDetectIntervalMs: 1_000_000,
      mergeCandidatesDetectIntervalMs: 1_000_000,
      mergeCandidatesDetectIdleDelayMs: 1_000_000,
      getNearDupConfig: () => DEFAULT_NEAR_DUP_CONFIG,
      readDb: readDb as unknown as import("better-sqlite3").Database,
    },
    scheduler,
  );
  const byName = new Map(bundle.tasks.map((t) => [t.name, t] as const));
  return {
    nearDupCompute: byName.get("backfill.nearDupCompute") as PeriodicTask<unknown, IdleResult>,
    nearDupDfRefresh: byName.get("backfill.nearDupDfRefresh") as PeriodicTask<unknown, IdleResult>,
    nearDupAlgoSweep: byName.get("backfill.nearDupAlgoSweep") as PeriodicTask<unknown, IdleResult>,
    scheduler,
  };
}

function assertIdle(outcome: TaskOutcome<unknown, IdleResult>, expected: boolean): void {
  expect(outcome.kind).toBe("done");
  if (outcome.kind === "done") {
    expect(outcome.value.idle).toBe(expected);
  }
}

describe("nearDupComputeTask — DF readiness guard", () => {
  test("parks (idle:true) when DF is not yet built for the active algo", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: null, // not built
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
    };
    const { nearDupCompute, scheduler } = buildTasks(state);
    const outcome = await nearDupCompute.run(undefined, undefined);
    assertIdle(outcome, true);
    expect(state.computeBatchCalls).toBe(0);
    expect(state.applyBatchCalls).toBe(0);
    await scheduler.dispose();
  });

  test("fires (idle:false) once DF is built (built_at non-null)", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: 1700000000,
      batches: [
        // Non-empty batch — at least one inbox row processed.
        {
          algoVersion: DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion,
          processedInboxIds: [1],
          signatureDeletes: ["a"],
          signatures: [],
          bucketRows: [],
          edgeUpserts: [],
          edgeDeletes: [],
        },
      ],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
    };
    const { nearDupCompute, scheduler } = buildTasks(state);
    const outcome = await nearDupCompute.run(undefined, undefined);
    assertIdle(outcome, false);
    expect(state.computeBatchCalls).toBe(1);
    expect(state.applyBatchCalls).toBe(1);
    await scheduler.dispose();
  });
});

describe("nearDupDfRefreshTask — wall-clock trigger", () => {
  test("fires when built_at is null (fresh algo)", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: null,
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
    };
    const { nearDupDfRefresh, scheduler } = buildTasks(state);
    const outcome = await nearDupDfRefresh.run(undefined, undefined);
    assertIdle(outcome, false);
    expect(state.applyDfCalls).toBe(1);
    await scheduler.dispose();
  });

  test("merges per-doc shingle counts into a pruned snapshot", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: null, // fresh algo → fires
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
      dfDocChunks: [["alpha bravo charlie", "bravo charlie delta"]],
    };
    const { nearDupDfRefresh, scheduler } = buildTasks(state);
    const outcome = await nearDupDfRefresh.run(undefined, undefined);

    assertIdle(outcome, false);
    expect(state.applyDfCalls).toBe(1);
    expect(state.lastDfStaging?.totalDocs).toBe(2);
    // alpha=1, bravo=2, charlie=2, delta=1 → prune df<2 → bravo, charlie.
    expect(state.stagedRows).toEqual([
      { shingle: "bravo", df: 2 },
      { shingle: "charlie", df: 2 },
    ]);
    await scheduler.dispose();
  });

  test("merges a shingle across multiple fetch chunks", async () => {
    // Two pages of documents, so the chunk loop runs more than once and
    // "shared" must sum across two separate fetchDfDocChunk calls to reach
    // df>=2 — the cross-chunk merge the accumulator exists for.
    const state: NearDupStubState = {
      dfBuiltAt: null,
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
      dfDocChunks: [["shared alpha"], ["shared beta"]],
    };
    const { nearDupDfRefresh, scheduler } = buildTasks(state);
    const outcome = await nearDupDfRefresh.run(undefined, undefined);

    assertIdle(outcome, false);
    expect(state.lastDfStaging?.totalDocs).toBe(2);
    // shared=2 (one per chunk) survives; alpha/beta (df=1) pruned.
    expect(state.stagedRows).toEqual([{ shingle: "shared", df: 2 }]);
    await scheduler.dispose();
  });

  test("removes corpus-derived staging data when extraction fails", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: null,
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
      dfDocChunks: [["synthetic extraction failure"]],
    };
    const { nearDupDfRefresh, scheduler } = buildTasks(state);
    const outcome = await nearDupDfRefresh.run(undefined, undefined);

    assertIdle(outcome, true);
    expect(state.applyDfCalls).toBe(0);
    expect(existsSync(join(tmpdir(), `near-dup-df-staging-${process.pid}.sqlite`))).toBe(false);
    await scheduler.dispose();
  });

  test("parks idle when built_at is recent (younger than the refresh cadence)", async () => {
    const state: NearDupStubState = {
      dfBuiltAt: Math.floor(Date.now() / 1000) - 60, // 1 min ago
      batches: [],
      computeBatchCalls: 0,
      applyBatchCalls: 0,
      applyDfCalls: 0,
      algoSweepCalls: 0,
    };
    const { nearDupDfRefresh, scheduler } = buildTasks(state);
    const outcome = await nearDupDfRefresh.run(undefined, undefined);
    assertIdle(outcome, true);
    expect(state.applyDfCalls).toBe(0);
    await scheduler.dispose();
  });

  // The decided rule: a new file buys a rebuild, but at most one every six
  // hours; with no files, once a day and only in the quiet hour. Detection
  // is unaffected either way — this governs only how current the weighting
  // is, and the build costs half an hour of CPU and a large memory peak.
  /**
   * Run one trigger decision at a chosen local hour, with the table a
   * chosen age. The clock is set first so the age is measured against it.
   */
  async function runTrigger(input: {
    builtHoursAgo: number | null;
    filesArrived: boolean;
    atHour: number;
  }): Promise<number> {
    const now = new Date();
    now.setHours(input.atHour, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const state: NearDupStubState = {
        dfBuiltAt:
          input.builtHoursAgo === null
            ? null
            : Math.floor(now.getTime() / 1000) - input.builtHoursAgo * 60 * 60,
        batches: [],
        computeBatchCalls: 0,
        applyBatchCalls: 0,
        applyDfCalls: 0,
        algoSweepCalls: 0,
        dfFilesArrived: input.filesArrived,
      };
      const { nearDupDfRefresh, scheduler } = buildTasks(state);
      await nearDupDfRefresh.run(undefined, undefined);
      await scheduler.dispose();
      return state.applyDfCalls;
    } finally {
      vi.useRealTimers();
    }
  }

  test("a new file rebuilds once the table is six hours old", async () => {
    expect(await runTrigger({ builtHoursAgo: 7, filesArrived: true, atHour: 14 })).toBe(1);
  });

  test("a new file does not rebuild inside the six-hour floor", async () => {
    expect(await runTrigger({ builtHoursAgo: 2, filesArrived: true, atHour: 14 })).toBe(0);
  });

  test("no files: rebuilds once a day, in the quiet hour", async () => {
    expect(await runTrigger({ builtHoursAgo: 30, filesArrived: false, atHour: 3 })).toBe(1);
  });

  test("no files: waits for the quiet hour even when a day old", async () => {
    expect(await runTrigger({ builtHoursAgo: 30, filesArrived: false, atHour: 14 })).toBe(0);
  });

  test("no files and less than a day old: nothing to do", async () => {
    expect(await runTrigger({ builtHoursAgo: 8, filesArrived: false, atHour: 3 })).toBe(0);
  });

  test("a never-built table rebuilds whatever the hour", async () => {
    expect(await runTrigger({ builtHoursAgo: null, filesArrived: false, atHour: 14 })).toBe(1);
  });
});
