// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Cross-platform token-stream fingerprint without redistributing corpus text. */
import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createIndexDatabase } from "../../../packages/gateway/src/indexer/db.js";
import { registerNative } from "./store.mjs";
import { analyze, COMPILED_QUERY_LOCALE } from "./query.mjs";

const [extension, output] = process.argv.slice(2);
if (!extension || !output) throw new Error("Usage: node --import tsx parity.mjs EXTENSION OUTPUT");
const fixtureFile = readFileSync(new URL("../cases.json", import.meta.url));
const fixtures = JSON.parse(fixtureFile.toString("utf8"));
const db = createIndexDatabase(":memory:");
try {
  registerNative(db, resolve(extension));
  const hash = createHash("sha256");
  const languages = new Set();
  let inputs = 0,
    tokens = 0,
    checkedTermQueries = 0;
  for (const mode of ["exact", "stem"]) {
    db.exec(`CREATE VIRTUAL TABLE temp.parity_${mode} USING fts5(content,locale=1,
      tokenize='omnesis_multilingual_v1 language und mode ${mode}')`);
    const insert = db.prepare(
      `INSERT INTO temp.parity_${mode}(rowid,content) VALUES(1,fts5_locale(?,?))`,
    );
    const clear = db.prepare(`DELETE FROM temp.parity_${mode}`);
    const match = db.prepare(`SELECT count(*) AS n FROM temp.parity_${mode}
      WHERE parity_${mode} MATCH fts5_locale(?,?)`);
    for (const fixture of fixtures) {
      languages.add(fixture.language);
      const query =
        fixture.query.startsWith('"') && fixture.query.endsWith('"')
          ? fixture.query.slice(1, -1)
          : fixture.query;
      for (const text of [query, ...fixture.positive, ...fixture.negative]) {
        const raw = Buffer.from(text, "utf8");
        const result = analyze(db, text, fixture.language, mode);
        clear.run();
        insert.run(fixture.language, text);
        for (const token of result.tokens) {
          assert(Number.isSafeInteger(token.start) && Number.isSafeInteger(token.end));
          assert(token.start >= 0 && token.end >= token.start && token.end <= raw.length);
          assert(token.end > token.start, "Searchable tokens must cover original text");
          assert(isUtf8(raw.subarray(0, token.start)), "Token start must be a UTF-8 boundary");
          assert(isUtf8(raw.subarray(0, token.end)), "Token end must be a UTF-8 boundary");
          assert(
            isUtf8(raw.subarray(token.start, token.end)),
            "Offsets must be original UTF-8 boundaries",
          );
          const quoted = '"' + token.text.replaceAll('"', '""') + '"';
          assert.equal(
            match.get(COMPILED_QUERY_LOCALE, quoted).n,
            1,
            "Compiled terms must find their source without a second stemming pass",
          );
          checkedTermQueries++;
        }
        hash.update(
          JSON.stringify({
            id: fixture.id,
            mode,
            language: fixture.language,
            tokens: result.tokens.map(({ text, start, end, position }) => ({
              text,
              start,
              end,
              position,
            })),
          }),
        );
        inputs++;
        tokens += result.tokens.length;
      }
    }
  }
  const report = {
    fixtureSHA256: createHash("sha256").update(fixtureFile).digest("hex"),
    analyzerFingerprint: db
      .prepare("SELECT omnesis_multilingual_fingerprint('und','stem') AS value")
      .get().value,
    streamSHA256: hash.digest("hex"),
    inputs,
    tokens,
    checkedTermQueries,
    languages: [...languages].sort(),
    sqlite: db.prepare("SELECT sqlite_version() AS v").get().v,
    platform: process.platform,
    architecture: process.arch,
    limitation:
      "Checks consistency, original offsets and platform parity; does not assert retrieval relevance for every language.",
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  db.close();
}
