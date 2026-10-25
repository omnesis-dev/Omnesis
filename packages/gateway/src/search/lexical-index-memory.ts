// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether the in-memory lexical index fits on this host.
 *
 * Before each build, {@link planLexicalIndexBuild} estimates what the index
 * will hold and what the build needs at its peak, from the corpus size FTS5
 * already records, and compares both with the host's memory. A build that
 * would not fit is skipped and BM25 keeps ranking with FTS5 on disk, so a
 * small host with a large corpus degrades to slower keyword ranking instead of
 * swapping or being killed by the kernel.
 */

import { totalmem } from "node:os";
import { DENSE_LOOKUP_MAX_ROWID, decodeVarints } from "./lexical-index-data.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The corpus a build would index, read without scanning it. */
export interface LexicalCorpusStats {
  /** Chunks in the FTS index. */
  chunks: number;
  /** Tokens across every chunk and column. */
  tokens: number;
  /** Largest chunk rowid, which sizes the build's rowid lookup table. */
  maxRowid: number;
}

/** Memory this process can use, in bytes. */
export interface HostMemory {
  /** Memory available to the process now, page cache and other reclaimable memory included. */
  availableBytes: number;
  /** All the memory the process may ever use: the host's, or its cgroup limit when lower. */
  totalBytes: number;
}

/** What the published index holds now, as measured. */
export interface LexicalIndexFootprint {
  /** Bytes of the index's own arrays (`lexicalIndexBytes`). */
  arrayBytes: number;
  docCount: number;
  /** Tokens the index was built from. */
  tokens: number;
}

export interface LexicalIndexBuildPlan {
  fits: boolean;
  /** Which limit a build that does not fit exceeds. */
  limitedBy?: "available" | "total";
  /** Bytes the index will hold once built, every ranker's scratch included. */
  indexBytes: number;
  /** Bytes held while the build runs: the current index, the new one and the build's working memory. */
  peakBytes: number;
  /** The most `peakBytes` may be. */
  peakBudgetBytes: number;
  /** The most `indexBytes` may be. */
  indexBudgetBytes: number;
}

/** `rowids` (Uint32) and `lengthNorm` (Float64) hold one entry per chunk. */
const ARRAY_BYTES_PER_CHUNK = 4 + 8;
/**
 * Every ranker (the main thread's and each search worker's) allocates its own
 * per-chunk scratch over the shared arrays: two Float64 accumulators, a Uint32
 * touched list and a Uint8 change mask (see `LexicalIndex`).
 */
const RANKER_BYTES_PER_CHUNK = 8 + 8 + 4 + 1;
/**
 * A posting is a Uint32 doc index and a Uint16 frequency. A chunk has at most
 * one posting per token, so the token count bounds the postings; the posting
 * buffers grow in place by steps of a quarter, so up to a quarter more is
 * committed than used. Together: at most 7.5 B per token.
 */
const POSTING_BYTES_PER_TOKEN = (4 + 2) * 1.25;
/**
 * The term dictionary (each distinct term's UTF-8 bytes plus two Uint32
 * offsets) is the one part the counts FTS5 keeps cannot bound, so it gets an
 * allowance per token above every corpus measured: 0.25-0.4 B per token on
 * prose and code chunked at 150 to 2,048 characters, under 2 B on a mixed
 * corpus of mail, messages and files rich in identifiers, and 2.3 B on
 * synthetic text whose every word is rare.
 */
const DICTIONARY_BYTES_PER_TOKEN = 2.5;
/** The build's own per-chunk working array: a Float64 length per chunk. */
const BUILD_BYTES_PER_CHUNK = 8;
/**
 * The build thread's fixed working memory: its SQLite handle's 64 MiB page
 * cache, the fts5vocab cursor and the thread's own heap.
 */
const BUILD_FIXED_BYTES = 128 * 1024 * 1024;

/**
 * The build's peak may take at most this share of the memory it could use
 * (what is available now plus what the current index already holds). The
 * other half stays for what grows after the check: the gateway's SQLite page
 * caches and model runtimes, the kernel page cache the on-disk indexes read
 * through, the change-log deltas the rankers accumulate between builds, and
 * every other process on the host.
 */
export const PEAK_SHARE_OF_AVAILABLE = 0.5;
/**
 * The built index may take at most this share of all the process's memory.
 * The index stays resident until the next build, so a host that happens to
 * have memory free at check time must not commit most of it for hours.
 */
export const INDEX_SHARE_OF_TOTAL = 0.25;

