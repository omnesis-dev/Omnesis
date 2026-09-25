#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Chaos harness: drives the gateway with mixed search + synthetic
// ingest load while an external better-sqlite3 handle forces periodic
// wal_checkpoint(TRUNCATE) to churn the -shm mapping.
//
// Crash detection is a cross-platform LIVENESS signal: the harness polls
// the gateway's /health endpoint and treats the transition from a healthy
// baseline (an observed 200) to connection-refused / non-200 as the crash
// signal. This works on every platform — unlike a macOS crash-report-dir
// watcher, which silently sees nothing (and so false-PASSes) on Linux. On
// macOS, new node-*.ips crash reports under ~/Library/Logs/DiagnosticReports
// are folded in as an ADDITIONAL signal, never the primary one.
//
// MTTF goal: no SIGBUS in
// 1 h of sustained load post-fix. Pre-fix this reproduces the crash in
// minutes on a live-sized DB (>200k docs).
//
// Usage:
//   node scripts/chaos-gateway.mjs [durationSec]
//
// Env:
//   OMNESIS_GATEWAY_URL   default http://localhost:7600 — attaches to a
//                         gateway you started separately (npm run gateway)
//   CHAOS_DB_PATH         default ~/.config/omnesis/omnesis.db — direct
//                         better-sqlite3 handle used for wal_checkpoint
//   CHAOS_CONCURRENCY     default 6 — search worker count
//   CHAOS_CHECKPOINT_MS   default 5000 — wal_checkpoint(TRUNCATE) period
//   CHAOS_INGEST          default "1" — enable synthetic /documents posts
//   CHAOS_INGEST_MS       default 250 — ingest tick period
//   CHAOS_INGEST_BATCH    default 20 — docs per batch
//   CHAOS_TOKEN_PATH      default ~/.config/omnesis/token — bearer token
//                         used for HTTP calls (override when running
//                         against an isolated test gateway in a worktree)
//   CHAOS_LIVENESS_MS     default 1000 — /health liveness poll period
//   CHAOS_BASELINE_MS     default 15000 — max time to observe the first
//                         healthy 200 before failing loud (the gateway must
//                         come up; never silently PASS without a baseline)
//
// Cleanup: synthetic ingest docs land under a unique source; on exit the
// harness issues POST /documents/delete-all/source/<sourceId> to remove
// them so the real DB isn't polluted.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const DURATION_SEC = Number(process.argv[2] ?? 3600);
const BASE = process.env.OMNESIS_GATEWAY_URL ?? "http://localhost:7600";
const DB_PATH = process.env.CHAOS_DB_PATH ?? join(homedir(), ".config/omnesis/omnesis.db");
const CONCURRENCY = Number(process.env.CHAOS_CONCURRENCY ?? 6);
const CHECKPOINT_MS = Number(process.env.CHAOS_CHECKPOINT_MS ?? 5000);
const INGEST_ENABLED = (process.env.CHAOS_INGEST ?? "1") !== "0";
const INGEST_MS = Number(process.env.CHAOS_INGEST_MS ?? 250);
const INGEST_BATCH = Number(process.env.CHAOS_INGEST_BATCH ?? 20);
const LIVENESS_MS = Number(process.env.CHAOS_LIVENESS_MS ?? 1000);
const BASELINE_MS = Number(process.env.CHAOS_BASELINE_MS ?? 15000);

const SESSION_ID = `session-${Date.now()}`;
const SYNTH_PROVIDER_ID = `chaos:${SESSION_ID}`;
const SYNTH_SOURCE_ID = `chaos:${SESSION_ID}`; // used by /documents/delete-all/source

const startedAt = Date.now();
const diagDir = join(homedir(), "Library/Logs/DiagnosticReports");

const TOKEN_PATH = process.env.CHAOS_TOKEN_PATH ?? join(homedir(), ".config/omnesis/token");
const token = readFileSync(TOKEN_PATH, "utf8").trim();
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};

// ─── Search driver (inlined from stress-search.mjs) ───────────────────
const QUERIES = [
  "meeting notes",
  "invoice",
  "flight booking",
  "birthday party",
  "python script",
  "dinner reservation",
  "gym workout",
  "tax documents",
  "weekend plans",
  "quarterly review",
  "vacation photos",
  "github pull request",
  "apartment rent",
  "doctor appointment",
  "grocery list",
  "investment",
  "insurance claim",
  "conference talk",
  "new york trip",
  "family dinner",
];

