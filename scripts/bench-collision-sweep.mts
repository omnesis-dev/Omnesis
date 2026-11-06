// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for the Brain's daily collision sweep
 * (`runCollisionSweepPass`) on a large, encrypted, invented store.
 *
 *   npx tsx scripts/bench-collision-sweep.mts build   <dir> [scale=1]
 *   npx tsx scripts/bench-collision-sweep.mts measure <dir> [runs=7]
 *   npx tsx scripts/bench-collision-sweep.mts capture <dir> <out.json>
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like a
 * production store, and fills it with invented Brain ledgers: documents,
 * people with merge chains, open and resolved loops with their people and
 * documents, observations over loops, a long history of temporal annotations
 * with a short future, doc and person annotations with disagreeing groups,
 * and a run queue holding settled collision verdicts. `scale` multiplies every
 * count.
 *
 * `measure` runs the sweep the way the gateway's rhythm task does: the main
 * handle is read-only with the default page cache, the reads the sweep may
 * hand to a worker go to a real io worker on its own handle, and the writes go
 * to a recording write gate (the writer is its own thread in the gateway, and
 * the sweep only enqueues a handful of runs). Each run opens a fresh main
 * handle and a fresh worker, so it starts as cold as a once-a-day task does.
 * It reports the longest main-thread block (`monitorEventLoopDelay`), the
 * sweep's total time and the process RSS growth.
 *
 * `capture` writes the runs the sweep enqueues and every candidate each finder
 * returns without a cap, so two checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's sweep: it
 * imports the gateway code relative to its own location. Never point it at a
 * live config directory; it writes the store it measures.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createLogger } from "@omnesis/core";
import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { Scheduler } from "../packages/gateway/src/scheduler/scheduler.js";
import { IoTaskRunner } from "../packages/gateway/src/scheduler/runners/io.js";
import { ioGateFromScheduler } from "../packages/gateway/src/scheduler/io-ops.js";
import { runCollisionSweepPass } from "../packages/gateway/src/brain/rhythm/collision-sweep-enqueuer.js";
import {
  findCollisionCandidates,
  findTemporalAnnotationCollisionCandidates,
  findAnnotationContradictionCandidates,
} from "../packages/gateway/src/brain/reconcile/collision-candidates.js";
import { synthesisCollisionDedupeKey } from "../packages/gateway/src/brain/run-payloads.js";
import type Database from "better-sqlite3";

