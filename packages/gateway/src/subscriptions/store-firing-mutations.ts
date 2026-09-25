// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writing a watch firing into the record substrate.
 *
 * A firing is where a watch stops being a definition and becomes something a
 * person or an agent is told about: the row that a delivery is queued from, the
 * disclosure the privacy ledger counts, and the authority a firing answer is
 * later scoped to. All of that is the substrate rather than the engine — one
 * engine decides *when*, and this records *that it did*.
 */

import { audit } from "./store-mutation-helpers.js";
import {
  planEvidenceRule,
  parseStoredSubscriptionJson,
  storedSubscriptionCompiledPlanCodec,
} from "./store-codecs.js";
import type { Db } from "../data/types.js";
import type { PrivacyCumulativeCategory } from "@omnesis/types/privacy";
import type { FireSubscriptionMutation, FireSubscriptionMutationResult } from "./store-types.js";

function disclosureCategories(value: string): PrivacyCumulativeCategory[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): PrivacyCumulativeCategory[] => {
      if (typeof item === "string") {
        return [{ category: item, detailLevel: "existence", subject: "unknown", count: 1 }];
      }
      if (!item || typeof item !== "object") return [];
      const row = item as Partial<PrivacyCumulativeCategory>;
      if (
        typeof row.category !== "string" ||
        !["existence", "summary", "exact", "original"].includes(row.detailLevel ?? "") ||
        !["user", "other_person", "multiple_people", "unknown"].includes(row.subject ?? "") ||
        !Number.isSafeInteger(row.count) ||
        (row.count ?? 0) < 1
      ) {
        return [];
      }
      return [row as PrivacyCumulativeCategory];
    });
  } catch {
    return [];
  }
}

export function addExistenceDisclosure(
  priorJson: string,
  firingJson: string,
): PrivacyCumulativeCategory[] {
  const merged = new Map<string, PrivacyCumulativeCategory>();
  for (const row of disclosureCategories(priorJson)) {
    merged.set(`${row.category}\0${row.detailLevel}\0${row.subject}`, { ...row });
  }
  for (const row of disclosureCategories(firingJson)) {
    const key = `${row.category}\0existence\0${row.subject}`;
    const prior = merged.get(key);
    if (prior) prior.count += 1;
    else merged.set(key, { ...row, detailLevel: "existence", count: 1 });
  }
  return [...merged.values()];
}

/**
 * The observation as stored, or null when it is too large to keep.
 *
 * Whatever the watch's report clause produced, and therefore unbounded at the
 * source. It is written on every firing and later read verbatim into an
 * answering turn's prompt, so a runaway payload would cost storage on the way
 * in and context on the way out. Dropped rather than truncated: half a row is
 * a misleading answer about which occurrence fired, and the condition summary
 * beside it still says what became true.
 */
const MAX_OBSERVATION_BYTES = 8_192;

function boundedObservation(observation: Record<string, unknown>): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(observation);
  } catch {
    return null;
  }
  return Buffer.byteLength(serialized, "utf8") <= MAX_OBSERVATION_BYTES ? serialized : null;
}