const stats = {
  searches: 0,
  searchErrors: 0,
  ingestBatches: 0,
  ingestDocs: 0,
  ingestErrors: 0,
  checkpoints: 0,
  checkpointErrors: 0,
};

async function searchWorker(deadline) {
  while (Date.now() < deadline && !stopping) {
    const text = QUERIES[Math.floor(Math.random() * QUERIES.length)];
    try {
      const res = await fetch(`${BASE}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, limit: 10 }),
      });
      if (!res.ok) stats.searchErrors++;
      else await res.json();
      stats.searches++;
    } catch {
      stats.searchErrors++;
    }
  }
}

// ─── Synthetic ingest: posts chaos:<sessionId> docs to churn the WAL ──
let ingestSeq = 0;
function makeDoc() {
  const n = ingestSeq++;
  const now = new Date().toISOString();
  const content = `Lorem ipsum dolor sit amet ${n}. `.repeat(40);
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  return {
    providerId: SYNTH_PROVIDER_ID,
    sourceId: SYNTH_SOURCE_ID,
    externalId: `${SESSION_ID}-${n}`,
    title: `Chaos doc ${n}`,
    content,
    contentHash,
    metadata: { documentType: "note" },
    sourceCreatedAt: now,
    sourceUpdatedAt: now,
  };
}

async function ingestWorker(deadline) {
  while (Date.now() < deadline && !stopping) {
    const batch = Array.from({ length: INGEST_BATCH }, makeDoc);
    try {
      const res = await fetch(`${BASE}/documents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ documents: batch }),
      });
      if (!res.ok) stats.ingestErrors++;
      else {
        stats.ingestBatches++;
        stats.ingestDocs += batch.length;
      }
    } catch {
      stats.ingestErrors++;
    }
    await sleep(INGEST_MS);
  }
}

