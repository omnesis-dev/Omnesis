// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { policyRevision } from "../privacy/policy-store.js";
import type { Db } from "../data/types.js";
import type { PrivacyPolicyRevisionGuard } from "../privacy/store-types.js";

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function matchesPrivacyPolicyRevision(
  db: Db,
  guard: PrivacyPolicyRevisionGuard | undefined,
): boolean {
  if (!guard) return true;
  const state = db
    .prepare<
      [string],
      { revision: string; digest: string }
    >("SELECT revision, digest FROM privacy_policy_state WHERE family_id = ?")
    .get(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
  if (state === undefined) {
    try {
      return policyRevision(readFileSync(guard.path, "utf8")) === guard.expectedRevision;
    } catch {
      return false;
    }
  }
  return (
    state.revision === guard.expectedRevision &&
    (guard.expectedDigest === undefined || state.digest === guard.expectedDigest)
  );
}

export function audit(
  db: Db,
  input: {
    subscriptionId: string;
    revision: number | null;
    eventType: string;
    title: string;
    status?: string;
    payload?: Record<string, unknown>;
    firingId?: string | null;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO subscription_audit_events
       (id, subscription_id, revision, firing_id, event_type, display_json, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `sae_${randomUUID()}`,
    input.subscriptionId,
    input.revision,
    input.firingId ?? null,
    input.eventType,
    json({ title: input.title, status: input.status ?? null }),
    json(input.payload ?? {}),
    input.createdAt,
  );
}

export const SUBSCRIPTION_APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function cancelOpenSubscriptionDeliveries(
  db: Db,
  subscriptionId: string,
  canceledAt: number,
  reason: string,
): void {
  const rows = db
    .prepare<[string], { id: string; firing_id: string; revision: number }>(
      `SELECT id, firing_id, revision
         FROM subscription_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'claimed', 'retry')`,
    )
    .all(subscriptionId);
  db.prepare(
    `UPDATE subscription_firing_answer_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE subscription_id = ? AND revoked_at IS NULL`,
  ).run(canceledAt, subscriptionId);
  db.prepare(
    `UPDATE subscription_firing_outcome_authorities
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE subscription_id = ? AND revoked_at IS NULL`,
  ).run(canceledAt, subscriptionId);
  if (rows.length === 0) return;
  db.prepare(
    `UPDATE subscription_deliveries
        SET status = 'cancel_pending',
            claim_id = CASE WHEN status = 'claimed' THEN claim_id ELSE NULL END,
            claimed_at = CASE WHEN status = 'claimed' THEN claimed_at ELSE NULL END,
            claim_expires_at =
              CASE WHEN status = 'claimed' THEN claim_expires_at ELSE NULL END,
            next_attempt_at = ?,
            last_error = ?, updated_at = ?
      WHERE subscription_id = ? AND status IN ('pending', 'claimed', 'retry')`,
  ).run(canceledAt, reason, canceledAt, subscriptionId);
  for (const row of rows) {
    db.prepare("UPDATE subscription_firings SET status = 'blocked' WHERE id = ?").run(
      row.firing_id,
    );
    audit(db, {
      subscriptionId,
      revision: row.revision,
      eventType: "delivery_cancel_pending",
      title: "Watch delivery cancellation queued",
      status: "cancel_pending",
      firingId: row.firing_id,
      payload: { deliveryId: row.id, firingId: row.firing_id, reason },
      createdAt: canceledAt,
    });
  }
}
