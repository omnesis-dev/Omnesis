// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * BM25 search via FTS5 — queries the chunks_fts virtual table.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { buildMetadataFilter } from "./metadata.js";
import { withDocIdRestriction } from "./docid-filter.js";
import { visibleChunkClause } from "./visible-chunks.js";
import type { SearchCandidate, SearchFilters } from "./types.js";

interface Bm25Row {
  rowid: number;
  document_id: string;
  source_id: string;
  document_type: string | null;
  title: string;
  source_url: string | null;
  source_created_at: string;
  author: string | null;
  tags: string | null;
  relevance_score: number | null;
  bm25_score: number;
}

/**
 * Convert a search query to FTS5 MATCH syntax.
 *
 * Semantics:
 * - Terms are joined with OR — multi-word natural-language queries (e.g. "the
 *   best man speech wrote for my wedding") only need a few terms to match for
 *   bm25() to rank a doc well; requiring AND across every token
 *   intersects to zero candidates on real corpora.
 * - Terms are emitted bare (no per-term double-quotes). FTS5 with a
 *   stemming/diacritic-folding tokenizer matches tokens after the
 *   tokenizer applies, so a bare term like `recipe` still matches
 *   `recipes` in the index. Wrapping each term in `"..."` would force
 *   exact-phrase match and defeat the tokenizer.
 * - Already-quoted full phrases (`"foo bar"`) pass through unchanged so
 *   callers can opt into phrase semantics explicitly.
 * - Strips FTS5 syntax characters from each term and drops bare
 *   operator tokens (`AND`, `OR`, `NOT`, `NEAR`). Without this, a
 *   query like `hello OR meeting` reaches FTS5 with a standalone
 *   `OR` and `bm25_search` 500s with `fts5: syntax error near "OR"`.
 *   The user-visible behavior is conjunctive plain text — boolean
 *   operators aren't a documented part of the query language, so
 *   treating them as noise rather than syntax is the safer default.
 */
export function toFts5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  // Already-quoted phrase passes through verbatim (length > 1 so a lone `"`
  // doesn't qualify and slip an unbalanced quote into MATCH).
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }

  // Replace every FTS5-significant / punctuation character with a space
  // before splitting into terms. Arbitrary user text ("c++", "example.com",
  // a stray quote) otherwise reaches FTS5 as invalid MATCH syntax and throws
  // `fts5: syntax error`, 500ing the search (#552). Spaces rather than
  // deletion keep the tokenizer splitting "example.com" into example/com
  // instead of concatenating to "examplecom". `\p{L}\p{N}_` keeps letters
  // (incl. non-Latin scripts), digits, and underscores; the `u` flag makes
  // the Unicode property escapes work.
  return trimmed
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => sanitizeFts5Term(t))
    .filter(Boolean)
    .join(" OR ");
}

/**
 * Per-term sanitizer for FTS5 MATCH input. Strips characters that
 * FTS5 treats as syntax (`* " ( ) : ^ -`) and discards tokens that
 * are nothing but punctuation or that name an FTS5 operator
 * (`AND` / `OR` / `NOT` / `NEAR`). Returns `""` to signal "drop this
 * term"; callers filter empty terms out before joining.
 */
function sanitizeFts5Term(term: string): string {
  // Strip FTS5 syntax punctuation. `toFts5Query` already replaces all
  // non-word characters with spaces (#552), so by the time terms reach here
  // they're word-only; this strip stays as defence-in-depth for the other
  // caller (`filterCommonTokens`), which sanitizes terms without that pass.
  const stripped = term.replace(/[*"():^\-]/g, "");
  if (!stripped) return "";
  // Bare operator tokens trigger FTS5 errors when surrounded by
  // implicit OR/AND joins. Drop them silently — phrase-quoted
  // queries can still use these words as literals.
  const upper = stripped.toUpperCase();
  if (upper === "AND" || upper === "OR" || upper === "NOT" || upper === "NEAR") {
    return "";
  }
  return stripped;
}

/**
 * Filter high-frequency tokens from a query to avoid slow BM25 scans.
 * Tokens appearing in more than `threshold` fraction of all chunks are
 * dropped. If ALL tokens are common, returns the original query
 * unchanged (something is better than nothing). Single-token queries
 * are never filtered (nothing to fall back to).
 *
 * Limitation: the fts5vocab table stores Porter-stemmed tokens. This
 * lookup uses the unstemmed query term. For most high-frequency tokens
 * this doesn't matter (common words like "about", "new", "email",
 * "the", "from" are unchanged by Porter stemming), but inflected forms
 * like "recipes" (stemmed to "recip") won't match their vocab entry.
 *
 * Returns `{ filtered, dropped }` — the filtered query string and
 * the list of dropped tokens (for diagnostics).
 */
export function filterCommonTokens(
  db: Db,
  query: string,
  threshold: number,
): { filtered: string; dropped: string[] } {
  if (threshold <= 0 || threshold >= 1) return { filtered: query, dropped: [] };

  const trimmed = query.trim();
  if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return { filtered: query, dropped: [] };
  }

  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => sanitizeFts5Term(t))
    .filter(Boolean);
  if (tokens.length <= 1) return { filtered: query, dropped: [] };

  let totalChunks: number;
  try {
    const row = db.prepare<[], { cnt: number }>("SELECT count(*) as cnt FROM chunks").get();
    totalChunks = row?.cnt ?? 0;
  } catch {
    return { filtered: query, dropped: [] };
  }
  if (totalChunks === 0) return { filtered: query, dropped: [] };

  const cutoff = Math.floor(totalChunks * threshold);
  const dropped: string[] = [];
  const kept: string[] = [];

  for (const token of tokens) {
    try {
      const row = db
        .prepare<[string], { doc: number }>("SELECT doc FROM chunks_fts_vocab WHERE term = ?")
        .get(token.toLowerCase());
      if (row && row.doc > cutoff) {
        dropped.push(token);
      } else {
        kept.push(token);
      }
    } catch {
      kept.push(token);
    }
  }

  if (kept.length === 0) return { filtered: query, dropped: [] };
  return { filtered: kept.join(" "), dropped };
}