/**
 * Read the corpus size from FTS5's own bookkeeping: the averages record
 * (rowid 1 of `chunks_fts_data`) holds the row count followed by each
 * column's total token count as varints, which FTS5 keeps current for BM25's
 * average document length. Two point lookups, so it is cheap enough for the
 * main thread before every build.
 */
export function readLexicalCorpusStats(db: Db): LexicalCorpusStats {
  const averages = db
    .prepare<[], { block: Buffer }>("SELECT block FROM chunks_fts_data WHERE id = 1")
    .get();
  const [chunks = 0, ...columnTokens] = averages ? decodeVarints(averages.block) : [];
  const maxRowid =
    db.prepare<[], { id: number | null }>("SELECT max(id) AS id FROM chunks_fts_docsize").get()
      ?.id ?? 0;
  return { chunks, tokens: columnTokens.reduce((sum, n) => sum + n, 0), maxRowid };
}

/**
 * The process's memory as libuv reports it. `process.availableMemory()` reads
 * `MemAvailable` from /proc/meminfo on Linux (free memory plus the page cache
 * and other memory the kernel can reclaim, unlike `MemFree`), counts inactive
 * and purgeable pages on macOS, and is capped by a cgroup limit inside a
 * container, where /proc/meminfo would describe the whole host.
 */
export function readHostMemory(): HostMemory {
  const constrained = process.constrainedMemory();
  const host = totalmem();
  return {
    availableBytes: process.availableMemory(),
    totalBytes: constrained > 0 && constrained < host ? constrained : host,
  };
}

/**
 * Estimate what a build of `corpus` will hold and need, and whether it fits.
 *
 * With an index already built, its measured array bytes scaled by the change
 * in token count predict the next one. Without one, the arrays are estimated
 * from their layout: `12 B × chunks + 10 B × tokens` (7.5 B bounding the
 * postings, 2.5 B for the term dictionary). Either way every
 * ranker adds `21 B × chunks` of scratch, and the build itself needs
 * `8 B × chunks`, a rowid lookup table of `4 B × (max rowid + 1)` when the
 * rowid space is dense enough to use one, and {@link BUILD_FIXED_BYTES}.
 *
 * The current index is not freed before the new one is built (it keeps
 * serving queries until the new one replaces it), so the peak is the current
 * index plus the new index plus the build's working memory. A build fits when
 * that peak is at most {@link PEAK_SHARE_OF_AVAILABLE} of the available memory
 * plus what the current index holds, and the new index is at most
 * {@link INDEX_SHARE_OF_TOTAL} of the process's total memory.
 */
export function planLexicalIndexBuild(input: {
  corpus: LexicalCorpusStats;
  memory: HostMemory;
  /** Rankers that will hold scratch over the index: the main thread plus each search worker. */
  rankers: number;
  current?: LexicalIndexFootprint | null;
}): LexicalIndexBuildPlan {
  const { corpus, memory, rankers, current } = input;
  const rankerBytes = (chunks: number) => rankers * RANKER_BYTES_PER_CHUNK * chunks;

  const arrayBytes =
    current && current.tokens > 0
      ? current.arrayBytes * (corpus.tokens / current.tokens)
      : ARRAY_BYTES_PER_CHUNK * corpus.chunks +
        (POSTING_BYTES_PER_TOKEN + DICTIONARY_BYTES_PER_TOKEN) * corpus.tokens;
  const indexBytes = arrayBytes + rankerBytes(corpus.chunks);
  const buildBytes =
    BUILD_BYTES_PER_CHUNK * corpus.chunks +
    (corpus.maxRowid < DENSE_LOOKUP_MAX_ROWID ? 4 * (corpus.maxRowid + 1) : 0) +
    BUILD_FIXED_BYTES;
  const currentBytes = current ? current.arrayBytes + rankerBytes(current.docCount) : 0;

  const peakBytes = currentBytes + indexBytes + buildBytes;
  const peakBudgetBytes = PEAK_SHARE_OF_AVAILABLE * (memory.availableBytes + currentBytes);
  const indexBudgetBytes = INDEX_SHARE_OF_TOTAL * memory.totalBytes;
  const limitedBy =
    peakBytes > peakBudgetBytes ? "available" : indexBytes > indexBudgetBytes ? "total" : undefined;
  return {
    fits: limitedBy === undefined,
    ...(limitedBy ? { limitedBy } : {}),
    indexBytes: Math.round(indexBytes),
    peakBytes: Math.round(peakBytes),
    peakBudgetBytes: Math.round(peakBudgetBytes),
    indexBudgetBytes: Math.round(indexBudgetBytes),
  };
}

/** A memory size for operators: gigabytes with one decimal from 1 GB, whole megabytes below. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
