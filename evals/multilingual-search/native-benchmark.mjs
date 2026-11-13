// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Small repeated-corpus diagnostic, not a representative production benchmark. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createIndexDatabase,
  openIndexDb,
  upsertChunks,
} from "../../packages/gateway/src/indexer/db.js";
import { bm25Search } from "../../packages/gateway/src/search/bm25.js";
import { LexicalIndex } from "../../packages/gateway/src/search/lexical-index.js";
import { lexicalIndexBytes } from "../../packages/gateway/src/search/lexical-index-data.js";

const [extensionArgument, outputArgument, countArgument = "10000"] = process.argv.slice(2);
if (!extensionArgument || !outputArgument || !/^\d+$/.test(countArgument)) {
  throw new Error("Usage: node --import tsx native-benchmark.mjs EXTENSION OUTPUT [COUNT=10000]");
}
const extension = resolve(extensionArgument);
const output = resolve(outputArgument);
const count = Number(countArgument);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) {
  throw new Error("COUNT must be an integer between 1 and 1000000");
}
const rawCases = readFileSync(new URL("./cases.json", import.meta.url));
const fixtures = JSON.parse(rawCases.toString("utf8"));
const corpus = fixtures.flatMap((fixture) => [...fixture.positive, ...fixture.negative]);
const preferredLanguages = [
  "ko",
  "zh",
  "ja",
  "th",
  "fr",
  "es",
  "de",
  "ru",
  "tr",
  "fi",
  "ar",
  "he",
  "el",
  "pt",
  "it",
  "hi",
  "fa",
  "vi",
  "en",
  "km",
];
const queries = preferredLanguages
  .map((language) => fixtures.find((fixture) => fixture.language === language))
  .filter(Boolean);
assert.equal(queries.length, 20, "The benchmark requires twenty language-stratified queries");
const repeats = 9;

function chunk(id, content) {
  return {
    id: `synthetic-chunk-${id}`,
    documentId: `synthetic-document-${id}`,
    chunkIndex: 0,
    content,
    embedding: null,
    sourceId: "synthetic-notes",
    documentType: "note",
    title: "",
    sourceCreatedAt: "2026-01-01T00:00:00Z",
  };
}

