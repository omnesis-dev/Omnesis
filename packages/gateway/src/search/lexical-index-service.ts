// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeps the in-memory lexical index built and reasonably fresh.
 *
 * Between builds each ranker stays current on its own by following the
 * `chunks_fts_changes` log (see lexical-index.ts), but that costs a little more
 * per query as changes pile up, document frequencies age, and a ranker whose
 * delta fills hands its queries back to FTS5. So the service rebuilds once the
 * log holds {@link LexicalIndexServiceOptions.changeFraction} of the indexed
 * chunk count in changes since the last build, or once the index is older than
 * {@link LexicalIndexServiceOptions.maxAgeMs}. A failed build is retried with
 * exponential backoff; until a build lands, BM25 ranks with FTS5.
 */

import { createLogger } from "@omnesis/core";
import { lexicalIndexBytes, type LexicalIndexData } from "./lexical-index-data.js";
import type { LexicalIndexBuild } from "../workers/lexical-index-build.js";

const log = createLogger("gateway:search:lexical");

export interface LexicalIndexServiceOptions {
  /** Start one off-thread build. */
  build: () => LexicalIndexBuild;
  /** Change-log entries written after `changeSeq`. */
  countChanges: (changeSeq: number) => number;
  /** Receives every freshly built index. */
  publish: (data: LexicalIndexData) => void;
  /** Rebuild once changes since the build reach this fraction of the indexed chunks. */
  changeFraction?: number;
  /** Rebuild an index older than this, whatever the changes. */
  maxAgeMs?: number;
  /** How often to check whether a rebuild is due. */
  checkIntervalMs?: number;
}

export class LexicalIndexService {
  private current: { data: LexicalIndexData; builtAt: number } | null = null;
  private building: LexicalIndexBuild | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  private readonly changeFraction: number;
  private readonly maxAgeMs: number;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: LexicalIndexServiceOptions) {
    this.changeFraction = opts.changeFraction ?? 0.02;
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 10 * 60 * 1000;
  }

  /** Build now, then keep checking whether a rebuild is due. A no-op once stopped. */
  start(): void {
    if (this.stopped || this.timer) return;
    void this.rebuild("initial build");
    this.timer = setInterval(() => this.checkDue(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.building?.terminate();
  }

  private checkDue(): void {
    if (this.building || Date.now() < this.retryAt) return;
    if (!this.current) {
      void this.rebuild(`retry ${this.failures} after a failed build`);
      return;
    }
    const { data, builtAt } = this.current;
    const age = Date.now() - builtAt;
    if (age >= this.maxAgeMs) {
      void this.rebuild(`index is ${Math.round(age / 60_000)} min old`);
      return;
    }
    let changes: number;
    try {
      changes = this.opts.countChanges(data.changeSeq);
    } catch (err) {
      log.warn(
        `could not count chunk changes: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (changes >= Math.max(1, data.docCount * this.changeFraction)) {
      void this.rebuild(`${changes} chunk changes since the last build`);
    }
  }

  private async rebuild(reason: string): Promise<void> {
    if (this.stopped || this.building) return;
    log.info(`lexical index build started (${reason})`);
    let built: { data: LexicalIndexData; ms: number };
    try {
      this.building = this.opts.build();
      built = await this.building.done;
    } catch (err) {
      if (!this.stopped) this.recordFailure(err);
      return;
    } finally {
      this.building = null;
    }
    if (this.stopped) return;
    const { data, ms } = built;
    this.current = { data, builtAt: Date.now() };
    this.failures = 0;
    this.retryAt = 0;
    try {
      this.opts.publish(data);
    } catch (err) {
      log.warn(
        `lexical index built but could not be published: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    log.info(
      `lexical index ready in ${ms}ms: ${data.docCount} chunks, ${data.postingDoc.length} postings, ` +
        `${Math.round(lexicalIndexBytes(data) / (1024 * 1024))} MiB`,
    );
  }

  private recordFailure(err: unknown): void {
    this.failures++;
    // One check interval after the first failure, doubling up to the max age.
    const backoff = Math.min(this.checkIntervalMs * 2 ** (this.failures - 1), this.maxAgeMs);
    this.retryAt = Date.now() + backoff;
    log.warn(
      `lexical index build failed (retry in ${Math.round(backoff / 60_000)} min); ` +
        `BM25 keeps its current ranker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
