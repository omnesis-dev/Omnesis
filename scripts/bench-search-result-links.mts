// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark for reading search results' links (`readSearchResultLinks`) on a
 * large, encrypted, invented corpus.
 *
 *   npx tsx scripts/bench-search-result-links.mts build   <dir> [documents=40000]
 *   npx tsx scripts/bench-search-result-links.mts measure <dir> [runs=7] [pool=50] [limit=10] [cold]
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like
 * a production store, and fills it with invented documents whose text sizes
 * have a long tail: most of 2–24 KiB, one in ten up to 256 KiB, and a few up
 * to 2 MiB, as long attachments and exports have.
 *
 * `measure` times one search's read of its results' links per run, each run
 * over documents no earlier run read:
 *
 *  - `poolOnMain`: the candidate pool's links read on the main read handle (256
 *    MiB cache), synchronously, as an agent search did;
 *  - `resultsOnMain`: only the returned results' links, on the same handle;
 *  - `resultsOnWorker`: only the returned results' links, on a real io worker
 *    (64 MiB cache), while the main thread runs a 1 ms timer.
 *
 * With `cold`, the store is dropped from the operating system's page cache
 * before each read (`dd iflag=nocache`, Linux), so every page comes from the
 * disk, as it does for documents nothing has read lately, or while other reads
 * crowd them out of memory.
 *
 * For each it reports how long the main thread was blocked (for a read on the
 * main handle, the read itself; on the worker, the longest gap between timer
 * ticks) and how long the search waited for the links. It checks the worker
 * returns what the main handle returns.
 *
 * Never point it at a live config directory; it writes the store it measures.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { Scheduler } from "../packages/gateway/src/scheduler/scheduler.js";
import { IoTaskRunner } from "../packages/gateway/src/scheduler/runners/io.js";
import { ioGateFromScheduler } from "../packages/gateway/src/scheduler/io-ops.js";
import { readSearchResultLinks } from "../packages/gateway/src/search/result-links.js";

