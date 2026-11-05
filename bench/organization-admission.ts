#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Organization admission bench: how long starting one organization cohort
 * holds the gateway's single writer, on a store with a long Brain history.
 *
 * Use:
 *   npx tsx bench/organization-admission.ts
 *   BENCH_RUNS=7 BENCH_SOURCE_WORK=400000 npx tsx bench/organization-admission.ts
 *
 * What it does:
 *   1. Seeds a fresh full-schema store (encrypted unless BENCH_ENCRYPTED=0)
 *      with invented documents, their organization coverage, settled
 *      cohorts (a share of them released for a publication retry), settled
 *      source work, and a pending discovery backlog. No ANALYZE, as in the
 *      gateway.
 *   2. Per run: selects a cohort on a second handle, standing in for the read
 *      worker, then admits it with `startOrganizationBatch` on the writer
 *      handle, as the `knowledge.startOrganization` writer op does. Then it
 *      settles the cohort so the next run starts another.
 *   3. Reports per run and as median / worst: the writer hold time, the
 *      selection read, the write-ahead-log frames and rows the admission
 *      wrote, one ordinary work enqueue on the same writer, and the heap.
 *
 * Point it at another checkout by copying this file there: its imports are
 * relative, so it measures the code of the tree it sits in.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createDatabase } from "../packages/gateway/src/db.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "../packages/gateway/src/brain/knowledge/discovery-policy.js";
import { selectOrganizationCohort } from "../packages/gateway/src/brain/knowledge/organization-cohorts.js";
import { startOrganizationBatch } from "../packages/gateway/src/brain/knowledge/organization-writer.js";
import { enqueueKnowledgeWork } from "../packages/gateway/src/brain/knowledge/work.js";
import type Database from "better-sqlite3";

const int = (name: string, fallback: number) => parseInt(process.env[name] ?? `${fallback}`, 10);
const RUNS = int("BENCH_RUNS", 5);
const DOCS = int("BENCH_DOCS", 30_000);
const COHORTS = int("BENCH_COHORTS", 6_000);
const SOURCE_WORK = int("BENCH_SOURCE_WORK", 200_000);
const PENDING = int("BENCH_PENDING", 50_000);
const COHORT_SIZE = int("BENCH_COHORT_SIZE", 5);
const ENCRYPTED = process.env.BENCH_ENCRYPTED !== "0";

const DAY = 86_400_000;
const START = Date.parse("2027-04-06T09:00:00Z");
const dbPath = `/tmp/omnesis-bench-${randomUUID()}.db`;
const key = ENCRYPTED ? randomBytes(32) : null;
const open = () => createDatabase(dbPath, { encryptionKey: key }) as unknown as Database.Database;

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
}

