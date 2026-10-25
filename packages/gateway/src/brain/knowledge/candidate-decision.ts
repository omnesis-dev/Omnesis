// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownsCandidateTurn } from "./candidate-affinity.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type Database from "better-sqlite3";

/** Only work explicitly admitted for this candidate generation owes its decision. */
export function pendingCandidateDecisions(
  db: Database.Database,
  batchId: string,
): Array<{ id: string; revision: number }> {
  if (!ownsCandidateTurn(db, batchId)) return [];
  const rows = db
    .prepare<[string], { id: string; revision: number; evidence: string }>(
      `SELECT DISTINCT c.id,c.revision,c.evidence_ids_json AS evidence FROM knowledge_candidate_decision_work cw
     JOIN knowledge_work w ON w.id=cw.work_id JOIN knowledge_candidates c ON c.id=cw.candidate_id
     JOIN knowledge_batches b ON b.id=w.batch_id
     WHERE w.batch_id=? AND b.status NOT IN ('completed','abandoned') AND c.decision_pending=1 AND c.decision_generation=cw.generation
       AND c.status IN ('proposed','deferred') ORDER BY c.id`,
    )
    .iterate(batchId);
  const result: Array<{ id: string; revision: number }> = [];
  for (const row of rows) {
    const ids: string[] = JSON.parse(row.evidence);
    if (
      ids.every((id) => isKnowledgeEvidenceReadable(db, id)) &&
      candidateSourcesSettled(db, row.id)
    )
      result.push({ id: row.id, revision: row.revision });
    // Remaining obligations are offered by the next frontier after these decisions.
    if (result.length === 20) break;
  }
  return result;
}

/** Source progress, not batch completion: the last chunk may still owe the decision. */
function candidateSourcesSettled(db: Database.Database, candidateId: string): boolean {
  return !db
    .prepare(
      `SELECT 1 FROM knowledge_candidate_decision_work cw
    JOIN knowledge_candidates c ON c.id=cw.candidate_id JOIN knowledge_work w ON w.id=cw.work_id
    WHERE c.id=? AND cw.generation=c.decision_generation
      AND w.status!='completed' AND (w.status IN ('pending','deferred') OR
        NOT EXISTS(SELECT 1 FROM knowledge_frontier f WHERE f.batch_id=w.batch_id AND f.node_id=CASE w.subject_kind WHEN 'source' THEN 'source:'||w.subject_id ELSE w.subject_id END)
        OR EXISTS(SELECT 1 FROM knowledge_frontier f WHERE f.batch_id=w.batch_id
          AND f.node_id=CASE w.subject_kind WHEN 'source' THEN 'source:'||w.subject_id ELSE w.subject_id END
          AND f.status IN ('pending','offered','deferred'))) LIMIT 1`,
    )
    .get(candidateId);
}
