// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Test-harness progress, separate from the predicate deciding whether work is quiet. */
export function readMaintenanceProgress(db: Database.Database, horizon: number) {
  const rows = db
    .prepare<[number], { phase: string; marker: string; pending: number }>(
      `
    SELECT 'work' AS phase,
      json_array(id,input_revision,generation,status,tier,last_error) AS marker,1 AS pending
      FROM knowledge_work WHERE status IN ('pending','batched') AND due_at<=?
    UNION ALL SELECT 'journal',json_array(seq,kind,entity_id,revision),1 FROM knowledge_changes
    UNION ALL SELECT 'owner',json_array(kind,owner_id,operation),1 FROM knowledge_owner_changes
    UNION ALL SELECT 'cascade',json_array(id,kind,target_kind,target_id,revision),1 FROM knowledge_cascade_jobs
    UNION ALL SELECT 'cleanup',json_array(document_id,node_id),1 FROM knowledge_projection_cleanup
    UNION ALL SELECT 'cascade-frontier',json_array(job_id,target_kind,target_id,after_node_id,done),0
      FROM knowledge_cascade_frontier
    UNION ALL SELECT 'batch',json_array(id,status,revision),1 FROM knowledge_batches
      WHERE status IN ('pending','running')
    ORDER BY phase,marker
  `,
    )
    .all(horizon);
  const hash = createHash("sha256");
  let pending = 0;
  for (const row of rows) {
    pending += row.pending;
    // Row identity, input generation and completed cursor movement count as
    // progress. Retry timestamps, owner queue rotation and elapsed time do not.
    hash.update(JSON.stringify([row.phase, row.marker]));
  }
  return { pending, signature: hash.digest("hex") };
}
