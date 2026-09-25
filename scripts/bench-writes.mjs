#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Write benchmark for an on/off comparison of the gateway's SQLite mitigations.
// Spawns a clean isolated gateway (its own config dir + port), fires a
// fixed batch-ingest load via POST /documents, records per-batch latency
// and total throughput, shuts the gateway down cleanly. Run twice with
// OMNESIS_192_MITIGATIONS=off and =on to get the comparison.
//
// Usage:
//   node scripts/bench-writes.mjs [batches=200] [batchSize=50]
//
// The benchmark's goal is to quantify the journal_mode=TRUNCATE vs WAL
// trade-off on ingest throughput. TRUNCATE blocks concurrent readers
// during commits and fsyncs twice per write, so we expect lower rps +
// somewhat higher tail latency; the question is whether it's still
// good enough for the collector's real load (batches every few seconds
// from a collector at steady state).

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BATCHES = Number(process.argv[2] ?? 200);
const BATCH_SIZE = Number(process.argv[3] ?? 50);
const PORT = Number(process.env.BENCH_PORT ?? 17790);
const MITI = process.env.OMNESIS_192_MITIGATIONS ?? "on";

const CONFIG_DIR = join(tmpdir(), `omn-bench-${process.pid}-${Date.now()}`);
const BASE = `http://localhost:${PORT}`;

function log(msg) {
  console.log(`[bench] ${msg}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("gateway didn't come up");
}

function startGateway() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const env = {
    ...process.env,
    OMNESIS_CONFIG_DIR: CONFIG_DIR,
    OMNESIS_GATEWAY_PORT: String(PORT),
    OMNESIS_INDEXER_ENABLED: "false",
    OMNESIS_192_MITIGATIONS: MITI,
    OMNESIS_LOG_LEVEL: "warn",
  };
  // Inherit PATH shenanigans from Makefile / CLAUDE.md (Node 24 keg-only).
  env.PATH = `/opt/homebrew/opt/node@24/bin:${env.PATH ?? ""}`;
  const proc = spawn(
    "node",
    [
      "--import",
      new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
      join("packages", "gateway", "src", "index.ts"),
    ],
    {
      env,
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      log(`gateway exited unexpectedly: code=${code} signal=${signal}`);
      if (stderr) log(`stderr:\n${stderr.slice(-2000)}`);
    }
  });
  return proc;
}

function readBootstrapToken() {
  const tokenPath = join(CONFIG_DIR, "token");
  for (let i = 0; i < 50; i++) {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, "utf8").trim();
    }
    // Ready can fire before token file lands. Busy-wait briefly.
  }
  throw new Error(`token file not found at ${tokenPath}`);
}

function syntheticDoc(runId, i) {
  const content = `Benchmark doc ${i} ${runId}. ${"lorem ipsum dolor sit amet ".repeat(80)}`; // ~2 KB
  const now = new Date().toISOString();
  return {
    providerId: `bench:${runId}`,
    sourceId: `bench:${runId}`,
    externalId: `doc-${i}`,
    title: `Doc ${i}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex").slice(0, 32),
    metadata: { documentType: "note" },
    sourceCreatedAt: now,
    sourceUpdatedAt: now,
  };
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function runBench() {
  log(`starting gateway (mitigations=${MITI}, port=${PORT}, dir=${CONFIG_DIR})`);
  const gw = startGateway();

  try {
    await waitReady();
    const token = readBootstrapToken();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };

    const runId = `run-${Date.now()}`;

    log(`warming up (5 small batches)`);
    for (let i = 0; i < 5; i++) {
      const docs = Array.from({ length: 10 }, (_, j) => syntheticDoc(`warm-${runId}`, j + i * 10));
      await fetch(`${BASE}/documents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ documents: docs }),
      });
    }

    log(`firing ${BATCHES} batches × ${BATCH_SIZE} docs`);
    const latencies = [];
    const t0 = Date.now();
    let ingested = 0;
    let errors = 0;

    for (let i = 0; i < BATCHES; i++) {
      const docs = Array.from({ length: BATCH_SIZE }, (_, j) =>
        syntheticDoc(runId, i * BATCH_SIZE + j),
      );
      const batchStart = Date.now();
      try {
        const res = await fetch(`${BASE}/documents`, {
          method: "POST",
          headers,
          body: JSON.stringify({ documents: docs }),
        });
        const lat = Date.now() - batchStart;
        if (res.ok) {
          const body = await res.json();
          ingested += body.ingested ?? 0;
          latencies.push(lat);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
      if ((i + 1) % 50 === 0) log(`progress: ${i + 1}/${BATCHES} batches, ${ingested} docs`);
    }

    const totalMs = Date.now() - t0;
    const rps = ingested / (totalMs / 1000);

    // Cleanup synthetic docs so re-running in the same dir doesn't pile up.
    try {
      await fetch(`${BASE}/documents/delete-all/source/${encodeURIComponent(`bench:${runId}`)}`, {
        method: "POST",
        headers,
      });
    } catch {
      /* best-effort */
    }

    console.log("\n=== RESULTS ===");
    console.log(`mitigations:   ${MITI}`);
    console.log(`batches:       ${BATCHES} × ${BATCH_SIZE} = ${BATCHES * BATCH_SIZE} docs`);
    console.log(`ingested:      ${ingested}`);
    console.log(`errors:        ${errors}`);
    console.log(`wall time:     ${(totalMs / 1000).toFixed(2)}s`);
    console.log(`throughput:    ${rps.toFixed(0)} docs/s`);
    console.log(`per-batch p50: ${percentile(latencies, 0.5)}ms`);
    console.log(`per-batch p95: ${percentile(latencies, 0.95)}ms`);
    console.log(`per-batch p99: ${percentile(latencies, 0.99)}ms`);
    console.log(`per-batch max: ${Math.max(...latencies)}ms`);
  } finally {
    log("shutting down gateway");
    gw.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (!gw.killed) gw.kill("SIGKILL");
    try {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

runBench().catch((e) => {
  console.error(`[bench] fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
