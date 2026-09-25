// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SCOPE_SUBSCRIPTIONS_ANSWER } from "@omnesis/types";
import { recordAnswerEgress } from "../privacy/store-audit.js";
import { validateSubscriptionFiringAnswerAuthority } from "./store-queries.js";
import { audit, matchesPrivacyPolicyRevision } from "./store-mutation-helpers.js";
import type { Db } from "../data/types.js";
import type {
  FinalizeSubscriptionFiringAnswerEgressMutation,
  FinalizeSubscriptionFiringAnswerEgressMutationResult,
  IssueSubscriptionFiringAnswerAuthorityMutation,
  IssueSubscriptionFiringAnswerAuthorityMutationResult,
  UseSubscriptionFiringAnswerAuthorityMutation,
  ValidateSubscriptionFiringAnswerAuthorityResult,
} from "./store-types.js";

export function issueSubscriptionFiringAnswerAuthority(
  db: Db,
  input: IssueSubscriptionFiringAnswerAuthorityMutation,
): IssueSubscriptionFiringAnswerAuthorityMutationResult {
  return db.transaction(() => {
    if (!matchesPrivacyPolicyRevision(db, input.policyGuard)) {
      return { outcome: "policy_changed" } as const;
    }
    const row = db
      .prepare<
        [string],
        {
          firing_id: string;
          subscription_id: string;
          revision: number;
          integration_device_id: string;
          workflow_id: string;
          owner_id: string;
          current_revision: number;
          subscription_status: string;
          subscription_expires_at: number | null;
          revision_policy: string;
          grant_policy: string | null;
          grant_expires_at: number | null;
          grant_revoked_at: number | null;
          grant_integration_device_id: string | null;
          grant_workflow_id: string | null;
          workflow_owner_id: string;
          workflow_status: string;
          workflow_expires_at: number;
          delivery_status: string;
          delivery_claim_id: string | null;
          delivery_claim_expires_at: number | null;
        }
      >(
        `SELECT d.firing_id, d.subscription_id, d.revision, d.integration_device_id,
                d.workflow_id, s.owner_id, s.current_revision,
                s.status AS subscription_status,
                s.expires_at AS subscription_expires_at,
                r.policy_revision AS revision_policy,
                g.policy_revision AS grant_policy,
                g.expires_at AS grant_expires_at,
                g.revoked_at AS grant_revoked_at,
                g.integration_device_id AS grant_integration_device_id,
                g.workflow_id AS grant_workflow_id,
                w.owner_id AS workflow_owner_id,
                w.status AS workflow_status, w.expires_at AS workflow_expires_at,
                d.status AS delivery_status, d.claim_id AS delivery_claim_id,
                d.claim_expires_at AS delivery_claim_expires_at
           FROM subscription_deliveries d
           JOIN subscriptions s ON s.id = d.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = d.subscription_id AND r.revision = d.revision
           LEFT JOIN subscription_grants g
             ON g.subscription_id = d.subscription_id AND g.revision = d.revision
           JOIN answer_workflows w ON w.id = d.workflow_id
          WHERE d.id = ?`,
      )
      .get(input.deliveryId);
    if (!row) return { outcome: "not_found" } as const;
    const expectedDeliveryStatus =
      input.phase === "commit_refresh" ? "commit_authorized" : "claimed";
    if (
      row.delivery_status !== expectedDeliveryStatus ||
      row.delivery_claim_id !== input.claimId ||
      row.delivery_claim_expires_at === null ||
      row.delivery_claim_expires_at <= input.createdAt
    ) {
      return { outcome: "stale_claim" } as const;
    }
    if (row.current_revision !== row.revision) return { outcome: "stale_revision" } as const;
    if (
      row.subscription_status !== "active" ||
      row.workflow_status !== "active" ||
      (row.subscription_expires_at !== null && row.subscription_expires_at <= input.createdAt) ||
      row.workflow_expires_at <= input.createdAt
    ) {
      return { outcome: "inactive" } as const;
    }
    if (
      row.revision_policy !== input.policyRevision ||
      (row.grant_policy !== null && row.grant_policy !== input.policyRevision)
    ) {
      return { outcome: "policy_changed" } as const;
    }
    if (
      row.grant_policy === null ||
      row.grant_revoked_at !== null ||
      row.grant_expires_at === null ||
      row.grant_expires_at <= input.createdAt ||
      row.grant_integration_device_id !== row.integration_device_id ||
      row.grant_workflow_id !== row.workflow_id ||
      row.workflow_owner_id !== row.owner_id
    ) {
      return { outcome: "grant_unavailable" } as const;
    }
    const authorityExpiresAt = Math.min(
      input.expiresAt,
      row.subscription_expires_at ?? input.expiresAt,
      row.workflow_expires_at,
      row.grant_expires_at,
    );
    if (authorityExpiresAt <= input.createdAt) return { outcome: "expired" } as const;
    const token = db
      .prepare<
        [string, string],
        { scopes: string; expires_at: number | null }
      >("SELECT scopes, expires_at FROM tokens WHERE id = ? AND device_id = ?")
      .get(input.tokenId, row.integration_device_id);
    if (!token) return { outcome: "token_unavailable" } as const;
    let scopes: unknown;
    try {
      scopes = JSON.parse(token.scopes);
    } catch {
      return { outcome: "token_unavailable" } as const;
    }
    if (
      !Array.isArray(scopes) ||
      scopes.length !== 1 ||
      scopes[0] !== SCOPE_SUBSCRIPTIONS_ANSWER ||
      token.expires_at === null ||
      token.expires_at < authorityExpiresAt
    ) {
      return { outcome: "token_unavailable" } as const;
    }
    if (input.phase === "commit_refresh") {
      db.prepare(
        `UPDATE subscription_firing_answer_authorities
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE delivery_id = ? AND revoked_at IS NULL`,
      ).run(input.createdAt, input.deliveryId);
    }
    db.prepare(
      `INSERT INTO subscription_firing_answer_authorities
         (id, token_id, delivery_id, firing_id, subscription_id, revision,
          workflow_id, owner_id, policy_revision, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.tokenId,
      input.deliveryId,
      row.firing_id,
      row.subscription_id,
      row.revision,
      row.workflow_id,
      row.owner_id,
      input.policyRevision,
      input.createdAt,
      authorityExpiresAt,
    );
    const validated = validateSubscriptionFiringAnswerAuthority(
      db,
      {
        tokenId: input.tokenId,
        firingId: row.firing_id,
        policyRevision: input.policyRevision,
        now: input.createdAt,
      },
      input.phase === "commit_refresh" ? {} : { allowClaimedForIssuance: true },
    );
    if (validated.outcome !== "authorized") {
      throw new Error("issued firing answer authority failed its own validation");
    }
    audit(db, {
      subscriptionId: row.subscription_id,
      revision: row.revision,
      eventType: "answer_authority_issued",
      title: "Firing answer authority issued",
      status: "active",
      firingId: row.firing_id,
      payload: {
        authorityId: input.id,
        deliveryId: input.deliveryId,
        firingId: row.firing_id,
        expiresAt: authorityExpiresAt,
      },
      createdAt: input.createdAt,
    });
    return { outcome: "issued", authority: validated.authority } as const;
  })();
}

export function useSubscriptionFiringAnswerAuthority(
  db: Db,
  input: UseSubscriptionFiringAnswerAuthorityMutation,
): ValidateSubscriptionFiringAnswerAuthorityResult {
  return db.transaction(() => {
    const validated = validateSubscriptionFiringAnswerAuthority(db, {
      tokenId: input.tokenId,
      firingId: input.firingId,
      policyRevision: input.policyRevision,
      now: input.usedAt,
    });
    if (validated.outcome !== "authorized") return validated;
    const authority = validated.authority;
    db.prepare(
      `UPDATE subscription_firing_answer_authorities
          SET first_used_at = COALESCE(first_used_at, ?),
              last_used_at = ?,
              use_count = use_count + 1,
              consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END
        WHERE id = ?`,
    ).run(input.usedAt, input.usedAt, input.consume === true ? 1 : 0, input.usedAt, authority.id);
    const updated = {
      ...authority,
      firstUsedAt: authority.firstUsedAt ?? input.usedAt,
      lastUsedAt: input.usedAt,
      useCount: authority.useCount + 1,
      consumedAt: input.consume === true ? input.usedAt : authority.consumedAt,
    };
    audit(db, {
      subscriptionId: authority.subscriptionId,
      revision: authority.revision,
      eventType: input.consume === true ? "answer_authority_consumed" : "answer_authority_used",
      title:
        input.consume === true
          ? "Firing answer authority consumed"
          : "Firing answer authority used",
      status: input.consume === true ? "consumed" : "active",
      firingId: authority.firingId,
      payload: {
        authorityId: authority.id,
        firingId: authority.firingId,
        useCount: updated.useCount,
      },
      createdAt: input.usedAt,
    });
    return { outcome: "authorized", authority: updated } as const;
  })();
}

/**
 * Final privacy boundary for firing answers. Authority revalidation, exact
 * task/firing/workflow binding, durable egress recording, and authority-use
 * accounting commit in one SQLite transaction so revocation cannot race the
 * outbound ledger.
 */
export function finalizeSubscriptionFiringAnswerEgress(
  db: Db,
  input: FinalizeSubscriptionFiringAnswerEgressMutation,
): FinalizeSubscriptionFiringAnswerEgressMutationResult {
  return db.transaction(() => {
    const validated = validateSubscriptionFiringAnswerAuthority(db, {
      tokenId: input.tokenId,
      firingId: input.firingId,
      policyRevision: input.policyRevision,
      now: input.recordedAt,
    });
    if (validated.outcome !== "authorized") return validated;
    const authority = validated.authority;
    const task = db
      .prepare<
        [string],
        {
          owner_id: string;
          workflow_id: string;
          subscription_firing_id: string | null;
        }
      >(
        `SELECT owner_id, workflow_id, subscription_firing_id
           FROM answer_tasks WHERE id = ?`,
      )
      .get(input.taskId);
    if (
      !task ||
      task.owner_id !== input.ownerId ||
      task.owner_id !== authority.ownerId ||
      task.workflow_id !== authority.workflowId ||
      task.subscription_firing_id !== authority.firingId
    ) {
      return { outcome: "task_scope_mismatch" } as const;
    }
    const egress = recordAnswerEgress(db, {
      id: input.egressId,
      taskId: input.taskId,
      ownerId: input.ownerId,
      endpoint: "/subscriptions/firings/:id/answer",
      subscriptionFiringId: input.firingId,
      now: input.recordedAt,
    });
    if (!egress) return { outcome: "task_unreleased" } as const;

    db.prepare(
      `UPDATE subscription_firing_answer_authorities
          SET first_used_at = COALESCE(first_used_at, ?),
              last_used_at = ?,
              use_count = use_count + 1
        WHERE id = ?`,
    ).run(input.recordedAt, input.recordedAt, authority.id);
    audit(db, {
      subscriptionId: authority.subscriptionId,
      revision: authority.revision,
      firingId: authority.firingId,
      eventType: "answer_egress_recorded",
      title: "Firing answer returned",
      status: "released",
      payload: {
        authorityId: authority.id,
        firingId: authority.firingId,
        taskId: input.taskId,
      },
      createdAt: input.recordedAt,
    });
    return { outcome: "recorded", egress } as const;
  })();
}
