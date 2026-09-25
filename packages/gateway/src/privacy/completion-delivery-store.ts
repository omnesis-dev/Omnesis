// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import {
  type AnswerCompletionDelivery,
  type AuthorizeAnswerCompletionDeliveryInput,
  type ClaimedAnswerCompletionDelivery,
  type ClaimAnswerCompletionDeliveriesInput,
  type PrivacyDb,
  type SettleAnswerCompletionDeliveryInput,
} from "./store-types.js";

interface DeliveryRow extends AnswerCompletionDelivery {
  owner_id: string;
  task_status: string;
  claim_id: string | null;
  claim_expires_at: number | null;
}

export function claimAnswerCompletionDeliveries(
  db: PrivacyDb,
  input: ClaimAnswerCompletionDeliveriesInput,
): ClaimedAnswerCompletionDelivery[] {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const leaseMs = Math.max(1, Math.floor(input.leaseMs));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  return db.transaction(() => {
    db.prepare(
      `UPDATE answer_completion_deliveries
          SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'retry' END,
              claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
              next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
              last_error = 'delivery attempt lease expired', updated_at = ?
        WHERE status IN ('claimed', 'commit_authorized') AND claim_expires_at <= ?`,
    ).run(maxAttempts, maxAttempts, input.now, input.now, input.now);
    const rows = db
      .prepare<[number, number], DeliveryRow>(
        `SELECT d.id, d.task_id AS taskId, d.integration_device_id AS integrationDeviceId,
              d.native_conversation_id AS nativeConversationId, d.status, d.attempts,
              d.claim_id, d.claim_expires_at, t.owner_id, t.status AS task_status
         FROM answer_completion_deliveries d JOIN answer_tasks t ON t.id = d.task_id
        WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at <= ?
          AND t.status IN ('released', 'released_with_reductions', 'denied')
        ORDER BY d.next_attempt_at, d.created_at LIMIT ?`,
      )
      .all(input.now, limit);
    const claimed: ClaimedAnswerCompletionDelivery[] = [];
    for (const row of rows) {
      const claimId = `acd_claim_${randomUUID()}`;
      const changed = db
        .prepare(
          `UPDATE answer_completion_deliveries SET status = 'claimed', attempts = attempts + 1,
           claim_id = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retry')`,
        )
        .run(claimId, input.now, input.now + leaseMs, input.now, row.id);
      if (changed.changes !== 1) continue;
      claimed.push({
        id: row.id,
        taskId: row.taskId,
        integrationDeviceId: row.integrationDeviceId,
        nativeConversationId: row.nativeConversationId,
        status: "claimed",
        attempts: row.attempts + 1,
        claimId,
        claimExpiresAt: input.now + leaseMs,
        attempt: row.attempts + 1,
        phase: "prepare",
      });
    }
    return claimed;
  })();
}

export function authorizeAnswerCompletionDelivery(
  db: PrivacyDb,
  input: AuthorizeAnswerCompletionDeliveryInput,
): boolean {
  return db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE answer_completion_deliveries SET status = 'commit_authorized', updated_at = ?
        WHERE id = ? AND claim_id = ? AND status = 'claimed' AND claim_expires_at > ?
          AND EXISTS (SELECT 1 FROM answer_tasks t WHERE t.id = task_id
                        AND t.status IN ('released', 'released_with_reductions', 'denied'))`,
      )
      .run(input.now, input.deliveryId, input.claimId, input.now);
    return changed.changes === 1;
  })();
}

export function settleAnswerCompletionDelivery(
  db: PrivacyDb,
  input: SettleAnswerCompletionDeliveryInput,
): boolean {
  return db.transaction(() => {
    const row = db
      .prepare<
        [string],
        { status: string; claim_id: string | null }
      >("SELECT status, claim_id FROM answer_completion_deliveries WHERE id = ?")
      .get(input.deliveryId);
    if (!row || row.claim_id !== input.claimId) return false;
    switch (input.outcome.kind) {
      case "delivered":
        return (
          db
            .prepare(
              `UPDATE answer_completion_deliveries SET status = 'delivered', accepted_at = ?, local_run_id = ?,
             claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND claim_id = ?`,
            )
            .run(
              input.outcome.acceptedAt,
              input.outcome.localRunId,
              input.now,
              input.deliveryId,
              input.claimId,
            ).changes === 1
        );
      case "retry":
        return (
          db
            .prepare(
              `UPDATE answer_completion_deliveries SET status = 'retry', claim_id = NULL, claimed_at = NULL,
             claim_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND claim_id = ?`,
            )
            .run(
              input.outcome.nextAttemptAt,
              input.outcome.error.slice(0, 2000),
              input.now,
              input.deliveryId,
              input.claimId,
            ).changes === 1
        );
      case "failed":
        return (
          db
            .prepare(
              `UPDATE answer_completion_deliveries SET status = 'failed', claim_id = NULL, claimed_at = NULL,
             claim_expires_at = NULL, next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND claim_id = ?`,
            )
            .run(input.outcome.error.slice(0, 2000), input.now, input.deliveryId, input.claimId)
            .changes === 1
        );
    }
  })();
}
