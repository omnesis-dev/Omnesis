// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Claims a maintenance run cannot re-check because they rest on a source
 * excluded from the Brain (`brain.excludedSources`). A background run may not
 * read or newly cite that source, so it has no way to re-ground such a claim,
 * and being unable to re-check a claim is not evidence against it. While none
 * of the claim's own references changed, its review is not offered: the claim
 * is kept unchanged and its outcome settles as `skipped`, which records that it
 * was not examined, never that it was verified. A claim whose own reference
 * changed or was deleted is still offered, because a real change is the
 * Brain's to judge.
 */

import { brainSourceInclusionSql } from "../source-exclusion.js";
import { pendingMaintenanceClaimIds, type ClaimMaintenanceIdentity } from "./claim-maintenance.js";
import { parseClaimReference } from "./references.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { resolveKnowledgeReference } from "./storage-validation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Whether one recorded dependency still reads the version the claim observed. */
function dependencyUnchanged(db: Database.Database, ref: string, observedJson: string): boolean {
  try {
    const target = resolveKnowledgeReference(db, parseClaimReference(ref));
    return !target.stale && target.revision === JSON.parse(observedJson);
  } catch (error) {
    if (error instanceof KnowledgeStorageError) return false;
    throw error;
  }
}

/**
 * Pending claims of one offered item that cite a document of an excluded
 * source and whose own references all still read the versions they observed.
 */
export function unreadablePendingClaimIds(
  db: Database.Database,
  identity: ClaimMaintenanceIdentity,
  excluded: readonly string[],
): string[] {
  if (excluded.length === 0 || identity.nodeId.startsWith("source:")) return [];
  const pending = new Set(pendingMaintenanceClaimIds(db, identity));
  if (pending.size === 0) return [];
  const inclusion = brainSourceInclusionSql(excluded, "doc.source_id");
  const cited = db
    .prepare<unknown[], { claim_id: string }>(
      `SELECT DISTINCT d.claim_id FROM knowledge_dependencies d JOIN documents doc ON doc.id=d.target_id
       WHERE d.node_id=? AND d.target_kind='source' AND NOT (${inclusion.sql}) ORDER BY d.claim_id`,
    )
    .all(identity.nodeId, ...inclusion.params)
    .map((row) => row.claim_id)
    .filter((id) => pending.has(id));
  if (cited.length === 0) return [];
  const dependencies = db.prepare<[string, string], { ref: string; input_version_json: string }>(
    "SELECT ref,input_version_json FROM knowledge_dependencies WHERE node_id=? AND claim_id=?",
  );
  return cited.filter((claimId) =>
    dependencies
      .all(identity.nodeId, claimId)
      .every((dependency) =>
        dependencyUnchanged(db, dependency.ref, dependency.input_version_json),
      ),
  );
}

/**
 * Writer leaf: settle {@link unreadablePendingClaimIds} as `skipped`,
 * recomputed in this transaction. Returns the claims it settled.
 */
export function exemptUnreadableClaims(
  db: Database.Database,
  input: ClaimMaintenanceIdentity & { runId: string; excluded: readonly string[] },
): string[] {
  return db.transaction(() => {
    assertKnowledgeRunFence(db, { batchId: input.batchId, runId: input.runId });
    const ids = unreadablePendingClaimIds(db, input, input.excluded);
    const settle = db.prepare(
      "UPDATE knowledge_claim_outcomes SET status='skipped' WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND claim_id=? AND status='pending'",
    );
    for (const id of ids) settle.run(input.batchId, input.nodeId, input.inputFingerprint, id);
    return ids;
  })();
}
