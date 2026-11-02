// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeps a search worker's in-memory lexical ranker current between queries.
 *
 * Left to queries alone, a ranker catches up on the `chunks_fts_changes` log
 * only within each query's small time budget. Under steady chunk churn — a
 * large document re-chunked every few seconds — the changes between two
 * queries can outgrow that budget, and a ranker that declines hands its query
 * to FTS5, which takes seconds over a large corpus while still more changes
 * pile up. This loop applies the log in short slices whenever the thread is
 * free, so a query normally finds at most a second of changes, and its rankers
 * rank with what they have applied when a burst briefly outruns them.
 *
 * A freshly built index reflects the corpus as of its build's start and
 * arrives minutes behind. It serves at once when the thread has no usable
 * ranker; otherwise the current ranker keeps serving while the loop catches the
 * new one up, and the new one takes over when it is current.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { LexicalIndex } from "./lexical-index.js";
import type { LexicalIndexData } from "./lexical-index-data.js";

/** Longest a single slice of catching up holds the thread. */
const SLICE_MS = 20;
/** Pause between slices once both rankers are current — the query path's own read interval. */
const IDLE_MS = 1_000;

export interface LexicalIndexFollowerOptions {
  sliceMs?: number;
  idleMs?: number;
  /** A slice that threw; the loop carries on at its idle pace. */
  onError?: (err: unknown) => void;
}

export class LexicalIndexFollower {
  private current: LexicalIndex | undefined;
  private next: LexicalIndex | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly sliceMs: number;
  private readonly idleMs: number;

  constructor(
    private readonly db: Db,
    private readonly opts: LexicalIndexFollowerOptions = {},
  ) {
    this.sliceMs = opts.sliceMs ?? SLICE_MS;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  /** The ranker queries use, if any. */
  get ranker(): LexicalIndex | undefined {
    return this.current;
  }

  /** Take a freshly built index; see the file comment for when it starts serving. */
  attach(data: LexicalIndexData): void {
    const index = new LexicalIndex(data, { rankWhileBehind: true });
    if (!this.current || this.current.declined) {
      this.current = index;
      this.next = undefined;
    } else {
      this.next = index;
    }
    this.schedule(0);
  }

  /** One slice for each ranker that is behind. Returns true while either has entries left to apply. */
  step(): boolean {
    let behind = false;
    if (this.current && !this.current.declined) {
      behind = this.current.follow(this.db, this.sliceMs);
    }
    const next = this.next;
    if (next) {
      if (next.follow(this.db, this.sliceMs)) behind = true;
      else if (next.declined) this.next = undefined;
      else {
        this.current = next;
        this.next = undefined;
      }
    }
    return behind;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      let behind = false;
      try {
        behind = this.step();
      } catch (err) {
        this.opts.onError?.(err);
      }
      this.schedule(behind ? 0 : this.idleMs);
    }, delayMs);
    this.timer.unref?.();
  }
}
