// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Mixed public-passage operational benchmark. All stores and keys are throwaway. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createIndexDatabase, openIndexDb } from "../../../packages/gateway/src/indexer/db.js";
import { bm25Search } from "../../../packages/gateway/src/search/bm25.js";
import { LexicalIndex } from "../../../packages/gateway/src/search/lexical-index.js";
import { lexicalIndexBytes } from "../../../packages/gateway/src/search/lexical-index-data.js";
import { installPrototype, openPrototype, putChunk } from "./store.mjs";
import { buildMemory, compileQuery, searchCompiled } from "./query.mjs";
import { jsonlRecords } from "./jsonl.mjs";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    queries: { type: "string" },
    extension: { type: "string" },
    output: { type: "string" },
    counts: { type: "string", default: "10000,100000" },
    child: { type: "string" },
    count: { type: "string" },
    reopen: { type: "boolean", default: false },
    repeats: { type: "string", default: "7" },
  },
});
const script = fileURLToPath(import.meta.url);
const percentile = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)];
const timing = (xs) => ({
  samples: xs.length,
  medianMs: percentile(xs, 0.5),
  p95Ms: percentile(xs, 0.95),
  p99Ms: percentile(xs, 0.99),
});
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ids = (answer) => answer.candidates.map((c) => c.documentId);

async function child(args, input) {
  return await new Promise((resolveChild, reject) => {
    const processChild = spawn(process.execPath, [...process.execArgv, script, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    processChild.stdout.setEncoding("utf8");
    processChild.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) processChild.kill("SIGTERM");
    });
    processChild.on("error", reject);
    processChild.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`Benchmark child failed (${code})`));
      try {
        resolveChild(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(error);
      }
    });
    processChild.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

function execute(db, method, query, path, memory, options = {}) {
  if (method === "current")
    return bm25Search(db, query.text, {}, 20, {
      ...options,
      ...(path === "memory" ? { ranker: memory } : {}),
    });
  return searchCompiled(db, compileQuery(db, query.text, query.language), {
    ...options,
    ...(path === "memory" ? { memory } : {}),
  });
}

