// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The near-dup compute tick on the real io and cpu workers, against a temp
 * database: candidates prepared on the cpu pool pair, verify and assemble
 * into exactly what the same pipeline produces when every phase runs in this
 * thread, and the batch the task hands the writer is that batch byte for
 * byte. The monolithic reference computes the same edge decisions.
 *
 * All fixture text is invented: words drawn from a fixed vocabulary by a
 * seeded generator.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { CpuTaskRunner } from "../scheduler/runners/cpu.js";
import { ioGateFromScheduler, type IoGate } from "../scheduler/io-ops.js";
import { cpuGateFromScheduler, type CpuGate } from "../scheduler/cpu-ops.js";
import { createBackfillTasks } from "../scheduler/tasks/backfill.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { enqueueNearDupInbox } from "./inbox.js";
import { setActiveAlgoVersion } from "./meta.js";
import {
  computeNearDupBatch,
  fetchNearDupCandidates,
  fetchNearDupDfData,
  fetchNearDupInbox,
} from "./NearDupComputeService.js";
import { computeNearDupDfSnapshot } from "./NearDupDfService.js";
import { applyNearDupBatch, applyNearDupDfSnapshot } from "./NearDupWriterOps.js";
import { prepareCandidateBatch, signDocBatch, verifyPairBatch } from "./cpu-signing.js";
import {
  assembleFinalBatch,
  assembleVerifyPairs,
  chunkCandidatesForPreparation,
  preparePersistedCandidates,
} from "./NearDupAssembler.js";
import type Database from "better-sqlite3";
import type { Db } from "../data/types.js";
import type { WriteGate } from "../write-gate.js";
import type { TaskContext } from "../scheduler/types.js";
import type { NearDupApplyBatch } from "./types.js";
import type { VerifiedPair, VerifyPairInput } from "./cpu-signing.js";

/**
 * Text processing this thread runs. The workers load their own copy of the
 * package, so only main-thread calls are counted.
 */
const mainThreadText = vi.hoisted(() => ({ normalizeCalls: 0, shingleCalls: 0 }));

vi.mock("@omnesis/near-dupes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/near-dupes")>();
  return {
    ...actual,
    normalizeText: (...args: Parameters<typeof actual.normalizeText>) => {
      mainThreadText.normalizeCalls++;
      return actual.normalizeText(...args);
    },
    shingles: (...args: Parameters<typeof actual.shingles>) => {
      mainThreadText.shingleCalls++;
      return actual.shingles(...args);
    },
  };
});

const IO_WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const CPU_WORKER_URL = new URL("../workers/cpu-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const config = DEFAULT_NEAR_DUP_CONFIG;
const algoVersion = config.algorithm.algoVersion;
const eligibleDocTypes = [...config.eligibleDocTypes];
const gateConfig = {
  recordThreshold: config.gate.recordThreshold,
  maxIdfWeight: config.algorithm.maxIdfWeight ?? 8.0,
  emailJaccardMin: config.gate.emailJaccardMin,
  emailPairUniqueDf2Min: config.gate.emailPairUniqueDf2Min,
  fileLikeJaccardMin: config.gate.fileLikeJaccardMin,
  fileLikePairUniqueDf2Min: config.gate.fileLikePairUniqueDf2Min,
  fileLikeContainmentMin: config.gate.fileLikeContainmentMin,
  automatedSenderPrefixes: [...config.gate.automatedSenderPrefixes],
};

const VOCABULARY = (
  "amber basil cobalt dune ember fjord grove harbor island juniper kestrel lagoon " +
  "meadow nimbus orchard pebble quarry river summit thicket umber valley willow " +
  "yarrow zephyr anchor beacon canyon delta estuary falcon glacier heron inlet " +
  "jasper kelp lantern marsh nettle oasis prairie quill reef sorrel tundra " +
  "upland vessel wharf yonder zenith atlas bramble cedar drift eddy flint gale"
).split(" ");

/** `count` words from the vocabulary, the same for the same seed. */
function words(seed: number, count: number): string {
  let state = seed >>> 0 || 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(VOCABULARY[(state >>> 16) % VOCABULARY.length]!);
  }
  return out.join(" ");
}

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let io: IoGate;
let cpu: CpuGate;