function installTokenizer(db, method) {
  if (method !== "native-charabia") return;
  db.loadExtension(extension);
  db.exec(`DROP TABLE chunks_fts;
    CREATE VIRTUAL TABLE chunks_fts USING fts5(content,title,
      content='chunks',content_rowid='rowid',tokenize='charabia');`);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function timing(values) {
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function storeBytes(directory) {
  return Object.fromEntries(
    readdirSync(directory).map((name) => [name, statSync(join(directory, name)).size]),
  );
}

function benchmarkMethod(directory, method) {
  mkdirSync(directory);
  const path = join(directory, "index.db");
  let started = performance.now();
  const db = createIndexDatabase(path);
  try {
    installTokenizer(db, method);
    db.pragma("temp_store = MEMORY");
    const setupMs = performance.now() - started;
    // Warm dictionaries separately, using every base text before indexing starts.
    started = performance.now();
    const tokenizer =
      method === "native-charabia" ? "charabia" : "porter unicode61 remove_diacritics 2";
    db.exec(
      `CREATE VIRTUAL TABLE temp.benchmark_warm USING fts5(content, tokenize='${tokenizer}')`,
    );
    const insertWarm = db.prepare("INSERT INTO temp.benchmark_warm(content) VALUES (?)");
    for (const text of [...corpus, ...queries.map((fixture) => fixture.query)])
      insertWarm.run(text);
    db.exec("DROP TABLE temp.benchmark_warm");
    const dictionaryWarmMs = performance.now() - started;

    const chunks = Array.from({ length: count }, (_, index) =>
      chunk(index, `${corpus[index % corpus.length]} ${String(index).padStart(8, "0")}`),
    );
    started = performance.now();
    for (let offset = 0; offset < chunks.length; offset += 250)
      upsertChunks(db, chunks.slice(offset, offset + 250));
    const indexMs = performance.now() - started;
    db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check',1)");
    db.pragma("wal_checkpoint(TRUNCATE)");

    started = performance.now();
    const ranker = LexicalIndex.build(db);
    const rankerBuildMs = performance.now() - started;
    const queryResults = [];
    const totals = { nullCalls: 0, resultCalls: 0, emptyCalls: 0 };
    const ftsTimes = [];
    const memoryTimes = [];
    for (const fixture of queries) {
      // Warm query SQL/token caches independently of the measured calls.
      for (let iteration = 0; iteration < 2; iteration++) {
        bm25Search(db, fixture.query, {}, 20);
        bm25Search(db, fixture.query, {}, 20, { ranker });
      }
      const observed = {
        rank(...args) {
          const rows = ranker.rank(...args);
          if (rows === null) totals.nullCalls++;
          else if (rows.length) totals.resultCalls++;
          else totals.emptyCalls++;
          return rows;
        },
        stats: (...args) => ranker.stats(...args),
      };
      const ftsSamples = [];
      const memorySamples = [];
      let ftsAnswer;
      let memoryAnswer;
      const previousNullCalls = totals.nullCalls;
      for (let iteration = 0; iteration < repeats; iteration++) {
        // Alternate order to avoid consistently favoring the second path's cache.
        for (const mode of iteration % 2 ? ["memory", "fts"] : ["fts", "memory"]) {
          started = performance.now();
          const answer = bm25Search(
            db,
            fixture.query,
            {},
            20,
            mode === "memory" ? { ranker: observed } : undefined,
          );
          const elapsed = performance.now() - started;
          if (mode === "memory") {
            memorySamples.push(elapsed);
            memoryAnswer = answer;
          } else {
            ftsSamples.push(elapsed);
            ftsAnswer = answer;
          }
        }
      }
      ftsTimes.push(...ftsSamples);
      memoryTimes.push(...memorySamples);
      const ids = (answer) => answer.candidates.map((candidate) => candidate.chunkRowid);
      queryResults.push({
        id: fixture.id,
        language: fixture.language,
        query: fixture.query,
        fts: timing(ftsSamples),
        memory: timing(memorySamples),
        ftsResultCount: ftsAnswer.candidates.length,
        memoryResultCount: memoryAnswer.candidates.length,
        actualMemoryAnswerRanker: memoryAnswer.ranker,
        nullRankCalls: totals.nullCalls - previousNullCalls,
        sameOrderedCandidates: JSON.stringify(ids(ftsAnswer)) === JSON.stringify(ids(memoryAnswer)),
      });
    }
    db.exec(
      "CREATE VIRTUAL TABLE temp.benchmark_instances USING fts5vocab(main,chunks_fts,'instance')",
    );
    const tokenInstances = db.prepare("SELECT count(*) AS n FROM temp.benchmark_instances").get().n;
    const pageCount = db.pragma("page_count", { simple: true });
    const pageSize = db.pragma("page_size", { simple: true });
    const files = storeBytes(directory);
    return {
      method,
      count,
      setupMs,
      dictionaryWarmMs,
      indexMs,
      indexChunksPerSecond: (count * 1000) / indexMs,
      rankerBuildMs,
      ftsTokenInstances: tokenInstances,
      lexicalIndexArrayBytes: lexicalIndexBytes(ranker.data),
      pageCount,
      pageSize,
      pageBytes: pageCount * pageSize,
      files,
      totalStoreBytes: Object.values(files).reduce((sum, bytes) => sum + bytes, 0),
      sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
      fts: timing(ftsTimes),
      memory: timing(memoryTimes),
      rankCalls: totals,
      queriesReturningFtsResults: queryResults.filter((row) => row.ftsResultCount > 0).length,
      queriesWithFallback: queryResults.filter((row) => row.nullRankCalls > 0).length,
      parityFailures: queryResults.filter((row) => !row.sameOrderedCandidates).length,
      queryResults,
    };
  } finally {
    db.close();
  }
}

function encryptedLifecycle(directory) {
  mkdirSync(directory);
  const path = join(directory, "index.db");
  const encryptionKey = randomBytes(32);
  let db;
  const passed = [];
  const rankerUses = [];
  try {
    db = createIndexDatabase(path, { encryptionKey });
    installTokenizer(db, "native-charabia");
    db.pragma("temp_store = MEMORY");
    upsertChunks(db, [chunk("encrypted", "우산을 문 옆에 두었습니다.")]);
    let ranker = LexicalIndex.build(db);
    const expected = (query, ids) => {
      for (const opts of [undefined, { ranker }]) {
        const answer = bm25Search(db, query, {}, 20, opts);
        assert.deepEqual(
          answer.candidates.map((candidate) => candidate.documentId),
          ids,
        );
        if (opts)
          rankerUses.push({ query, ranker: answer.ranker, resultCount: answer.candidates.length });
      }
    };
    expected("우산", ["synthetic-document-encrypted"]);
    passed.push("insert/search via FTS and memory ranker");
    assert.match(
      db
        .prepare(
          "SELECT highlight(chunks_fts,0,'[',']') AS text FROM chunks_fts WHERE chunks_fts MATCH ?",
        )
        .get("우산").text,
      /\[우산\]/u,
    );
    passed.push("highlight uses original Hangul byte offsets");
    upsertChunks(db, [chunk("encrypted", "모자를 서랍 안에 두었습니다.")]);
    expected("우산", []);
    expected("모자", ["synthetic-document-encrypted"]);
    passed.push("upsert updates index and existing ranker follows change log");
    assert.equal(
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run("synthetic-document-encrypted")
        .changes,
      1,
    );
    expected("모자", []);
    passed.push("delete trigger and existing ranker remove document");
    upsertChunks(db, [
      chunk("phrase", "A red kite flies."),
      chunk("nonphrase", "A red balloon and a kite fly."),
    ]);
    expected("red", ["synthetic-document-phrase", "synthetic-document-nonphrase"]);
    expected('"red kite"', ["synthetic-document-phrase"]);
    passed.push("phrase positions distinguish adjacent and nonadjacent terms");
    db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check',1)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = undefined;
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")), false);
    passed.push("encrypted database has no plaintext SQLite header");
    db = openIndexDb(path, { readonly: true, encryptionKey });
    db.loadExtension(extension);
    ranker = LexicalIndex.build(db);
    expected('"red kite"', ["synthetic-document-phrase"]);
    passed.push("keyed readonly reopen, extension registration and ranker rebuild");
    return {
      passed,
      checks: passed.length,
      rankerUses,
      sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
    };
  } finally {
    db?.close();
    encryptionKey.fill(0);
  }
}

const ownedTemporaryDirectory = mkdtempSync(join(tmpdir(), "omnesis-multilingual-benchmark-"));
try {
  const methods = ["current", "native-charabia"].map((method) =>
    benchmarkMethod(join(ownedTemporaryDirectory, method), method),
  );
  for (const method of methods) {
    assert.equal(method.parityFailures, 0, "SQLite and memory-ranked candidates must agree");
  }
  const encryption = encryptedLifecycle(join(ownedTemporaryDirectory, "encrypted"));
  const report = {
    fixtureSha256: createHash("sha256").update(rawCases).digest("hex"),
    node: process.version,
    icu: process.versions.icu,
    baseTexts: corpus.length,
    count,
    measuredRepeatsPerQueryPerPath: repeats,
    methods,
    encryption,
    limitations: [
      "Repeated short synthetic texts plus unique numeric markers; not a representative production corpus.",
      "Lexical-only indexing stores no embedding values; timing excludes chunk preparation and dictionary warming and includes real upsert triggers.",
      "Query latency is warm and uses the existing gateway query sanitizer, not a proposed improved multilingual query pipeline.",
      "Aggregate query timings mix successful and zero-hit lookups; use per-query result counts when comparing paths and methods.",
      "Memory-path latency includes SQLite fallback when the ranker declines; null/result/empty calls are reported separately.",
      "lexicalIndexArrayBytes excludes ranker scratch arrays, dictionaries, SQLite caches and other process memory.",
      "Fixed current-then-Charabia method order and one run; no claim of stable production throughput or cross-platform validation.",
      "Phrase and highlight checks cover a flat token stream, not every possible token graph or compound analysis.",
    ],
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ methods: methods.map(({ queryResults, ...summary }) => summary), encryption }, null, 2)}\n`,
  );
} finally {
  rmSync(ownedTemporaryDirectory, { recursive: true, force: true });
}
