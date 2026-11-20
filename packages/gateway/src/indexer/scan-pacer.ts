// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Page size and pause for the indexing scan.
 *
 * The scan used to read `pageSize` documents, then sleep `betweenPageSleep`,
 * whatever the page held. The pause exists so the scan's reads and index
 * writes leave gaps for the rest of the gateway — the writer's commits and
 * checkpoints on omnesis.db, interactive search on index.db, and the CPU an
 * interactive request needs. At a fixed pace it also capped the scan at
 * `pageSize / betweenPageSleep` documents a second, including the pages
 * where every document was already indexed and nothing but a hash comparison
 * was done.
 *
 * The configured `pageSize` and `betweenPageSleep` remain the pace whenever
 * something else needs the machine. When nothing does and the scan has a
 * backlog, the pacer catches up:
 *
 *  - Pages a document hash check finishes quickly grow, doubling up to
 *    `maxPageSize`, and the pause drops to `minSleepMs`.
 *  - The documents a page sends to the embedder are bounded separately
 *    (`embedDocs`) and adapt to the page time: a page slower than
 *    `targetPageMs` halves it, a page under half of it doubles it, never past
 *    `maxEmbedDocs`. A page that reaches the bound ends there and the next
 *    page continues after it, so a page stays about as long as the target
 *    however much of it needs embedding — which also bounds how long a
 *    shutdown waits for the embedding in flight.
 *  - Backpressure returns the scan to the configured pace at once: a user
 *    request in flight (the scheduler's admission control is engaged), or
 *    more than `walPendingFramesLimit` frames in index.db's WAL that no
 *    checkpoint has copied, which means readers are holding the WAL and every
 *    further write makes it longer. While the WAL stays over the limit the
 *    pause doubles, up to `maxWalSleepMs`, so the checkpoint can catch up.
 */

import type { ScanPressure } from "./scan-progress.js";

export interface ScanPacingOptions {
  /** Configured `indexer.pageSize`: the page under pressure, and the floor. */
  basePageSize: number;
  /** Configured `indexer.betweenPageSleep`, ms: the pause under pressure. */
  baseSleepMs: number;
  /** Adapt to the backlog; false keeps the configured pace on every page. */
  adaptive: boolean;
  /** Largest page while catching up. */
  maxPageSize: number;
  /** Pause between pages while catching up, ms. */
  minSleepMs: number;
  /** Page time the embedding bound aims for, ms. */
  targetPageMs?: number;
  /** Largest number of documents one page sends to the embedder. */
  maxEmbedDocs?: number;
  /** Uncopied index.db WAL frames past which the scan backs off. */
  walPendingFramesLimit?: number;
  /** Longest pause while the WAL is over the limit, ms. */
  maxWalSleepMs?: number;
}

export interface ScanPressureSignal {
  /** A user request is in flight on the gateway. */
  userActive: boolean;
  /** index.db WAL frames not yet copied back by a checkpoint. */
  walPendingFrames: number;
}

export interface ScanPageSizing {
  /** Documents the next lightweight scan reads. */
  pageSize: number;
  /** Documents the next page may send to the embedder before it ends. */
  embedDocs: number;
}

export const DEFAULT_TARGET_PAGE_MS = 1_000;
export const DEFAULT_MAX_EMBED_DOCS = 200;
export const DEFAULT_WAL_PENDING_FRAMES_LIMIT = 16_384;
export const DEFAULT_MAX_WAL_SLEEP_MS = 5_000;

export class ScanPacer {
  private pageSize: number;
  private embedDocs: number;
  private sleepMs: number;
  private pressure: ScanPressure = "none";
  private readonly basePageSize: number;
  private readonly maxPageSize: number;
  private readonly targetPageMs: number;
  private readonly maxEmbedDocs: number;
  private readonly walPendingFramesLimit: number;
  private readonly maxWalSleepMs: number;

  constructor(private readonly opts: ScanPacingOptions) {
    this.basePageSize = Math.max(1, Math.floor(opts.basePageSize));
    this.maxPageSize = Math.max(this.basePageSize, Math.floor(opts.maxPageSize));
    this.targetPageMs = opts.targetPageMs ?? DEFAULT_TARGET_PAGE_MS;
    this.maxEmbedDocs = Math.max(
      this.basePageSize,
      Math.floor(opts.maxEmbedDocs ?? DEFAULT_MAX_EMBED_DOCS),
    );
    this.walPendingFramesLimit = opts.walPendingFramesLimit ?? DEFAULT_WAL_PENDING_FRAMES_LIMIT;
    this.maxWalSleepMs = Math.max(opts.baseSleepMs, opts.maxWalSleepMs ?? DEFAULT_MAX_WAL_SLEEP_MS);
    this.pageSize = this.basePageSize;
    this.embedDocs = this.basePageSize;
    this.sleepMs = opts.baseSleepMs;
  }

  /** Sizing for the next page. */
  next(): ScanPageSizing {
    if (!this.opts.adaptive) return { pageSize: this.basePageSize, embedDocs: this.basePageSize };
    return { pageSize: this.pageSize, embedDocs: Math.min(this.embedDocs, this.pageSize) };
  }

  /**
   * Record a finished page and return the pause before the next one.
   * `elapsedMs` is the page's own time, from its scan through its writes;
   * `embedLimited` is true when the page ended at the embedding bound.
   */
  settle(page: { elapsedMs: number; embedLimited: boolean }, signal: ScanPressureSignal): number {
    if (!this.opts.adaptive) {
      this.pressure = "none";
      this.sleepMs = this.opts.baseSleepMs;
      return this.sleepMs;
    }
    if (signal.walPendingFrames > this.walPendingFramesLimit) {
      const backoff = this.pressure === "wal" ? this.sleepMs * 2 : this.opts.baseSleepMs;
      this.toBase("wal");
      this.sleepMs = Math.min(this.maxWalSleepMs, Math.max(this.opts.baseSleepMs, backoff, 1));
      return this.sleepMs;
    }
    if (signal.userActive) {
      this.toBase("user");
      this.sleepMs = this.opts.baseSleepMs;
      return this.sleepMs;
    }
    this.pressure = "none";
    this.sleepMs = this.opts.minSleepMs;
    if (page.elapsedMs > this.targetPageMs) {
      this.embedDocs = Math.max(this.basePageSize, Math.floor(this.embedDocs / 2));
      if (page.elapsedMs > 2 * this.targetPageMs) {
        this.pageSize = Math.max(this.basePageSize, Math.floor(this.pageSize / 2));
      }
    } else if (page.elapsedMs <= this.targetPageMs / 2) {
      this.pageSize = Math.min(this.maxPageSize, this.pageSize * 2);
      if (page.embedLimited) this.embedDocs = Math.min(this.maxEmbedDocs, this.embedDocs * 2);
    }
    return this.sleepMs;
  }

  /** The pace in effect, for the durable scan record. */
  current(): { pageSize: number; sleepMs: number; pressure: ScanPressure } {
    const { pageSize } = this.next();
    return { pageSize, sleepMs: this.sleepMs, pressure: this.pressure };
  }

  private toBase(pressure: ScanPressure): void {
    this.pressure = pressure;
    this.pageSize = this.basePageSize;
    this.embedDocs = Math.min(this.embedDocs, this.basePageSize);
  }
}