const [mode, dir, arg] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: bench-collision-sweep.mts build|measure|capture <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
/** The gateway's default main-thread page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;
/** The sweep's clock: every run sees the same day. */
const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;
const SELF = "person-self";
const WORKER_URL = new URL("../packages/gateway/src/workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url)
  .href;

// ── deterministic invented content ─────────────────────────────────────────

let seed = 0x5eed4321;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}
function int(n: number): number {
  return Math.floor(random() * n);
}
const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );
function text(minBytes: number, maxBytes: number): string {
  const target = minBytes + int(maxBytes - minBytes);
  const out: string[] = [];
  let length = 0;
  while (length < target) {
    const word = pick(WORDS);
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ");
}
function pad(n: number): string {
  return String(n).padStart(6, "0");
}

// ── build ──────────────────────────────────────────────────────────────────

function build(scale: number): void {
  mkdirSync(dir!, { recursive: true });
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; build into an empty directory`);
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const n = (count: number) => Math.max(1, Math.round(count * scale));
  const counts = {
    documents: n(60_000),
    people: n(6_000),
    loops: n(4_000),
    observations: n(400),
    temporal: n(16_000),
    docAnnotations: n(30_000),
    personAnnotations: n(12_000),
    runs: n(40_000),
  };
  const started = performance.now();

  db.transaction(() => {
    const insDoc = db.prepare(`
      INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
      VALUES (?, 'example', 'source-notes', ?, '', ?, ?, ?, '{}', ?, ?, ?, ?)`);
    for (let i = 0; i < counts.documents; i++) {
      const at = new Date(NOW - (counts.documents - i) * 600_000).toISOString();
      insDoc.run(
        `doc-${pad(i)}`,
        `ext-${i}`,
        text(20, 60),
        text(400, 2_000),
        `h${i}`,
        at,
        at,
        at,
        at,
      );
    }

    const insPerson = db.prepare(`
      INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen,
        created_at, updated_at) VALUES (?, ?, ?, 'example', ?, ?, ?, ?, ?)`);
    const iso = new Date(NOW - 400 * DAY).toISOString();
    insPerson.run(SELF, "Maya Reeves", null, 1, iso, iso, iso, iso);
    for (let i = 0; i < counts.people; i++) {
      // One person in ten is merged into an earlier one; some of those
      // targets are themselves merged, so chains run two or three hops.
      const merged = i > 10 && i % 10 === 0 ? `person-${pad(int(i))}` : null;
      insPerson.run(`person-${pad(i)}`, `Person ${i}`, merged, 0, iso, iso, iso, iso);
    }

    const insLoop = db.prepare(`
      INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title,
        deadline_json, created_at, last_update) VALUES (?, 'run-seed', ?, 0.8, ?, ?, ?, ?, ?)`);
    const insLoopPerson = db.prepare(
      "INSERT OR IGNORE INTO open_loop_people (loop_id, person_id, role) VALUES (?, ?, ?)",
    );
    const insLoopDoc = db.prepare(
      "INSERT OR IGNORE INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)",
    );
    const loopIds: string[] = [];
    for (let i = 0; i < counts.loops; i++) {
      const id = `loop-${pad(i)}`;
      loopIds.push(id);
      const state = i % 8 < 3 ? "open" : i % 8 === 3 ? "snoozed" : i % 8 < 6 ? "done" : "dismissed";
      const deadline =
        random() < 0.4
          ? JSON.stringify({
              type: pick(["by", "on_day"]),
              date: new Date(NOW + (int(120) - 30) * DAY).toISOString().slice(0, 10),
            })
          : null;
      const touched = NOW - int(200) * DAY;
      insLoop.run(
        id,
        state,
        Math.round(random() * 100) / 100,
        text(20, 60),
        deadline,
        touched,
        touched,
      );
      insLoopPerson.run(id, SELF, "actor");
      for (let k = 0, m = 1 + int(3); k < m; k++)
        insLoopPerson.run(id, `person-${pad(int(counts.people))}`, pick(["actor", "involved"]));
      for (let k = 0, m = 1 + int(3); k < m; k++)
        insLoopDoc.run(id, `doc-${pad(int(counts.documents))}`);
    }

    const insObs = db.prepare(`
      INSERT INTO observations (id, created_by_run, summary, state, shipped_at, created_at, updated_at)
      VALUES (?, 'run-seed', ?, ?, ?, ?, ?)`);
    const insObsLoop = db.prepare(
      "INSERT OR IGNORE INTO observation_related_loops (observation_id, loop_id) VALUES (?, ?)",
    );
    for (let i = 0; i < counts.observations; i++) {
      const id = `obs-${pad(i)}`;
      const state = pick(["live", "held", "shipped", "shipped", "dropped"]);
      const at = NOW - int(40) * DAY;
      insObs.run(id, text(20, 60), state, state === "shipped" ? at : null, at, at);
      for (let k = 0, m = 2 + int(3); k < m; k++) insObsLoop.run(id, pick(loopIds));
    }

    // Temporal annotations: years of history behind the clock, a short future
    // ahead of it, and a few coarse year/month entries the join excludes.
    const insTemporal = db.prepare(`
      INSERT INTO temporal_annotations (id, interval_start_ms, interval_end_ms, precision,
        canonical, sentence, kind, created_by_run, created_at, updated_at, invalidated_at)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, 'run-seed', ?, ?, ?)`);
    const insTemporalDoc = db.prepare(
      "INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, ?)",
    );
    const temporalIds: string[] = [];
    for (let i = 0; i < counts.temporal; i++) {
      const id = `ta-${pad(i)}`;
      temporalIds.push(id);
      const future = random() < 0.04;
      const start = future ? NOW + int(90 * 24) * 3_600_000 : NOW - int(3 * 365 * 24) * 3_600_000;
      const precision = pick(["day", "day", "day", "hour", "week", "month", "year"]);
      const span =
        precision === "hour"
          ? 3_600_000
          : precision === "day"
            ? DAY * (1 + int(4))
            : precision === "week"
              ? 7 * DAY
              : precision === "month"
                ? 30 * DAY
                : 365 * DAY;
      const updated = Math.min(start, NOW) - int(30) * DAY;
      const invalidated = random() < 0.05 ? updated + DAY : null;
      insTemporal.run(
        id,
        start,
        start + span,
        precision,
        text(30, 120),
        updated,
        updated,
        invalidated,
      );
      for (let k = 0, m = 1 + int(2); k < m; k++)
        insTemporalDoc.run(id, `doc-${pad(int(counts.documents))}`);
    }

    // Doc and person annotations: a handful of claim types per subject, so
    // many (subject, claim type) groups carry more than one claim text.
    const claimTypes = ["status", "owner", "amount", "due date", "location", "role"];
    const insDocAnno = db.prepare(`
      INSERT INTO doc_annotations (id, doc_id, claim_type, claim_text, evidence_doc_id,
        evidence_quote, confidence, created_by_run, created_at, updated_at, invalidated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0.7, 'run-seed', ?, ?, ?)`);
    for (let i = 0; i < counts.docAnnotations; i++) {
      const subject = `doc-${pad(int(Math.round(counts.documents / 4)))}`;
      const at = NOW - int(300) * DAY;
      insDocAnno.run(
        `da-${pad(i)}`,
        subject,
        pick(claimTypes),
        `${pick(WORDS)} ${pick(WORDS)}`,
        // A few cite a document that no longer exists.
        random() < 0.03 ? `doc-missing-${i}` : `doc-${pad(int(counts.documents))}`,
        text(20, 80),
        at,
        random() < 0.5 ? at + DAY : null,
        random() < 0.1 ? at + 2 * DAY : null,
      );
    }
    const insPersonAnno = db.prepare(`
      INSERT INTO person_annotations (id, person_id, claim_type, claim_text, evidence_doc_id,
        evidence_quote, confidence, created_by_run, created_at, updated_at, invalidated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0.7, 'run-seed', ?, ?, ?)`);
    for (let i = 0; i < counts.personAnnotations; i++) {
      const at = NOW - int(300) * DAY;
      insPersonAnno.run(
        `pa-${pad(i)}`,
        `person-${pad(int(counts.people))}`,
        pick(claimTypes),
        `${pick(WORDS)} ${pick(WORDS)}`,
        `doc-${pad(int(counts.documents))}`,
        text(20, 80),
        at,
        random() < 0.5 ? at + DAY : null,
        random() < 0.1 ? at + 2 * DAY : null,
      );
    }

    // The run queue: mostly other kinds' history, plus settled collision
    // verdicts over loop sets and temporal pairs.
    const insRun = db.prepare(`
      INSERT INTO cognition_runs (id, kind, payload_json, dedupe_key, status, next_attempt_at,
        enqueued_at, completed_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`);
    for (let i = 0; i < counts.runs; i++) {
      const at = NOW - int(120) * DAY;
      const roll = random();
      if (roll < 0.05) {
        const pair = [pick(loopIds), pick(loopIds)].sort();
        insRun.run(
          `run-${pad(i)}`,
          "synthesis",
          "{}",
          synthesisCollisionDedupeKey(pair.join(",")),
          "completed",
          at,
          at,
        );
      } else if (roll < 0.1) {
        const pair = [pick(temporalIds), pick(temporalIds)].sort();
        insRun.run(
          `run-${pad(i)}`,
          "synthesis",
          "{}",
          synthesisCollisionDedupeKey(pair.join(",")),
          "completed",
          at,
          at,
        );
      } else {
        insRun.run(
          `run-${pad(i)}`,
          pick(["daily", "event", "decay", "synthesis", "reverification"]),
          JSON.stringify({ note: text(40, 200) }),
          `example:${i}`,
          pick(["completed", "completed", "completed", "failed"]),
          at,
          at,
        );
      }
    }
  })();
  db.close();
  console.log(
    `built ${dbPath} in ${((performance.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(counts)}`,
  );
}

// ── measure / capture ──────────────────────────────────────────────────────

interface Enqueued {
  kind: string;
  payload: unknown;
  dedupeKey: string | undefined;
}

function recordingWriteGate(out: Enqueued[]) {
  return {
    enqueueCognitionRun: async (input: {
      kind: string;
      payload?: unknown;
      dedupeKey?: string;
    }): Promise<unknown> => {
      out.push({ kind: input.kind, payload: input.payload, dedupeKey: input.dedupeKey });
      return { outcome: "inserted" };
    },
    setCognitionEngineState: async (): Promise<void> => {},
  } as never;
}

async function startWorker(keyHex: string) {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      gatewayDbKeyHex: keyHex,
      concurrency: 1,
      cacheSizeBytes: READ_CACHE_BYTES,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  return { scheduler, gate: ioGateFromScheduler(scheduler) };
}

async function sweepOnce(db: Database.Database, reads: unknown, out: Enqueued[]) {
  return runCollisionSweepPass({
    db,
    // The branch's sweep takes its selection reads from here; a checkout
    // without that seam ignores the field and reads on `db`.
    reads,
    writeGate: recordingWriteGate(out),
    clock: () => NOW,
    getCadenceHours: () => 24,
    getMaxPerSweep: () => 3,
    getSelfPersonId: () => SELF,
    getTimeHorizonDays: () => 60,
    getLoopCollisionsEnabled: () => true,
    getAnnotationContradictionsEnabled: () => true,
    getAnnotationContradictionsMaxPerSweep: () => 2,
    log: createLogger("bench").child("collision"),
  } as Parameters<typeof runCollisionSweepPass>[0]);
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `median ${median.toFixed(0)} ms, worst ${sorted[sorted.length - 1]!.toFixed(0)} ms`;
}

async function measure(runs: number): Promise<void> {
  const keyHex = readFileSync(keyPath, "utf8").trim();
  const key = Buffer.from(keyHex, "hex");
  const blocked: number[] = [];
  const total: number[] = [];
  const rss: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { scheduler, gate } = await startWorker(keyHex);
    const db = openReadOnlyDatabase(dbPath, {
      encryptionKey: key,
      cacheSizeBytes: READ_CACHE_BYTES,
    }) as unknown as Database.Database;
    const out: Enqueued[] = [];
    const rssBefore = process.memoryUsage().rss;
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = performance.now();
    const result = await sweepOnce(db, gate, out);
    const ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 5));
    histogram.disable();
    const grown = (process.memoryUsage().rss - rssBefore) / 1_048_576;
    blocked.push(histogram.max / 1e6);
    total.push(ms);
    rss.push(grown);
    console.log(
      `run ${i + 1}: blocked ${(histogram.max / 1e6).toFixed(0)} ms, total ${ms.toFixed(0)} ms, rss +${grown.toFixed(0)} MiB, enqueued ${result.enqueued}`,
    );
    db.close();
    await scheduler.dispose();
  }
  console.log(`main-thread blocked: ${summary(blocked)}`);
  console.log(`sweep total:         ${summary(total)}`);
  console.log(
    `rss growth:          median ${[...rss].sort((a, b) => a - b)[Math.floor(rss.length / 2)]!.toFixed(0)} MiB`,
  );
}

async function capture(outPath: string): Promise<void> {
  const keyHex = readFileSync(keyPath, "utf8").trim();
  const db = openReadOnlyDatabase(dbPath, {
    encryptionKey: Buffer.from(keyHex, "hex"),
    cacheSizeBytes: READ_CACHE_BYTES,
  }) as unknown as Database.Database;
  const { scheduler, gate } = await startWorker(keyHex);
  const enqueued: Enqueued[] = [];
  await sweepOnce(db, gate, enqueued);
  const result = {
    enqueued,
    loops: findCollisionCandidates(db, { limit: 1_000_000, selfPersonId: SELF, now: NOW }),
    temporal: findTemporalAnnotationCollisionCandidates(db, {
      limit: 1_000_000,
      now: NOW,
      horizonDays: 60,
    }),
    contradictions: findAnnotationContradictionCandidates(db, { max: 1_000_000 }),
  };
  writeFileSync(outPath, JSON.stringify(result, null, 1));
  console.log(
    `captured ${enqueued.length} enqueued runs, ${result.loops.length} loop, ${result.temporal.length} temporal, ${result.contradictions.length} contradiction candidates`,
  );
  db.close();
  await scheduler.dispose();
}

if (mode === "build") build(Number(arg ?? 1));
else if (mode === "measure") await measure(Number(arg ?? 7));
else if (mode === "capture") await capture(arg ?? join(dir, "capture.json"));
else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
