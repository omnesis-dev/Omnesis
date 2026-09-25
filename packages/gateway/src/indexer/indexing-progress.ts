// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Index-completion accounting.
 *
 * A document is "done" once the indexer has reached a **terminal** state for
 * it — either it was successfully indexed, or it terminally errored (e.g. a
 * chunk the embedder rejects, or content that yields nothing embeddable).
 * Counting errored docs toward completion is what lets the progress bar reach
 * 100% and the ETA reach zero once the indexer has caught up, instead of
 * stalling a hair under 100% forever on a handful of un-embeddable docs (their
 * failures are still surfaced separately as the error count, so nothing is
 * hidden). Retryable failures move back out of the error count if a later
 * sweep succeeds, so the number self-corrects.
 */
export interface IndexingProgress {
  /** 0–100, rounded and clamped. Reaches 100 once indexed + errored ≥ total. */
  percent: number;
  /** Docs not yet in a terminal state. 0 once the indexer has caught up. */
  remaining: number;
}

export function computeIndexingProgress(
  indexed: number,
  errored: number,
  total: number,
): IndexingProgress {
  if (total <= 0) return { percent: 0, remaining: 0 };
  const done = indexed + errored;
  const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  const remaining = Math.max(0, total - done);
  return { percent, remaining };
}
