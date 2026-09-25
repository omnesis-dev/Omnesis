#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduling bench — drives mixed realtime/user load against an
 * in-process gateway Scheduler + writer worker, reports
 * user-priority SLA percentiles.
 *
 * Use:
 *   npx tsx bench/scheduling.ts            # default: 30s
 *   BENCH_DURATION_MS=60000 npx tsx ...    # 60s run
 *
 * What it does:
 *   1. Spins up a Scheduler with WriterTaskRunner + ComputeTaskRunner
 *      + MainTaskRunner against a fresh temp DB.
 *   2. Concurrently drives:
 *      - "realtime" load: upsertDocuments with N docs every M ms.
 *      - "user" load: setSyncState (small write) every K ms.
 *   3. Captures Scheduler.snapshot at end, prints per-priority SLA
 *      percentiles for user ops + per-task latencies for realtime.
 *
 * Exit code: 0 if user p99 <= budget (default 1s), else 1. Suitable
 * as a CI guard against scheduling regressions.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import {
  Scheduler,
  WriterTaskRunner,
  ComputeTaskRunner,
  MainTaskRunner,
  writeGateFromScheduler,
} from "../packages/gateway/src/scheduler/index.js";
import { createDatabase } from "../packages/gateway/src/db.js";
import { runWithPriority } from "../packages/gateway/src/priority.js";
import type { DocumentInput, SyncCursor } from "@omnesis/core";

const DURATION_MS = parseInt(process.env.BENCH_DURATION_MS ?? "30000", 10);
const BUDGET_MS = parseInt(process.env.BENCH_USER_BUDGET_MS ?? "1000", 10);

const REALTIME_DOCS_PER_BATCH = 50;
const REALTIME_INTERVAL_MS = 100;
const USER_INTERVAL_MS = 50;

const dbPath = `/tmp/omnesis-bench-${randomUUID()}.db`;
const workerUrl = new URL("../packages/gateway/src/workers/writer-worker.ts", import.meta.url);
const computeUrl = new URL("../packages/gateway/src/workers/compute-worker.ts", import.meta.url);
const loaderUrl = new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url).href;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDocs(n: number): DocumentInput[] {
  const now = new Date().toISOString();
  const docs: DocumentInput[] = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      providerId: "bench",
      sourceId: "bench-source",
      externalId: `${randomUUID()}-${i}`,
      title: `Bench doc ${i}`,
      content: "Lorem ipsum dolor sit amet, ".repeat(50),
      contentHash: randomUUID(),
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      metadata: { documentType: "email" },
    });
  }
  return docs;
}

async function main(): Promise<void> {
  console.log(
    `bench: duration=${DURATION_MS}ms userBudget=${BUDGET_MS}ms ` +
      `realtime=${REALTIME_DOCS_PER_BATCH}docs/${REALTIME_INTERVAL_MS}ms ` +
      `user=1op/${USER_INTERVAL_MS}ms`,
  );

  const seedDb = createDatabase(dbPath);
  seedDb.close();

  const scheduler = new Scheduler({ enablePreemption: true, userSlaBudgetMs: BUDGET_MS });
  scheduler.registerRunner(
    new WriterTaskRunner({
      gatewayDbPath: dbPath,
      journalMode: "WAL",
      heartbeatIntervalMs: 5_000,
      heartbeatWarnGapMs: 30_000,
      workerUrl,
      workerExecArgv: ["--import", loaderUrl],
    }),
  );
  scheduler.registerRunner(
    new ComputeTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 5_000,
      workerUrl: computeUrl,
      workerExecArgv: ["--import", loaderUrl],
    }),
  );
  scheduler.registerRunner(new MainTaskRunner({ concurrency: 16 }));
  await scheduler.start();
  const gate = writeGateFromScheduler(scheduler);

  let stop = false;
  const stopAt = Date.now() + DURATION_MS;

  // Realtime ingest loop.
  const realtimeLoop = (async () => {
    let inflight = 0;
    while (!stop) {
      if (inflight < 2) {
        inflight++;
        runWithPriority("realtime", () => gate.upsertDocuments(makeDocs(REALTIME_DOCS_PER_BATCH)))
          .catch(() => undefined)
          .finally(() => inflight--);
      }
      await new Promise((r) => setTimeout(r, REALTIME_INTERVAL_MS));
    }
  })();

  // User-priority pings.
  const userLoop = (async () => {
    let counter = 0;
    while (!stop) {
      const cursor = {
        type: "incremental",
        lastSyncTime: new Date().toISOString(),
      } as SyncCursor;
      counter++;
      runWithPriority("user", () => gate.setSyncState(`user-${counter}`, cursor, undefined)).catch(
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, USER_INTERVAL_MS));
    }
  })();

  // Run until duration elapses.
  while (Date.now() < stopAt) {
    await new Promise((r) => setTimeout(r, 250));
  }
  stop = true;
  await Promise.all([realtimeLoop, userLoop]);
  // Let in-flight ops drain.
  await new Promise((r) => setTimeout(r, 1_000));

  const snap = scheduler.snapshot(Math.ceil(DURATION_MS / 1000) + 5);

  console.log("");
  console.log("─── User-priority SLA ────────────────────────────────");
  console.log(
    `count=${snap.userSla.count} ` +
      `p50=${snap.userSla.p50}ms ` +
      `p95=${snap.userSla.p95}ms ` +
      `p99=${snap.userSla.p99}ms ` +
      `p999=${snap.userSla.p999}ms ` +
      `violations=${snap.userSla.violations}/${snap.userSla.count} ` +
      `budget=${snap.userSla.budgetMs}ms`,
  );

  console.log("");
  console.log("─── Top tasks by p99 ─────────────────────────────────");
  console.log(
    "name".padEnd(40),
    "runner".padEnd(8),
    "n".padStart(6),
    "p50".padStart(6),
    "p95".padStart(6),
    "p99".padStart(6),
    "max".padStart(6),
    "yield".padStart(5),
  );
  for (const t of snap.perTask.slice(0, 10)) {
    console.log(
      t.name.padEnd(40),
      t.runner.padEnd(8),
      String(t.count).padStart(6),
      `${t.p50}ms`.padStart(6),
      `${t.p95}ms`.padStart(6),
      `${t.p99}ms`.padStart(6),
      `${t.max}ms`.padStart(6),
      String(t.yieldCount).padStart(5),
    );
  }

  console.log("");
  console.log("─── Per-runner final state ───────────────────────────");
  for (const r of snap.perRunner) {
    console.log(
      `${r.runner}: inflight=${r.inFlight} ` +
        `queueDepth u=${r.queueDepthByPriority.user} r=${r.queueDepthByPriority.realtime} b=${r.queueDepthByPriority.background} ` +
        `maxAge u=${r.queueAgeMaxByPriority.user}ms r=${r.queueAgeMaxByPriority.realtime}ms b=${r.queueAgeMaxByPriority.background}ms`,
    );
  }

  await scheduler.dispose();
  cleanupDb(dbPath);

  // CI guard: fail if user p99 exceeds budget.
  if (snap.userSla.count > 0 && snap.userSla.p99 > BUDGET_MS) {
    console.error(`\nFAIL: user p99 ${snap.userSla.p99}ms > budget ${BUDGET_MS}ms`);
    process.exit(1);
  }
  console.log(`\nPASS: user p99 ${snap.userSla.p99}ms ≤ budget ${BUDGET_MS}ms`);
}

main().catch((err) => {
  console.error(err);
  cleanupDb(dbPath);
  process.exit(2);
});
