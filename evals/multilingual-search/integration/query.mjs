// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Prototype compiler and executor; production search defaults are unchanged. */
import { LexicalIndex } from "../../../packages/gateway/src/search/lexical-index.js";
import { joinRankedCandidates } from "../../../packages/gateway/src/search/bm25.js";
import { buildMetadataFilter } from "../../../packages/gateway/src/search/metadata.js";
import { visibleChunkClause } from "../../../packages/gateway/src/search/visible-chunks.js";
import { withDocIdRestriction } from "../../../packages/gateway/src/search/docid-filter.js";
import { generation, assertGeneration } from "./store.mjs";

export const COMPILED_QUERY_LOCALE = "und-x-omnesis-terms-v1";

export function analyze(db, text, language, mode) {
  const row = db
    .prepare("SELECT omnesis_multilingual_analyze(?,?,?) AS value")
    .get(text, language, mode);
  const result = JSON.parse(row.value);
  if (!Array.isArray(result.tokens)) throw new Error("Invalid analyzer response");
  for (const token of result.tokens) {
    if (
      typeof token.text !== "string" ||
      !token.text ||
      token.text.includes("\0") ||
      /[\t\n\v\f\r ]/u.test(token.text)
    ) {
      throw new Error("Analyzer emitted a term outside the compiled-query contract");
    }
  }
  return result;
}

/** All MATCH operators come from the compiler, never from untrusted input. */
export function compileQuery(db, text, language = "und", { maxTerms = 128 } = {}) {
  if (typeof text !== "string" || text.length > 20000)
    throw new Error("Query exceeds prototype bound");
  if (!Number.isInteger(maxTerms) || maxTerms < 1 || maxTerms > 1024)
    throw new Error("Invalid term bound");
  const snapshot = generation(db);
  const trimmed = text.trim();
  const phrase = trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const source = phrase ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
  const analyzed = analyze(db, source, language, snapshot.active_mode);
  const analyzedTerms = analyzed.tokens.map((token) => token.text);
  if (analyzedTerms.length > maxTerms) throw new Error("Query has too many analyzed terms");
  const terms = phrase ? analyzedTerms : [...new Set(analyzedTerms)];
  const quote = (term) => `"${term.replaceAll('"', '""')}"`;
  return {
    terms,
    phrase,
    language,
    mode: snapshot.active_mode,
    snapshot,
    expression: terms.length
      ? phrase
        ? quote(terms.join(" "))
        : terms.map(quote).join(" OR ")
      : "",
  };
}

/** Locale-aware delta analysis on a read handle, with no second query stemming. */
export function tokenizerForGeneration(snapshot) {
  return (db) => {
    const languageOf = db.prepare("SELECT research_language AS language FROM chunks WHERE rowid=?");
    return {
      words(words) {
        assertGeneration(db, snapshot);
        return words.map((text) =>
          analyze(db, text, "und", snapshot.active_mode).tokens.map((t) => t.text),
        );
      },
      fold() {
        throw new Error(
          "Type-ahead prefixes require a separate precision policy in this prototype",
        );
      },
      chunks(rows) {
        assertGeneration(db, snapshot);
        return rows.map((row) => {
          const language = languageOf.get(row.rowid)?.language;
          if (!language) throw new Error("Changed chunk disappeared from the current snapshot");
          const content = analyze(db, row.content ?? "", language, snapshot.active_mode).tokens;
          const title = analyze(db, row.title ?? "", language, snapshot.active_mode).tokens;
          const freqs = new Map();
          for (const [tokens, weight] of [
            [content, 1],
            [title, 2],
          ]) {
            for (const token of tokens)
              freqs.set(token.text, (freqs.get(token.text) ?? 0) + weight);
          }
          return { rowid: row.rowid, length: content.length + title.length, freqs };
        });
      },
    };
  };
}

export function buildMemory(db) {
  const snapshot = generation(db);
  return {
    snapshot,
    index: LexicalIndex.build(db, { tokenizer: tokenizerForGeneration(snapshot) }),
  };
}

/** Reuses production metadata, visibility and document-restriction primitives. */
export function searchCompiled(
  db,
  compiled,
  { memory, filters = {}, documentIds, limit = 20 } = {},
) {
  // Generation checks, cache following and candidate joins must share one read
  // snapshot even if an independent writer activates a generation concurrently.
  if (!db.inTransaction) {
    return db
      .transaction(() => searchCompiled(db, compiled, { memory, filters, documentIds, limit }))
      .deferred();
  }
  assertGeneration(db, compiled.snapshot);
  if (memory) assertGeneration(db, memory.snapshot);
  if (!compiled.expression || limit <= 0 || documentIds?.length === 0)
    return { candidates: [], path: "empty" };
  if (memory && !compiled.phrase && !documentIds) {
    for (let window = Math.max(80, limit * 4); window <= 10000; window *= 4) {
      const ranked = memory.index.rankTerms(db, compiled.terms, window);
      if (!ranked) break;
      const candidates = joinRankedCandidates(db, ranked, filters, limit);
      if (candidates.length === limit || ranked.length < window)
        return { candidates, path: "memory" };
    }
  }
  const filter = buildMetadataFilter(filters, "c");
  const ranked = withDocIdRestriction(db, "c.document_id", documentIds, ({ clause, params }) =>
    db
      .prepare(
        `SELECT chunks_fts.rowid AS rowid,-bm25(chunks_fts,1.0,2.0) AS score
     FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid
     WHERE chunks_fts MATCH fts5_locale(?,?)
       AND ${visibleChunkClause("c")} AND ${filter.clause}${clause}
     ORDER BY score DESC,chunks_fts.rowid LIMIT ?`,
      )
      .all(COMPILED_QUERY_LOCALE, compiled.expression, ...filter.params, ...params, limit),
  );
  return { candidates: joinRankedCandidates(db, ranked, filters, limit), path: "fts5" };
}
