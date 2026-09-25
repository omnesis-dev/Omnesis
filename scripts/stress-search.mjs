#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Stress harness: concurrent search queries against the live gateway to
// exercise multi-connection DB reads. Throwaway; used to validate the
// mmap_size=0 mitigation under load.
//
// Usage: node scripts/stress-search.mjs [durationSec] [concurrency]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DURATION_SEC = Number(process.argv[2] ?? 300);
const CONCURRENCY = Number(process.argv[3] ?? 6);

const token = readFileSync(join(homedir(), ".config/omnesis/token"), "utf8").trim();
const base = process.env.OMNESIS_GATEWAY_URL ?? "http://localhost:7600";
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};

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
  "wedding",
  "car insurance",
  "dentist",
  "running route",
  "recipe pasta",
  "homework assignment",
  "code review",
  "sprint planning",
];

function pickQuery() {
  return QUERIES[Math.floor(Math.random() * QUERIES.length)];
}

const stats = {
  count: 0,
  errors: 0,
  latencies: [],
  start: Date.now(),
};

async function fireOne() {
  const query = pickQuery();
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: query, limit: 10 }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      stats.errors++;
      if (stats.errors <= 5 || stats.errors % 50 === 0) {
        const body = await res.text();
        process.stderr.write(
          `[ERR ${stats.errors}] "${query}" HTTP ${res.status}: ${body.slice(0, 120)}\n`,
        );
      }
      return;
    }
    await res.json(); // drain body
    stats.latencies.push(ms);
    stats.count++;
  } catch (e) {
    stats.errors++;
    process.stderr.write(`[ERR ${stats.errors}] "${query}" fetch: ${e.message}\n`);
  }
}

async function worker(_id) {
  const deadline = Date.now() + DURATION_SEC * 1000;
  while (Date.now() < deadline) {
    await fireOne();
  }
}

function summary() {
  const elapsed = (Date.now() - stats.start) / 1000;
  const rps = stats.count / elapsed;
  console.log(`\n=== ${elapsed.toFixed(1)}s elapsed ===`);
  console.log(`queries: ${stats.count}  errors: ${stats.errors}  rps: ${rps.toFixed(1)}`);
  const arr = stats.latencies.slice().sort((a, b) => a - b);
  if (arr.length > 0) {
    const p50 = arr[Math.floor(arr.length / 2)];
    const p95 = arr[Math.floor(arr.length * 0.95)];
    const p99 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.99))];
    console.log(
      `latency  n=${String(arr.length).padStart(4)} p50=${String(p50).padStart(5)}ms  p95=${String(p95).padStart(6)}ms  p99=${String(p99).padStart(6)}ms`,
    );
  }
}

const interval = setInterval(summary, 30_000);

const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
clearInterval(interval);
console.log("\n=== final ===");
summary();
