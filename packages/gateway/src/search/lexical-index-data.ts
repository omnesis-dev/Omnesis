// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The in-memory lexical index's data: its layout and how it is built from
 * `index.db`. The arrays are immutable once built; {@link LexicalIndex} in
 * lexical-index.ts ranks over them.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { COLUMN_WEIGHTS } from "./lexical-tokenizer.js";

/** FTS5's BM25 constants. */
export const K1 = 1.2;
export const B = 0.75;

/** The index's arrays. Every field is a typed array or a number, so it can be shared across threads. */
export interface LexicalIndexData {
  /** Number of chunks indexed (FTS5 `nRow` at build time). */
  docCount: number;
  /** Last `chunks_fts_changes.seq` the arrays reflect. */
  changeSeq: number;
  /** Mean tokens per chunk, title and content together. */
  avgLength: number;
  /** dense doc index → chunk rowid, ascending. */
  rowids: Uint32Array;
  /** dense doc index → `K1 * (1 - B + B * length / avgLength)`. */
  lengthNorm: Float64Array;
  /** term i's UTF-8 bytes are `termBytes[termStart[i] .. termStart[i + 1])`, terms in byte order. */
  termBytes: Uint8Array;
  termStart: Uint32Array;
  /** term i's postings are `[postingStart[i], postingStart[i + 1])`. */
  postingStart: Uint32Array;
  /** Posting → dense doc index, ascending within a term. */
  postingDoc: Uint32Array;
  /** Posting → column-weighted term frequency, capped at 65,535. */
  postingFreq: Uint16Array;
}

/** Bytes held by an index's arrays. */
export function lexicalIndexBytes(d: LexicalIndexData): number {
  return [
    d.rowids,
    d.lengthNorm,
    d.termBytes,
    d.termStart,
    d.postingStart,
    d.postingDoc,
    d.postingFreq,
  ].reduce((sum, a) => sum + a.byteLength, 0);
}

/**
 * Build the arrays from the index database, in one read transaction so the
 * postings, lengths and change-log position describe the same snapshot. Reads
 * every FTS5 posting once; on a corpus of ~800k chunks this takes on the order
 * of a minute and belongs off the request path. With `shared`, the arrays live
 * on `SharedArrayBuffer`s; the two posting arrays grow in place inside a buffer
 * reserved up to the corpus token count, so the build never holds a second copy.
 */
export function buildLexicalIndexData(db: Db, opts: { shared?: boolean } = {}): LexicalIndexData {
  const shared = opts.shared === true;
  const ownTransaction = !db.inTransaction;
  if (ownTransaction) db.exec("BEGIN");
  try {
    const changeSeq =
      db.prepare<[], { seq: number | null }>("SELECT max(seq) AS seq FROM chunks_fts_changes").get()
        ?.seq ?? 0;
    const docCount =
      db.prepare<[], { n: number }>("SELECT count(*) AS n FROM chunks_fts_docsize").get()?.n ?? 0;
    const rowids = alloc(Uint32Array, docCount, shared);
    const lengths = new Float64Array(docCount);
    let totalLength = 0;
    let i = 0;
    for (const [rowid, sz] of db
      .prepare<[], [number, Buffer]>("SELECT id, sz FROM chunks_fts_docsize ORDER BY id")
      .raw()
      .iterate()) {
      if (i === docCount) break;
      rowids[i] = rowid;
      lengths[i] = sumVarints(sz);
      totalLength += lengths[i++];
    }
    const avgLength = docCount > 0 ? totalLength / docCount : 1;
    const lengthNorm = alloc(Float64Array, docCount, shared);
    for (let d = 0; d < docCount; d++) lengthNorm[d] = K1 * (1 - B + (B * lengths[d]) / avgLength);
    const denseOf = denseLookup(rowids);

    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_instances USING fts5vocab(main, chunks_fts, 'instance')",
    );
    // A chunk has at most as many postings as tokens, so the token count bounds
    // the posting arrays.
    const maxPostings = Math.max(1024, totalLength);
    const termBytes = new Growable(Uint8Array, 1 << 20, Number.MAX_SAFE_INTEGER, false);
    const termStart = new Growable(Uint32Array, 1 << 16, maxPostings + 1, false);
    const postingStart = new Growable(Uint32Array, 1 << 16, maxPostings + 1, false);
    const postingDoc = new Growable(Uint32Array, 1 << 20, maxPostings, shared);
    const postingFreq = new Growable(Uint16Array, 1 << 20, maxPostings, shared);
    const encoder = new TextEncoder();
    let term: string | null = null;
    let doc = -1;
    let freq = 0;
    const flushPosting = () => {
      if (doc >= 0) {
        postingDoc.push(doc);
        postingFreq.push(Math.min(freq, 0xffff));
      }
      doc = -1;
      freq = 0;
    };
    for (const [t, rowid, col] of db
      .prepare<[], [string, number, string]>("SELECT term, doc, col FROM temp.lexical_instances")
      .raw()
      .iterate()) {
      if (t !== term) {
        flushPosting();
        term = t;
        termStart.push(termBytes.length);
        termBytes.pushAll(encoder.encode(t));
        postingStart.push(postingDoc.length);
      }
      const dense = denseOf(rowid);
      if (dense < 0) continue;
      if (dense !== doc) {
        flushPosting();
        doc = dense;
      }
      freq += COLUMN_WEIGHTS[col] ?? 1;
    }
    flushPosting();
    termStart.push(termBytes.length);
    postingStart.push(postingDoc.length);

    return {
      docCount,
      changeSeq,
      avgLength,
      rowids,
      lengthNorm,
      termBytes: termBytes.finish(shared),
      termStart: termStart.finish(shared),
      postingStart: postingStart.finish(shared),
      postingDoc: postingDoc.finish(shared),
      postingFreq: postingFreq.finish(shared),
    };
  } finally {
    if (ownTransaction) db.exec("COMMIT");
  }
}

