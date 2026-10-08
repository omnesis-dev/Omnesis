// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * BM25 search over the `chunks_fts` full-text index: ranked by the in-memory
 * lexical index when one is attached, by FTS5 otherwise.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { buildMetadataFilter } from "./metadata.js";
import { withDocIdRestriction } from "./docid-filter.js";
import { visibleChunkClause } from "./visible-chunks.js";
import { createLogger } from "@omnesis/core";
import type { SearchCandidate, SearchFilters } from "./types.js";

const log = createLogger("gateway:search");

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
export function toFts5Query(query: string, prefixLastToken = false): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  if (prefixLastToken) {
    // Suggestions never accept raw FTS syntax. Quote generated literal terms,
    // and append the only wildcard outside the final term's quoted boundary.
    const terms = queryWords(trimmed);
    return terms
      .map((term, index) => `"${term}"${index === terms.length - 1 ? "*" : ""}`)
      .join(" OR ");
  }

  // Already-quoted phrase passes through verbatim (length > 1 so a lone `"`
  // doesn't qualify and slip an unbalanced quote into MATCH).
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }

  return queryWords(trimmed).join(" OR ");
}

/**
 * The words of a query as BM25 searches them, in order.
 *
 * Every FTS5-significant / punctuation character becomes a space before the
 * split. Arbitrary user text ("c++", "example.com", a stray quote) otherwise
 * reaches FTS5 as invalid MATCH syntax and throws `fts5: syntax error`, 500ing
 * the search. Spaces rather than deletion keep the tokenizer splitting
 * "example.com" into example/com instead of concatenating to "examplecom".
 * `\p{L}\p{N}_` keeps letters (incl. non-Latin scripts), digits, and
 * underscores; the `u` flag makes the Unicode property escapes work. Bare
 * operator words (`AND`, `OR`, `NOT`, `NEAR`) are dropped.
 */