function seed(db: Database.Database): void {
  const body = "Invented survey notes about the water readings at the north station. ".repeat(40);
  const at = new Date(START - DAY).toISOString();
  const document = db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'bench','bench-notes',?,?,?,?,?,?,?,?)`,
  );
  const revision = db.prepare(
    "UPDATE knowledge_source_revisions SET generation=1 WHERE document_id=?",
  );
  const coverage = db.prepare(
    `INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at)
     VALUES(?,?,?,?,'considered',?)`,
  );
  const run = db.prepare(
    `INSERT INTO cognition_runs(id,kind,payload_json,status,next_attempt_at,enqueued_at,completed_at)
     VALUES(?,'synthesis','{"focus":"knowledge-maintenance"}','completed',?,?,?)`,
  );
  const batch = db.prepare(
    `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at,finished_at)
     VALUES(?,?,'bench','routine','completed',?,?,?)`,
  );
  const cohort = db.prepare(
    `INSERT INTO knowledge_organization_cohorts(id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at,retrieval_reconsidered,retrieval_reconsider_at)
     VALUES(?,?,?,?,'completed',?,?,?,?,?)`,
  );
  const member = db.prepare(
    "INSERT INTO knowledge_organization_members(cohort_id,source_id,content_hash) VALUES(?,?,?)",
  );
  const frontier = db.prepare(
    `INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status)
     VALUES(?,?,?,'{}',0,'unchanged')`,
  );
  const region = db.prepare("INSERT INTO knowledge_batch_regions(batch_id,node_id) VALUES(?,?)");
  const work = db.prepare(
    `INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id)
     VALUES(?,?,'source',?,?,?,'routine',?,?,?,?,?)`,
  );
  // Settled history covers the first part of the corpus; the rest is still
  // waiting for its first cohort, which is what each run admits.
  const settled = Math.floor(DOCS * 0.8);
  db.transaction(() => {
    for (let i = 0; i < DOCS; i++) {
      const id = `note-${i}`;
      document.run(id, id, `Survey note ${i}`, `${body}${i}`, `hash-${i}`, at, at, at, at);
      revision.run(id);
      for (const phase of ["interpretation", "organization"])
        coverage.run(
          id,
          `hash-${i}:knowledge:1`,
          phase,
          KNOWLEDGE_DISCOVERY_POLICY,
          START - DAY + i,
        );
    }
    for (let c = 0; c < COHORTS; c++) {
      const created = START - 30 * DAY + c * 1000;
      run.run(`cog-history-${c}`, created, created, created);
      batch.run(`kb-history-${c}`, `cog-history-${c}`, created, created, created);
      const released = c % 3 === 0;
      cohort.run(
        `ko-history-${c}`,
        `kb-history-${c}`,
        `history-${c}`,
        KNOWLEDGE_DISCOVERY_POLICY,
        created + DAY,
        created,
        created,
        released ? 1 : 0,
        released ? created + DAY : null,
      );
      for (let m = 0; m < 4; m++) {
        const d = (c * 4 + m) % settled;
        member.run(`ko-history-${c}`, `note-${d}`, `hash-${d}:knowledge:1`);
        frontier.run(`kb-history-${c}`, `source:note-${d}`, `history-${c}-${m}`);
        region.run(`kb-history-${c}`, `source:note-${d}`);
      }
    }
    for (let w = 0; w < SOURCE_WORK; w++) {
      const d = w % settled;
      const created = START - 30 * DAY + w;
      work.run(
        `kw-history-${w}`,
        `note-${d}`,
        w % 2 ? "review" : "discovery",
        `hash-${d}:knowledge:1`,
        created,
        created,
        created,
        created,
        "completed",
        `kb-history-${w % COHORTS}`,
      );
    }
    for (let p = 0; p < PENDING; p++) {
      const id = `backlog-${p}`;
      document.run(id, id, `Backlog note ${p}`, `${body}${p}`, `backlog-${p}`, at, at, at, at);
      work.run(
        `kw-backlog-${p}`,
        id,
        "discovery",
        `backlog-${p}`,
        START,
        START,
        START,
        START,
        "pending",
        null,
      );
    }
  })();
}

/** Ends the admitted cohort the way a finished run does, so the next run can start one. */
function settle(db: Database.Database, suffix: string, at: number): void {
  db.transaction(() => {
    db.prepare("UPDATE knowledge_batches SET status='completed',finished_at=? WHERE id=?").run(
      at,
      `kb-${suffix}`,
    );
    db.prepare(
      "UPDATE knowledge_organization_cohorts SET status='completed',retry_at=?,updated_at=? WHERE id=?",
    ).run(at + 30 * DAY, at, `ko-${suffix}`);
    db.prepare("UPDATE knowledge_work SET status='completed' WHERE batch_id=?").run(`kb-${suffix}`);
    db.prepare("UPDATE cognition_runs SET status='completed',completed_at=? WHERE id=?").run(
      at,
      `cog-${suffix}`,
    );
  })();
}

function walFrames(db: Database.Database): number {
  const size = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  return size <= 32 ? 0 : Math.round((size - 32) / (pageSize + 24));
}

interface Sample {
  admissionMs: number;
  selectionMs: number;
  walFrames: number;
  rows: number;
  enqueueMs: number;
  heapMb: number;
}

function main(): void {
  cleanup();
  const writer = open();
  const reader = open();
  const seeded = performance.now();
  seed(writer);
  console.log(
    `seeded in ${Math.round(performance.now() - seeded)} ms: ${DOCS} documents, ${COHORTS} settled cohorts, ` +
      `${SOURCE_WORK} settled and ${PENDING} pending source work rows, ${ENCRYPTED ? "encrypted" : "plaintext"}`,
  );
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    const now = START + i * 10 * 60_000;
    const options = { now, intervalMs: 60_000, retryMs: 600_000, limit: COHORT_SIZE };
    let started = performance.now();
    const selection = selectOrganizationCohort(reader, options);
    const selectionMs = performance.now() - started;
    if (!selection) throw new Error(`run ${i}: nothing to select`);
    const sources = Object.keys(selection.sourceVersions);
    writer.pragma("wal_checkpoint(TRUNCATE)");
    const changes = (writer.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const heap = process.memoryUsage().heapUsed;
    started = performance.now();
    startOrganizationBatch(
      writer,
      {
        ...selection,
        id: `ko-run-${i}`,
        batchId: `kb-run-${i}`,
        runId: `cog-run-${i}`,
        workPrefix: `kw-run-${i}`,
        intervalMs: options.intervalMs,
        retryMs: options.retryMs,
        regionNodeIds: sources.map((id) => `source:${id}`),
        frontier: sources.map((id) => ({
          nodeId: `source:${id}`,
          depth: 0,
          inputFingerprint: `run-${i}-${id}`,
          inputVersions: { [`source:${id}`]: selection.sourceVersions[id]! },
        })),
      },
      now,
    );
    const admissionMs = performance.now() - started;
    const heapMb = (process.memoryUsage().heapUsed - heap) / 1048576;
    const rows = (writer.prepare("SELECT total_changes() AS n").get() as { n: number }).n - changes;
    const frames = walFrames(writer);
    settle(writer, `run-${i}`, now);
    // One ordinary writer op over the same ledgers, to show its cost is unchanged.
    const target = `note-${DOCS - 1 - i}`;
    started = performance.now();
    enqueueKnowledgeWork(
      writer,
      {
        id: `kw-enqueue-${i}`,
        subjectKind: "source",
        subjectId: target,
        reason: "change",
        inputRevision: `hash-${DOCS - 1 - i}:knowledge:1`,
        tier: "routine",
        dueAt: now + DAY,
      },
      now,
    );
    const enqueueMs = performance.now() - started;
    writer.prepare("DELETE FROM knowledge_work WHERE id=?").run(`kw-enqueue-${i}`);
    samples.push({ admissionMs, selectionMs, walFrames: frames, rows, enqueueMs, heapMb });
    console.log(
      `run ${i + 1}: ${sources.length} sources${selection.publicationRetry ? " (retry)" : ""}, ` +
        `admission ${admissionMs.toFixed(1)} ms, selection ${selectionMs.toFixed(1)} ms, ` +
        `${frames} WAL frames, ${rows} rows, enqueue ${enqueueMs.toFixed(2)} ms, heap ${heapMb.toFixed(1)} MB`,
    );
  }
  const stat = (pick: (s: Sample) => number) => {
    const values = samples.map(pick).sort((a, b) => a - b);
    return { median: values[Math.floor(values.length / 2)]!, worst: values[values.length - 1]! };
  };
  console.log("\nmetric                 median      worst");
  for (const [label, pick] of [
    ["admission (ms)", (s: Sample) => s.admissionMs],
    ["selection read (ms)", (s: Sample) => s.selectionMs],
    ["WAL frames", (s: Sample) => s.walFrames],
    ["rows written", (s: Sample) => s.rows],
    ["work enqueue (ms)", (s: Sample) => s.enqueueMs],
    ["heap delta (MB)", (s: Sample) => s.heapMb],
  ] as const) {
    const { median, worst } = stat(pick);
    console.log(
      `${label.padEnd(22)} ${median.toFixed(2).padStart(9)}  ${worst.toFixed(2).padStart(9)}`,
    );
  }
  reader.close();
  writer.close();
  cleanup();
}

main();
