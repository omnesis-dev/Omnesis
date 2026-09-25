// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { HistoryCoverage, SyncProgress } from "@omnesis/source-sdk";
import type { SourceStatus } from "./source-lifecycle.js";

const DEFAULT_THROTTLE_MS = 500;

/**
 * Per-sync throttle for `sync.progress` emissions. Sources can emit a
 * progress update every page (potentially many times per second). The
 * tracker drops events that fire within `throttleMs` of the last one;
 * the WebSocket clients get a smooth ~2 Hz feed even when bootstrap
 * tears through pages.
 *
 * One instance per `syncSource()` invocation. After the run finishes
 * the instance is discarded.
 */
/**
 * How much a claim concedes, weakest first.
 *
 * A source that says "partial" knows it is missing history; one that says
 * "unknown" only knows it cannot tell. Between the two the definite answer is
 * the one worth showing, so it outranks the vague one — and both outrank
 * "complete", which concedes nothing.
 */
const CLAIM_RANK: Record<HistoryCoverage, number> = { partial: 0, unknown: 1, complete: 2 };

export class ProgressTracker {
  private lastEmitMs = 0;
  /**
   * The standing claim per subject this run, each one the latest that subject
   * made. The source's claim is the weakest of them.
   */
  private readonly claims = new Map<string, { coverage: HistoryCoverage; detail?: string }>();

  constructor(
    private readonly emit: (status: SourceStatus) => void,
    private readonly throttleMs: number = DEFAULT_THROTTLE_MS,
  ) {}

  /**
   * Update the status's `progress` block from a per-page progress
   * report and emit (subject to throttle). `processedDocs` is the
   * caller's running total — `result.progress.total` is treated as the
   * cycle's queue size and percentComplete derives from `processed /
   * total`.
   */
  reportPage(status: SourceStatus, pageProgress: SyncProgress, processedDocs: number): void {
    status.progress = {
      ...pageProgress,
      processed: processedDocs,
      percentComplete: pageProgress.total
        ? Math.min(100, Math.round((processedDocs / pageProgress.total) * 100))
        : undefined,
    };
    // A coverage claim is about the corpus, not this page, so it is copied
    // somewhere the terminal transitions do not clear. A page that makes no
    // claim leaves the last one standing rather than erasing it.
    //
    // Claims combine by subject: the latest one about a given subject
    // replaces its predecessor, and the source's claim is the weakest across
    // subjects.
    //
    // Both halves are load-bearing, and each is wrong for the other's case. A
    // bank session holding several accounts can be missing history on one and
    // whole on another; both are true at once, and taking the last would let
    // whichever account finished last speak for the connection — resolving in
    // whichever direction the iteration order fell, which for a claim about
    // missing history can be the reassuring one. A messaging source has one
    // subject, and its bootstrap says "still arriving" on every page until the
    // page where it says "finished". That is one claim revised, not two
    // claims held, and keeping the weaker would re-assert a question the
    // source had just answered — on the longest run it ever has, the one right
    // after pairing.
    if (pageProgress.coverage !== undefined) {
      this.claims.set(pageProgress.coverageSubject ?? "", {
        coverage: pageProgress.coverage,
        detail: pageProgress.detail,
      });
      let weakest: { coverage: HistoryCoverage; detail?: string } | undefined;
      for (const claim of this.claims.values()) {
        if (!weakest || CLAIM_RANK[claim.coverage] < CLAIM_RANK[weakest.coverage]) weakest = claim;
      }
      status.coverage = weakest!.coverage;
      status.coverageDetail = weakest!.detail;
    }
    this.maybeEmit(status);
  }

  /** Emit the current source status, respecting the progress throttle. */
  maybeEmit(status: SourceStatus): void {
    const now = Date.now();
    if (now - this.lastEmitMs < this.throttleMs) return;
    this.emit(status);
    this.lastEmitMs = now;
  }
}