function seedDoc(id: string, body: string, documentType = "email"): void {
  db.prepare(
    `INSERT OR REPLACE INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', ?, ?, ?, ?, ?, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z',
             '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
  ).run(
    id,
    `src:${id}`,
    id,
    `title-${id}`,
    body,
    `ch-${id}-${body.length}`,
    JSON.stringify({ documentType }),
  );
}

/** Sign and persist everything in the inbox, through the monolithic reference. */
function drainInbox(): void {
  for (;;) {
    const batch = computeNearDupBatch(db as unknown as Db, config);
    if (batch.processedInboxIds.length === 0) return;
    applyNearDupBatch(db as unknown as Db, batch);
  }
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  const handle = db as unknown as Db;
  setActiveAlgoVersion(handle, algoVersion);

  // A newsletter family large enough that every new issue has more persisted
  // candidates than one preparation call takes, a family of long files, and
  // unrelated filler for the DF table.
  const newsletter = words(11, 400);
  for (let i = 0; i < 50; i++) seedDoc(`letter-${i}`, `${newsletter} issue ${i}`);
  const report = words(23, 8_000);
  for (let i = 0; i < 4; i++) seedDoc(`report-${i}`, `${report} ${words(200 + i, 40)}`, "file");
  for (let i = 0; i < 12; i++) seedDoc(`filler-${i}`, words(300 + i, 300));
  applyNearDupDfSnapshot(handle, computeNearDupDfSnapshot(handle, config));
  enqueueNearDupInbox(
    handle,
    [...Array.from({ length: 50 }, (_, i) => `letter-${i}`), "report-0", "report-1"],
    "insert",
  );
  enqueueNearDupInbox(handle, ["report-2", "report-3"], "insert");
  enqueueNearDupInbox(
    handle,
    Array.from({ length: 12 }, (_, i) => `filler-${i}`),
    "insert",
  );
  drainInbox();

  // The batch under test: new issues, an edited report whose old edges are
  // re-judged, a contact that is not eligible, and a deleted document.
  for (let i = 0; i < 6; i++) seedDoc(`letter-new-${i}`, `${newsletter} issue ${100 + i}`);
  seedDoc("report-1", `${report} ${words(600, 40)} revised appendix ${words(601, 200)}`, "file");
  seedDoc("contact-1", words(700, 200), "contact");
  enqueueNearDupInbox(
    handle,
    [...Array.from({ length: 6 }, (_, i) => `letter-new-${i}`), "contact-1"],
    "insert",
  );
  enqueueNearDupInbox(handle, ["report-1"], "update");
  enqueueNearDupInbox(handle, ["filler-0"], "delete");

  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: IO_WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  scheduler.registerRunner(
    new CpuTaskRunner({
      concurrency: 2,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: CPU_WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  io = ioGateFromScheduler(scheduler);
  cpu = cpuGateFromScheduler(scheduler);
}, 60_000);

afterEach(async () => {
  await scheduler.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

/** Every phase in this thread, the whole candidate set prepared in one call. */
function directPipeline(): {
  pairs: VerifyPairInput[];
  verified: VerifiedPair[];
  batch: NearDupApplyBatch;
} {
  const handle = db as unknown as Db;
  const fetched = fetchNearDupInbox(handle, config.scheduler.computeBatchSize, eligibleDocTypes);
  const dfData = fetchNearDupDfData(handle, algoVersion);
  const signed = signDocBatch(fetched.docs, config.algorithm, dfData, eligibleDocTypes);
  const candidateResult = fetchNearDupCandidates(
    handle,
    signed
      .filter((s) => !s.shouldDelete && s.bands !== null)
      .map((s) => ({ docId: s.docId, bands: s.bands!, reason: s.reason })),
    algoVersion,
    config.algorithm.bands,
    config.scheduler.maxCandidatesPerDoc,
  );
  const prepared = new Map(
    prepareCandidateBatch(
      Object.values(candidateResult.candidates),
      config.algorithm,
      eligibleDocTypes,
    ).map((c) => [c.candidateId, c] as const),
  );
  const pairs = assembleVerifyPairs(
    signed,
    candidateResult,
    prepared,
    config.scheduler.maxCandidatesPerDoc,
  );
  const verified = verifyPairBatch(pairs, dfData, gateConfig);
  return {
    pairs,
    verified,
    batch: assembleFinalBatch(fetched, signed, candidateResult, verified, algoVersion),
  };
}

it("prepares candidates on the cpu pool into exactly the pairs and verdicts of a direct run", async () => {
  const direct = directPipeline();
  const handle = db as unknown as Db;

  const fetched = await io.nearDupFetchInbox(config.scheduler.computeBatchSize, eligibleDocTypes);
  const dfData = await io.nearDupFetchDfData(algoVersion);
  const signed = await cpu.nearDupSignBatch(
    fetched.docs,
    config.algorithm,
    dfData,
    eligibleDocTypes,
  );
  const candidateResult = await io.nearDupFetchCandidates(
    signed
      .filter((s) => !s.shouldDelete && s.bands !== null)
      .map((s) => ({ docId: s.docId, bands: s.bands!, reason: s.reason })),
    algoVersion,
    config.algorithm.bands,
    config.scheduler.maxCandidatesPerDoc,
  );
  // The fixture is only a test of chunking if it spans several calls.
  expect(chunkCandidatesForPreparation(candidateResult.candidates).length).toBeGreaterThan(1);
  const prepared = await preparePersistedCandidates(candidateResult.candidates, (chunk) =>
    cpu.nearDupPrepareCandidates(chunk, config.algorithm, eligibleDocTypes),
  );
  const pairs = assembleVerifyPairs(
    signed,
    candidateResult,
    prepared,
    config.scheduler.maxCandidatesPerDoc,
  );
  expect(pairs).toStrictEqual(direct.pairs);
  expect(pairs.length).toBeGreaterThan(100);

  const verified = await cpu.nearDupVerifyBatch(pairs, dfData, gateConfig);
  expect(verified).toStrictEqual(direct.verified);
  expect(verified.some((v) => v.accepted)).toBe(true);

  // And the monolithic reference makes the same edge decisions.
  const reference = computeNearDupBatch(handle, config);
  const edgeKeys = (b: NearDupApplyBatch) =>
    b.edgeUpserts.map((e) => `${e.docA}|${e.docB}|${e.gateFamily}`).sort();
  expect(edgeKeys(direct.batch)).toEqual(edgeKeys(reference));
  expect(direct.batch.edgeDeletes.map((e) => `${e.docA}|${e.docB}`).sort()).toEqual(
    reference.edgeDeletes.map((e) => `${e.docA}|${e.docB}`).sort(),
  );
}, 60_000);

it("hands the writer the batch a direct run assembles, byte for byte", async () => {
  const direct = directPipeline();
  const applied: NearDupApplyBatch[] = [];
  const writeGate = {
    applyNearDupBatch: (batch: NearDupApplyBatch) => {
      applied.push(batch);
      return Promise.resolve({
        inboxConsumed: batch.processedInboxIds.length,
        signaturesUpserted: batch.signatures.length,
        bucketsUpserted: batch.bucketRows.length,
        edgesUpserted: batch.edgeUpserts.length,
        edgesDeleted: batch.edgeDeletes.length,
      });
    },
  } as unknown as WriteGate;
  let prepareCalls = 0;
  const countingCpu: CpuGate = {
    ...cpu,
    nearDupPrepareCandidates: (...args) => {
      prepareCalls++;
      return cpu.nearDupPrepareCandidates(...args);
    },
  };
  const bundle = createBackfillTasks(
    {
      writeGate,
      ioGate: io,
      cpuGate: countingCpu,
      log: createLogger("test:near-dup-worker"),
      sourceFiltersInUse: () => false,
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
      plannerStatisticsIntervalMs: 0,
      linkStatsRefreshIntervalMs: 1_000_000,
      linkStatsIdleDelayMs: 1_000_000,
      interactionScoresRefreshIntervalMs: 1_000_000,
      interactionScoresIdleDelayMs: 1_000_000,
      mergeRulesEvalIntervalMs: 1_000_000,
      mergeRulesEvalIdleDelayMs: 1_000_000,
      autoDetectIntervalMs: 1_000_000,
      mergeCandidatesDetectIntervalMs: 1_000_000,
      mergeCandidatesDetectIdleDelayMs: 1_000_000,
      getNearDupConfig: () => config,
      getCompletionProvider: () => null,
      readDb: db,
    },
    scheduler,
  );
  const task = bundle.tasks.find((t) => t.name === "backfill.nearDupCompute")!;

  mainThreadText.normalizeCalls = 0;
  mainThreadText.shingleCalls = 0;
  const outcome = await task.run(undefined, {} as TaskContext);

  expect(outcome).toMatchObject({ kind: "done", value: { idle: false } });
  expect(applied).toHaveLength(1);
  expect(applied[0]).toStrictEqual(direct.batch);
  expect(prepareCalls).toBeGreaterThan(1);
  // Every text was normalized and shingled on the workers, none in this thread.
  expect(mainThreadText).toEqual({ normalizeCalls: 0, shingleCalls: 0 });
}, 60_000);
