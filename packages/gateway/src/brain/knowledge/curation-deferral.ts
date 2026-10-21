// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { assertWikiRepairAssessment, wikiFactualRepairFingerprint } from "./wiki-factual-repair.js";
import { parseClaimMarkup } from "./claims.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { pendingMaintenanceClaimIds } from "./claim-maintenance.js";
import { getKnowledgeNode, getKnowledgeClaims, getKnowledgeDependencies } from "./storage-read.js";
import { enqueueKnowledgeWork } from "./work.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

export interface KnowledgeCurationDeferralRecord {
  reasonCode: "insufficient_useful_context";
  batchId: string;
  revision: number;
  assessedAt: number;
  nextReviewAt: number;
}

/** Called in the writer transaction before replacing the current page. */
export function assertCurationDeferral(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  resolvedStates = false,
): boolean {
  const maintenance = input.maintenance;
  const request = maintenance?.curationDeferral;
  if (!request) return false;
  const previous = getKnowledgeNode(db, input.id);
  if (
    input.kind === "wiki" &&
    previous &&
    !db
      .prepare(
        "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND subject_kind='node' AND reason='review' AND (status='batched' OR (status='deferred' AND last_error='curation_insufficient_context'))",
      )
      .get(maintenance.batchId, input.id)
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Curation deferral defers only an offered whole-page review (review=true); this page is offered for claim repair, which cannot be deferred. Repair the claims you can re-check, keep the others unchanged and leave their review pending: this run's own earlier edits do not change that",
    );
  if (
    input.kind !== "wiki" ||
    !previous ||
    previous.title !== input.title ||
    maintenance.placementAssessment ||
    request.reasonCode !== "insufficient_useful_context" ||
    !request.reason.trim() ||
    request.reason.length > 500
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Curation deferral requires an existing offered wiki review with unchanged title, prose and claim semantics",
    );
  if (request.factualRepair) {
    if (resolvedStates) assertWikiRepairAssessment(db, input, true);
    else wikiFactualRepairFingerprint(db, input);
    return true;
  }
  const before = parseClaimMarkup(previous.markdown);
  const after = parseClaimMarkup(input.markdown);
  const states = new Map(getKnowledgeClaims(db, input.id).map((claim) => [claim.id, claim]));
  const proposed = new Map(input.claims?.map((claim) => [claim.id, claim]));
  const relations = new Map(
    getKnowledgeDependencies(db, input.id).map((dep) => [
      `${dep.claimId}:${dep.ref}`,
      dep.relation,
    ]),
  );
  const shape = (parsed: typeof before) =>
    parsed.claims.map((claim) => [claim.id, claim.parentId, claim.textSpan]);
  const fail = (): never => {
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Curation deferral cannot change claim meaning, qualifiers, support relations, title or prose; title and visible prose must remain unchanged; only supporting references may be repaired",
    );
  };
  if (
    before.text !== after.text ||
    !isDeepStrictEqual(shape(before), shape(after)) ||
    !isDeepStrictEqual(input.canonicalFields ?? previous.canonicalFields, previous.canonicalFields)
  )
    fail();
  let rewired = false;
  for (let i = 0; i < after.claims.length; i++) {
    const claim = after.claims[i]!;
    const old = before.claims[i]!;
    const state = states.get(claim.id);
    if (!state) fail();
    const next = proposed.get(claim.id);
    const defaults = {
      supportLogic: "all",
      attribution: null,
      modality: "observation",
      epistemicStatus: "asserted",
      validFrom: null,
      validUntil: null,
    } as const;
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
      const effective =
        next?.[key] === undefined ? (resolvedStates ? defaults[key] : state![key]) : next[key];
      if (effective !== state![key]) fail();
    }
    const oldRefs = old.refs.map((ref) => ref.raw);
    const newRefs = claim.refs.map((ref) => ref.raw);
    const changed = !isDeepStrictEqual(oldRefs, newRefs);
    const oldRelations = oldRefs.map((ref) => relations.get(`${claim.id}:${ref}`) ?? "supports");
    const newRelations = newRefs.map((ref) =>
      next?.relations !== undefined || resolvedStates
        ? (next?.relations?.[ref] ?? "supports")
        : (relations.get(`${claim.id}:${ref}`) ?? "supports"),
    );
    if (changed) {
      // The complete unchanged assertion must receive fresh proof from the new support set.
      if (
        oldRelations.some((relation) => relation !== "supports") ||
        newRelations.some((relation) => relation !== "supports")
      )
        fail();
      rewired = true;
    } else if (!isDeepStrictEqual(oldRelations, newRelations)) fail();
  }
  return rewired;
}

/** Factual review remains mandatory; only the separate editorial obligation is delayed. */
export function recordCurationDeferral(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  now: number,
  requirePositiveProof = false,
): KnowledgeCurationDeferralRecord | undefined {
  const maintenance = input.maintenance;
  if (!maintenance?.curationDeferral) return undefined;
  if (pendingMaintenanceClaimIds(db, { ...maintenance, nodeId: input.id }).length)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Review every offered claim against current evidence before deferring curation; unreviewed claims remain pending",
    );
  if (
    requirePositiveProof &&
    getKnowledgeClaims(db, input.id).some(
      (claim) => claim.verification !== "verified" || claim.verifier !== CONTEXTUAL_VERIFIER,
    )
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Proof-only curation repair requires current positive verification for every retained claim; unavailable verification leaves the original page and pending work unchanged",
    );
  const revision = getKnowledgeNode(db, input.id)!.revision;
  const nextReviewAt = now + Math.max(60_000, maintenance.placementRetryDelayMs ?? 21_600_000);
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?,'$.reviewDecision','defer','$.reviewReason','curation_insufficient_context','$.reviewDecidedAt',?) WHERE id=?",
  ).run(nextReviewAt, now, input.id);
  db.prepare(
    "UPDATE knowledge_work SET status='deferred',updated_at=?,last_error='curation_insufficient_context' WHERE batch_id=? AND subject_id=? AND subject_kind='node' AND reason='review' AND status='batched'",
  ).run(now, maintenance.batchId, input.id);
  enqueueKnowledgeWork(
    db,
    {
      id: `kw_${randomUUID()}`,
      subjectId: input.id,
      subjectKind: "node",
      reason: "review",
      inputRevision: String(revision),
      tier: "routine",
      dueAt: nextReviewAt,
    },
    now,
  );
  // Free-form explanation stays in the privacy-bound run transcript, not scheduler metadata.
  return {
    reasonCode: "insufficient_useful_context",
    batchId: maintenance.batchId,
    revision,
    assessedAt: now,
    nextReviewAt,
  };
}