// ─── External wal_checkpoint pressure ─────────────────────────────────
let checkpointDb = null;
function openCheckpointHandle() {
  try {
    // Resolve better-sqlite3 from the monorepo's gateway workspace.
    const gatewayPkgDir = join(import.meta.dirname, "../packages/gateway");
    const r = createRequire(join(gatewayPkgDir, "package.json"));
    const Database = r("better-sqlite3");
    const db = new Database(DB_PATH, { fileMustExist: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA mmap_size = 0");
    return db;
  } catch (e) {
    console.error(`[chaos] could not open better-sqlite3 handle on ${DB_PATH}: ${e.message}`);
    console.error(`[chaos] checkpoint pressure disabled; search/ingest load still applied`);
    return null;
  }
}

async function checkpointWorker(deadline) {
  if (!checkpointDb) return;
  while (Date.now() < deadline && !stopping) {
    try {
      checkpointDb.pragma("wal_checkpoint(TRUNCATE)");
      stats.checkpoints++;
    } catch (e) {
      stats.checkpointErrors++;
      if (stats.checkpointErrors <= 3) {
        console.error(`[chaos] wal_checkpoint failed: ${e.message}`);
      }
    }
    await sleep(CHECKPOINT_MS);
  }
}

// ─── Liveness probe (primary, cross-platform crash signal) ────────────
// A single /health probe. Returns true on HTTP 200, false on any non-200
// or transport error (connection refused, reset, timeout, …) — i.e. the
// gateway is not currently serving healthy responses.
async function probeHealth() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(LIVENESS_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

const liveness = {
  everHealthy: false, // baseline: did we ever observe a 200?
  crashed: false, // observed a 200→down transition (the crash signal)
  downAtSec: null, // elapsed seconds at the crash transition
};

// Watches /health on a fixed period. The crash signal is the transition
// from a healthy baseline (an observed 200) to a down state (refused/non-200).
// Probes that are down BEFORE the baseline are not crashes — that is the
// gateway still starting up, handled separately by the fail-loud baseline.
async function livenessWorker(deadline) {
  while (Date.now() < deadline && !stopping) {
    const healthy = await probeHealth();
    if (healthy) {
      liveness.everHealthy = true;
    } else if (liveness.everHealthy && !liveness.crashed) {
      liveness.crashed = true;
      liveness.downAtSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(
        `[chaos] LIVENESS LOST at t=${liveness.downAtSec}s — /health was 200, now down (refused/non-200) at ${BASE}`,
      );
      console.error(`[chaos] stopping early — gateway appears to have crashed`);
      stopping = true;
    }
    await sleep(LIVENESS_MS);
  }
}

// ─── Crash-report watcher (additional macOS-only signal) ──────────────
// Folded into the verdict as a supplementary signal where the directory
// exists (macOS); on other platforms it is simply empty. The liveness
// probe above — not this — is the primary, cross-platform crash signal.
function scanForNewCrashes() {
  try {
    const entries = readdirSync(diagDir).filter((n) => n.startsWith("node-") && n.endsWith(".ips"));
    const fresh = [];
    for (const name of entries) {
      const path = join(diagDir, name);
      try {
        if (statSync(path).mtimeMs >= startedAt) fresh.push(name);
      } catch {
        /* file vanished, ignore */
      }
    }
    return fresh;
  } catch {
    return [];
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────
let stopping = false;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtStats() {
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  return (
    `t=${elapsedSec}s  search=${stats.searches}/${stats.searchErrors}e  ` +
    `ingest=${stats.ingestBatches}b/${stats.ingestDocs}d/${stats.ingestErrors}e  ` +
    `ckpt=${stats.checkpoints}/${stats.checkpointErrors}e  ` +
    `live=${liveness.crashed ? "DOWN" : "up"}`
  );
}

async function cleanupSyntheticDocs() {
  try {
    const res = await fetch(
      `${BASE}/documents/delete-all/source/${encodeURIComponent(SYNTH_SOURCE_ID)}`,
      { method: "POST", headers },
    );
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log(`[chaos] cleanup deleted ${body.deleted ?? "?"} synthetic docs`);
    } else {
      console.error(`[chaos] cleanup HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[chaos] cleanup failed: ${e.message}`);
  }
}

async function main() {
  console.log(`[chaos] starting ${DURATION_SEC}s run: base=${BASE}  db=${DB_PATH}`);
  console.log(
    `[chaos] session=${SESSION_ID}  concurrency=${CONCURRENCY}  ckpt=${CHECKPOINT_MS}ms  ingest=${INGEST_ENABLED}`,
  );

  // Fail-loud baseline: the gateway MUST answer /health with a 200 within
  // BASELINE_MS, otherwise we never had a live gateway to crash and a PASS
  // would be meaningless. Bounded retry (gateway may still be booting), with
  // one named signal on failure — never a silent PASS without a baseline.
  const baselineDeadline = Date.now() + BASELINE_MS;
  while (Date.now() < baselineDeadline) {
    if (await probeHealth()) {
      liveness.everHealthy = true;
      break;
    }
    await sleep(LIVENESS_MS);
  }
  if (!liveness.everHealthy) {
    console.error(
      `[chaos] BASELINE NOT ESTABLISHED — gateway never returned /health 200 at ${BASE} within ${BASELINE_MS}ms`,
    );
    process.exit(2);
  }

  checkpointDb = openCheckpointHandle();

  const deadline = Date.now() + DURATION_SEC * 1000;
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(searchWorker(deadline));
  if (INGEST_ENABLED) workers.push(ingestWorker(deadline));
  workers.push(checkpointWorker(deadline));
  workers.push(livenessWorker(deadline));

  const statsInterval = setInterval(() => {
    console.log(`[chaos] ${fmtStats()}`);
    const fresh = scanForNewCrashes();
    if (fresh.length) {
      console.error(`[chaos] NEW CRASH REPORT(S): ${fresh.join(", ")}`);
      console.error(`[chaos] stopping early — inspect ${join(diagDir, fresh[fresh.length - 1])}`);
      stopping = true;
    }
  }, 30_000);

  const onSignal = () => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await Promise.all(workers);
  clearInterval(statsInterval);

  console.log(`[chaos] final ${fmtStats()}`);

  // Primary, cross-platform verdict: did the gateway stay live? A 200→down
  // transition is the crash signal on every platform.
  if (liveness.crashed) {
    console.error(
      `[chaos] FAIL — gateway liveness lost at t=${liveness.downAtSec}s (/health 200→down)`,
    );
  }
  // Additional macOS-only signal, folded in where the crash dir exists.
  const crashes = scanForNewCrashes();
  if (crashes.length) {
    console.error(`[chaos] FAIL — ${crashes.length} new crash report(s):`);
    for (const c of crashes) console.error(`  - ${join(diagDir, c)}`);
  }
  const failed = liveness.crashed || crashes.length > 0;
  if (!failed) {
    console.log(
      `[chaos] PASS — gateway stayed live (and no new crash reports) for ${DURATION_SEC}s`,
    );
  }

  if (checkpointDb) {
    try {
      checkpointDb.close();
    } catch {
      /* best-effort */
    }
  }

  await cleanupSyntheticDocs();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`[chaos] fatal: ${e.stack ?? e.message}`);
  process.exit(2);
});