async function reopen() {
  let text = "";
  for await (const part of process.stdin) text += part;
  const input = JSON.parse(text),
    key = Buffer.from(input.key, "hex");
  let db;
  try {
    const started = performance.now();
    db =
      input.method === "current"
        ? openIndexDb(input.path, { encryptionKey: key, readonly: true })
        : openPrototype(input.path, input.extension, { encryptionKey: key, readonly: true });
    const openMs = performance.now() - started;
    const queryStarted = performance.now();
    const answer = execute(db, input.method, input.query, "fts", undefined);
    const result = {
      openMs,
      firstQueryMs: performance.now() - queryStarted,
      resultCount: answer.candidates.length,
      rssBytes: process.memoryUsage().rss,
      queryLanguage: input.query.language,
      qualification: "Fresh process; OS file cache is not forcibly cleared.",
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    db?.close();
    key.fill(0);
  }
}

async function trial() {
  const method = values.child,
    count = Number(values.count),
    repeats = Number(values.repeats);
  if (!["current", "combined-stem", "combined-exact"].includes(method))
    throw new Error("Invalid trial method");
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1000000 ||
    !Number.isSafeInteger(repeats) ||
    repeats < 1 ||
    repeats > 30
  )
    throw new Error("Invalid trial bound");
  const documents = [];
  for await (const record of jsonlRecords(createReadStream(values.corpus))) {
    documents.push(record);
    if (documents.length >= count) break;
  }
  assert.equal(documents.length, count, "Prepared corpus must contain requested document count");
  const present = new Set(documents.map((d) => d.id));
  const queries = JSON.parse(readFileSync(values.queries, "utf8")).filter((q) =>
    q.positiveIds.some((id) => present.has(id)),
  );
  assert(queries.length > 0, "Workload must have successful-query opportunities");
  const directory = mkdtempSync(join(tmpdir(), "omnesis-lexical-scale-"));
  const path = join(directory, "index.db"),
    key = randomBytes(32);
  const profiles = { inputLoaded: process.memoryUsage() };
  let db;
  try {
    let started = performance.now();
    db = createIndexDatabase(path, { encryptionKey: key });
    const setupMs = performance.now() - started;
    started = performance.now();
    if (method === "current")
      db.exec("ALTER TABLE chunks ADD COLUMN research_language TEXT NOT NULL DEFAULT 'und'");
    else installPrototype(db, values.extension, method === "combined-exact" ? "exact" : "stem");
    const extensionAndSchemaMs = performance.now() - started;
    profiles.afterRegistration = process.memoryUsage();
    const insert =
      db.prepare(`INSERT INTO chunks(id,document_id,chunk_index,content,title,source_id,document_type,source_created_at,embedding,research_language)
      VALUES(?,?,0,?,?,'synthetic-public-probe','note','2026-01-01T00:00:00Z',NULL,?)`);
    const batchTimes = [];
    const write = db.transaction((rows) => {
      for (const row of rows) insert.run(row.id, row.id, row.text, row.title ?? "", row.language);
    });
    started = performance.now();
    for (let offset = 0; offset < documents.length; offset += 100) {
      const before = performance.now();
      write.immediate(documents.slice(offset, offset + 100));
      batchTimes.push(performance.now() - before);
    }
    const indexMs = performance.now() - started;
    profiles.afterIndex = process.memoryUsage();
    started = performance.now();
    let memory = method === "current" ? LexicalIndex.build(db) : buildMemory(db);
    const memoryBuildMs = performance.now() - started;
    profiles.afterMemoryBuild = process.memoryUsage();
    const data = method === "current" ? memory.data : memory.index.data;
    const rows = [],
      byPath = { fts: [], memory: [] };
    let parityFailures = 0,
      fallbacks = 0;
    for (const query of queries) {
      execute(db, method, query, "fts", memory);
      execute(db, method, query, "memory", memory);
      const samples = { fts: [], memory: [] };
      let sql, mem;
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const requested of repeat % 2 ? ["memory", "fts"] : ["fts", "memory"]) {
          const before = performance.now(),
            answer = execute(db, method, query, requested, memory);
          samples[requested].push(performance.now() - before);
          if (requested === "fts") sql = answer;
          else mem = answer;
        }
      }
      const same = JSON.stringify(ids(sql)) === JSON.stringify(ids(mem));
      parityFailures += !same;
      const actualPath = method === "current" ? mem.ranker : mem.path;
      fallbacks += actualPath !== "memory";
      rows.push({
        queryId: query.id,
        language: query.language,
        sameOrderedCandidates: same,
        resultCount: sql.candidates.length,
        knownPositiveInTop20: ids(sql).some((id) => query.positiveIds.includes(id)),
        requestedMemoryActualPath: actualPath,
        fts: timing(samples.fts),
        memory: timing(samples.memory),
      });
      byPath.fts.push(...samples.fts);
      byPath.memory.push(...samples.memory);
    }
    assert.equal(parityFailures, 0, "Fresh memory cache must agree with SQLite candidate order");
    const restricted = [];
    for (const query of queries.filter((q) => ["ko", "en", "zh", "fr"].includes(q.language))) {
      const allowed = query.positiveIds.filter((id) => present.has(id)).slice(0, 1);
      const before = performance.now();
      const answer = execute(db, method, query, "memory", memory, {
        documentIds: allowed,
        limit: 1,
      });
      assert(answer.candidates.every((c) => allowed.includes(c.documentId)));
      restricted.push({
        queryId: query.id,
        allowedDocuments: allowed.length,
        resultCount: answer.candidates.length,
        milliseconds: performance.now() - before,
      });
    }
    const updateTimes = [];
    for (const record of documents.slice(0, 100)) {
      const before = performance.now();
      putChunk(db, {
        id: record.id,
        language: record.language,
        title: record.title,
        content: record.text + " operationmarker",
      });
      updateTimes.push(performance.now() - before);
    }
    const followStarted = performance.now();
    let deltaOrderDifferences = 0;
    for (const query of queries.slice(0, 8)) {
      const sql = execute(db, method, query, "fts", memory),
        mem = execute(db, method, query, "memory", memory);
      deltaOrderDifferences += JSON.stringify(ids(sql)) !== JSON.stringify(ids(mem));
    }
    const followAndQueryMs = performance.now() - followStarted;
    db.exec(
      "CREATE VIRTUAL TABLE temp.scale_instances USING fts5vocab(main,chunks_fts,'instance')",
    );
    const tokenInstances = db.prepare("SELECT count(*) AS n FROM temp.scale_instances").get().n;
    db.pragma("wal_checkpoint(TRUNCATE)");
    const storeBytes = readdirSync(directory).reduce(
      (sum, name) => sum + statSync(join(directory, name)).size,
      0,
    );
    const coldQuery = queries.find((q) => q.language === "ko") ?? queries[0];
    const freshReopen = await child(["--reopen"], {
      path,
      extension: values.extension,
      method,
      key: key.toString("hex"),
      query: coldQuery,
    });
    profiles.afterQueriesAndUpdates = process.memoryUsage();
    const report = {
      method,
      count,
      queries: rows.length,
      repeats,
      setupMs,
      extensionAndSchemaMs,
      indexMs,
      indexDocumentsPerSecond: (count * 1000) / indexMs,
      writerBatch100: timing(batchTimes),
      memoryBuildMs,
      fts: timing(byPath.fts),
      memory: timing(byPath.memory),
      fallbackQueries: fallbacks,
      parityFailures,
      queryResults: rows,
      restrictiveDocumentQueries: restricted,
      updateOneDocument: timing(updateTimes),
      followAndEightQueriesMs: followAndQueryMs,
      deltaOrderDifferences,
      tokenInstances,
      lexicalArrayBytes: lexicalIndexBytes(data),
      storeBytes,
      rawInputUTF8Bytes: documents.reduce(
        (sum, d) => sum + Buffer.byteLength(d.text) + Buffer.byteLength(d.title ?? ""),
        0,
      ),
      memoryProfiles: profiles,
      peakRSSKiB: process.resourceUsage().maxRSS,
      freshReopen,
      sqlite: db.prepare("SELECT sqlite_version() AS v").get().v,
      qualifications: [
        "Index timing includes first dictionary use, identical prepared inserts and bounded100-row commits.",
        "Warm query aggregates mix different candidate counts; inspect per-query hits and fallback. No latency-superiority claim.",
        "RSS includes Node, loaded raw inputs, native dictionaries, SQLite caches, arrays and scratch space; it is not dictionary-only RAM.",
        "Delta ranking uses production approximate statistics until the next cache build; ordering differences are reported.",
        "Fresh reopen uses a new process, but the OS file cache is uncontrolled.",
      ],
    };
    writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({ method, count, status: "passed", parityFailures }) + "\n",
    );
  } finally {
    db?.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  for (const name of ["corpus", "queries", "extension", "output"])
    if (!values[name]) throw new Error(`--${name} is required`);
  const counts = values.counts.split(",").map(Number);
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 1000 || n > 1000000))
    throw new Error("Invalid corpus size");
  const scratch = mkdtempSync(join(tmpdir(), "omnesis-lexical-scale-reports-"));
  const methods = ["current", "combined-stem", "combined-exact"],
    trials = [];
  try {
    for (let i = 0; i < counts.length; i++) {
      for (const method of i % 2 ? [...methods].reverse() : methods) {
        const output = join(scratch, `${method}-${counts[i]}.json`);
        await child([
          "--child",
          method,
          "--count",
          String(counts[i]),
          "--corpus",
          resolve(values.corpus),
          "--queries",
          resolve(values.queries),
          "--extension",
          resolve(values.extension),
          "--output",
          output,
          "--repeats",
          values.repeats,
        ]);
        trials.push(JSON.parse(readFileSync(output, "utf8")));
        writeFileSync(values.output, JSON.stringify({ complete: false, trials }, null, 2) + "\n");
        process.stdout.write(`Completed ${method} at ${counts[i]} documents\n`);
      }
    }
    const report = {
      complete: true,
      corpusSHA256: digest(values.corpus),
      queriesSHA256: digest(values.queries),
      node: process.version,
      trials,
      scope:
        "Lexical-only mixed public-passage operational workload; no production services or private stores.",
    };
    writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (values.reopen) await reopen();
else if (values.child) await trial();
else await main();