export function queryWords(query: string): string[] {
  return query
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .map(sanitizeFts5Term)
    .filter(Boolean);
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
  // non-word characters with spaces, so by the time terms reach here
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
 * How long corpus statistics stay cached. They steer a heuristic, so minutes of
 * staleness are harmless, while recomputing them costs a full `chunks` count
 * and one posting-list decode per query word on every search.
 */
const CORPUS_STATS_TTL_MS = 5 * 60 * 1000;
/** Bound on cached per-term frequencies, so arbitrary query text cannot grow it without limit. */
const CORPUS_STATS_MAX_TERMS = 50_000;

/** Corpus statistics the common-token filter reads. */
export interface CorpusStats {
  /** Chunks in the index. */
  chunkCount(): number;
  /** Chunks containing `term`, an index term (lowercase, as FTS5 stores it). */
  documentFrequency(term: string): number;
}

const corpusStatsByDb = new WeakMap<Db, CorpusStats>();

function corpusStats(db: Db): CorpusStats {
  const cached = corpusStatsByDb.get(db);
  if (cached) return cached;
  let count: { at: number; value: number } | undefined;
  const frequencies = new Map<string, { at: number; value: number }>();
  const countChunks = db.prepare<[], { cnt: number }>("SELECT count(*) as cnt FROM chunks");
  const termDocs = db.prepare<[string], { doc: number }>(
    "SELECT doc FROM chunks_fts_vocab WHERE term = ?",
  );
  const stats: CorpusStats = {
    chunkCount() {
      if (count && Date.now() - count.at < CORPUS_STATS_TTL_MS) return count.value;
      count = { at: Date.now(), value: countChunks.get()?.cnt ?? 0 };
      return count.value;
    },
    documentFrequency(term) {
      const hit = frequencies.get(term);
      if (hit && Date.now() - hit.at < CORPUS_STATS_TTL_MS) return hit.value;
      const row = termDocs.get(term);
      if (frequencies.size >= CORPUS_STATS_MAX_TERMS) frequencies.clear();
      frequencies.set(term, { at: Date.now(), value: row?.doc ?? 0 });
      return row?.doc ?? 0;
    },
  };
  corpusStatsByDb.set(db, stats);
  return stats;
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
  stats?: CorpusStats,
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
    stats ??= corpusStats(db);
    totalChunks = stats.chunkCount();
  } catch {
    return { filtered: query, dropped: [] };
  }
  if (totalChunks === 0) return { filtered: query, dropped: [] };

  const cutoff = Math.floor(totalChunks * threshold);
  const dropped: string[] = [];
  const kept: string[] = [];

  for (const token of tokens) {
    try {
      if (stats.documentFrequency(token.toLowerCase()) > cutoff) {
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
 * Ranks the chunks matching a query by BM25 without touching `chunks`. The
 * in-memory lexical index implements this; FTS5 itself is the fallback.
 */
export interface LexicalRanker {
  /**
   * Best-first `{ rowid, score }` pairs (higher score = better), at most `k`.
   * Returns `null` when the ranker cannot serve the query — it needs positions
   * (a quoted phrase, or a word FTS5 reads as a phrase), or it cannot follow
   * the change log just now — and the caller ranks with FTS5 instead.
   */
  rank(
    db: Db,
    query: string,
    k: number,
    opts?: { prefixLastToken?: boolean },
  ): RankedChunk[] | null;
  /** The ranker's corpus statistics, read without touching FTS5. */
  readonly stats?: CorpusStats;
}

export interface RankedChunk {
  rowid: number;
  score: number;
}

/** First rank-first window: generous enough that unfiltered queries rarely widen. */
const RANK_FIRST_MIN_K = 200;
/** Widening factor when filters reject too many of the in-memory ranker's rows. */
const RANK_FIRST_GROWTH = 8;
/**
 * The widest window the in-memory ranker is asked for. Past it, a filter is
 * selective enough that joining every match (the filter-first plan) is cheaper.
 */
const RANK_FIRST_MAX_K = 25_000;

const CHUNK_COLUMNS = `c.rowid, c.document_id, c.source_id, c.document_type,
           c.title, c.source_url, c.source_created_at, c.author, c.tags,
           c.relevance_score`;

/** Which ranker ordered the BM25 candidates. */
export type Bm25Ranker = "memory" | "fts5";

/**
 * Search using BM25.
 *
 * Ranking happens before any `chunks` row is read: the top K chunk rowids
 * come from the in-memory lexical ranker or, when none is attached or it
 * declines the query, from FTS5's own `bm25()`; only those K rows are then
 * joined to `chunks` for metadata, visibility and filters. Joining every match
 * before sorting costs one random, overflow-chasing, decrypted row read per
 * match — seconds for queries containing common words.
 *
 * When filters reject so many ranked rows that fewer than `limit` survive, the
 * in-memory ranker re-ranks a wider window (it is cheap to ask again), up to
 * {@link RANK_FIRST_MAX_K}; FTS5 scores every match on each call, so after one
 * window it goes straight to the filter-first join. A person-filter document
 * set is always filter-first.
 *
 * Both rankers see the query after the common-token filter, so they rank the
 * same words; with the in-memory ranker attached, the filter reads its corpus
 * statistics from the ranker instead of from FTS5's vocabulary.
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
    prefixLastToken?: boolean;
    /** In-memory ranker used in place of FTS5 ranking when it can serve the query. */
    ranker?: LexicalRanker;
  },
): { candidates: SearchCandidate[]; droppedTokens: string[]; ranker: Bm25Ranker } {
  const docIds = opts?.documentIds;
  if (limit <= 0 || (docIds && docIds.length === 0)) {
    return { candidates: [], droppedTokens: [], ranker: "fts5" };
  }
  const filter = buildMetadataFilter(filters, "c");

  let effectiveQuery = query;
  let droppedTokens: string[] = [];
  if (opts?.commonTokenThreshold && opts.commonTokenThreshold > 0) {
    const result = filterCommonTokens(db, query, opts.commonTokenThreshold, opts.ranker?.stats);
    effectiveQuery = result.filtered;
    droppedTokens = result.dropped;
  }

  if (!docIds && opts?.ranker) {
    const rows = rankWithRanker(
      db,
      opts.ranker,
      effectiveQuery,
      filter,
      limit,
      opts.prefixLastToken,
    );
    if (rows) return { candidates: rows.map(toCandidate), droppedTokens, ranker: "memory" };
  }

  const ftsQuery = toFts5Query(effectiveQuery, opts?.prefixLastToken);
  if (!ftsQuery) return { candidates: [], droppedTokens, ranker: "fts5" };

  try {
    const rows = docIds
      ? filterFirst(db, ftsQuery, filter, docIds, limit)
      : rankWithFts(db, ftsQuery, filter, limit);
    return { candidates: rows.map(toCandidate), droppedTokens, ranker: "fts5" };
  } catch (err) {
    // `toFts5Query` should prevent malformed MATCH input, but the
    // phrase-passthrough path (or an unforeseen edge) could still produce
    // `fts5: syntax error`. Degrade to no BM25 results rather than 500 the
    // whole search — vector search still answers.
    if (err instanceof Error && /fts5: syntax error/i.test(err.message)) {
      return { candidates: [], droppedTokens, ranker: "fts5" };
    }
    throw err;
  }
}

type ScoredRow = Omit<Bm25Row, "bm25_score"> & { score: number };
type MetadataFilter = { clause: string; params: (string | number)[] };

/**
 * Rank with the in-memory ranker, widening while filters leave fewer than
 * `limit` rows. Null when the ranker declines or fails, so FTS5 ranks instead.
 */
function rankWithRanker(
  db: Db,
  ranker: LexicalRanker,
  query: string,
  filter: MetadataFilter,
  limit: number,
  prefixLastToken: boolean | undefined,
): ScoredRow[] | null {
  for (let k = Math.max(RANK_FIRST_MIN_K, limit * 4); ; k *= RANK_FIRST_GROWTH) {
    const window = Math.min(k, RANK_FIRST_MAX_K);
    let ranked: RankedChunk[] | null;
    try {
      ranked = ranker.rank(db, query, window, { prefixLastToken });
    } catch (err) {
      log.warn(
        `in-memory BM25 ranking failed; FTS5 ranks instead: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!ranked) return null;
    const rows = joinRanked(db, ranked, filter, limit);
    // Enough rows survived, or the ranking was exhaustive (fewer than `window`
    // chunks match at all), so a wider window cannot add anything.
    if (rows.length === limit || ranked.length < window) return rows;
    if (window === RANK_FIRST_MAX_K)
      return filterFirst(db, toFts5Query(query, prefixLastToken), filter, undefined, limit);
  }
}

/** FTS5 ranks one window; a filter that leaves too few rows falls back to filter-first. */
function rankWithFts(db: Db, ftsQuery: string, filter: MetadataFilter, limit: number): ScoredRow[] {
  const window = Math.min(Math.max(RANK_FIRST_MIN_K, limit * 4), RANK_FIRST_MAX_K);
  // bm25() returns negative scores (lower = better match).
  // Weight: content=1.0, title=2.0 (title matches worth 2x).
  const ranked = db
    .prepare<[string, number], { rowid: number; s: number }>(
      `SELECT rowid, bm25(chunks_fts, 1.0, 2.0) AS s
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s, rowid LIMIT ?`,
    )
    .all(ftsQuery, window)
    .map((r) => ({ rowid: r.rowid, score: -r.s }));
  const rows = joinRanked(db, ranked, filter, limit);
  if (rows.length === limit || ranked.length < window) return rows;
  return filterFirst(db, ftsQuery, filter, undefined, limit);
}

/**
 * The ranked rowids as candidates — visible chunks that pass `filters`, best
 * first, ranked from 1, at most `limit`. For lanes that rank chunk rowids
 * themselves and need the same metadata join the BM25 lane uses.
 */
export function joinRankedCandidates(
  db: Db,
  ranked: readonly RankedChunk[],
  filters: SearchFilters,
  limit: number,
): SearchCandidate[] {
  return joinRanked(db, ranked, buildMetadataFilter(filters, "c"), limit).map(toCandidate);
}

/** The ranked rowids' `chunks` rows that are visible and pass `filter`, best first, at most `limit`. */
function joinRanked(
  db: Db,
  ranked: readonly RankedChunk[],
  filter: MetadataFilter,
  limit: number,
): ScoredRow[] {
  if (ranked.length === 0) return [];
  const byRowid = new Map(
    db
      .prepare<(string | number)[], Omit<Bm25Row, "bm25_score">>(
        `SELECT ${CHUNK_COLUMNS}
         FROM chunks c
         WHERE c.rowid IN (SELECT value FROM json_each(?))
           AND ${visibleChunkClause("c")}
           AND ${filter.clause}`,
      )
      .all(JSON.stringify(ranked.map((r) => r.rowid)), ...filter.params)
      .map((row) => [row.rowid, row]),
  );
  const rows: ScoredRow[] = [];
  for (const r of ranked) {
    const row = byRowid.get(r.rowid);
    if (row) rows.push({ ...row, score: r.score });
    if (rows.length === limit) break;
  }
  return rows;
}

/**
 * Filter-first plan: every match is joined to `chunks` before sorting. Right
 * when the filter (or a person-filter document set) admits few chunks.
 */
function filterFirst(
  db: Db,
  ftsQuery: string,
  filter: MetadataFilter,
  docIds: readonly string[] | undefined,
  limit: number,
): ScoredRow[] {
  // The `docIds` set is unbounded; a large set is staged into a temp table so
  // it never overflows SQLite's bound-variable limit.
  return withDocIdRestriction<ScoredRow[]>(
    db,
    "c.document_id",
    docIds,
    ({ clause: docIdClause, params: docIdParams }) =>
      db
        .prepare<(string | number)[], Bm25Row>(
          `SELECT ${CHUNK_COLUMNS},
                  bm25(chunks_fts, 1.0, 2.0) as bm25_score
           FROM chunks_fts
           JOIN chunks c ON chunks_fts.rowid = c.rowid
           WHERE chunks_fts MATCH ?
             AND ${visibleChunkClause("c")}
             AND ${filter.clause}${docIdClause}
           ORDER BY bm25_score
           LIMIT ?`,
        )
        .all(ftsQuery, ...filter.params, ...docIdParams, limit)
        .map(({ bm25_score, ...row }) => ({ ...row, score: -bm25_score })),
  );
}

function toCandidate(row: ScoredRow, i: number): SearchCandidate {
  return {
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
    score: row.score,
    rank: i + 1,
    relevanceScore: row.relevance_score,
  };
}
