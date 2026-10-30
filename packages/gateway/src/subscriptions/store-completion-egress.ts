// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SCOPE_SUBSCRIPTIONS_RECEIVE } from "@omnesis/types";
import { recordAnswerEgress } from "../privacy/store-audit.js";
import { audit, matchesPrivacyPolicyRevision } from "./store-mutation-helpers.js";
import {
  planEvidenceRule,
  parseStoredSubscriptionJson,
  storedSubscriptionCompiledPlanCodec,
} from "./store-codecs.js";
import type { Db } from "../data/types.js";
import type {
  FinalizeSubscriptionCompletionEgressMutation,
  FinalizeSubscriptionCompletionEgressResult,
} from "./store-types.js";

/** Read one already released Watch answer during its authenticated completion commit.
 * The original asking token may have expired and been deleted while approval waited.
 * This authority cannot start another ask or read another task.
 */
export function finalizeSubscriptionCompletionEgress(
  db: Db,
  input: FinalizeSubscriptionCompletionEgressMutation,
): FinalizeSubscriptionCompletionEgressResult {
  return db.transaction(() => {
    // Use the writer's clock: time spent queued must not extend a claim or credential.
    const now = Date.now();
    if (!matchesPrivacyPolicyRevision(db, input.policyGuard))
      return { outcome: "unavailable" } as const;
    const row = db
      .prepare<
        unknown[],
        {
          task_id: string;
          owner_id: string;
          firing_id: string;
          subscription_id: string;
          revision: number;
          scopes: string;
          compiled_plan_json: string;
          evidence_count: number;
          live_evidence_count: number;
        }
      >(
        `
      SELECT t.id AS task_id, t.owner_id, f.id AS firing_id, s.id AS subscription_id,
             f.revision, tok.scopes, r.compiled_plan_json, f.evidence_count,
             (SELECT COUNT(*) FROM subscription_firing_evidence e WHERE e.firing_id = f.id)
               AS live_evidence_count
        FROM answer_completion_deliveries c
        JOIN answer_tasks t ON t.id = c.task_id
        JOIN subscription_firings f ON f.id = t.subscription_firing_id
        JOIN subscriptions s ON s.id = f.subscription_id
        JOIN subscription_revisions r ON r.subscription_id = s.id AND r.revision = f.revision
        JOIN subscription_deliveries d ON d.firing_id = f.id AND d.subscription_id = s.id
          AND d.revision = f.revision AND d.workflow_id = t.workflow_id
        JOIN subscription_grants g ON g.subscription_id = s.id AND g.revision = f.revision
        JOIN answer_workflows w ON w.id = t.workflow_id
        JOIN devices dev ON dev.id = c.integration_device_id
        JOIN tokens tok ON tok.id = ? AND tok.device_id = dev.id
       WHERE c.id = ? AND dev.id = ? AND dev.kind = 'agent' AND dev.revoked_at IS NULL
         AND (tok.expires_at IS NULL OR tok.expires_at > ?)
         AND c.status = 'commit_authorized' AND c.claim_id IS NOT NULL AND c.claim_expires_at > ?
         AND t.status IN ('released', 'released_with_reductions', 'denied')
         AND t.completion_device_id = dev.id
         AND t.completion_native_conversation_id = c.native_conversation_id
         AND f.status IN ('pending', 'delivered')
         AND f.workflow_id = w.id AND r.workflow_id = w.id AND s.workflow_id = w.id
         AND s.integration_device_id = dev.id
         AND t.policy_revision = r.policy_revision
         AND s.current_revision = f.revision AND s.status = 'active' AND s.revoked_at IS NULL
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND w.status = 'active' AND w.expires_at > ?
         AND t.owner_id = s.owner_id AND w.owner_id = s.owner_id
         AND d.integration_device_id = dev.id
         AND d.status IN ('commit_authorized', 'manual_review', 'delivered')
         AND g.integration_device_id = dev.id AND g.workflow_id = w.id
         AND g.revoked_at IS NULL AND g.expires_at > ?
         AND r.policy_revision = ? AND g.policy_revision = ?
    `,
      )
      .get(
        input.tokenId,
        input.deliveryId,
        input.deviceId,
        now,
        now,
        now,
        now,
        now,
        input.policyGuard.expectedRevision,
        input.policyGuard.expectedRevision,
      );
    if (!row || row.evidence_count !== row.live_evidence_count)
      return { outcome: "unavailable" } as const;
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      return { outcome: "unavailable" } as const;
    }
    if (!Array.isArray(scopes) || !scopes.includes(SCOPE_SUBSCRIPTIONS_RECEIVE))
      return { outcome: "unavailable" } as const;
    const plan = parseStoredSubscriptionJson(
      storedSubscriptionCompiledPlanCodec,
      row.compiled_plan_json,
      "compiled plan",
    );
    if (planEvidenceRule(plan) === "none" && row.evidence_count !== 0)
      return { outcome: "unavailable" } as const;
    const egress = recordAnswerEgress(db, {
      id: input.egressId,
      taskId: row.task_id,
      ownerId: row.owner_id,
      endpoint: "/subscriptions/answer-completions/:deliveryId",
      subscriptionFiringId: row.firing_id,
      now,
      includeCitations: true,
    });
    if (!egress) return { outcome: "unavailable" } as const;
    audit(db, {
      subscriptionId: row.subscription_id,
      revision: row.revision,
      firingId: row.firing_id,
      eventType: "answer_egress_recorded",
      title: "Firing answer completion returned",
      status: egress.response.status,
      payload: { taskId: row.task_id, completionDeliveryId: input.deliveryId },
      createdAt: now,
    });
    return { outcome: "recorded", egress } as const;
  })();
}
