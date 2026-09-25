// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The dismissal half of the feedback loop: one atomic write that flips a
 * brief into its `dismissed_*` state (storing the user's free text) and
 * enqueues the async `feedback` run the Cognition Steward reacts with. The two
 * must land together — a dismissal the agent never hears about, or a
 * feedback run for a brief still showing, both break the contract — so
 * the whole thing runs inside a single writer-worker transaction.
 *
 * Reason model (mirrors the iOS dismiss modal): `already_handled` exists
 * only on `loop`-kind briefs and `acknowledged` only on `info`-kind — the
 * engine enforces the pairing so a client bug is a loud 400, not a
 * silently-wrong state. `snoozed` may carry the user-picked re-surface
 * time; the other reasons never do (the agent decides everything else).
 * When the user did pick a time, it is written to the brief's `next_show`
 * in this same transaction, so the durable snooze-resurface sweep returns
 * the brief to the feed on schedule regardless of the async feedback run.
 *
 * A brief already in a terminal `dismissed_*` state refuses re-dismissal
 * ("never shown again" is one-way). `dismissed_snoozed` is re-dismissable
 * — the newest signal wins, and the pending feedback run (same dedupe
 * key) folds instead of stacking.
 */

import { isTerminalBriefState, type BriefKind, type BriefState } from "./storage/types.js";
import { enqueueCognitionRun } from "./storage/run-queue.js";
import { feedbackRunDedupeKey, type CognitionFeedbackRunPayload } from "./run-payloads.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The dismiss modal's reasons. Kind-conditional: see the module doc. */
export type BriefDismissReason =
  | "not_relevant"
  | "wrong"
  | "already_handled"
  | "acknowledged"
  | "snoozed";

export const BRIEF_DISMISS_REASONS: readonly BriefDismissReason[] = [
  "not_relevant",
  "wrong",
  "already_handled",
  "acknowledged",
  "snoozed",
];

const REASON_TO_STATE: Record<BriefDismissReason, BriefState> = {
  not_relevant: "dismissed_not_relevant",
  wrong: "dismissed_wrong",
  already_handled: "dismissed_already_handled",
  acknowledged: "dismissed_acknowledged",
  snoozed: "dismissed_snoozed",
};

export interface DismissBriefInput {
  briefId: string;
  reason: BriefDismissReason;
  /** Free text the user typed in the dismiss modal; null/absent = none. */
  feedback?: string | null;
  /**
   * User-picked snooze re-surface time (unix ms). Only valid with reason
   * `snoozed`; absent there = "the agent decides".
   */
  snoozeUntil?: number | null;
  /** Id for the enqueued feedback run (caller-generated, unique). */
  feedbackRunId: string;
}

export type DismissBriefResult =
  /** State flipped and the feedback run is queued (id may be a fold). */
  | { outcome: "dismissed"; state: BriefState; feedbackRunId: string }
  | { outcome: "not_found" }
  /** The brief is already in a terminal state — dismissals are one-way. */
  | { outcome: "already_terminal"; state: BriefState }
  /** Reason/kind pairing or snoozeUntil misuse; message says which. */
  | { outcome: "invalid"; message: string };

function validateReason(
  reason: BriefDismissReason,
  kind: BriefKind,
  snoozeUntil: number | null,
): string | null {
  if (reason === "already_handled" && kind !== "loop") {
    return `reason "already_handled" applies only to loop-kind briefs (this brief is "${kind}")`;
  }
  if (reason === "acknowledged" && kind !== "info") {
    return `reason "acknowledged" applies only to info-kind briefs (this brief is "${kind}")`;
  }
  if (snoozeUntil !== null && reason !== "snoozed") {
    return `snoozeUntil is only valid with reason "snoozed"`;
  }
  return null;
}

/**
 * Dismiss a brief and enqueue its feedback run, atomically. The state
 * flip is synchronous (durable when this returns); the agent's reaction
 * is asynchronous via the queued run.
 */
export function dismissBriefAndEnqueueFeedback(
  db: Db,
  input: DismissBriefInput,
  now: number,
): DismissBriefResult {
  return db.transaction((): DismissBriefResult => {
    const row = db
      .prepare<
        [string],
        { kind: string; state: string }
      >("SELECT kind, state FROM briefs WHERE id = ?")
      .get(input.briefId);
    if (!row) return { outcome: "not_found" };

    const currentState = row.state as BriefState;
    if (isTerminalBriefState(currentState)) {
      return { outcome: "already_terminal", state: currentState };
    }

    const snoozeUntil = input.snoozeUntil ?? null;
    const invalid = validateReason(input.reason, row.kind as BriefKind, snoozeUntil);
    if (invalid) return { outcome: "invalid", message: invalid };

    const state = REASON_TO_STATE[input.reason];
    // A user-picked snooze time is persisted DURABLY here, in the same
    // transaction as the state flip. The return-to-`unread` is then driven by
    // the engine's snooze-resurface sweep (which reads `next_show`), so it
    // survives even when the async feedback run fails terminally — the snooze
    // can no longer become silently permanent. A snooze without a chosen time
    // leaves `next_show` null; the feedback run decides when it re-surfaces.
    if (snoozeUntil !== null) {
      db.prepare<[string, string | null, number, number, string]>(
        "UPDATE briefs SET state = ?, user_feedback = ?, updated_at = ?, next_show = ? WHERE id = ?",
      ).run(state, input.feedback ?? null, now, snoozeUntil, input.briefId);
    } else {
      db.prepare<[string, string | null, number, string]>(
        "UPDATE briefs SET state = ?, user_feedback = ?, updated_at = ? WHERE id = ?",
      ).run(state, input.feedback ?? null, now, input.briefId);
    }

    const payload: CognitionFeedbackRunPayload = {
      briefId: input.briefId,
      ...(snoozeUntil !== null ? { snoozeUntil } : {}),
    };
    const enqueued = enqueueCognitionRun(
      db,
      {
        id: input.feedbackRunId,
        kind: "feedback",
        payload,
        dedupeKey: feedbackRunDedupeKey(input.briefId),
      },
      now,
    );
    return { outcome: "dismissed", state, feedbackRunId: enqueued.runId };
  })();
}
