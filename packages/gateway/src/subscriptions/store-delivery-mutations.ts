// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { parseStoredSubscriptionJson, subscriptionReactionCodec } from "./store-codecs.js";
import { audit, matchesPrivacyPolicyRevision } from "./store-mutation-helpers.js";
import type { Db } from "../data/types.js";
import type {
  AuthorizeSubscriptionDeliveryCommitMutation,
  AuthorizeSubscriptionDeliveryCommitMutationResult,
  ClaimedSubscriptionDelivery,
  ClaimSubscriptionDeliveriesMutation,
  SettleSubscriptionDeliveryMutation,
  SettleSubscriptionDeliveryMutationResult,
} from "./store-types.js";

interface DeliveryClaimRow {
  id: string;
  firing_id: string;
  subscription_id: string;
  revision: number;
  integration_device_id: string;
  workflow_id: string;
  attempts: number;
  owner_id: string;
  current_revision: number;
  subscription_status: string;
  subscription_expires_at: number | null;
  reaction_json: string;
  revision_policy: string;
  revision_workflow_id: string;
  grant_policy: string | null;
  grant_expires_at: number | null;
  grant_revoked_at: number | null;
  grant_integration_device_id: string | null;
  grant_workflow_id: string | null;
  workflow_owner_id: string;
  workflow_status: string;
  workflow_expires_at: number;
}

function deliveryClaimEligible(
  row: DeliveryClaimRow,
  reactionKind: "agent-workflow" | "ios-push",
  policyRevision: string,
  now: number,
): boolean {
  // Policy currency is an exit gate: a wake that crosses to an external agent
  // must carry authority under the policy as it stands NOW, so a policy edit
  // parks it until the operator re-approves. An iOS push never leaves the
  // corpus — the operator's own phone is the destination — so it delivers on
  // its revision-consistent grant regardless of later policy edits. Every
  // other check here is lifecycle/consistency and applies to both.
  const policyCurrent =
    reactionKind !== "agent-workflow" ||
    (row.revision_policy === policyRevision && row.grant_policy === policyRevision);
  return (
    policyCurrent &&
    row.subscription_status === "active" &&
    row.current_revision === row.revision &&
    (row.subscription_expires_at === null || row.subscription_expires_at > now) &&
    row.revision_workflow_id === row.workflow_id &&
    row.grant_policy !== null &&
    row.grant_revoked_at === null &&
    row.grant_expires_at !== null &&
    row.grant_expires_at > now &&
    row.grant_integration_device_id === row.integration_device_id &&
    row.grant_workflow_id === row.workflow_id &&
    row.workflow_owner_id === row.owner_id &&
    row.workflow_status === "active" &&
    row.workflow_expires_at > now
  );
}

