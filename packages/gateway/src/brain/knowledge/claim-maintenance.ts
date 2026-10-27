// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

export interface ClaimMaintenanceIdentity {
  batchId: string;
  nodeId: string;
  inputFingerprint: string;
}

/** Snapshot eligible identities and revisions, never copies of private prose. */
export function snapshotClaimMaintenance(
  db: Database.Database,
  identity: ClaimMaintenanceIdentity,
  eligibleClaimIds?: readonly string[],
): void {
  if (identity.nodeId.startsWith("source:")) return;
  const claims = db
    .prepare<[string], { id: string; meaning_revision: number }>(
      "SELECT id,meaning_revision FROM knowledge_claims WHERE node_id=? ORDER BY id",
    )
    .all(identity.nodeId);
  if (claims.length > 1024 || (eligibleClaimIds?.length ?? 0) > 1024)
    throw new KnowledgeStorageError("claim_invalid", "Claim maintenance exceeds its bounded scope");
  const eligible = eligibleClaimIds ? new Set(eligibleClaimIds) : null;
  const insert =
    db.prepare(`INSERT INTO knowledge_claim_outcomes(batch_id,node_id,input_fingerprint,claim_id,input_claim_revision,status)
    VALUES(?,?,?,?,?,'pending') ON CONFLICT(batch_id,node_id,input_fingerprint,claim_id) DO NOTHING`);
  for (const claim of claims)
    if (!eligible || eligible.has(claim.id))
      insert.run(
        identity.batchId,
        identity.nodeId,
        identity.inputFingerprint,
        claim.id,
        claim.meaning_revision,
      );
}

export function pendingMaintenanceClaimIds(
  db: Database.Database,
  identity: ClaimMaintenanceIdentity,
): string[] {
  return db
    .prepare<[string, string, string], { claim_id: string }>(
      "SELECT claim_id FROM knowledge_claim_outcomes WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND status='pending' ORDER BY claim_id",
    )
    .all(identity.batchId, identity.nodeId, identity.inputFingerprint)
    .map((row) => row.claim_id);
}

/**
 * Each claim's dependencies as one comparable signature: its references and the
 * versions it observed them at. Read before a write replaces them.
 */
export function claimDependencySignatures(
  db: Database.Database,
  nodeId: string,
): Map<string, string> {
  const rows = db
    .prepare<[string], { claim_id: string; ref: string; input_version_json: string }>(
      "SELECT claim_id,ref,input_version_json FROM knowledge_dependencies WHERE node_id=? ORDER BY claim_id,ref",
    )
    .all(nodeId);
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const refs = grouped.get(row.claim_id) ?? [];
    refs.push(`${row.ref}\u0000${row.input_version_json}`);
    grouped.set(row.claim_id, refs);
  }
  return new Map([...grouped].map(([id, refs]) => [id, refs.join("\u0001")]));
}

/**
 * Called inside the accepted page write transaction, after claim validation.
 * `previousDependencies` are the page's {@link claimDependencySignatures} read
 * before the write replaced them.
 */
export function recordAcceptedClaimMaintenance(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  previousDependencies: ReadonlyMap<string, string>,
): void {
  if (!input.maintenance) return;
  const identity = { ...input.maintenance, nodeId: input.id };
  const current = new Map(
    db
      .prepare<[string], { id: string; meaning_revision: number }>(
        "SELECT id,meaning_revision FROM knowledge_claims WHERE node_id=?",
      )
      .all(input.id)
      .map((row) => [row.id, row.meaning_revision]),
  );
  const rows = db
    .prepare<
      [string, string, string],
      { claim_id: string; input_claim_revision: number; status: string }
    >(
      "SELECT claim_id,input_claim_revision,status FROM knowledge_claim_outcomes WHERE batch_id=? AND node_id=? AND input_fingerprint=?",
    )
    .all(identity.batchId, identity.nodeId, identity.inputFingerprint);
  const reviewed = new Set(input.maintenance.reviewedClaimIds ?? []);
  if (
    reviewed.size > 1024 ||
    [...reviewed].some((id) => !current.has(id) && !rows.some((row) => row.claim_id === id))
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Reviewed claims must name this page's eligible or accepted assertions",
    );
  const update = db.prepare(
    "UPDATE knowledge_claim_outcomes SET status=?,result_claim_revision=? WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND claim_id=?",
  );
  for (const row of rows) {
    if (row.status !== "pending") continue;
    const revision = current.get(row.claim_id);
    if (revision !== row.input_claim_revision || reviewed.has(row.claim_id))
      update.run(
        revision === row.input_claim_revision ? "unchanged" : "changed",
        revision ?? null,
        identity.batchId,
        identity.nodeId,
        identity.inputFingerprint,
        row.claim_id,
      );
  }
  const known = new Set(rows.map((row) => row.claim_id));
  const acceptedRevision = db
    .prepare<[string], { revision: number }>("SELECT revision FROM knowledge_nodes WHERE id=?")
    .get(input.id)!.revision;
  for (const [id, revision] of current)
    if (!known.has(id) && revision === acceptedRevision)
      db.prepare(
        `INSERT INTO knowledge_claim_outcomes(batch_id,node_id,input_fingerprint,claim_id,input_claim_revision,result_claim_revision,status)
      VALUES(?,?,?,?,0,?,'changed')`,
      ).run(identity.batchId, identity.nodeId, identity.inputFingerprint, id, revision);
  // A page write cannot silently refresh an untouched eligible assertion merely
  // because the caller supplied a new document-wide input-version map: a claim
  // still pending whose recorded versions this write moved is stale until it
  // is reviewed. One whose dependencies the write carried through unchanged
  // keeps its state, so editing one claim never makes its untouched neighbours
  // look broken.
  const dependencies = claimDependencySignatures(db, input.id);
  const refreshed = pendingMaintenanceClaimIds(db, identity).filter(
    (id) => (dependencies.get(id) ?? "") !== (previousDependencies.get(id) ?? ""),
  );
  for (const id of refreshed)
    db.prepare(
      "UPDATE knowledge_claims SET verification='stale',verifier=NULL WHERE node_id=? AND id=?",
    ).run(input.id, id);
  if (refreshed.length)
    db.prepare("UPDATE knowledge_nodes SET validity='stale' WHERE id=?").run(input.id);
}

/** Gating and input supersession are explicit outcomes, never entailment proofs. */
export function settleClaimMaintenance(
  db: Database.Database,
  input: ClaimMaintenanceIdentity & { status: string; resultRevision?: number },
): void {
  if (["offered", "pending", "deferred"].includes(input.status)) return;
  const pending = pendingMaintenanceClaimIds(db, input);
  if (!pending.length) return;
  if (input.status !== "skipped" && input.resultRevision !== undefined)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Eligible claims still require explicit review or repair",
    );
  db.prepare(
    "UPDATE knowledge_claim_outcomes SET status=? WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND status='pending'",
  ).run(
    input.status === "skipped" ? "skipped" : "deferred",
    input.batchId,
    input.nodeId,
    input.inputFingerprint,
  );
}
