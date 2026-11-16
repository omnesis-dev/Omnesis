// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tokenization for the in-memory lexical index, done by FTS5 itself.
 *
 * Query words and changed chunks are run through scratch FTS5 tables in the
 * connection's TEMP schema, created with the exact `tokenize=` spec of the
 * index being searched, and read back through `fts5vocab`. That guarantees the
 * terms match the indexed ones — Porter stemming, diacritic folding and all —
 * without reimplementing any of it. Text a lexical version rewrites (see
 * lexical-versions.ts) arrives here already rewritten. TEMP tables are private
 * to the connection and work on read-only handles and inside an open read
 * transaction.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/** Column weights of `bm25(chunks_fts, 1.0, 2.0)`: content, title. */
export const COLUMN_WEIGHTS: Readonly<Record<string, number>> = { content: 1, title: 2 };

export interface TokenizedChunk {
  rowid: number;
  /** Total tokens across title and content. */
  length: number;
  /** term → column-weighted frequency. */
  freqs: Map<string, number>;
}

export interface ChunkRow {
  rowid: number;
  content: string | null;
  title: string | null;
}

export interface Fts5Tokenizer {
  /** Each word's tokens, in order; a word may yield zero or several (`foo_bar`). */
  words(words: readonly string[]): string[][];
  /**
   * `word` folded as the index folds it — case and diacritics — but not
   * stemmed, for a type-ahead prefix: `res` is the start of "reservation", not
   * the stem `re`. Empty when the word holds no token characters.
   */
  fold(word: string): string;
  /** Chunk rows tokenized as the index indexes them, after any rewrite. */
  chunks(rows: readonly ChunkRow[]): TokenizedChunk[];
}

const tokenizers = new WeakMap<Db, Map<string, Fts5Tokenizer>>();

/** The tokenizer for `tokenize` (an FTS5 `tokenize=` spec) bound to `db`, created on first use. */
export function fts5Tokenizer(db: Db, tokenize: string): Fts5Tokenizer {
  let byTokenize = tokenizers.get(db);
  if (!byTokenize) {
    byTokenize = new Map();
    tokenizers.set(db, byTokenize);
  }
  let tokenizer = byTokenize.get(tokenize);
  if (!tokenizer) {
    tokenizer = createTokenizer(db, tokenize, byTokenize.size);
    byTokenize.set(tokenize, tokenizer);
  }
  return tokenizer;
}

/**
 * unicode61 with `remove_diacritics 2`: lowercase, combining marks removed.
 * Used for a type-ahead prefix, which must not be stemmed — `res` is the start
 * of "reservation", not the stem `re`.
 */
export function foldPrefix(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function createTokenizer(db: Db, tokenize: string, id: number): Fts5Tokenizer {
  // Chunk text staged in TEMP tables must not spill to disk unencrypted. Search
  // handles set this when they open; SQLite refuses the change inside a
  // transaction, and making it drops existing TEMP objects, so only a handle
  // that has not done so already and is outside one sets it here.
  if (!db.inTransaction && db.pragma("temp_store", { simple: true }) !== 2) {
    db.pragma("temp_store = MEMORY");
  }
  const spec = tokenize.replace(/'/g, "''");
  // The same tokenizer without its stemming wrapper, for prefix folding.
  const foldSpec = tokenize.replace(/^\s*porter\s+/i, "").replace(/'/g, "''");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_words${id} USING fts5(w, tokenize='${spec}');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_words${id}_tokens
      USING fts5vocab(temp, lexical_words${id}, 'instance');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_chunks${id}
      USING fts5(content, title, tokenize='${spec}');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_chunks${id}_tokens
      USING fts5vocab(temp, lexical_chunks${id}, 'instance');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_fold${id} USING fts5(w, tokenize='${foldSpec}');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.lexical_fold${id}_tokens
      USING fts5vocab(temp, lexical_fold${id}, 'instance');
  `);
  const clearFold = db.prepare(`DELETE FROM temp.lexical_fold${id}`);
  const insertFold = db.prepare(`INSERT INTO temp.lexical_fold${id}(rowid, w) VALUES (1, ?)`);
  const readFold = db
    .prepare<[], [string]>(`SELECT term FROM temp.lexical_fold${id}_tokens ORDER BY offset`)
    .raw();
  const clearWords = db.prepare(`DELETE FROM temp.lexical_words${id}`);
  const insertWord = db.prepare(`INSERT INTO temp.lexical_words${id}(rowid, w) VALUES (?, ?)`);
  const readWords = db
    .prepare<[], [string, number]>(
      `SELECT term, doc FROM temp.lexical_words${id}_tokens ORDER BY doc, offset`,
    )
    .raw();
  const clearChunks = db.prepare(`DELETE FROM temp.lexical_chunks${id}`);
  const insertChunk = db.prepare(
    `INSERT INTO temp.lexical_chunks${id}(rowid, content, title) VALUES (?, ?, ?)`,
  );
  const readChunks = db
    .prepare<[], [string, number, string]>(
      `SELECT term, doc, col FROM temp.lexical_chunks${id}_tokens`,
    )
    .raw();
  return {
    fold(word) {
      clearFold.run();
      insertFold.run(word);
      const out = readFold
        .all()
        .map(([t]) => t)
        .join("");
      clearFold.run();
      return out;
    },
    words(words) {
      clearWords.run();
      words.forEach((w, i) => insertWord.run(i + 1, w));
      const out: string[][] = words.map(() => []);
      for (const [term, doc] of readWords.all()) out[doc - 1].push(term);
      clearWords.run();
      return out;
    },
    chunks(rows) {
      clearChunks.run();
      for (const r of rows) insertChunk.run(r.rowid, r.content ?? "", r.title ?? "");
      const byRowid = new Map<number, TokenizedChunk>(
        rows.map((r) => [r.rowid, { rowid: r.rowid, length: 0, freqs: new Map() }]),
      );
      for (const [term, rowid, col] of readChunks.all()) {
        const chunk = byRowid.get(rowid)!;
        chunk.length++;
        chunk.freqs.set(term, (chunk.freqs.get(term) ?? 0) + (COLUMN_WEIGHTS[col] ?? 1));
      }
      clearChunks.run();
      return [...byRowid.values()];
    },
  };
}
