#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/**
 * Reproducible invented, file-backed encrypted accounting comparison. Admit via
 * the host's `other` queue, e.g. node --import tsx scripts/bench-storage-accounting.mjs
 * --rows 1000000 --body-bytes 256 --large-every 4096 --large-bytes 1048576 --runs 5.
 * Both phases use identical files/cache budgets, no cache dropping. Parent
 * performs an independent indexed read + tiny WAL write every 25 ms. Baseline
 * is the previous GROUP BY dbstat/CAST implementation in a background worker;
 * after uses the production bounded logical reads and paced physical scanner.
 * This isolates SQL/scan costs; production scheduler IPC overhead is excluded.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { openEncryptedSqlite } from "../packages/gateway/src/sqlite-encryption.ts";
import { measureStorageAccounting } from "../packages/gateway/src/storage/accounting.ts";
import { measureIndexStorageAccounting } from "../packages/gateway/src/storage/index-accounting.ts";
import { STORAGE_READS, STORAGE_INDEX_READS } from "../packages/gateway/src/storage/reads.ts";
import { directReadPort } from "../packages/gateway/src/scheduler/read-port.ts";
import { scanStorageAllocation } from "../packages/gateway/src/storage/physical-accounting.ts";
import { deprioritizeBackgroundWorker } from "../packages/gateway/src/workers/worker-priority.ts";
const fixedNow = () => new Date("2032-01-01T00:00:00Z");
const key = Buffer.alloc(32, 23);
function open(path, readonly = false) {
  const db = openEncryptedSqlite(path, {
    key,
    readonly,
    fileMustExist: readonly,
    migratePlaintext: false,
  });
  db.pragma("cache_size=-8192");
  db.pragma("mmap_size=0");
  return db;
}
function sum(rows, name) {
  return rows.reduce((n, r) => n + r[name], 0);
}
function fingerprint(logical, index, mainTables, indexTables) {
  return {
    documents: sum(logical.sources, "documents"),
    payloadBytes: sum(logical.sources, "payloadBytes"),
    chunks: sum(index.sources, "chunkCount"),
    indexTextBytes: sum(index.sources, "textBytes"),
    embeddingBytes: index.embeddingBytes,
    sourceMonths: logical.sources.flatMap((source) =>
      source.months.map((month) => ({
        sourceId: source.sourceId,
        month: month.month,
        documents: month.documents,
        payloadBytes: month.payloadBytes,
        trimmableDocuments: month.trimmableDocuments,
      })),
    ),
    indexSourceMonths: index.sources,
    mainTables,
    indexTables,
  };
}
if (!isMainThread) {
  deprioritizeBackgroundWorker(10, "accounting-benchmark");
  const { mainPath, indexPath, phase } = workerData;
  const main = open(mainPath, true),
    index = open(indexPath, true);
  // Match the main IO reader; the indexer uses SQLite's default temp storage.
  main.pragma("temp_store=MEMORY");
  const start = performance.now();
  const cpu = process.threadCpuUsage();
  let result;
  try {
    if (phase === "before") {
      const mainTables = main
        .prepare("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name")
        .all();
      const sourceMonths = new Map();
      const indexSourceMonths = new Map();
      const bySourceMonth = (a, b) =>
        a.sourceId.localeCompare(b.sourceId) || a.month.localeCompare(b.month);
      let after = 0,
        upper = main.prepare("SELECT MAX(rowid) AS n FROM documents").get().n,
        documents = 0,
        payloadBytes = 0;
      const page =
        main.prepare(`SELECT rowid,source_id AS sourceId,length(CAST(content AS BLOB))+length(CAST(title AS BLOB))+length(CAST(metadata AS BLOB)) AS bytes,
    COALESCE(strftime('%Y-%m',source_created_at),'unknown') AS month,
    CASE WHEN COALESCE(json_extract(metadata,'$.documentType'),'')<>'contact' AND (source_created_at=strftime('%Y-%m-%dT%H:%M:%fZ',source_created_at) OR source_created_at=strftime('%Y-%m-%dT%H:%M:%SZ',source_created_at)) THEN 1 ELSE 0 END AS trimmable
    FROM documents WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 500`);
      while (after < upper) {
        const rows = page.all(after, upper);
        if (!rows.length) break;
        documents += rows.length;
        payloadBytes += sum(rows, "bytes");
        for (const row of rows) {
          const key = JSON.stringify([row.sourceId, row.month]);
          const group = sourceMonths.get(key) ?? {
            sourceId: row.sourceId,
            month: row.month,
            documents: 0,
            payloadBytes: 0,
            trimmableDocuments: 0,
          };
          group.documents++;
          group.payloadBytes += row.bytes;
          group.trimmableDocuments += row.trimmable;
          sourceMonths.set(key, group);
        }
        after = rows.at(-1).rowid;
      }
      const indexTables = index
        .prepare("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name")
        .all();
      const indexPage = index.prepare(
        `SELECT rowid,source_id AS sourceId,COALESCE(strftime('%Y-%m',source_created_at),'unknown') AS month,length(CAST(content AS BLOB))+length(CAST(title AS BLOB)) AS textBytes,COALESCE(length(embedding),0) AS embeddingBytes FROM chunks WHERE rowid>? ORDER BY rowid LIMIT 1000`,
      );
      after = 0;
      upper = index.prepare("SELECT MAX(rowid) AS n FROM chunks").get().n;
      let chunks = 0,
        textBytes = 0,
        embeddingBytes = 0;
      while (after < upper) {
        const rows = indexPage.all(after);
        if (!rows.length) break;
        chunks += rows.length;
        textBytes += sum(rows, "textBytes");
        embeddingBytes += sum(rows, "embeddingBytes");
        for (const row of rows) {
          const key = JSON.stringify([row.sourceId, row.month]);
          const group = indexSourceMonths.get(key) ?? {
            sourceId: row.sourceId,
            month: row.month,
            chunkCount: 0,
            textBytes: 0,
            embeddingBytes: 0,
          };
          group.chunkCount++;
          group.textBytes += row.textBytes;
          group.embeddingBytes += row.embeddingBytes;
          indexSourceMonths.set(key, group);
        }
        after = rows.at(-1).rowid;
      }
      result = {
        documents,
        payloadBytes,
        chunks,
        indexTextBytes: textBytes,
        embeddingBytes,
        sourceMonths: [...sourceMonths.values()].sort(bySourceMonth),
        indexSourceMonths: [...indexSourceMonths.values()].sort(bySourceMonth),
        mainTables,
        indexTables,
      };
      // Both inventories were withheld until the coupled aggregate completed.
      const available = performance.now() - start;
      parentPort.postMessage({ phase: "logical", at: available });
      parentPort.postMessage({ phase: "index", at: available });
    } else {
      const [logical, idx] = await Promise.all([
        measureStorageAccounting(directReadPort(STORAGE_READS, main), fixedNow).then((logical) => {
          parentPort.postMessage({ phase: "logical", at: performance.now() - start });
          return logical;
        }),
        measureIndexStorageAccounting(directReadPort(STORAGE_INDEX_READS, index), fixedNow).then(
          (index) => {
            parentPort.postMessage({ phase: "index", at: performance.now() - start });
            return index;
          },
        ),
      ]);
      const mainAllocation = await scanStorageAllocation(
        { path: mainPath, keyHex: key.toString("hex") },
        {},
        () => false,
        () => {},
      );
      const indexAllocation = await scanStorageAllocation(
        { path: indexPath, keyHex: key.toString("hex") },
        {},
        () => false,
        () => {},
      );
      if (mainAllocation.state !== "ready" || indexAllocation.state !== "ready")
        throw Error("Benchmark allocation did not finish");
      result = fingerprint(logical, idx, mainAllocation.tables, indexAllocation.tables);
    }
    const used = process.threadCpuUsage(cpu);
    parentPort.postMessage({
      phase: "done",
      durationMs: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      rssBytes: process.memoryUsage().rss,
      result,
    });
  } finally {
    main.close();
    index.close();
    parentPort.close();
  }
} else {
  const args = process.argv.slice(2);
  const number = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : Number(args[i + 1]);
  };
  const rows = number("--rows", 50000),
    bodyBytes = number("--body-bytes", 8192),
    largeEvery = number("--large-every", 4096),
    largeBytes = number("--large-bytes", 1048576),
    runs = number("--runs", 5);
  if (
    [rows, bodyBytes, largeEvery, largeBytes, runs].some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw Error("Benchmark sizes must be positive integers");
  const root = mkdtempSync(join(tmpdir(), "omnesis-accounting-bench-"));
  const mainPath = join(root, "main.db"),
    indexPath = join(root, "index.db");
  let main, index;
  try {
    main = open(mainPath);
    index = open(indexPath);
    main.pragma("journal_mode=WAL");
    index.pragma("journal_mode=WAL");
    main.exec(
      "CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,metadata TEXT,source_created_at TEXT); CREATE TABLE probe_state(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO probe_state VALUES(1,0)",
    );
    index.exec(
      "CREATE TABLE chunks(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,embedding BLOB,source_created_at TEXT); CREATE VIRTUAL TABLE chunks_fts USING fts5(content)",
    );
    for (let i = 0; i < 4; i++) main.prepare("INSERT INTO sources VALUES(?)").run("invented:" + i);
    const small = "x".repeat(bodyBytes),
      large = "y".repeat(largeBytes);
    const doc = main.prepare(
      "INSERT INTO documents(rowid,id,source_id,title,content,metadata,source_created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const chunk = index.prepare(
      "INSERT INTO chunks(rowid,id,source_id,title,content,embedding,source_created_at) VALUES(?,?,?,?,?,zeroblob(512),?)",
    );
    const start = performance.now();
    for (let offset = 0; offset < rows; offset += 1000) {
      main.transaction(() => {
        for (let i = offset; i < Math.min(rows, offset + 1000); i++)
          doc.run(
            i * 3 + 1,
            "doc" + i,
            "invented:" + (i % 4),
            "Invented café",
            i % largeEvery === 0 ? large : small,
            "{}",
            "2031-" + String((i % 12) + 1).padStart(2, "0") + "-01T00:00:00Z",
          );
      })();
      index.transaction(() => {
        for (let i = offset; i < Math.min(rows, offset + 1000); i++)
          chunk.run(
            i * 3 + 1,
            "chunk" + i,
            "invented:" + (i % 4),
            "Entry",
            "Invented café " + i,
            "2031-01-01T00:00:00Z",
          );
      })();
    }
    index.exec("INSERT INTO chunks_fts VALUES('invented lexical allocation fixture')");
    main.pragma("wal_checkpoint(TRUNCATE)");
    index.pragma("wal_checkpoint(TRUNCATE)");
    console.log(
      JSON.stringify({
        fixture: {
          documents: main.prepare("SELECT COUNT(*) AS n FROM documents").get().n,
          chunks: index.prepare("SELECT COUNT(*) AS n FROM chunks").get().n,
          sparseRowidUpperBound: main.prepare("SELECT MAX(rowid) AS n FROM documents").get().n,
          bodyBytes,
          largeEvery,
          largeBytes,
          runs,
          mainBytes: statSync(mainPath).size,
          indexBytes: statSync(indexPath).size,
          encrypted: true,
          setupMs: performance.now() - start,
        },
      }),
    );
    const summaries = { before: [], after: [] };
    let expected;
    for (let run = 0; run < runs; run++)
      for (const phase of run % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
        const timings = [];
        const readTimings = [];
        const writeTimings = [];
        let maxWalBytes = 0,
          logicalMs = null,
          indexMs = null,
          probeWrites = 0;
        const delay = monitorEventLoopDelay({ resolution: 10 });
        delay.enable();
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { mainPath, indexPath, phase },
        });
        const probe = setInterval(() => {
          const t = performance.now();
          main.prepare("SELECT source_id FROM documents WHERE rowid=1").get();
          const readDone = performance.now();
          main.prepare("UPDATE probe_state SET value=value+1 WHERE id=1").run();
          const writeDone = performance.now();
          readTimings.push(readDone - t);
          writeTimings.push(writeDone - readDone);
          probeWrites++;
          timings.push(writeDone - t);
          try {
            maxWalBytes = Math.max(maxWalBytes, statSync(mainPath + "-wal").size);
          } catch {
            // SQLite may remove a checkpointed WAL before the size probe.
          }
        }, 25);
        let output;
        let exited = false;
        try {
          output = await new Promise((resolve, reject) => {
            let completed;
            worker.on("error", reject);
            worker.on("message", (message) => {
              if (message.phase === "logical") logicalMs = message.at;
              if (message.phase === "index") indexMs = message.at;
              if (message.phase === "done") completed = message;
            });
            worker.on("exit", (code) => {
              exited = true;
              if (code !== 0) reject(Error("Benchmark worker failed"));
              else if (!completed) reject(Error("Benchmark worker exited without a result"));
              else resolve(completed);
            });
          });
        } finally {
          clearInterval(probe);
          delay.disable();
          // A successful sample owns its handles until natural worker exit.
          if (!exited) await worker.terminate();
        }
        if (!expected) {
          expected = JSON.stringify(output.result);
          console.log(JSON.stringify({ exactParityBaseline: output.result }));
        } else if (expected !== JSON.stringify(output.result))
          throw Error("Accounting parity mismatch");
        for (const series of [timings, readTimings, writeTimings]) series.sort((a, b) => a - b);
        const percentile = (series, quantile) =>
          series[Math.min(series.length - 1, Math.floor(series.length * quantile))] ?? 0;
        const record = {
          run: run + 1,
          durationMs: output.durationMs,
          logicalMs,
          indexMs,
          cpuMs: output.cpuMs,
          rssBytes: output.rssBytes,
          probeP50Ms: timings[Math.floor(timings.length * 0.5)] ?? 0,
          probeP95Ms: timings[Math.floor(timings.length * 0.95)] ?? 0,
          probeWorstMs: timings.at(-1) ?? 0,
          probeReadP50Ms: percentile(readTimings, 0.5),
          probeReadP95Ms: percentile(readTimings, 0.95),
          probeReadWorstMs: percentile(readTimings, 1),
          probeWriteP50Ms: percentile(writeTimings, 0.5),
          probeWriteP95Ms: percentile(writeTimings, 0.95),
          probeWriteWorstMs: percentile(writeTimings, 1),
          eventLoopWorstMs: delay.max / 1e6,
          maxWalBytes,
          probeWrites,
        };
        summaries[phase].push(record);
        console.log(JSON.stringify({ phase, ...record }));
        main.pragma("wal_checkpoint(TRUNCATE)");
      }
    for (const [phase, records] of Object.entries(summaries)) {
      const metrics = {};
      for (const field of [
        "durationMs",
        "logicalMs",
        "indexMs",
        "cpuMs",
        "probeP50Ms",
        "probeP95Ms",
        "probeReadP50Ms",
        "probeReadP95Ms",
        "probeReadWorstMs",
        "probeWriteP50Ms",
        "probeWriteP95Ms",
        "probeWriteWorstMs",
        "probeWorstMs",
        "eventLoopWorstMs",
        "rssBytes",
        "maxWalBytes",
      ]) {
        const values = records.map((r) => r[field]).sort((a, b) => a - b);
        metrics[field] = { median: values[Math.floor(values.length / 2)], worst: values.at(-1) };
      }
      console.log(JSON.stringify({ summary: phase, metrics }));
    }
  } finally {
    main?.close();
    index?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
