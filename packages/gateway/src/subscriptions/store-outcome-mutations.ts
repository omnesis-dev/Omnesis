// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The authority a woken run reports through, and the report itself.
 *
 * Kept apart from the Answer authority beside it because it authorizes the
 * opposite direction. An Answer releases corpus content to an external agent,
 * so it is bounded by the policy revision it was approved under, the grant
 * standing behind it, and the census of the evidence it may read. A report
 * carries nothing out: it is the run telling the gateway what it did. Binding
 * it to those same disclosure controls would mean a workflow whose policy
 * changed mid-run, or whose answer waited on an approval, could no longer say
 * what happened — which is the silence the report exists to end.
 *
 * What it is still bound to is the firing. The token names one, and a run can
 * report on no other.
 */

import { SCOPE_SUBSCRIPTIONS_OUTCOME } from "@omnesis/types";
import { audit } from "./store-mutation-helpers.js";
import type { Db } from "../data/types.js";
import type {
  IssueSubscriptionFiringOutcomeAuthorityMutation,
  IssueSubscriptionFiringOutcomeAuthorityMutationResult,
  RecordSubscriptionFiringOutcomeMutation,
  RecordSubscriptionFiringOutcomeMutationResult,
} from "./store-types.js";

/**
 * How many times one firing may be reported on.
 *
 * Generous against the legitimate shape — a run that defers, resumes, and
 * finishes reports three times at most — and small enough that a plugin stuck
 * in a loop stops being able to spend the writer queue on it.
 */
const MAX_OUTCOME_REPORTS_PER_FIRING = 32;

export function issueSubscriptionFiringOutcomeAuthority(
  db: Db,
  input: IssueSubscriptionFiringOutcomeAuthorityMutation,
): IssueSubscriptionFiringOutcomeAuthorityMutationResult {
  return db.transaction(() => {
    const delivery = db
      .prepare<
        [string],
        {
          firing_id: string;
          subscription_id: string;
          revision: number;
          workflow_id: string;
        }
      >(
        `SELECT firing_id, subscription_id, revision, workflow_id
           FROM subscription_deliveries WHERE id = ?`,
      )
      .get(input.deliveryId);
    if (!delivery) return { outcome: "not_found" } as const;

    const token = db
      .prepare<
        [string],
        { scopes: string; expires_at: number | null }
      >("SELECT scopes, expires_at FROM tokens WHERE id = ?")
      .get(input.tokenId);
    if (!token) return { outcome: "token_unavailable" } as const;
    let scopes: unknown;
    try {
      scopes = JSON.parse(token.scopes);
    } catch {
      return { outcome: "token_unavailable" } as const;
    }
    // Exactly one scope, and that scope. A token that could also answer would
    // let a lost report double as an authority to read the corpus.
    if (
      !Array.isArray(scopes) ||
      scopes.length !== 1 ||
      scopes[0] !== SCOPE_SUBSCRIPTIONS_OUTCOME ||
      token.expires_at === null ||
      token.expires_at < input.expiresAt
    ) {
      return { outcome: "token_unavailable" } as const;
    }

    // One live authority per delivery. A wake re-sent after a lost
    // acknowledgement arrives with a fresh bearer, and leaving the previous one
    // standing would let two credentials report on one firing — each counting
    // as a separate run, for a day, with no way to tell which run said what.
    db.prepare(
      `UPDATE subscription_firing_outcome_authorities
          SET revoked_at = ?
        WHERE delivery_id = ? AND revoked_at IS NULL`,
    ).run(input.createdAt, input.deliveryId);
    const inserted = db
      .prepare(
        `INSERT INTO subscription_firing_outcome_authorities
           (id, token_id, delivery_id, firing_id, subscription_id, revision,
            workflow_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tokenId,
        input.deliveryId,
        delivery.firing_id,
        delivery.subscription_id,
        delivery.revision,
        delivery.workflow_id,
        input.createdAt,
        input.expiresAt,
      );
    if (inserted.changes === 0) return { outcome: "not_found" } as const;
    return { outcome: "issued", firingId: delivery.firing_id } as const;
  })();
}

export function recordSubscriptionFiringOutcome(
  db: Db,
  input: RecordSubscriptionFiringOutcomeMutation,
): RecordSubscriptionFiringOutcomeMutationResult {
  return db.transaction(() => {
    const authority = db
      .prepare<
        [string, string],
        {
          delivery_id: string;
          subscription_id: string;
          revision: number;
          expires_at: number;
          revoked_at: number | null;
        }
      >(
        `SELECT delivery_id, subscription_id, revision, expires_at, revoked_at
           FROM subscription_firing_outcome_authorities
          WHERE token_id = ? AND firing_id = ?`,
      )
      .get(input.tokenId, input.firingId);
    if (!authority) return { outcome: "not_found" } as const;
    if (authority.revoked_at !== null) return { outcome: "revoked" } as const;
    if (authority.expires_at <= input.reportedAt) return { outcome: "expired" } as const;

    const existing = db
      .prepare<
        [string],
        { runs: number; first_reported_at: number }
      >("SELECT runs, first_reported_at FROM subscription_firing_outcomes WHERE firing_id = ?")
      .get(input.firingId);
    // A firing is reported on once, or a handful of times when a deferred run
    // resumes. Past that the caller is looping, and each report is a write at
    // the priority reserved for work somebody is waiting on — so the ceiling is
    // what stops one firing's runaway plugin from crowding out user requests
    // for the life of its authority.
    if (existing && existing.runs >= MAX_OUTCOME_REPORTS_PER_FIRING) {
      return { outcome: "too_many_reports" } as const;
    }
    // Last report wins, and `runs` keeps the earlier ones legible: a run that
    // ended deferred and a later one that finished are the same workflow
    // twice, not two workflows disagreeing.
    db.prepare(
      `INSERT INTO subscription_firing_outcomes
         (firing_id, delivery_id, subscription_id, status, report, runs,
          first_reported_at, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(firing_id) DO UPDATE SET
         status = excluded.status,
         report = excluded.report,
         runs = runs + 1,
         reported_at = excluded.reported_at`,
    ).run(
      input.firingId,
      authority.delivery_id,
      authority.subscription_id,
      input.status,
      input.report ?? null,
      1,
      existing?.first_reported_at ?? input.reportedAt,
      input.reportedAt,
    );
    audit(db, {
      subscriptionId: authority.subscription_id,
      revision: authority.revision,
      eventType: "workflow_outcome_reported",
      title: "Woken workflow reported",
      status: input.status,
      firingId: input.firingId,
      // The report itself is the run's own prose and can quote what it read in
      // the corpus, so the audit trail keeps only its shape.
      payload: { firingId: input.firingId, status: input.status, runs: (existing?.runs ?? 0) + 1 },
      createdAt: input.reportedAt,
    });
    return { outcome: "recorded", runs: (existing?.runs ?? 0) + 1 } as const;
  })();
}