/**
 * Search using BM25 via FTS5.
 *
 * @param db Index database (has chunks + chunks_fts tables)
 * @param query Search query text
 * @param filters Optional metadata filters
 * @param limit Maximum results to return
 * @returns Ranked candidates with BM25 scores
 */
export function bm25Search(
  db: Db,
  query: string,
  filters: SearchFilters,
  limit: number,
  opts?: {
    /**
     * When provided, restrict candidates to chunks whose `document_id`
     * is in this list. Used by the person-filter pushdown
     * — `from:jamesbond` resolves to a docId set in the
     * gateway DB, then BM25 only ranks chunks belonging to those docs.
     * Empty array means "no allowed docs" → empty result.
     */
    documentIds?: readonly string[];
    commonTokenThreshold?: number;
  },
): { candidates: SearchCandidate[]; droppedTokens: string[] } {
  let effectiveQuery = query;
  let droppedTokens: string[] = [];
  if (opts?.commonTokenThreshold && opts.commonTokenThreshold > 0) {
    const result = filterCommonTokens(db, query, opts.commonTokenThreshold);
    effectiveQuery = result.filtered;
    droppedTokens = result.dropped;
  }

  const ftsQuery = toFts5Query(effectiveQuery);
  if (!ftsQuery) return { candidates: [], droppedTokens };

  const docIds = opts?.documentIds;
  if (docIds && docIds.length === 0) {
    return { candidates: [], droppedTokens };
  }

  const { clause: filterClause, params: filterParams } = buildMetadataFilter(filters, "c");

  // The `docIds` set is unbounded; a large set is staged into a temp table so
  // it never overflows SQLite's bound-variable limit (#581).
  const rows = withDocIdRestriction<Bm25Row[]>(
    db,
    "c.document_id",
    docIds,
    ({ clause: docIdClause, params: docIdParams }) => {
      // bm25() returns negative scores (lower = better match)
      // Weight: content=1.0, title=2.0 (title matches worth 2x)
      // Exclude c.content from the scoring query. The chunks table is 2+ GB
      // and reading content blobs for every candidate causes 20-60s of disk
      // IO under background-task contention. Content is only needed for the
      // final results — the pipeline hydrates it after fusion via
      // hydrateChunkText().
      const sql = `
    SELECT c.rowid, c.document_id, c.source_id, c.document_type,
           c.title, c.source_url, c.source_created_at, c.author, c.tags,
           c.relevance_score,
           bm25(chunks_fts, 1.0, 2.0) as bm25_score
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.rowid
    WHERE chunks_fts MATCH ?
      AND ${visibleChunkClause("c")}
      AND ${filterClause}${docIdClause}
    ORDER BY bm25_score
    LIMIT ?
  `;

      const params = [ftsQuery, ...filterParams, ...docIdParams, limit];
      try {
        return db.prepare<(string | number)[], Bm25Row>(sql).all(...params);
      } catch (err) {
        // `toFts5Query` should prevent malformed MATCH input, but the
        // phrase-passthrough path (or an unforeseen edge) could still produce
        // `fts5: syntax error`. Degrade to no BM25 results rather than 500 the
        // whole search — vector search still answers (#552).
        if (err instanceof Error && /fts5: syntax error/i.test(err.message)) {
          return [];
        }
        throw err;
      }
    },
  );

  const candidates = rows.map((row, i) => ({
    documentId: row.document_id,
    chunkRowid: row.rowid,
    sourceId: row.source_id,
    documentType: row.document_type ?? "unknown",
    title: row.title,
    sourceUrl: row.source_url,
    sourceCreatedAt: row.source_created_at,
    author: row.author,
    tags: row.tags,
    chunkText: "",
    score: -row.bm25_score,
    rank: i + 1,
    relevanceScore: row.relevance_score,
  }));
  return { candidates, droppedTokens };
}
