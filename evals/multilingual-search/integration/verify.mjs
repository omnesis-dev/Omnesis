// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Real encrypted SQLite, shared memory scorer, locale and generation assertions. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  createIndexDatabase,
  enqueueDocumentIndexPurge,
} from "../../../packages/gateway/src/indexer/db.js";
import {
  installPrototype,
  putChunk,
  openPrototype,
  generation,
  beginGeneration,
  backfillGeneration,
  activateGeneration,
  discardPending,
  rollbackGeneration,
  retirePrevious,
} from "./store.mjs";
import {
  analyze,
  compileQuery,
  buildMemory,
  searchCompiled,
  COMPILED_QUERY_LOCALE,
} from "./query.mjs";

function ids(answer) {
  return answer.candidates.map((c) => c.documentId);
}
function integrity(db, name = "chunks_fts") {
  if (!["chunks_fts", "research_next_fts", "research_previous_fts"].includes(name))
    throw new Error("Invalid integrity target");
  db.exec(`INSERT INTO ${name}(${name},rank) VALUES('integrity-check',1)`);
}

async function run(extension, output) {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-lexical-integration-"));
  const key = randomBytes(32);
  const checks = [];
  const observations = {};
  const check = (name, fn) => {
    fn();
    checks.push(name);
    process.stdout.write(`PASS ${name}\n`);
  };
  let db;
  try {
    const path = join(directory, "main.db");
    db = createIndexDatabase(path, { encryptionKey: key });
    installPrototype(db, extension);
    const docs = [
      { id: "ko-positive", language: "ko", content: "파란고래우체통입니다" },
      { id: "ko-negative", language: "ko", content: "파란고래우체국입니다" },
      { id: "fr", language: "fr", content: "Les archives contiennent des recettes de cuisine." },
      { id: "zh", language: "zh", content: "我想查找邮箱的操作说明。" },
      { id: "ja", language: "ja", content: "図書館で新しい本を借りました。" },
      { id: "tr", language: "tr", content: "İstanbul toplantı kayıtları" },
      { id: "adjacent", language: "en", content: "quartz harbor" },
      { id: "separated", language: "en", content: "quartz distant harbor" },
      { id: "accent", language: "en", content: "A cafe\u0301 opened beside the observatory." },
      {
        id: "hidden",
        language: "en",
        content: "privatequartz harbor",
        sourceId: "synthetic-other",
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `background-${i}`,
        language: "en",
        content: `Observatory calendar entry number ${i}.`,
      })),
    ];
    db.transaction(() => {
      for (const doc of docs) putChunk(db, doc);
    }).immediate();
    let memory = buildMemory(db);
    check("language metadata travels through the supported FTS5 locale API", () => {
      for (const [query, language, expected] of [
        ["recette", "fr", "fr"],
        ["邮箱", "zh", "zh"],
        ["図書館", "ja", "ja"],
        ["istanbul", "tr", "tr"],
      ]) {
        const ir = compileQuery(db, query, language);
        for (const options of [{}, { memory }])
          assert(ids(searchCompiled(db, ir, options)).includes(expected));
      }
      observations.sqlite = db.prepare("SELECT sqlite_version() AS v").get().v;
      observations.analysisFingerprint = generation(db).active_fingerprint;
    });
    check(
      "Korean attached ending is found and ranked ahead of the shared-component negative",
      () => {
        const ir = compileQuery(db, "파란고래우체통", "ko");
        const sql = searchCompiled(db, ir),
          mem = searchCompiled(db, ir, { memory });
        assert.equal(ids(sql)[0], "ko-positive");
        assert.deepEqual(ids(mem), ids(sql));
        assert.equal(mem.path, "memory");
        observations.koreanCandidates = ids(sql);
      },
    );
    check("unquoted terms use the memory path; intentional quotes retain adjacency", () => {
      const terms = compileQuery(db, "quartz harbor", "en");
      assert(ids(searchCompiled(db, terms, { memory })).includes("separated"));
      const phrase = compileQuery(db, '"quartz harbor"', "en");
      const result = searchCompiled(db, phrase, { memory });
      assert.deepEqual(ids(result), ["adjacent"]);
      assert.equal(result.path, "fts5");
    });
    check("memory and SQLite scores agree on the same analyzed snapshot", () => {
      for (const [query, language] of [
        ["recette", "fr"],
        ["邮箱", "zh"],
        ["quartz harbor", "en"],
        ["파란고래우체통", "ko"],
      ]) {
        const ir = compileQuery(db, query, language);
        const sql = searchCompiled(db, ir),
          mem = searchCompiled(db, ir, { memory });
        assert.deepEqual(ids(mem), ids(sql));
        mem.candidates.forEach((row, i) =>
          assert(Math.abs(row.score - sql.candidates[i].score) < 1e-9),
        );
      }
    });
    check("compiled terms are passed through once, with no second stemming", () => {
      const candidates = [
        "generously",
        "relationally",
        "organization",
        "communism",
        "ugliness",
        "consolatory",
        "agreement",
        "early",
        "sensationally",
        "skies",
        "proceeding",
        "rationalization",
        "probate",
        "cease",
      ];
      const samples = candidates.map((word) => {
        const first = analyze(db, word, "en", "stem").tokens.map((t) => t.text);
        return {
          word,
          first,
          second: first.flatMap((term) =>
            analyze(db, term, "en", "stem").tokens.map((t) => t.text),
          ),
        };
      });
      observations.nonIdempotentStemCount = samples.filter(
        (s) => JSON.stringify(s.first) !== JSON.stringify(s.second),
      ).length;
      for (let i = 0; i < samples.length; i++) {
        putChunk(db, { id: `stem-${i}`, language: "en", content: candidates[i] });
      }
      memory = buildMemory(db);
      for (const word of candidates) {
        const ir = compileQuery(db, word, "en");
        assert.deepEqual(ids(searchCompiled(db, ir, { memory })), ids(searchCompiled(db, ir)));
      }
    });
    check("highlighting returns original UTF-8 Hangul text and combining marks", () => {
      const ir = compileQuery(db, '"파란고래우체통"', "ko");
      const row = db
        .prepare(
          "SELECT highlight(chunks_fts,0,'[',']') AS t FROM chunks_fts WHERE chunks_fts MATCH fts5_locale(?,?) ORDER BY rowid LIMIT 1",
        )
        .get(COMPILED_QUERY_LOCALE, ir.expression);
      assert.match(row.t, /\[/u);
      assert.equal(row.t.replaceAll("[", "").replaceAll("]", ""), "파란고래우체통입니다");
      const accent = compileQuery(db, "café", "en");
      const marked = db
        .prepare(
          "SELECT highlight(chunks_fts,0,'[',']') AS t FROM chunks_fts WHERE chunks_fts MATCH fts5_locale(?,?)",
        )
        .get(COMPILED_QUERY_LOCALE, accent.expression);
      assert.match(marked.t, /\[cafe\u0301\]/u);
    });
    check("updates, deletes and language-only changes reach an existing memory ranker", () => {
      putChunk(db, { id: "fr", language: "fr", content: "Les bateaux quittent le port." });
      assert(
        !ids(searchCompiled(db, compileQuery(db, "recette", "fr"), { memory })).includes("fr"),
      );
      assert(ids(searchCompiled(db, compileQuery(db, "bateau", "fr"), { memory })).includes("fr"));
      db.prepare("UPDATE chunks SET research_language='en' WHERE id='fr'").run();
      const changed = compileQuery(db, "bateau", "fr");
      assert.deepEqual(
        ids(searchCompiled(db, changed, { memory })),
        ids(searchCompiled(db, changed)),
      );
      db.prepare("DELETE FROM chunks WHERE id='fr'").run();
      assert(!ids(searchCompiled(db, changed, { memory })).includes("fr"));
      integrity(db);
    });
    check("metadata filters and document restrictions apply before result limits", () => {
      const ir = compileQuery(db, "quartz harbor", "en");
      for (const options of [{}, { memory }]) {
        assert.deepEqual(
          ids(searchCompiled(db, ir, { ...options, documentIds: ["separated"], limit: 1 })),
          ["separated"],
        );
        assert.deepEqual(
          ids(searchCompiled(db, ir, { ...options, documentIds: [], limit: 1 })),
          [],
        );
        const filtered = searchCompiled(db, compileQuery(db, "privatequartz", "en"), {
          ...options,
          filters: { sourceIds: ["synthetic-notes"] },
        });
        assert.deepEqual(ids(filtered), []);
      }
    });
    check("pending source deletions are invisible on both lexical paths", () => {
      enqueueDocumentIndexPurge(db, "hidden", true);
      for (const options of [{}, { memory }])
        assert.deepEqual(
          ids(searchCompiled(db, compileQuery(db, "privatequartz", "en"), options)),
          [],
        );
    });
    check("generation cursors reject nonpositive or mutable rowids", () => {
      assert.throws(
        () => db.prepare("UPDATE chunks SET rowid=-1 WHERE id='adjacent'").run(),
        /stable chunk rowids/,
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO chunks(rowid,id,document_id,chunk_index,content,title,source_id,source_created_at)
        VALUES(0,'zero-rowid','zero-rowid',0,'running','','synthetic-notes','2026-01-01')`,
            )
            .run(),
        /positive chunk rowids/,
      );
      integrity(db);
    });
    check("arbitrary input cannot inject MATCH operators or SQL", () => {
      for (const text of [
        '"',
        '" OR NEAR(*)',
        "'); DROP TABLE chunks; --",
        "a:b*c^d",
        "(mailbox NOT garden)",
      ]) {
        searchCompiled(db, compileQuery(db, text, "en"), { memory });
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM chunks").get().n, docs.length + 14 - 1);
      assert.throws(() => compileQuery(db, "word ".repeat(129), "en"), /too many analyzed terms/);
      assert.throws(
        () => putChunk(db, { id: "reserved", language: COMPILED_QUERY_LOCALE, content: "bad" }),
        /Invalid document language/,
      );
    });
    integrity(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = undefined;
    check("encrypted store does not have a plaintext SQLite header", () => {
      assert(!readFileSync(path).subarray(0, 16).equals(Buffer.from("SQLite format 3\0")));
    });
    db = openPrototype(path, extension, { readonly: true, encryptionKey: key });
    check("keyed read-only reopening can re-register the tokenizer and rebuild memory", () => {
      memory = buildMemory(db);
      assert.equal(
        ids(searchCompiled(db, compileQuery(db, "파란고래우체통", "ko"), { memory }))[0],
        "ko-positive",
      );
    });
    const workerResult = await new Promise((resolveWorker, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { path, extension, key: key.toString("hex") },
      });
      worker.once("message", resolveWorker);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Reader worker exited ${code}`));
      });
    });
    check(
      "independent reader worker registers the tokenizer and returns equivalent candidates",
      () => {
        assert.deepEqual(workerResult.ids, ["ko-positive", "ko-negative"]);
        assert.equal(workerResult.path, "memory");
      },
    );
    db.close();
    db = undefined;

    const migrationPath = join(directory, "migration.db");
    db = createIndexDatabase(migrationPath, { encryptionKey: key });
    installPrototype(db, extension, "exact");
    for (let i = 0; i < 8; i++)
      putChunk(db, { id: `m-${i}`, language: "en", content: `running observatory entry ${i}` });
    const oldMemory = buildMemory(db),
      oldQuery = compileQuery(db, "run", "en");
    check("initial precise generation does not imply stemming", () =>
      assert.deepEqual(ids(searchCompiled(db, oldQuery)), []),
    );
    beginGeneration(db, "stem");
    backfillGeneration(db, 2);
    putChunk(db, { id: "m-0", language: "en", content: "running changed after backfill" });
    putChunk(db, { id: "m-7", language: "en", content: "running changed before backfill" });
    db.prepare("DELETE FROM chunks WHERE id='m-5'").run();
    putChunk(db, { id: "m-late", language: "en", content: "running added during build" });
    check("a generation cannot activate before catching up with current writes", () =>
      assert.throws(() => activateGeneration(db), /behind/),
    );
    const cursor = generation(db).watermark;
    db.close();
    db = openPrototype(migrationPath, extension, { encryptionKey: key });
    check("an interrupted generation resumes its cursor after encrypted reopening", () =>
      assert.equal(generation(db).watermark, cursor),
    );
    while (!backfillGeneration(db, 2).caughtUp) {
      /* Bounded committed batches, no held reader snapshot. */
    }
    const epoch = generation(db).epoch;
    check("failed validation leaves the old generation serving", () => {
      assert.throws(
        () =>
          activateGeneration(db, () => {
            throw new Error("Synthetic relevance gate failed");
          }),
        /relevance gate failed/,
      );
      assert.equal(generation(db).epoch, epoch);
      assert.deepEqual(ids(searchCompiled(db, compileQuery(db, "run", "en"))), []);
    });
    activateGeneration(db);
    check("validated switch catches updates, deletes and inserts during backfill", () => {
      const answer = searchCompiled(db, compileQuery(db, "run", "en"));
      assert.equal(answer.candidates.length, 8);
      assert(!ids(answer).includes("m-5"));
      assert(ids(answer).includes("m-late"));
      integrity(db);
      integrity(db, "research_previous_fts");
    });
    check("a switch rejects stale compiled queries and stale memory snapshots", () => {
      assert.throws(() => searchCompiled(db, oldQuery), /Stale lexical analysis/);
      assert.throws(
        () => searchCompiled(db, compileQuery(db, "run", "en"), { memory: oldMemory }),
        /Stale lexical analysis/,
      );
    });
    putChunk(db, {
      id: "after-flip",
      language: "en",
      content: "running inserted after activation",
    });
    rollbackGeneration(db);
    check("rollback retains writes committed after the new generation became active", () => {
      assert.equal(generation(db).active_mode, "exact");
      assert(ids(searchCompiled(db, compileQuery(db, "running", "en"))).includes("after-flip"));
      assert.deepEqual(ids(searchCompiled(db, compileQuery(db, "run", "en"))), []);
      integrity(db);
    });
    beginGeneration(db, "stem");
    discardPending(db);
    check("an abandoned pending generation can be discarded without changing active data", () => {
      assert.equal(generation(db).pending_mode, null);
      integrity(db);
    });
    beginGeneration(db, "stem");
    while (!backfillGeneration(db, 2).caughtUp) {
      /* Resume-safe batch loop. */
    }
    activateGeneration(db);
    retirePrevious(db);
    check("retirement removes only the retained index and explicitly ends rollback", () => {
      assert.throws(() => rollbackGeneration(db), /No retained/);
      assert(ids(searchCompiled(db, compileQuery(db, "run", "en"))).includes("after-flip"));
      integrity(db);
    });
    const report = {
      checks: checks.length,
      passed: checks,
      observations,
      limitations: [
        "Isolated research schema and query adapter, not production HTTP wiring.",
        "Generation proof uses small synthetic batches; realistic writer contention is measured separately.",
        "Existing delta BM25 statistics retain the production cache's documented approximation until rebuild.",
        "Language metadata is explicitly provided; detection quality is evaluated in separate diagnostics.",
      ],
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ checks: checks.length, status: "passed" })}\n`);
  } finally {
    db?.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (isMainThread) {
  const [extension, output] = process.argv.slice(2);
  if (!extension || !output)
    throw new Error("Usage: node --import tsx verify.mjs EXTENSION OUTPUT");
  await run(resolve(extension), resolve(output));
} else {
  const key = Buffer.from(workerData.key, "hex");
  const db = openPrototype(workerData.path, workerData.extension, {
    readonly: true,
    encryptionKey: key,
  });
  try {
    const answer = searchCompiled(db, compileQuery(db, "파란고래우체통", "ko"), {
      memory: buildMemory(db),
    });
    parentPort.postMessage({ ids: ids(answer), path: answer.path });
  } finally {
    db.close();
    key.fill(0);
  }
}
