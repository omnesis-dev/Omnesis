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
 *
 * Before every build the service checks that the index fits in memory (see
 * lexical-index-memory.ts). A build that would not fit is skipped: with no
 * index yet BM25 keeps ranking with FTS5, and an index already built keeps
 * serving. Each later check asks again, so the index is built once memory
 * frees up or the corpus shrinks.
 */

import { createLogger } from "@omnesis/core";
import { lexicalIndexBytes, type LexicalIndexData } from "./lexical-index-data.js";
import {
  formatSize,
  INDEX_SHARE_OF_TOTAL,
  PEAK_SHARE_OF_AVAILABLE,
  planLexicalIndexBuild,
  readHostMemory,
  type HostMemory,
  type LexicalCorpusStats,
  type LexicalIndexBuildPlan,
} from "./lexical-index-memory.js";
import type { KeywordIndexStatus } from "@omnesis/source-sdk";
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
  /** The corpus the next build would index, read cheaply before each build. */
  corpusStats: () => LexicalCorpusStats;
  /** Rankers holding scratch over each index: the main thread's plus each search worker's. */
  rankers: number;
  /** Build even when the index would not fit in memory. Read before each build. */
  ignoreMemoryCheck?: () => boolean;
  /** The process's memory; defaults to {@link readHostMemory}. */
  hostMemory?: () => HostMemory;
}

/** The config key that makes a build ignore the memory check. */
const IGNORE_MEMORY_CHECK_KEY = "search.bm25.memoryIndexIgnoreMemoryCheck";

export class LexicalIndexService {
  private current: { data: LexicalIndexData; builtAt: number } | null = null;
  private building: LexicalIndexBuild | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  /** The last build's outcome when it did not publish; null after a published build. */
  private setback: { kind: "too-large"; plan: LexicalIndexBuildPlan } | { kind: "failed" } | null =
    null;
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

  /** Where keyword ranking reads from, for `/index/stats` and the doctor. */
  status(): KeywordIndexStatus {
    const bytes = this.current ? lexicalIndexBytes(this.current.data) : undefined;
    const inMemory = bytes !== undefined;
    if (this.setback?.kind === "too-large") {
      const { plan } = this.setback;
      return {
        state: "too-large",
        inMemory,
        ...(inMemory ? { bytes } : {}),
        neededBytes: plan.peakBytes,
        message: tooLargeMessage(plan, inMemory),
      };
    }
    if (this.setback?.kind === "failed") {
      return {
        state: "failed",
        inMemory,
        ...(inMemory ? { bytes } : {}),
        message: inMemory
          ? "The in-memory keyword index could not be rebuilt; it keeps serving and the build is retried."
          : "The in-memory keyword index could not be built; keyword search ranks from the on-disk index until a retry succeeds.",
      };
    }
    if (inMemory) {
      return {
        state: "ready",
        inMemory,
        bytes,
        message: `Keyword search ranks from an in-memory index (${formatSize(bytes)}).`,
      };
    }
    return {
      state: "pending",
      inMemory,
      message:
        "The in-memory keyword index is not built yet; keyword search ranks from the on-disk index meanwhile.",
    };
  }

  private checkDue(): void {
    if (this.building || Date.now() < this.retryAt) return;
    if (!this.current) {
      void this.rebuild(
        this.setback?.kind === "too-large"
          ? "memory check passed"
          : `retry ${this.failures} after a failed build`,
      );
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
    const plan = this.admit();
    if (plan === false) return;
    log.info(
      `lexical index build started (${reason}` +
        (plan ? `; about ${formatSize(plan.peakBytes)} at its peak)` : ")"),
    );
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
    this.setback = null;
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

  /**
   * Whether the next build may run: its plan when it may, false when it does
   * not fit. Logs only when the answer changes, so a host that stays short of
   * memory warns once rather than at every check. A check that cannot read its
   * inputs lets the build run, with no plan.
   */
  private admit(): LexicalIndexBuildPlan | null | false {
    let plan: LexicalIndexBuildPlan;
    try {
      const current = this.current?.data;
      plan = planLexicalIndexBuild({
        corpus: this.opts.corpusStats(),
        memory: (this.opts.hostMemory ?? readHostMemory)(),
        rankers: this.opts.rankers,
        current: current
          ? {
              arrayBytes: lexicalIndexBytes(current),
              docCount: current.docCount,
              tokens: current.avgLength * current.docCount,
            }
          : null,
      });
    } catch (err) {
      log.warn(
        `could not check whether the lexical index fits in memory; building anyway: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (plan.fits) {
      if (this.setback?.kind === "too-large") {
        log.info(
          `lexical index now fits in memory (about ${formatSize(plan.peakBytes)} at its peak); building it`,
        );
        this.setback = null;
      }
      return plan;
    }
    if (this.opts.ignoreMemoryCheck?.()) {
      log.warn(
        `building the lexical index although it may not fit in memory, because ${IGNORE_MEMORY_CHECK_KEY} is true: ` +
          describePlan(plan),
      );
      return plan;
    }
    if (this.setback?.kind !== "too-large") {
      log.warn(`${tooLargeMessage(plan, this.current !== null)} (${describePlan(plan)})`);
    }
    this.setback = { kind: "too-large", plan };
    return false;
  }

  private recordFailure(err: unknown): void {
    this.failures++;
    this.setback = { kind: "failed" };
    // One check interval after the first failure, doubling up to the max age.
    const backoff = Math.min(this.checkIntervalMs * 2 ** (this.failures - 1), this.maxAgeMs);
    this.retryAt = Date.now() + backoff;
    log.warn(
      `lexical index build failed (retry in ${Math.round(backoff / 60_000)} min); ` +
        `BM25 keeps its current ranker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The operator-facing explanation of a skipped build, shared by the log, `/index/stats` and the doctor. */
function tooLargeMessage(plan: LexicalIndexBuildPlan, inMemory: boolean): string {
  const need =
    plan.limitedBy === "total"
      ? `would hold about ${formatSize(plan.indexBytes)}, more than a quarter of the ` +
        `${formatSize(plan.indexBudgetBytes / INDEX_SHARE_OF_TOTAL)} of memory on this host`
      : `would need about ${formatSize(plan.peakBytes)} while it builds, more than half of the ` +
        `${formatSize(plan.peakBudgetBytes / PEAK_SHARE_OF_AVAILABLE)} of memory available`;
  const now = inMemory
    ? "Keyword search keeps the in-memory index built earlier without rebuilding it"
    : "Keyword search ranks from the on-disk index";
  return `${now}: the in-memory keyword index ${need}. Set ${IGNORE_MEMORY_CHECK_KEY} to true to build it anyway.`;
}

function describePlan(plan: LexicalIndexBuildPlan): string {
  return (
    `peak ${formatSize(plan.peakBytes)} of a ${formatSize(plan.peakBudgetBytes)} budget, ` +
    `index ${formatSize(plan.indexBytes)} of a ${formatSize(plan.indexBudgetBytes)} budget`
  );
}