function fireSubscriptionInTransaction(
  db: Db,
  input: FireSubscriptionMutation,
): FireSubscriptionMutationResult {
  const row = db
    .prepare<
      [string],
      {
        current_revision: number;
        status: string;
        expires_at: number | null;
        workflow_id: string;
        owner_id: string;
        integration_device_id: string;
        grant_policy_revision: string | null;
        grant_expires_at: number | null;
        grant_revoked_at: number | null;
        categories_json: string;
        disclosure_categories_json: string;
        compiled_plan_json: string;
      }
    >(
      `SELECT s.current_revision, s.status, s.expires_at, r.workflow_id,
              s.owner_id, s.integration_device_id,
              g.policy_revision AS grant_policy_revision,
              g.expires_at AS grant_expires_at, g.revoked_at AS grant_revoked_at,
              r.privacy_categories_json AS categories_json,
              g.disclosure_categories_json,
              r.compiled_plan_json
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
         LEFT JOIN subscription_grants g
           ON g.subscription_id = s.id AND g.revision = s.current_revision
        WHERE s.id = ?`,
    )
    .get(input.subscriptionId);
  if (!row) return { outcome: "not_found" };
  if (row.current_revision !== input.revision) return { outcome: "stale_revision" };
  if (row.status !== "active") return { outcome: "inactive" };
  if (row.expires_at !== null && row.expires_at <= input.firedAt) return { outcome: "expired" };
  if (
    row.grant_policy_revision !== input.policyRevision ||
    row.grant_revoked_at !== null ||
    row.grant_expires_at === null ||
    row.grant_expires_at <= input.firedAt
  ) {
    return { outcome: "grant_unavailable" };
  }
  const plan = parseStoredSubscriptionJson(
    storedSubscriptionCompiledPlanCodec,
    row.compiled_plan_json,
    "compiled plan",
  );
  const uniqueEvidence = new Set(input.evidenceDocumentIds);
  const evidenceRule = planEvidenceRule(plan);
  if (evidenceRule === "none" && uniqueEvidence.size !== 0) {
    throw new Error("an existence-only firing cannot carry document evidence");
  }
  // An observation belongs only to a firing whose approved evidence kind is
  // the condition itself. Where documents are the evidence they already say
  // what happened, and a second description of the same occurrence could
  // disagree with them; where the approval admitted no evidence at all, the
  // rule the line above enforces for documents holds here too.
  const observation =
    evidenceRule !== "none" || uniqueEvidence.size !== 0
      ? null
      : input.observation && Object.keys(input.observation).length > 0
        ? boundedObservation(input.observation)
        : null;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO subscription_firings
         (id, subscription_id, revision, workflow_id, index_event_key,
          status, evidence_json, evidence_count, observation_json, fired_at)
       VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`,
    )
    .run(
      input.firingId,
      input.subscriptionId,
      input.revision,
      row.workflow_id,
      input.indexEventKey,
      uniqueEvidence.size,
      observation,
      input.firedAt,
    );
  if (result.changes === 0) {
    const existing = db
      .prepare<[string, number, string], { id: string; delivery_id: string | null }>(
        `SELECT f.id, d.id AS delivery_id FROM subscription_firings f
          LEFT JOIN subscription_deliveries d ON d.firing_id = f.id
          WHERE f.subscription_id = ? AND f.revision = ? AND f.index_event_key = ?`,
      )
      .get(input.subscriptionId, input.revision, input.indexEventKey);
    if (!existing) throw new Error("firing insert was ignored without an idempotent row");
    if (!existing.delivery_id) {
      db.prepare(
        `INSERT INTO subscription_deliveries
           (id, firing_id, subscription_id, revision, integration_device_id,
            workflow_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        `sdel_${existing.id}`,
        existing.id,
        input.subscriptionId,
        input.revision,
        row.integration_device_id,
        row.workflow_id,
        input.firedAt,
        input.firedAt,
      );
    }
    return { outcome: "duplicate", firingId: existing.id };
  }
  const insertEvidence = db.prepare(
    `INSERT INTO subscription_firing_evidence (firing_id, document_id)
     VALUES (?, ?)`,
  );
  for (const documentId of uniqueEvidence) {
    insertEvidence.run(input.firingId, documentId);
  }
  const deliveryId = `sdel_${input.firingId}`;
  const workflowDisclosure = db
    .prepare<
      [string],
      { categories_json: string }
    >("SELECT categories_json FROM subscription_workflow_disclosure WHERE workflow_id = ?")
    .get(row.workflow_id);
  const cumulativeCategories = addExistenceDisclosure(
    workflowDisclosure?.categories_json ?? "[]",
    row.disclosure_categories_json === "[]" ? row.categories_json : row.disclosure_categories_json,
  );
  db.prepare(
    `INSERT INTO subscription_deliveries
       (id, firing_id, subscription_id, revision, integration_device_id,
        workflow_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    deliveryId,
    input.firingId,
    input.subscriptionId,
    input.revision,
    row.integration_device_id,
    row.workflow_id,
    input.firedAt,
    input.firedAt,
  );
  db.prepare(
    `UPDATE subscription_workflow_disclosure
        SET revision = revision + 1,
            existence_signals = existence_signals + 1,
            categories_json = ?,
            updated_at = ?
      WHERE workflow_id = ?`,
  ).run(JSON.stringify(cumulativeCategories), input.firedAt, row.workflow_id);
  audit(db, {
    subscriptionId: input.subscriptionId,
    revision: input.revision,
    eventType: "fired",
    title: "Watch condition became true",
    status: "pending",
    firingId: input.firingId,
    payload: { firingId: input.firingId, deliveryId },
    createdAt: input.firedAt,
  });
  audit(db, {
    subscriptionId: input.subscriptionId,
    revision: input.revision,
    eventType: "delivery_enqueued",
    title: "Watch delivery queued",
    status: "pending",
    firingId: input.firingId,
    payload: { firingId: input.firingId, deliveryId },
    createdAt: input.firedAt,
  });
  return { outcome: "fired", firingId: input.firingId };
}

export function fireSubscription(
  db: Db,
  input: FireSubscriptionMutation,
): FireSubscriptionMutationResult {
  return db.transaction(() => fireSubscriptionInTransaction(db, input))();
}
