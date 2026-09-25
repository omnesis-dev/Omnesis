// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Private evidence admitted to a firing-bound Answer turn — what the firing
 * itself established, as ground truth for the question "what fired?".
 *
 * No arm is serialized into the external wake: the wake carries identifiers
 * and the subscriber's instruction, and everything below reaches the external
 * agent only as a reviewed release. That is what lets this be specific. A
 * document firing names its documents, and a firing on a condition carries the
 * approved interpretation, the instant it came true, and — when the plan
 * observed one — the row that satisfied it.
 *
 * The turn that reads this is not confined to it. It researches the corpus
 * with the ordinary read-only tools, and the privacy reviewer classifies the
 * candidate it produces. Evidence is the anchor, not the ceiling: it says
 * which occurrence is under discussion so that research cannot answer about
 * the wrong one.
 */
export type FiringAnswerEvidence =
  | {
      kind: "documents";
      documentIds: readonly string[];
    }
  | {
      kind: "catalog-watch";
      conditionSummary: string;
      firedAt: number;
      observation?: FiringObservation;
    }
  | {
      kind: "analytics-event";
      conditionSummary: string;
      firedAt: number;
      observation?: FiringObservation;
    }
  | {
      // A Watch V2 watch whose firings carry no documents — a row arriving, a
      // clock reaching a boundary, a deadline passing with nothing to cancel
      // it. What it has to offer is the claim the operator wrote, the instant
      // it came true, and whatever the plan recorded as satisfying it.
      kind: "watch-v2";
      conditionSummary: string;
      firedAt: number;
      observation?: FiringObservation;
    };

/**
 * What the plan recorded as satisfying the condition — the fields a watch's
 * author chose to report, captured when it fired.
 *
 * Recorded at fire time rather than recovered by a later query: a query run
 * minutes afterwards can return a different row, or none, and an answer built
 * on it would be about a different occurrence than the one that woke anybody.
 */
export type FiringObservation = Readonly<Record<string, unknown>>;
