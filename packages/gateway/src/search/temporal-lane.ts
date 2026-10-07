// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The temporal lane: the third candidate list fused beside BM25 and vector
 * when a query names a time ("the dentist next month", "invoice from March",
 * "atelier 15 juin").
 *
 * Text lanes rank the whole corpus by words and meaning and treat "next
 * month" as two more words; embedding models in particular barely encode
 * dates. This lane instead starts from the window the query names and ranks
 * only what falls inside it. A document is in the window when either of its
 * times is:
 *
 * - **document time** — when it was sent, written or recorded
 *   (`chunks.source_created_at`), the time "emails from last week" asks
 *   about;
 * - **event time** — a time it is about, read from the gateway's time index
 *   (source-owned projections such as calendar events, date mentions in the
 *   text, the background agent's annotations) and handed in as document ids,
 *   the time "the dentist next month" asks about.
 *
 * Inside the window the query's remaining words rank the chunks: BM25 over
 * FTS5 restricted to the window's rowids, and by meaning — exactly, against
 * the stored embeddings, when the window is a day's worth of chunks, else
 * through the query's deep HNSW neighbourhood kept to the window's chunks. Each list counts a document once,
 * at its best chunk, and the two fuse by reciprocal rank. A query that is
 * nothing but a time ("tomorrow", "Saturday 10 October") has no words left to
 * rank by, so its window is listed event-time documents first, then by
 * document time, newest first.
 *
 * A window can hold a year of a corpus, so membership in it is read from the
 * `source_created_at` and `document_id` indexes alone: its cost grows with the
 * window's index entries, never with its chunk rows. Only the ranked head of
 * each list is joined to `chunks`, where the search's filters, visibility and
 * person restriction apply — and when they reject so much of that head that
 * the list comes up short, a wider head is joined, as the BM25 lane does. A
 * person restriction narrow enough is applied to the window itself instead.
 *
 * Runs inside the candidate-generation core against `index.db` only (it is
 * structured-clone safe and runs on the search worker); the event-time
 * document ids are resolved upstream from `omnesis.db`.
 */

import {
  filterCommonTokens,
  joinRankedCandidates,
  toFts5Query,
  type LexicalRanker,
  type RankedChunk,
} from "./bm25.js";
import type Database from "better-sqlite3";
import type { VectorReadSource } from "../indexer/usearch-index.js";
import type { SearchCandidate, SearchFilters } from "./types.js";

type Db = Database.Database;

/** What the temporal lane needs from the caller; structured-clone safe. */
export interface TemporalLaneRequest {
  /** Document-time windows, half-open, as UTC ISO instants. */
  windows: Array<{ start: string; endExclusive: string }>;
  /** Documents the time index places inside a window (event time), in the index's order. */
  eventDocumentIds: string[];
  /** The query's words with its temporal phrases removed; "" when nothing else is left. */
  text: string;
  /**
   * Embedding of `text`, or null when there is none: no embedder, no words
   * left, or a vector lane that could not rank this generation of the index.
   */
  vector: Float32Array | null;
  /** RRF weight of the lane's list in fusion. */
  weight: number;
}

export interface TemporalLaneReport {
  durationMs: number;
  candidates: number;
  eventDocuments: number;
  bm25Candidates: number;
  vectorCandidates: number;
  /** True when the window was listed by time because nothing else could rank it. */
  timeOrdered: boolean;
}

/**
 * A window of at most this many chunks — about a day of a busy corpus — is
 * ranked by meaning exactly, against its stored embeddings: the global HNSW
 * neighbourhood holds only a handful of a day's chunks. Each is a few KB to
 * read, so wider windows go through HNSW instead.
 */
export const EXACT_WINDOW_MAX_CHUNKS = 1_000;
/**
 * Neighbours read from HNSW for a wider window before keeping those inside
 * it: one native search, deep enough that a window holding a few percent of
 * the corpus still yields a list.
 */
export const WINDOW_NEIGHBOURS = 4_000;
/** A person restriction with at most this many documents bounds the window itself. */
const WINDOW_RESTRICTION_MAX_DOCUMENTS = 5_000;
/** Chunk rows each list ranks per document it needs: documents span several chunks. */
const CHUNKS_PER_DOCUMENT = 4;
/** How far a list's ranked head may widen when filters reject most of it. */
const MAX_HEAD_CHUNKS = 6_400;
/** RRF constant joining the lane's BM25 and vector lists. */
const LANE_RRF_K = 60;

/**
 * The temporal lane's candidates: at most `limit` documents inside the
 * query's windows that the search may return, best first, each as its best
 * chunk, ranked from 1.
 */
export function temporalLaneCandidates(
  db: Db,
  usearch: VectorReadSource | undefined,
  lane: TemporalLaneRequest,
  filters: SearchFilters,
  allowedDocumentIds: readonly string[] | undefined,
  limit: number,
  options: { commonTokenThreshold: number; ranker?: LexicalRanker },
): { candidates: SearchCandidate[]; report: TemporalLaneReport } {
  const start = Date.now();
  const report: TemporalLaneReport = {
    durationMs: 0,
    candidates: 0,
    eventDocuments: lane.eventDocumentIds.length,
    bm25Candidates: 0,
    vectorCandidates: 0,
    timeOrdered: false,
  };
  const finish = (candidates: SearchCandidate[]) => {
    report.candidates = candidates.length;
    report.durationMs = Date.now() - start;
    return { candidates, report };
  };
  if (limit <= 0 || lane.windows.length === 0 || allowedDocumentIds?.length === 0)
    return finish([]);

  const allowed = allowedDocumentIds ? new Set(allowedDocumentIds) : undefined;
  const narrow =
    allowedDocumentIds && allowedDocumentIds.length <= WINDOW_RESTRICTION_MAX_DOCUMENTS
      ? allowedDocumentIds
      : undefined;
  const window = windowRowids(lane, narrow);
  const documents = (rank: (k: number) => RankedChunk[]) =>
    rankedDocuments(db, rank, filters, allowed, limit);

  const bm25: SearchCandidate[] = [];
  const vector: SearchCandidate[] = [];
  const terms = lexicalQuery(db, lane.text, options);
  if (terms) {
    const ranked = bm25InWindow(db, window, terms, MAX_HEAD_CHUNKS);
    bm25.push(...documents((k) => ranked.slice(0, k)));
  }
  report.bm25Candidates = bm25.length;

  if (lane.vector) {
    const exact =
      countWindowChunks(db, window, EXACT_WINDOW_MAX_CHUNKS + 1) <= EXACT_WINDOW_MAX_CHUNKS;
    const ranked = exact
      ? exactCosineInWindow(db, window, lane.vector, MAX_HEAD_CHUNKS)
      : usearch
        ? windowNeighbours(db, usearch, window, lane.vector)
        : null;
    if (ranked) vector.push(...documents((k) => ranked.slice(0, k)));
  }
  report.vectorCandidates = vector.length;

  if (bm25.length === 0 && vector.length === 0) {
    report.timeOrdered = true;
    return finish(
      documents((k) => [...eventFirstChunks(db, lane, k), ...newestInWindows(db, lane, k)]),
    );
  }
  return finish(fuseLaneLists(bm25, vector, limit));
}

/** A `rowid IN (…)` set naming every chunk in the window, read from indexes alone. */
interface WindowRowids {
  sql: string;
  params: Array<string | number>;
}

/**
 * The window's chunks: those created inside a window, and every chunk of an
 * event-time document. With a narrow person restriction, only its documents'
 * chunks are read — through the `document_id` index rather than the date one.
 */
function windowRowids(
  lane: TemporalLaneRequest,
  restriction: readonly string[] | undefined,
): WindowRowids {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  const inRestriction = "document_id IN (SELECT value FROM json_each(?))";
  for (const w of lane.windows) {
    parts.push(
      `SELECT rowid FROM chunks WHERE source_created_at >= ? AND source_created_at < ?${
        restriction ? ` AND ${inRestriction}` : ""
      }`,
    );
    params.push(w.start, w.endExclusive, ...(restriction ? [JSON.stringify(restriction)] : []));
  }
  const allowed = restriction ? new Set(restriction) : undefined;
  const events = lane.eventDocumentIds.filter((id) => !allowed || allowed.has(id));
  if (events.length > 0) {
    parts.push(`SELECT rowid FROM chunks WHERE ${inRestriction}`);
    params.push(JSON.stringify(events));
  }
  return { sql: parts.join(" UNION "), params };
}

/** The window's chunk count, read up to `cap`. */
function countWindowChunks(db: Db, window: WindowRowids, cap: number): number {
  const row = db
    .prepare<
      (string | number)[],
      { n: number }
    >(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM (${window.sql}) LIMIT ?)`)
    .get(...window.params, cap);
  return row?.n ?? 0;
}

/** Every window chunk scored by cosine similarity to the query vector, best first, at most `k`. */
function exactCosineInWindow(
  db: Db,
  window: WindowRowids,
  query: Float32Array,
  k: number,
): RankedChunk[] {
  let queryNorm = 0;
  for (let i = 0; i < query.length; i++) queryNorm += query[i]! * query[i]!;
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];
  const scored: RankedChunk[] = [];
  const rows = db
    .prepare<
      (string | number)[],
      { rowid: number; embedding: Buffer | null }
    >(`SELECT rowid, embedding FROM chunks WHERE rowid IN (${window.sql}) AND embedding IS NOT NULL`)
    .iterate(...window.params);
  for (const row of rows) {
    const blob = row.embedding;
    // A vector of another dimension belongs to another embedding generation.
    if (!blob || blob.byteLength !== query.length * 4) continue;
    const v = new Float32Array(blob.buffer, blob.byteOffset, query.length);
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      dot += v[i]! * query[i]!;
      norm += v[i]! * v[i]!;
    }
    if (norm > 0) scored.push({ rowid: row.rowid, score: dot / (Math.sqrt(norm) * queryNorm) });
  }
  scored.sort((a, b) => b.score - a.score || a.rowid - b.rowid);
  return scored.slice(0, k);
}

/**
 * A ranked chunk list as documents the search may return: the head of the
 * ranking joined to `chunks` under the search's filters, each document once
 * at its best chunk. When the filters leave fewer than `limit` documents and
 * the ranking had more to give, a wider head is joined.
 */
function rankedDocuments(
  db: Db,
  rank: (k: number) => RankedChunk[],
  filters: SearchFilters,
  allowed: Set<string> | undefined,
  limit: number,
): SearchCandidate[] {
  let previous = -1;
  for (let k = limit * CHUNKS_PER_DOCUMENT; ; k *= 4) {
    const head = Math.min(k, MAX_HEAD_CHUNKS);
    const ranked = rank(head);
    const joined = joinRankedCandidates(db, ranked, filters, ranked.length).filter(
      (c) => !allowed || allowed.has(c.documentId),
    );
    const docs = perDocument(joined, limit);
    // Done when full, when the ranking has nothing more to give, or at the cap.
    const exhausted = ranked.length < head || ranked.length === previous;
    if (docs.length === limit || exhausted || head === MAX_HEAD_CHUNKS) {
      return docs;
    }
    previous = ranked.length;
  }
}

/** The FTS5 query for the lane's words after the common-token filter, or "" when none is left. */
function lexicalQuery(
  db: Db,
  text: string,
  options: { commonTokenThreshold: number; ranker?: LexicalRanker },
): string {
  // Stripping a time phrase can split a quoted phrase ("concert 22 May 2026"
  // leaves an unbalanced quote), so the lane ranks the words, never phrases.
  const words = text.replace(/"/g, " ");
  if (words.trim() === "") return "";
  const filtered =
    options.commonTokenThreshold > 0
      ? filterCommonTokens(db, words, options.commonTokenThreshold, options.ranker?.stats).filtered
      : words;
  return toFts5Query(filtered);
}

/**
 * BM25 over FTS5, restricted to the window's rowids before any `chunks` row
 * is read. The unary `+` keeps SQLite from handing the rowid set to FTS5 as
 * an index constraint, which would rerun the MATCH once per window rowid.
 */
function bm25InWindow(db: Db, window: WindowRowids, fts: string, k: number): RankedChunk[] {
  try {
    return db
      .prepare<(string | number)[], { rowid: number; s: number }>(
        `SELECT rowid, bm25(chunks_fts, 1.0, 2.0) AS s
           FROM chunks_fts
          WHERE chunks_fts MATCH ? AND +rowid IN (${window.sql})
          ORDER BY s, rowid
          LIMIT ?`,
      )
      .all(fts, ...window.params, k)
      .map((r) => ({ rowid: r.rowid, score: -r.s }));
  } catch (err) {
    if (err instanceof Error && /fts5: syntax error/i.test(err.message)) return [];
    throw err;
  }
}

/**
 * The query's deep HNSW neighbourhood, kept to the window's chunks, best
 * first. Null when the index cannot answer (mid-swap), so the lane ranks by
 * its words alone.
 */
function windowNeighbours(
  db: Db,
  usearch: VectorReadSource,
  window: WindowRowids,
  query: Float32Array,
): RankedChunk[] | null {
  let neighbours: Array<{ key: bigint; distance: number }>;
  try {
    neighbours = usearch.search(query, WINDOW_NEIGHBOURS);
  } catch {
    return null;
  }
  if (neighbours.length === 0) return [];
  const inside = new Set(
    db
      .prepare<(string | number)[], { rowid: number }>(
        `SELECT value AS rowid FROM json_each(?) WHERE value IN (${window.sql})`,
      )
      .all(JSON.stringify(neighbours.map((n) => Number(n.key))), ...window.params)
      .map((r) => r.rowid),
  );
  return neighbours
    .filter((n) => inside.has(Number(n.key)))
    .map((n) => ({ rowid: Number(n.key), score: 1 - n.distance }));
}

/** The first chunk of each event-time document, in the time index's order, at most `k`. */
function eventFirstChunks(db: Db, lane: TemporalLaneRequest, k: number): RankedChunk[] {
  if (lane.eventDocumentIds.length === 0) return [];
  const rows = db
    .prepare<[string], { rowid: number; document_id: string }>(
      `SELECT rowid, document_id FROM chunks
        WHERE document_id IN (SELECT value FROM json_each(?)) AND chunk_index = 0`,
    )
    .all(JSON.stringify(lane.eventDocumentIds.slice(0, k)));
  const order = new Map(lane.eventDocumentIds.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => order.get(a.document_id)! - order.get(b.document_id)!)
    .map((r, i) => ({ rowid: r.rowid, score: -i }));
}

/** The window's newest chunks by document time, newest first, at most `k`. */
function newestInWindows(db: Db, lane: TemporalLaneRequest, k: number): RankedChunk[] {
  const rows = lane.windows.flatMap((w) =>
    db
      .prepare<[string, string, number], { rowid: number; at: string }>(
        `SELECT rowid, source_created_at AS at FROM chunks
          WHERE source_created_at >= ? AND source_created_at < ?
          ORDER BY source_created_at DESC
          LIMIT ?`,
      )
      .all(w.start, w.endExclusive, k),
  );
  return rows
    .sort((a, b) => b.at.localeCompare(a.at) || a.rowid - b.rowid)
    .slice(0, k)
    .map((r, i) => ({ rowid: r.rowid, score: -i }));
}

/** A chunk list as a document list: each document once, at its best chunk, at most `limit`. */
function perDocument(candidates: SearchCandidate[], limit: number): SearchCandidate[] {
  const seen = new Set<string>();
  const docs: SearchCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.documentId)) continue;
    seen.add(c.documentId);
    docs.push(c);
    if (docs.length === limit) break;
  }
  return docs;
}

/** BM25 and vector document lists, joined by reciprocal rank into one list. */
function fuseLaneLists(
  bm25: SearchCandidate[],
  vector: SearchCandidate[],
  limit: number,
): SearchCandidate[] {
  const byDoc = new Map<string, { candidate: SearchCandidate; score: number; best: number }>();
  const add = (list: SearchCandidate[]) => {
    list.forEach((candidate, i) => {
      const contribution = 1 / (LANE_RRF_K + i + 1);
      const entry = byDoc.get(candidate.documentId);
      if (!entry) {
        byDoc.set(candidate.documentId, { candidate, score: contribution, best: contribution });
        return;
      }
      entry.score += contribution;
      // The document's chunk is the one the stronger list ranked higher.
      if (contribution > entry.best) {
        entry.candidate = candidate;
        entry.best = contribution;
      }
    });
  };
  add(bm25);
  add(vector);
  return [...byDoc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry, i) => ({ ...entry.candidate, score: entry.score, rank: i + 1 }));
}