const [mode, dir, ...rest] = process.argv.slice(2);
if ((mode !== "build" && mode !== "measure") || !dir) {
  console.error("usage: bench-search-result-links.mts build|measure <dir> [args]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
/** The main read handle's and an io worker's page caches (`runtime-settings.ts`). */
const MAIN_READ_CACHE_BYTES = 256 * 1024 * 1024;
const IO_READ_CACHE_BYTES = 64 * 1024 * 1024;
const NOW = "2026-01-01T00:00:00Z";

let seed = 0x1ee7c0de;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const WORDS =
  "budget review quarterly marathon entry form heart rate trend venue schedule invoice notes draft".split(
    " ",
  );
function body(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

function textSize(): number {
  const r = random();
  if (r < 0.015) return 256 * 1024 + Math.floor(random() * (2048 - 256) * 1024);
  if (r < 0.115) return 24 * 1024 + Math.floor(random() * (256 - 24) * 1024);
  return 2048 + Math.floor(random() * 22 * 1024);
}

function build(): void {
  const documents = Number(rest[0] ?? 40_000);
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; use a fresh directory`);
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata,
                            source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'bench', 'bench', ?, 'Example', ?, ?, ?, ?, ?, ?, ?)`,
  );
  let bytes = 0;
  const batch = 2_000;
  for (let start = 0; start < documents; start += batch) {
    db.transaction(() => {
      for (let i = start; i < Math.min(documents, start + batch); i++) {
        const id = `doc-${i}`;
        const text = body(textSize());
        bytes += text.length;
        const metadata = {
          documentType: i % 3 ? "email" : "attachment",
          sourceUrl: `https://example.org/open/${id}`,
          ...(i % 2 ? { appUrl: `fictional-app://doc/${id}` } : {}),
          ...(i % 3 ? {} : { extra: { mimeType: "application/pdf" } }),
        };
        insert.run(id, id, text, `h${i}`, JSON.stringify(metadata), NOW, NOW, NOW, NOW);
      }
    })();
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(JSON.stringify({ documents, textMiB: Math.round(bytes / 2 ** 20) }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function summary(values: number[]) {
  return { median: Math.round(median(values)), worst: Math.round(Math.max(...values)) };
}

/** Runs `work` while a 1 ms timer ticks; returns its time and the longest gap between ticks. */
async function withTimer<T>(
  work: () => Promise<T>,
): Promise<{ ms: number; gapMs: number; value: T }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 1);
  const t = performance.now();
  const value = await work();
  const ms = performance.now() - t;
  clearInterval(timer);
  gapMs = Math.max(gapMs, performance.now() - last);
  return { ms, gapMs, value };
}

async function measure(): Promise<void> {
  const runs = Number(rest[0] ?? 7);
  const pool = Number(rest[1] ?? 50);
  const limit = Number(rest[2] ?? 10);
  const cold = rest[3] === "cold";
  /** Drop the store from the page cache, so the next read comes from the disk. */
  const evict = () => {
    if (!cold) return;
    for (const file of [dbPath, `${dbPath}-wal`])
      if (existsSync(file))
        execFileSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"]);
  };
  const keyHex = readFileSync(keyPath, "utf8").trim();
  const main = openReadOnlyDatabase(dbPath, {
    encryptionKey: Buffer.from(keyHex, "hex"),
    cacheSizeBytes: MAIN_READ_CACHE_BYTES,
  });
  const documents = (main.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      gatewayDbKeyHex: keyHex,
      concurrency: 1,
      cacheSizeBytes: IO_READ_CACHE_BYTES,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 60_000,
      workerUrl: new URL("../packages/gateway/src/workers/io-worker.ts", import.meta.url),
      workerExecArgv: [
        "--import",
        new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url).href,
      ],
    }),
  );
  await scheduler.start();
  const gate = ioGateFromScheduler(scheduler);
  await gate.searchResultLinks(["doc-0"]);

  // Each run and each variant reads documents no earlier read touched, so
  // every read pays for its documents' pages as a search over new hits does.
  const order = Array.from({ length: documents }, (_, i) => i).sort(() => random() - 0.5);
  let next = 0;
  const take = (n: number) => order.slice(next, (next += n)).map((i) => `doc-${i}`);
  const stats = { poolOnMain: [] as number[], resultsOnMain: [] as number[] };
  const worker = { blockedMs: [] as number[], waitMs: [] as number[] };
  for (let run = 0; run < runs; run++) {
    evict();
    let t = performance.now();
    readSearchResultLinks(main, take(pool));
    stats.poolOnMain.push(performance.now() - t);
    evict();
    t = performance.now();
    readSearchResultLinks(main, take(limit));
    stats.resultsOnMain.push(performance.now() - t);
    const ids = take(limit);
    evict();
    const timed = await withTimer(() => gate.searchResultLinks(ids));
    worker.blockedMs.push(timed.gapMs);
    worker.waitMs.push(timed.ms);
    const direct = readSearchResultLinks(main, ids);
    if (JSON.stringify(timed.value) !== JSON.stringify(direct))
      throw new Error("the worker and the main handle disagree");
  }
  await scheduler.dispose();
  main.close();
  console.log(
    JSON.stringify({
      documents,
      runs,
      pool,
      limit,
      cold,
      poolOnMain: { blockedMs: summary(stats.poolOnMain), waitMs: summary(stats.poolOnMain) },
      resultsOnMain: {
        blockedMs: summary(stats.resultsOnMain),
        waitMs: summary(stats.resultsOnMain),
      },
      resultsOnWorker: { blockedMs: summary(worker.blockedMs), waitMs: summary(worker.waitMs) },
    }),
  );
}

if (mode === "build") build();
else await measure();
// The io runner's worker can keep the process alive after its scheduler is
// disposed; the measurement is printed, so end here.
process.exit(0);
