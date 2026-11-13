// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createIndexDatabase, upsertChunks } from "../../packages/gateway/src/indexer/db.js";
import { bm25Search } from "../../packages/gateway/src/search/bm25.js";
import { LexicalIndex } from "../../packages/gateway/src/search/lexical-index.js";

const [extension, output] = process.argv.slice(2);
if (!extension || !output)
  throw new Error("Usage: node --import tsx gateway-probe.mjs EXTENSION OUTPUT");
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const results = [];
for (const method of ["current", "native-charabia"]) {
  for (const fixture of cases) {
    const db = createIndexDatabase(":memory:");
    try {
      if (method === "native-charabia") {
        db.loadExtension(extension);
        db.exec(`DROP TABLE chunks_fts;
          CREATE VIRTUAL TABLE chunks_fts USING fts5(content,title,
            content='chunks',content_rowid='rowid',tokenize='charabia');`);
      }
      const texts = [...fixture.positive, ...fixture.negative];
      const chunks = texts.map((content, index) => ({
        id: `synthetic-chunk-${index}`,
        documentId: `synthetic-document-${index}`,
        chunkIndex: 0,
        content,
        embedding: null,
        sourceId: "synthetic-notes",
        documentType: "note",
        title: "",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      }));
      const key = (chunk) =>
        createHash("sha256").update(`${fixture.id}\0${chunk.content}`).digest("hex");
      upsertChunks(
        db,
        chunks.sort((left, right) => key(left).localeCompare(key(right))),
      );
      const ranker = LexicalIndex.build(db);
      let fellBack = false;
      const observed = {
        rank(...args) {
          const answer = ranker.rank(...args);
          if (answer === null) fellBack = true;
          return answer;
        },
        stats: (...args) => ranker.stats(...args),
      };
      const fts = bm25Search(db, fixture.query, {}, 20);
      const memory = bm25Search(db, fixture.query, {}, 20, { ranker: observed });
      const ids = (answer) =>
        answer.candidates.map((candidate) => Number(candidate.documentId.split("-").at(-1)));
      const ftsIds = ids(fts);
      const memoryIds = ids(memory);
      const positive = new Set(fixture.positive.map((_, index) => index));
      const allowedIds = new Set(fixture.positive.map((_, index) => `synthetic-document-${index}`));
      const hit = ftsIds.some((id) => positive.has(id));
      const falsePositives = ftsIds.filter((id) => !positive.has(id)).length;
      const restricted = bm25Search(db, fixture.query, {}, 20, {
        documentIds: [...allowedIds],
      });
      results.push({
        method,
        id: fixture.id,
        language: fixture.language,
        hit,
        clean:
          ftsIds.filter((id) => positive.has(id)).length === positive.size && falsePositives === 0,
        falsePositives,
        ftsIds,
        memoryIds,
        sameResults: JSON.stringify(ftsIds) === JSON.stringify(memoryIds),
        fellBack,
        restrictionLeaks: restricted.candidates.some(
          (candidate) => !allowedIds.has(candidate.documentId),
        ),
      });
    } finally {
      db.close();
    }
  }
}
const summary = Object.fromEntries(
  ["current", "native-charabia"].map((method) => {
    const rows = results.filter((row) => row.method === method);
    return [
      method,
      {
        cases: rows.length,
        hits: rows.filter((row) => row.hit).length,
        clean: rows.filter((row) => row.clean).length,
        falsePositives: rows.reduce((sum, row) => sum + row.falsePositives, 0),
        memoryFallbacks: rows.filter((row) => row.fellBack).length,
        parityFailures: rows.filter((row) => !row.sameResults).length,
        restrictionLeaks: rows.filter((row) => row.restrictionLeaks).length,
      },
    ];
  }),
);
writeFileSync(output, `${JSON.stringify({ summary, results }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
for (const row of Object.values(summary)) {
  assert.equal(row.parityFailures, 0, "SQLite and memory-ranked results must agree");
  assert.equal(row.restrictionLeaks, 0, "Document restrictions must hold with either tokenizer");
}
assert.equal(
  results.find((row) => row.method === "native-charabia" && row.id === "ko-synthetic-ending").clean,
  true,
);