function failDelivery(
  db: Db,
  row: { id: string; firing_id: string; subscription_id: string; revision: number },
  failedAt: number,
  reason: string,
  firingStatus: "blocked" | "failed" = "failed",
): void {
  db.prepare(
    `UPDATE subscription_deliveries
        SET status = 'failed', claim_id = NULL, claimed_at = NULL,
            claim_expires_at = NULL, next_attempt_at = NULL,
            last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(reason, failedAt, row.id);
  db.prepare("UPDATE subscription_firings SET status = ? WHERE id = ?").run(
    firingStatus,
    row.firing_id,
  );
  db.prepare(
    `UPDATE subscription_firing_answer_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE delivery_id = ? AND revoked_at IS NULL`,
  ).run(failedAt, row.id);
  db.prepare(
    `UPDATE subscription_firing_outcome_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE delivery_id = ? AND revoked_at IS NULL`,
  ).run(failedAt, row.id);
  audit(db, {
    subscriptionId: row.subscription_id,
    revision: row.revision,
    eventType: "delivery_failed",
    title: "Watch delivery failed",
    status: "failed",
    firingId: row.firing_id,
    payload: { deliveryId: row.id, firingId: row.firing_id, reason },
    createdAt: failedAt,
  });
}

function queueDeliveryCancellation(
  db: Db,
  row: { id: string; firing_id: string; subscription_id: string; revision: number },
  queuedAt: number,
  reason: string,
  nextAttemptAt: number = queuedAt,
): void {
  db.prepare(
    `UPDATE subscription_deliveries
        SET status = 'cancel_pending', claim_id = NULL, claimed_at = NULL,
            claim_expires_at = NULL, next_attempt_at = ?,
            last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(nextAttemptAt, reason.slice(0, 2_000), queuedAt, row.id);
  db.prepare("UPDATE subscription_firings SET status = 'blocked' WHERE id = ?").run(row.firing_id);
  db.prepare(
    `UPDATE subscription_firing_answer_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE delivery_id = ? AND revoked_at IS NULL`,
  ).run(queuedAt, row.id);
  db.prepare(
    `UPDATE subscription_firing_outcome_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE delivery_id = ? AND revoked_at IS NULL`,
  ).run(queuedAt, row.id);
  audit(db, {
    subscriptionId: row.subscription_id,
    revision: row.revision,
    eventType: "delivery_cancel_pending",
    title: "Watch delivery cancellation queued",
    status: "retry",
    firingId: row.firing_id,
    payload: { deliveryId: row.id, firingId: row.firing_id, reason },
    createdAt: queuedAt,
  });
}

/**
 * Claim due delivery rows through an attempt-scoped lease. Expired leases are
 * recovered first. Every claim rechecks the live revision, grant, policy,
 * workflow, and expiry before returning identifier-only payload material.
 */
export function claimSubscriptionDeliveries(
  db: Db,
  input: ClaimSubscriptionDeliveriesMutation,
): ClaimedSubscriptionDelivery[] {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const leaseMs = Math.max(1, Math.floor(input.leaseMs));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  return db.transaction(() => {
    const abandoned = db
      .prepare<
        [number, number],
        {
          id: string;
          firing_id: string;
          subscription_id: string;
          revision: number;
          attempts: number;
        }
      >(
        `SELECT id, firing_id, subscription_id, revision, attempts
           FROM subscription_deliveries
          WHERE status = 'claimed' AND claim_expires_at <= ?
          ORDER BY claim_expires_at, id
          LIMIT ?`,
      )
      .all(input.claimedAt, limit);
    for (const row of abandoned) {
      if (row.attempts >= maxAttempts) {
        // The expired worker may have staged a wake before it died. Persist a
        // cancellation tombstone instead of abandoning that remote state.
        queueDeliveryCancellation(
          db,
          row,
          input.claimedAt,
          "delivery attempt lease expired at attempt limit",
        );
        continue;
      }
      db.prepare(
        `UPDATE subscription_deliveries
            SET status = 'retry', claim_id = NULL, claimed_at = NULL,
                claim_expires_at = NULL, next_attempt_at = ?,
                last_error = 'delivery attempt lease expired', updated_at = ?
          WHERE id = ? AND status = 'claimed'`,
      ).run(input.claimedAt, input.claimedAt, row.id);
      db.prepare(
        `UPDATE subscription_firing_answer_authorities
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE delivery_id = ? AND revoked_at IS NULL`,
      ).run(input.claimedAt, row.id);
      db.prepare(
        `UPDATE subscription_firing_outcome_authorities
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE delivery_id = ? AND revoked_at IS NULL`,
      ).run(input.claimedAt, row.id);
      audit(db, {
        subscriptionId: row.subscription_id,
        revision: row.revision,
        eventType: "delivery_retry",
        title: "Watch delivery queued for retry",
        status: "retry",
        firingId: row.firing_id,
        payload: { deliveryId: row.id, firingId: row.firing_id, reason: "lease expired" },
        createdAt: input.claimedAt,
      });
    }

    const claimed: ClaimedSubscriptionDelivery[] = [];
    // Cancellation tombstones are durable privacy cleanup. They do not depend
    // on the now-revoked subscription grant and are drained before execution
    // commits. Sending a cancel before a prepare is safe: integrations persist
    // the tombstone so a delayed prepare cannot resurrect the wake.
    const cancellationRows = db
      .prepare<[number, number, number], DeliveryClaimRow>(
        `SELECT d.id, d.firing_id, d.subscription_id, d.revision,
                d.integration_device_id, d.workflow_id, d.attempts,
                s.owner_id, s.current_revision, s.status AS subscription_status,
                s.expires_at AS subscription_expires_at,
                r.reaction_json, r.policy_revision AS revision_policy,
                r.workflow_id AS revision_workflow_id,
                g.policy_revision AS grant_policy,
                g.expires_at AS grant_expires_at,
                g.revoked_at AS grant_revoked_at,
                g.integration_device_id AS grant_integration_device_id,
                g.workflow_id AS grant_workflow_id,
                w.owner_id AS workflow_owner_id,
                w.status AS workflow_status, w.expires_at AS workflow_expires_at
           FROM subscription_deliveries d
           JOIN subscriptions s ON s.id = d.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = d.subscription_id AND r.revision = d.revision
           LEFT JOIN subscription_grants g
             ON g.subscription_id = d.subscription_id AND g.revision = d.revision
           JOIN answer_workflows w ON w.id = d.workflow_id
          WHERE d.status = 'cancel_pending'
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
            AND (d.claim_id IS NULL OR d.claim_expires_at <= ?)
          ORDER BY COALESCE(d.next_attempt_at, d.updated_at), d.id
          LIMIT ?`,
      )
      .all(input.claimedAt, input.claimedAt, limit);
    for (const row of cancellationRows) {
      const claimId = `sdclaim_${randomUUID()}`;
      const claimExpiresAt = input.claimedAt + leaseMs;
      const changed = db
        .prepare(
          `UPDATE subscription_deliveries
              SET attempts = attempts + 1, claim_id = ?, claimed_at = ?,
                  claim_expires_at = ?, next_attempt_at = NULL,
                  last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'cancel_pending'
              AND (claim_id IS NULL OR claim_expires_at <= ?)`,
        )
        .run(claimId, input.claimedAt, claimExpiresAt, input.claimedAt, row.id, input.claimedAt);
      if (changed.changes === 0) continue;
      const reaction = parseStoredSubscriptionJson(
        subscriptionReactionCodec,
        row.reaction_json,
        "reaction",
      );
      claimed.push({
        id: row.id,
        claimId,
        attempt: row.attempts + 1,
        firingId: row.firing_id,
        subscriptionId: row.subscription_id,
        revision: row.revision,
        integrationDeviceId: row.integration_device_id,
        workflowId: row.workflow_id,
        ownerId: row.owner_id,
        reaction,
        claimedAt: input.claimedAt,
        claimExpiresAt,
        phase: "cancel",
      });
    }

    // A commit-authorized wake has crossed the durable disclosure boundary:
    // lifecycle revocation no longer rewinds it. Re-lease these rows first so
    // a crash or lost commit ACK resumes only the idempotent commit command,
    // never a second preparation/authorization cycle.
    const committedRows = db
      .prepare<[number, number, number], DeliveryClaimRow>(
        `SELECT d.id, d.firing_id, d.subscription_id, d.revision,
                d.integration_device_id, d.workflow_id, d.attempts,
                s.owner_id, s.current_revision, s.status AS subscription_status,
                s.expires_at AS subscription_expires_at,
                r.reaction_json, r.policy_revision AS revision_policy,
                r.workflow_id AS revision_workflow_id,
                g.policy_revision AS grant_policy,
                g.expires_at AS grant_expires_at,
                g.revoked_at AS grant_revoked_at,
                g.integration_device_id AS grant_integration_device_id,
                g.workflow_id AS grant_workflow_id,
                w.owner_id AS workflow_owner_id,
                w.status AS workflow_status, w.expires_at AS workflow_expires_at
           FROM subscription_deliveries d
           JOIN subscriptions s ON s.id = d.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = d.subscription_id AND r.revision = d.revision
           LEFT JOIN subscription_grants g
             ON g.subscription_id = d.subscription_id AND g.revision = d.revision
           JOIN answer_workflows w ON w.id = d.workflow_id
          WHERE d.status = 'commit_authorized'
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
            AND (d.claim_id IS NULL OR d.claim_expires_at <= ?)
          ORDER BY COALESCE(d.next_attempt_at, d.updated_at), d.id
          LIMIT ?`,
      )
      .all(input.claimedAt, input.claimedAt, limit);
    for (const row of committedRows) {
      if (claimed.length >= limit) break;
      const claimId = `sdclaim_${randomUUID()}`;
      const claimExpiresAt = input.claimedAt + leaseMs;
      const changed = db
        .prepare(
          `UPDATE subscription_deliveries
              SET attempts = attempts + 1, claim_id = ?, claimed_at = ?,
                  claim_expires_at = ?, next_attempt_at = NULL,
                  last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'commit_authorized'
              AND (claim_id IS NULL OR claim_expires_at <= ?)`,
        )
        .run(claimId, input.claimedAt, claimExpiresAt, input.claimedAt, row.id, input.claimedAt);
      if (changed.changes === 0) continue;
      const reaction = parseStoredSubscriptionJson(
        subscriptionReactionCodec,
        row.reaction_json,
        "reaction",
      );
      claimed.push({
        id: row.id,
        claimId,
        attempt: row.attempts + 1,
        firingId: row.firing_id,
        subscriptionId: row.subscription_id,
        revision: row.revision,
        integrationDeviceId: row.integration_device_id,
        workflowId: row.workflow_id,
        ownerId: row.owner_id,
        reaction,
        claimedAt: input.claimedAt,
        claimExpiresAt,
        phase: "commit",
      });
    }

    const rows = db
      .prepare<[number, number], DeliveryClaimRow>(
        `SELECT d.id, d.firing_id, d.subscription_id, d.revision,
                d.integration_device_id, d.workflow_id, d.attempts,
                s.owner_id, s.current_revision, s.status AS subscription_status,
                s.expires_at AS subscription_expires_at,
                r.reaction_json, r.policy_revision AS revision_policy,
                r.workflow_id AS revision_workflow_id,
                g.policy_revision AS grant_policy,
                g.expires_at AS grant_expires_at,
                g.revoked_at AS grant_revoked_at,
                g.integration_device_id AS grant_integration_device_id,
                g.workflow_id AS grant_workflow_id,
                w.owner_id AS workflow_owner_id,
                w.status AS workflow_status, w.expires_at AS workflow_expires_at
           FROM subscription_deliveries d
           JOIN subscriptions s ON s.id = d.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = d.subscription_id AND r.revision = d.revision
           LEFT JOIN subscription_grants g
             ON g.subscription_id = d.subscription_id AND g.revision = d.revision
           JOIN answer_workflows w ON w.id = d.workflow_id
          WHERE d.status IN ('pending', 'retry')
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
          ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.id
          LIMIT ?`,
      )
      .all(input.claimedAt, Math.max(1, (limit - claimed.length) * 2));
    for (const row of rows) {
      if (row.attempts >= maxAttempts) {
        // A prior attempt may have reached the integration even when its ACK
        // did not. Cleanup therefore crosses the same durable delivery queue.
        queueDeliveryCancellation(db, row, input.claimedAt, "delivery attempt limit reached");
        continue;
      }
      const reaction = parseStoredSubscriptionJson(
        subscriptionReactionCodec,
        row.reaction_json,
        "reaction",
      );
      if (!deliveryClaimEligible(row, reaction.kind, input.policyRevision, input.claimedAt)) {
        if (row.attempts > 0) {
          // A retried row may already be staged remotely. A direct policy-file
          // edit has no lifecycle callback, so the claim boundary itself must
          // durably clean up before abandoning the wake.
          queueDeliveryCancellation(
            db,
            row,
            input.claimedAt,
            "subscription delivery authority changed",
          );
        } else {
          failDelivery(
            db,
            row,
            input.claimedAt,
            "subscription delivery authority changed",
            "blocked",
          );
        }
        continue;
      }
      if (claimed.length >= limit) break;
      const claimId = `sdclaim_${randomUUID()}`;
      const claimExpiresAt = input.claimedAt + leaseMs;
      const changed = db
        .prepare(
          `UPDATE subscription_deliveries
              SET status = 'claimed', attempts = attempts + 1, claim_id = ?,
                  claimed_at = ?, claim_expires_at = ?, next_attempt_at = NULL,
                  last_error = NULL, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'retry')`,
        )
        .run(claimId, input.claimedAt, claimExpiresAt, input.claimedAt, row.id);
      if (changed.changes === 0) continue;
      const attempt = row.attempts + 1;
      audit(db, {
        subscriptionId: row.subscription_id,
        revision: row.revision,
        eventType: "delivery_claimed",
        title: "Watch delivery claimed",
        status: "claimed",
        firingId: row.firing_id,
        payload: { deliveryId: row.id, firingId: row.firing_id, attempt },
        createdAt: input.claimedAt,
      });
      claimed.push({
        id: row.id,
        claimId,
        attempt,
        firingId: row.firing_id,
        subscriptionId: row.subscription_id,
        revision: row.revision,
        integrationDeviceId: row.integration_device_id,
        workflowId: row.workflow_id,
        ownerId: row.owner_id,
        reaction,
        claimedAt: input.claimedAt,
        claimExpiresAt,
        phase: "prepare",
      });
    }
    return claimed;
  })();
}

/**
 * Atomically revalidate every live privacy input after the integration has
 * durably prepared the wake, then cross the external-disclosure boundary.
 *
 * Once this transition commits, later lifecycle revocation still revokes the
 * firing-bound Answer authority, but does not pretend it can retract a commit
 * that may already be in flight to the external harness.
 */
export function authorizeSubscriptionDeliveryCommit(
  db: Db,
  input: AuthorizeSubscriptionDeliveryCommitMutation,
): AuthorizeSubscriptionDeliveryCommitMutationResult {
  return db.transaction(() => {
    // This synchronous read is deliberately inside the SQLite transaction.
    // PrivacyPolicyStore.runIfRevision serializes normal API writes around the
    // mutation; this guard also closes the boundary for direct file edits.
    if (!matchesPrivacyPolicyRevision(db, input.policyGuard)) {
      return { outcome: "policy_changed" } as const;
    }
    const row = db
      .prepare<
        [number, string],
        DeliveryClaimRow & {
          delivery_status: string;
          delivery_claim_id: string | null;
          delivery_claim_expires_at: number | null;
          authority_active: number;
        }
      >(
        `SELECT d.id, d.firing_id, d.subscription_id, d.revision,
                d.integration_device_id, d.workflow_id, d.attempts,
                s.owner_id, s.current_revision, s.status AS subscription_status,
                s.expires_at AS subscription_expires_at,
                r.reaction_json, r.policy_revision AS revision_policy,
                r.workflow_id AS revision_workflow_id,
                g.policy_revision AS grant_policy,
                g.expires_at AS grant_expires_at,
                g.revoked_at AS grant_revoked_at,
                g.integration_device_id AS grant_integration_device_id,
                g.workflow_id AS grant_workflow_id,
                w.owner_id AS workflow_owner_id,
                w.status AS workflow_status, w.expires_at AS workflow_expires_at,
                d.status AS delivery_status, d.claim_id AS delivery_claim_id,
                d.claim_expires_at AS delivery_claim_expires_at,
                EXISTS (
                  SELECT 1
                    FROM subscription_firing_answer_authorities a
                   WHERE a.delivery_id = d.id
                     AND a.revoked_at IS NULL
                     AND a.expires_at > ?
                ) AS authority_active
           FROM subscription_deliveries d
           JOIN subscriptions s ON s.id = d.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = d.subscription_id AND r.revision = d.revision
           LEFT JOIN subscription_grants g
             ON g.subscription_id = d.subscription_id AND g.revision = d.revision
           JOIN answer_workflows w ON w.id = d.workflow_id
          WHERE d.id = ?`,
      )
      .get(input.authorizedAt, input.deliveryId);
    if (!row) return { outcome: "not_found" } as const;
    if (
      row.delivery_status !== "claimed" ||
      row.delivery_claim_id !== input.claimId ||
      row.delivery_claim_expires_at === null ||
      row.delivery_claim_expires_at <= input.authorizedAt
    ) {
      return { outcome: "stale_claim" } as const;
    }
    if (row.current_revision !== row.revision) return { outcome: "stale_revision" } as const;
    if (row.subscription_expires_at !== null && row.subscription_expires_at <= input.authorizedAt) {
      return { outcome: "expired" } as const;
    }
    if (
      row.subscription_status !== "active" ||
      row.workflow_status !== "active" ||
      row.workflow_expires_at <= input.authorizedAt
    ) {
      return { outcome: "inactive" } as const;
    }
    if (row.revision_policy !== input.policyRevision) {
      return { outcome: "policy_changed" } as const;
    }
    if (
      row.grant_policy !== input.policyRevision ||
      row.grant_revoked_at !== null ||
      row.grant_expires_at === null ||
      row.grant_expires_at <= input.authorizedAt ||
      row.grant_integration_device_id !== row.integration_device_id ||
      row.grant_workflow_id !== row.workflow_id ||
      row.workflow_owner_id !== row.owner_id ||
      row.revision_workflow_id !== row.workflow_id
    ) {
      return { outcome: "grant_unavailable" } as const;
    }
    if (row.authority_active !== 1) return { outcome: "authority_unavailable" } as const;
    const changed = db
      .prepare(
        `UPDATE subscription_deliveries
            SET status = 'commit_authorized', updated_at = ?
          WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
      )
      .run(input.authorizedAt, input.deliveryId, input.claimId);
    if (changed.changes === 0) return { outcome: "stale_claim" } as const;
    audit(db, {
      subscriptionId: row.subscription_id,
      revision: row.revision,
      eventType: "delivery_commit_authorized",
      title: "Watch delivery commit authorized",
      status: "commit_authorized",
      firingId: row.firing_id,
      payload: { deliveryId: row.id, firingId: row.firing_id },
      createdAt: input.authorizedAt,
    });
    return { outcome: "authorized" } as const;
  })();
}

export function settleSubscriptionDelivery(
  db: Db,
  input: SettleSubscriptionDeliveryMutation,
): SettleSubscriptionDeliveryMutationResult {
  return db.transaction(() => {
    const row = db
      .prepare<
        [string],
        {
          firing_id: string;
          subscription_id: string;
          revision: number;
          status: string;
          claim_id: string | null;
        }
      >(
        `SELECT firing_id, subscription_id, revision, status, claim_id
           FROM subscription_deliveries WHERE id = ?`,
      )
      .get(input.deliveryId);
    if (!row) return { outcome: "not_found" } as const;
    const expectedStatus =
      input.outcome.kind === "delivered" ||
      input.outcome.kind === "retry_commit" ||
      input.outcome.kind === "failed_commit" ||
      (input.outcome.kind === "manual_review" && input.outcome.phase === "commit")
        ? "commit_authorized"
        : input.outcome.kind === "cancelled" ||
            input.outcome.kind === "retry_cancel" ||
            (input.outcome.kind === "manual_review" && input.outcome.phase === "cancel")
          ? "cancel_pending"
          : "claimed";
    if (row.status !== expectedStatus || row.claim_id !== input.claimId) {
      return { outcome: "stale_claim" } as const;
    }
    // `pushed` and `delivered` reach the same end state; they differ only in
    // which status they are legal from (see the expectedStatus derivation).
    const outcome =
      input.outcome.kind === "pushed"
        ? {
            kind: "delivered" as const,
            acceptedAt: input.outcome.acceptedAt,
            localRunId: input.outcome.localRunId,
          }
        : input.outcome;
    if (outcome.kind === "queue_cancel") {
      queueDeliveryCancellation(
        db,
        {
          id: input.deliveryId,
          firing_id: row.firing_id,
          subscription_id: row.subscription_id,
          revision: row.revision,
        },
        input.settledAt,
        outcome.error,
        outcome.nextAttemptAt,
      );
    } else if (outcome.kind === "delivered") {
      db.prepare(
        `UPDATE subscription_deliveries
            SET status = 'delivered', accepted_at = ?, local_run_id = ?,
                claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(outcome.acceptedAt, outcome.localRunId, input.settledAt, input.deliveryId);
      db.prepare("UPDATE subscription_firings SET status = 'delivered' WHERE id = ?").run(
        row.firing_id,
      );
    } else if (
      outcome.kind === "retry" ||
      outcome.kind === "retry_commit" ||
      outcome.kind === "retry_cancel" ||
      outcome.kind === "parked"
    ) {
      db.prepare(
        `UPDATE subscription_deliveries
            SET status = ?, next_attempt_at = ?, last_error = ?,
                attempts = CASE WHEN ? = 'parked' THEN MAX(0, attempts - 1) ELSE attempts END,
                claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(
        outcome.kind === "retry_commit"
          ? "commit_authorized"
          : outcome.kind === "retry_cancel"
            ? "cancel_pending"
            : "retry",
        outcome.nextAttemptAt,
        outcome.error.slice(0, 2_000),
        outcome.kind,
        input.settledAt,
        input.deliveryId,
      );
      if (outcome.kind !== "retry_commit") {
        db.prepare(
          `UPDATE subscription_firing_answer_authorities
              SET revoked_at = COALESCE(revoked_at, ?)
            WHERE delivery_id = ? AND revoked_at IS NULL`,
        ).run(input.settledAt, input.deliveryId);
        db.prepare(
          `UPDATE subscription_firing_outcome_authorities
              SET revoked_at = COALESCE(revoked_at, ?)
            WHERE delivery_id = ? AND revoked_at IS NULL`,
        ).run(input.settledAt, input.deliveryId);
      }
    } else if (outcome.kind === "cancelled") {
      db.prepare(
        `UPDATE subscription_deliveries
            SET status = 'failed', next_attempt_at = NULL,
                last_error = 'prepared subscription wake cancelled',
                claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(input.settledAt, input.deliveryId);
      db.prepare("UPDATE subscription_firings SET status = 'blocked' WHERE id = ?").run(
        row.firing_id,
      );
      db.prepare(
        `UPDATE subscription_firing_answer_authorities
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE delivery_id = ? AND revoked_at IS NULL`,
      ).run(input.settledAt, input.deliveryId);
      db.prepare(
        `UPDATE subscription_firing_outcome_authorities
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE delivery_id = ? AND revoked_at IS NULL`,
      ).run(input.settledAt, input.deliveryId);
    } else if (outcome.kind === "manual_review") {
      db.prepare(
        `UPDATE subscription_deliveries
            SET status = 'manual_review', next_attempt_at = NULL,
                last_error = ?, claim_id = NULL, claimed_at = NULL,
                claim_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(outcome.error.slice(0, 2_000), input.settledAt, input.deliveryId);
      // Native execution may already have started. Preserve the firing-bound
      // authority until its normal TTL so that a real run is not stranded;
      // subscription/grant/policy/evidence lifecycle revocation still wins.
      db.prepare("UPDATE subscription_firings SET status = ? WHERE id = ?").run(
        outcome.phase === "cancel" ? "blocked" : "failed",
        row.firing_id,
      );
    } else {
      failDelivery(
        db,
        {
          id: input.deliveryId,
          firing_id: row.firing_id,
          subscription_id: row.subscription_id,
          revision: row.revision,
        },
        input.settledAt,
        outcome.error.slice(0, 2_000),
      );
    }
    const status =
      outcome.kind === "delivered"
        ? "delivered"
        : outcome.kind === "manual_review"
          ? "manual_review"
          : outcome.kind === "cancelled"
            ? "failed"
            : outcome.kind === "retry" ||
                outcome.kind === "retry_commit" ||
                outcome.kind === "retry_cancel" ||
                outcome.kind === "queue_cancel" ||
                outcome.kind === "parked"
              ? "retry"
              : "failed";
    if (
      outcome.kind !== "failed" &&
      outcome.kind !== "failed_commit" &&
      outcome.kind !== "cancelled" &&
      outcome.kind !== "queue_cancel"
    ) {
      audit(db, {
        subscriptionId: row.subscription_id,
        revision: row.revision,
        eventType:
          status === "delivered"
            ? "delivery_delivered"
            : status === "manual_review"
              ? "delivery_manual_review"
              : "delivery_retry",
        title:
          status === "delivered"
            ? "Watch delivery accepted"
            : status === "manual_review"
              ? "Watch delivery requires manual review"
              : "Watch delivery queued for retry",
        status,
        payload: {
          deliveryId: input.deliveryId,
          firingId: row.firing_id,
          ...(outcome.kind === "delivered"
            ? {
                acceptedAt: outcome.acceptedAt,
                localRunId: outcome.localRunId,
              }
            : outcome.kind === "manual_review"
              ? {
                  reason: outcome.error.slice(0, 2_000),
                  code: outcome.code,
                }
              : {
                  reason: outcome.error.slice(0, 2_000),
                  parked: outcome.kind === "parked",
                  commitAuthorized: outcome.kind === "retry_commit",
                  cancellationPending: outcome.kind === "retry_cancel",
                }),
        },
        createdAt: input.settledAt,
      });
    }
    if (outcome.kind === "cancelled") {
      audit(db, {
        subscriptionId: row.subscription_id,
        revision: row.revision,
        eventType: "delivery_cancelled",
        title: "Watch delivery cancelled",
        status: "failed",
        firingId: row.firing_id,
        payload: {
          deliveryId: input.deliveryId,
          firingId: row.firing_id,
          cancelledAt: outcome.cancelledAt,
        },
        createdAt: input.settledAt,
      });
    }
    return { outcome: "settled", status } as const;
  })();
}