/**
 * Sum of the per-column token counts in a `chunks_fts_docsize.sz` blob. FTS5
 * writes them as SQLite varints: big-endian 7-bit groups with a continuation
 * bit, where a ninth byte contributes all 8 of its bits.
 */
function sumVarints(buf: Buffer): number {
  let total = 0;
  let i = 0;
  while (i < buf.length) {
    let v = 0;
    for (let k = 0; i < buf.length; k++) {
      const byte = buf[i++];
      if (k === 8) {
        v = v * 256 + byte;
        break;
      }
      v = v * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    total += v;
  }
  return total;
}

export function binarySearch(sorted: Uint32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] === value) return mid;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function denseLookup(rowids: Uint32Array): (rowid: number) => number {
  const max = rowids.length > 0 ? rowids[rowids.length - 1] : 0;
  // A direct table while it stays modest; binary search for sparse rowid spaces.
  if (max < 16 * 1024 * 1024) {
    const table = new Int32Array(max + 1).fill(-1);
    for (let i = 0; i < rowids.length; i++) table[rowids[i]] = i;
    return (rowid) => (rowid <= max ? table[rowid] : -1);
  }
  return (rowid) => binarySearch(rowids, rowid);
}

type TypedArray = Uint8Array | Uint16Array | Uint32Array | Float64Array;
type TypedArrayCtor<T extends TypedArray> = {
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): T;
  BYTES_PER_ELEMENT: number;
};

/** A zeroed typed array, on a `SharedArrayBuffer` when other threads will read it. */
function alloc<T extends TypedArray>(ctor: TypedArrayCtor<T>, length: number, shared: boolean): T {
  const bytes = length * ctor.BYTES_PER_ELEMENT;
  return new ctor(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

/**
 * An append-only typed array. With `inPlace`, it grows inside one resizable
 * `SharedArrayBuffer` reserved up to `maxLength` (address space only), so
 * finishing hands back a view with no copy and at most a quarter unused;
 * otherwise it doubles a private buffer and `finish` copies the used prefix out
 * once.
 */
class Growable<T extends TypedArray> {
  private buffer: ArrayBuffer | SharedArrayBuffer;
  private view: T;
  length = 0;

  constructor(
    private readonly ctor: TypedArrayCtor<T>,
    initialLength: number,
    private readonly maxLength: number,
    private readonly inPlace: boolean,
  ) {
    const bytes = Math.min(initialLength, maxLength) * ctor.BYTES_PER_ELEMENT;
    this.buffer = inPlace
      ? new SharedArrayBuffer(bytes, { maxByteLength: maxLength * ctor.BYTES_PER_ELEMENT })
      : new ArrayBuffer(bytes);
    this.view = new ctor(this.buffer);
  }

  push(v: number): void {
    if (this.length === this.view.length) this.grow(this.length + 1);
    this.view[this.length++] = v;
  }

  pushAll(values: ArrayLike<number>): void {
    if (this.length + values.length > this.view.length) this.grow(this.length + values.length);
    this.view.set(values as never, this.length);
    this.length += values.length;
  }

  finish(shared: boolean): T {
    if (this.inPlace) return new this.ctor(this.buffer, 0, this.length);
    const out = alloc(this.ctor, this.length, shared);
    out.set(this.view.subarray(0, this.length) as never);
    return out;
  }

  private grow(minLength: number): void {
    // In place, growth commits memory that can never be returned, so step finely;
    // a private buffer is copied on every growth, so double it.
    const factor = this.inPlace ? 1.25 : 2;
    const length = Math.min(
      Math.max(minLength, Math.ceil(this.view.length * factor)),
      this.maxLength,
    );
    if (length < minLength) throw new Error("lexical index outgrew its reserved size");
    if (this.buffer instanceof SharedArrayBuffer) {
      this.buffer.grow(length * this.ctor.BYTES_PER_ELEMENT);
      this.view = new this.ctor(this.buffer);
      return;
    }
    const next = new this.ctor(new ArrayBuffer(length * this.ctor.BYTES_PER_ELEMENT));
    next.set(this.view as never);
    this.buffer = next.buffer as ArrayBuffer;
    this.view = next;
  }
}
