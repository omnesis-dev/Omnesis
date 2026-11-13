// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory lexical index: the FTS5 postings of `chunks_fts`, laid out as flat
 * typed arrays and scored with the same BM25 FTS5 computes.
 *
 * FTS5 stores postings in SQLite pages. Scoring a query whose words are common
 * means walking hundreds of thousands of postings through the B-tree and, under
 * storage encryption, decrypting every page — and FTS5 scores every match
 * before it can return the top K. Here a posting is two array reads, so even an
 * exhaustive score over a word in half the corpus takes a few milliseconds.
 *
 * The index is built from FTS5's own `instance` vocabulary, so tokenization is
 * FTS5's by construction, and the scorer reproduces `bm25(chunks_fts, 1.0,
 * 2.0)`: per query phrase, the column-weighted term frequency, FTS5's IDF and
 * its floor, and the document length from `chunks_fts_docsize`. Right after a
 * build the top K is identical to FTS5's.
 *
 * The built arrays never change. Each {@link LexicalIndex} — one per thread —
 * follows the `chunks_fts_changes` log to stay current: a chunk inserted,
 * deleted or rewritten since the build is masked out of the arrays and, when it
 * still exists, re-tokenized into a small per-ranker delta. Every query first
 * applies the changes committed before it, so it ranks what FTS5 would match.
 * Document frequencies count the arrays plus the delta, so a chunk changed
 * since the build still counts toward its old terms, and the length average
 * keeps its build-time value; both refresh at the next build. A chunk rewritten
 * again retires its earlier delta copy, and the delta is compacted once retired
 * postings outnumber live ones, so a few chunks rewritten over and over hold
 * only their latest text.
 *
 * Catching up costs a chunk read and a tokenization per change, so a query
 * spends at most a time budget on it; a ranker still behind after its budget
 * declines that query, and the caller ranks with FTS5. In a search worker a
 * background loop ({@link LexicalIndex.follow}, see lexical-index-follower.ts)
 * applies the log between queries, so a query rarely finds more than a moment
 * of changes. A ranker past its delta cap, or whose log was pruned past its
 * position, declines until the next build.
 *
 * Everything in {@link LexicalIndexData} is a typed array or a number, so the
 * arrays can live on `SharedArrayBuffer`s and serve several search workers
 * without copies.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { queryWords, type CorpusStats, type LexicalRanker, type RankedChunk } from "./bm25.js";
import {
  B,
  binarySearch,
  buildLexicalIndexData,
  K1,
  type LexicalIndexData,
} from "./lexical-index-data.js";
import { fts5Tokenizer, type Fts5Tokenizer } from "./lexical-tokenizer.js";

/**
 * A type-ahead prefix expands to at most this many concrete terms, the most
 * frequent first, so a one-letter prefix stays bounded.
 */
const PREFIX_EXPANSIONS = 32;
/** Change-log entries applied per read; small enough that one read stays a few milliseconds. */
const CHANGES_BATCH = 250;
/** Time one query may spend catching up on changes before it declines instead. */
const CHANGES_BUDGET_MS = 25;
/** Past this many live delta postings a ranker declines until the next build — a memory bound. */
const DELTA_MAX_POSTINGS = 2_000_000;
/**
 * Retired delta postings tolerated before a compaction, whatever the live
 * count, so a small delta is not rewritten on every change.
 */
const DELTA_COMPACT_MIN_RETIRED = 100_000;
/** One thread's ranker over shared {@link LexicalIndexData}, kept current from the change log. */
export class LexicalIndex implements LexicalRanker {
  private readonly termCount: number;
  private readonly accumulator: Float64Array;
  private readonly prefixFreq: Float64Array;
  private readonly touched: Uint32Array;
  private readonly encoder = new TextEncoder();
  private readonly live: LiveChanges;

  private readonly limits: Required<LexicalIndexLimits>;

  constructor(
    readonly data: LexicalIndexData,
    limits: LexicalIndexLimits = {},
    private readonly tokenizer: (db: Db) => Fts5Tokenizer = fts5Tokenizer,
  ) {
    this.limits = {
      changesBatch: limits.changesBatch ?? CHANGES_BATCH,
      changesBudgetMs: limits.changesBudgetMs ?? CHANGES_BUDGET_MS,
      maxDeltaPostings: limits.maxDeltaPostings ?? DELTA_MAX_POSTINGS,
      deltaCompactMinRetired: limits.deltaCompactMinRetired ?? DELTA_COMPACT_MIN_RETIRED,
    };
    this.termCount = data.termStart.length - 1;
    this.accumulator = new Float64Array(data.docCount);
    this.prefixFreq = new Float64Array(data.docCount);
    this.touched = new Uint32Array(data.docCount);
    this.live = {
      lastSeq: data.changeSeq,
      declined: false,
      masked: new Uint8Array(data.docCount),
      maskedCount: 0,
      delta: {
        rowids: [],
        norms: [],
        dead: [],
        sizes: [],
        byRowid: new Map(),
        live: 0,
        postingCount: 0,
        livePostings: 0,
        postings: new Map(),
      },
    };
  }

  /**
   * Chunk and document-frequency counts from the arrays plus this ranker's
   * delta, for the common-token filter, after catching up on the change log so
   * they count the chunks {@link rank} scores; null when it would decline. A
   * term's count still includes chunks changed since the build; the rebuild
   * threshold bounds that difference.
   */
  stats(db: Db): CorpusStats | null {
    return this.syncChanges(db) ? this.corpusStats : null;
  }

  private readonly corpusStats: CorpusStats = {
    chunkCount: () => this.data.docCount - this.live.maskedCount + this.live.delta.live,
    documentFrequency: (term) => {
      const t = this.findTerm(term);
      const base = t < 0 ? 0 : this.data.postingStart[t + 1] - this.data.postingStart[t];
      const extra = this.live.delta.postings.get(term);
      return base + (extra ? extra.docs.filter((d) => !this.live.delta.dead[d]).length : 0);
    },
  };

  /** The ranker can no longer follow the log; it declines every query until a new build. */
  get declined(): boolean {
    return this.live.declined;
  }

  /**
   * Apply change-log entries for up to `budgetMs` (at least one batch), for a
   * loop that keeps the ranker current between queries. Returns true while
   * entries remain to apply.
   */
  follow(db: Db, budgetMs: number): boolean {
    if (this.live.declined) return false;
    return this.applyChanges(db, budgetMs) === "behind";
  }

  /** Build in-process; see {@link buildLexicalIndexData}. */
  static build(
    db: Db,
    opts: { shared?: boolean; tokenizer?: (db: Db) => Fts5Tokenizer } = {},
  ): LexicalIndex {
    return new LexicalIndex(buildLexicalIndexData(db, opts), {}, opts.tokenizer);
  }

  rank(
    db: Db,
    query: string,
    k: number,
    opts?: { prefixLastToken?: boolean },
  ): RankedChunk[] | null {
    const trimmed = query.trim();
    // Quoted phrases need positions, which this index does not keep.
    if (!trimmed || (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return null;
    }
    const words = queryWords(trimmed, opts?.prefixLastToken);
    if (words.length === 0) return [];
    const tokens = this.tokenizer(db).words(words);
    const prefixWord = opts?.prefixLastToken ? words.length - 1 : -1;
    const phrases: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (i === prefixWord) continue;
      // FTS5 reads a word that tokenizes into several tokens (`foo_bar`) as a
      // phrase, which needs positions.
      if (tokens[i].length !== 1) return null;
      phrases.push(tokens[i][0]);
    }
    let prefix = "";
    if (prefixWord >= 0) {
      prefix = this.tokenizer(db).fold(words[prefixWord]);
      if (tokens[prefixWord].length > 1) return null;
      // A finished word ("meetings") is indexed under its stem ("meet"), which
      // no completion of the unstemmed text reaches; score the stem as well.
      const stem = tokens[prefixWord][0];
      if (stem && stem !== prefix) phrases.push(stem);
    }
    if (!this.syncChanges(db)) return null;
    return this.score(phrases, prefix, k);
  }

  /**
   * Rank an OR of already-analyzed index terms without tokenizing them again.
   * The caller must use the index's analysis configuration and keep explicit
   * phrases on a position-aware path. Repeated terms contribute repeatedly,
   * matching a SQLite OR query containing the same phrases in the same order.
   * The tokenizer supplied at construction also analyzes change-log deltas.
   */
  rankTerms(db: Db, terms: readonly string[], k: number): RankedChunk[] | null {
    if (!this.syncChanges(db)) return null;
    return this.score(terms, "", k);
  }

  private score(phrases: readonly string[], prefix: string, k: number): RankedChunk[] {
    const { masked, maskedCount, delta } = this.live;
    const touched = this.touched;
    const acc = this.accumulator;
    const deltaAcc = new Map<number, number>();
    let touchedCount = 0;
    const n = this.data.docCount - maskedCount + delta.live;
    // FTS5: log((N - hits + 0.5) / (hits + 0.5)), floored to 1e-6 when not positive.
    const idf = (hits: number) => {
      const v = Math.log((n - hits + 0.5) / (hits + 0.5));
      return v <= 0 ? 1e-6 : v;
    };
    const { postingStart, postingDoc, postingFreq, lengthNorm } = this.data;
    const bm25 = (w: number, f: number, norm: number) => w * ((f * (K1 + 1)) / (f + norm));
    const liveDeltaDocs = (list: DeltaPostings | undefined) =>
      list ? list.docs.reduce((c, d) => c + (delta.dead[d] ? 0 : 1), 0) : 0;

    // Each query token is one FTS5 phrase, summed in query order; a repeated
    // token counts again, as in FTS5.
    for (const phrase of phrases) {
      const t = this.findTerm(phrase);
      const extra = delta.postings.get(phrase);
      const start = t < 0 ? 0 : postingStart[t];
      const end = t < 0 ? 0 : postingStart[t + 1];
      if (end === start && !extra) continue;
      const w = idf(end - start + liveDeltaDocs(extra));
      for (let p = start; p < end; p++) {
        const d = postingDoc[p];
        if (masked[d]) continue;
        if (acc[d] === 0) touched[touchedCount++] = d;
        acc[d] += bm25(w, postingFreq[p], lengthNorm[d]);
      }
      extra?.docs.forEach((d, i) => {
        if (delta.dead[d]) return;
        deltaAcc.set(d, (deltaAcc.get(d) ?? 0) + bm25(w, extra.freqs[i], delta.norms[d]));
      });
    }

    // The type-ahead prefix is one phrase over its most frequent completions.
    if (prefix) {
      const freqs = this.prefixFreq;
      const prefixDocs: number[] = [];
      for (const t of this.expandPrefix(prefix)) {
        for (let p = postingStart[t]; p < postingStart[t + 1]; p++) {
          const d = postingDoc[p];
          if (masked[d]) continue;
          if (freqs[d] === 0) prefixDocs.push(d);
          freqs[d] += postingFreq[p];
        }
      }
      const deltaFreqs = new Map<number, number>();
      for (const [term, list] of delta.postings) {
        if (!term.startsWith(prefix)) continue;
        list.docs.forEach((d, i) => {
          if (!delta.dead[d]) deltaFreqs.set(d, (deltaFreqs.get(d) ?? 0) + list.freqs[i]);
        });
      }
      const w = idf(prefixDocs.length + deltaFreqs.size);
      for (const d of prefixDocs) {
        const f = freqs[d];
        freqs[d] = 0;
        if (acc[d] === 0) touched[touchedCount++] = d;
        acc[d] += bm25(w, f, lengthNorm[d]);
      }
      for (const [d, f] of deltaFreqs) {
        deltaAcc.set(d, (deltaAcc.get(d) ?? 0) + bm25(w, f, delta.norms[d]));
      }
    }

    const top = topK(acc, touched, touchedCount, k);
    for (let i = 0; i < touchedCount; i++) acc[touched[i]] = 0;
    const ranked = top.map((d) => ({ rowid: this.data.rowids[d.doc], score: d.score }));
    if (deltaAcc.size === 0) return ranked;
    for (const [d, score] of deltaAcc) ranked.push({ rowid: delta.rowids[d], score });
    return ranked.sort((a, b) => b.score - a.score || a.rowid - b.rowid).slice(0, k);
  }

  /**
   * Bring the ranker up to date for a query: apply the change log within the
   * query's time budget. Returns false — the query should go to FTS5 — when the
   * ranker has declined, or is still behind after its budget.
   */
  private syncChanges(db: Db): boolean {
    if (this.live.declined) return false;
    return this.applyChanges(db, this.limits.changesBudgetMs) === "current";
  }

  /**
   * Apply change-log entries past this ranker's position for up to `budgetMs`:
   * mask the changed chunks out of the built arrays and re-tokenize those that
   * still exist into the delta. "behind" when entries remain after the budget;
   * "declined" — until the next build — when the delta is full or the log was
   * pruned past this ranker's position.
   */
  private applyChanges(db: Db, budgetMs: number): "current" | "behind" | "declined" {
    const live = this.live;
    const started = Date.now();
    const read = db.prepare<[number, number], { seq: number; chunk_rowid: number }>(
      "SELECT seq, chunk_rowid FROM chunks_fts_changes WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    const fetch = db.prepare<[string], { rowid: number; content: string; title: string }>(
      "SELECT rowid, content, title FROM chunks WHERE rowid IN (SELECT value FROM json_each(?))",
    );
    const { changesBatch, maxDeltaPostings, deltaCompactMinRetired } = this.limits;
    for (let batches = 0; ; batches++) {
      if (batches > 0 && Date.now() - started > budgetMs) {
        // Still behind: the next query or follow continues from here.
        return "behind";
      }
      const changes = read.all(live.lastSeq, changesBatch);
      if (changes.length === 0) return "current";
      if (changes[0].seq > live.lastSeq + 1 && this.prunedPast(db, live.lastSeq)) {
        live.declined = true;
        return "declined";
      }
      const rowids = [...new Set(changes.map((c) => c.chunk_rowid))];
      for (const rowid of rowids) this.forget(rowid);
      const rows = fetch.all(JSON.stringify(rowids));
      for (const chunk of this.tokenizer(db).chunks(rows)) this.addToDelta(chunk);
      live.lastSeq = changes[changes.length - 1].seq;
      const delta = live.delta;
      if (delta.livePostings > maxDeltaPostings) {
        live.declined = true;
        return "declined";
      }
      const retired = delta.postingCount - delta.livePostings;
      if (retired > Math.max(deltaCompactMinRetired, delta.livePostings)) this.compactDelta();
      if (changes.length < changesBatch) return "current";
    }
  }

  private prunedPast(db: Db, seq: number): boolean {
    const min = db
      .prepare<[], { seq: number | null }>("SELECT min(seq) AS seq FROM chunks_fts_changes")
      .get()?.seq;
    return min != null && min > seq + 1;
  }

  /** Drop every indexed posting of `rowid`: mask it in the arrays, retire its delta doc. */
  private forget(rowid: number): void {
    const { live, data } = this;
    const dense = binarySearch(data.rowids, rowid);
    if (dense >= 0 && !live.masked[dense]) {
      live.masked[dense] = 1;
      live.maskedCount++;
    }
    const prior = live.delta.byRowid.get(rowid);
    if (prior !== undefined) {
      live.delta.dead[prior] = true;
      live.delta.live--;
      live.delta.livePostings -= live.delta.sizes[prior];
      live.delta.byRowid.delete(rowid);
    }
  }

  private addToDelta(chunk: { rowid: number; length: number; freqs: Map<string, number> }): void {
    const delta = this.live.delta;
    const d = delta.rowids.length;
    delta.rowids.push(chunk.rowid);
    delta.norms.push(K1 * (1 - B + (B * chunk.length) / this.data.avgLength));
    delta.dead.push(false);
    delta.sizes.push(chunk.freqs.size);
    delta.byRowid.set(chunk.rowid, d);
    delta.live++;
    for (const [term, f] of chunk.freqs) {
      let list = delta.postings.get(term);
      if (!list) delta.postings.set(term, (list = { docs: [], freqs: [] }));
      list.docs.push(d);
      list.freqs.push(f);
    }
    delta.postingCount += chunk.freqs.size;
    delta.livePostings += chunk.freqs.size;
  }

  /**
   * Drop retired delta docs and their postings, renumbering the live docs in
   * their original order, so the delta holds only chunks' latest text.
   */
  private compactDelta(): void {
    const delta = this.live.delta;
    const renumbered = new Int32Array(delta.rowids.length).fill(-1);
    const rowids: number[] = [];
    const norms: number[] = [];
    const sizes: number[] = [];
    for (let d = 0; d < delta.rowids.length; d++) {
      if (delta.dead[d]) continue;
      renumbered[d] = rowids.length;
      delta.byRowid.set(delta.rowids[d], rowids.length);
      rowids.push(delta.rowids[d]);
      norms.push(delta.norms[d]);
      sizes.push(delta.sizes[d]);
    }
    for (const [term, list] of delta.postings) {
      const docs: number[] = [];
      const freqs: number[] = [];
      list.docs.forEach((d, i) => {
        if (renumbered[d] < 0) return;
        docs.push(renumbered[d]);
        freqs.push(list.freqs[i]);
      });
      if (docs.length === 0) delta.postings.delete(term);
      else delta.postings.set(term, { docs, freqs });
    }
    delta.rowids = rowids;
    delta.norms = norms;
    delta.sizes = sizes;
    delta.dead = new Array<boolean>(rowids.length).fill(false);
    delta.postingCount = delta.livePostings;
  }

  /** Term ids sharing `prefix`, most frequent first, at most {@link PREFIX_EXPANSIONS}. */
  private expandPrefix(prefix: string): number[] {
    const key = this.encoder.encode(prefix);
    let lo = 0;
    let hi = this.termCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareTerm(mid, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    const { postingStart } = this.data;
    const best: { t: number; df: number }[] = [];
    for (let t = lo; t < this.termCount && this.termHasPrefix(t, key); t++) {
      const df = postingStart[t + 1] - postingStart[t];
      if (best.length < PREFIX_EXPANSIONS) {
        best.push({ t, df });
        if (best.length === PREFIX_EXPANSIONS) best.sort((a, b) => b.df - a.df);
      } else if (df > best[PREFIX_EXPANSIONS - 1].df) {
        best[PREFIX_EXPANSIONS - 1] = { t, df };
        for (let i = PREFIX_EXPANSIONS - 1; i > 0 && best[i].df > best[i - 1].df; i--) {
          [best[i], best[i - 1]] = [best[i - 1], best[i]];
        }
      }
    }
    return best.map((b) => b.t);
  }

  private findTerm(term: string): number {
    const key = this.encoder.encode(term);
    let lo = 0;
    let hi = this.termCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.compareTerm(mid, key);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private compareTerm(t: number, key: Uint8Array): number {
    const { termBytes, termStart } = this.data;
    const s = termStart[t];
    const len = termStart[t + 1] - s;
    const n = Math.min(len, key.length);
    for (let i = 0; i < n; i++) {
      const diff = termBytes[s + i] - key[i];
      if (diff !== 0) return diff;
    }
    return len - key.length;
  }

  private termHasPrefix(t: number, key: Uint8Array): boolean {
    const { termBytes, termStart } = this.data;
    const s = termStart[t];
    if (termStart[t + 1] - s < key.length) return false;
    for (let i = 0; i < key.length; i++) if (termBytes[s + i] !== key[i]) return false;
    return true;
  }
}

/** How much change-log work a ranker takes on; the defaults suit production. */
export interface LexicalIndexLimits {
  /** Change-log entries applied per read. */
  changesBatch?: number;
  /** Time one query may spend catching up before it declines. */
  changesBudgetMs?: number;
  /** Live delta postings past which the ranker declines until the next build. */
  maxDeltaPostings?: number;
  /** Retired delta postings tolerated before a compaction, however few are live. */
  deltaCompactMinRetired?: number;
}

/** A ranker's view of changes since its arrays were built. */
interface LiveChanges {
  /** Last change-log seq applied. */
  lastSeq: number;
  /** The ranker can no longer follow the log; every query goes to FTS5 until a new build. */
  declined: boolean;
  /** dense doc → 1 when the chunk changed since the build. */
  masked: Uint8Array;
  maskedCount: number;
  delta: Delta;
}

/** Chunks re-tokenized since the build. Delta doc ids index the arrays below. */
interface Delta {
  rowids: number[];
  norms: number[];
  /** A delta doc superseded by a later change to the same chunk. */
  dead: boolean[];
  /** Postings each delta doc holds. */
  sizes: number[];
  /** chunk rowid → its current delta doc. */
  byRowid: Map<number, number>;
  /** Delta docs not dead. */
  live: number;
  /** Postings held, dead docs' included. */
  postingCount: number;
  /** Postings held by docs not dead. */
  livePostings: number;
  postings: Map<string, DeltaPostings>;
}

interface DeltaPostings {
  docs: number[];
  freqs: number[];
}

function topK(
  acc: Float64Array,
  touched: Uint32Array,
  count: number,
  k: number,
): { doc: number; score: number }[] {
  // Min-heap of the best k under "higher score, then lower rowid" — the order
  // FTS5 returns ties in, so equal scores at the cutoff resolve deterministically.
  const cap = Math.min(k, count);
  const heapDoc = new Uint32Array(cap);
  const heapScore = new Float64Array(cap);
  let size = 0;
  const worse = (i: number, j: number) =>
    heapScore[i] < heapScore[j] || (heapScore[i] === heapScore[j] && heapDoc[i] > heapDoc[j]);
  const swap = (i: number, j: number) => {
    [heapScore[i], heapScore[j]] = [heapScore[j], heapScore[i]];
    [heapDoc[i], heapDoc[j]] = [heapDoc[j], heapDoc[i]];
  };
  for (let i = 0; i < count; i++) {
    const d = touched[i];
    const s = acc[d];
    if (size < cap) {
      let j = size++;
      heapDoc[j] = d;
      heapScore[j] = s;
      while (j > 0) {
        const p = (j - 1) >> 1;
        if (!worse(j, p)) break;
        swap(j, p);
        j = p;
      }
      continue;
    }
    if (s < heapScore[0] || (s === heapScore[0] && d > heapDoc[0])) continue;
    heapDoc[0] = d;
    heapScore[0] = s;
    for (let j = 0; ;) {
      const l = 2 * j + 1;
      const r = l + 1;
      let m = j;
      if (l < size && worse(l, m)) m = l;
      if (r < size && worse(r, m)) m = r;
      if (m === j) break;
      swap(j, m);
      j = m;
    }
  }
  const out: { doc: number; score: number }[] = [];
  for (let i = 0; i < size; i++) out.push({ doc: heapDoc[i], score: heapScore[i] });
  return out.sort((a, b) => b.score - a.score || a.doc - b.doc);
}
