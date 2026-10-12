// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import { CONTEXTUAL_VERIFIER } from "../knowledge/claim-context.js";
import type Database from "better-sqlite3";

/** Current proof policy, joined to real bound review work, never a payload priority. */
export function policyRepairAdmissionSql(db: Database.Database): string {
  const tables = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  if (
    ![
      "knowledge_work",
      "knowledge_batches",
      "knowledge_batch_regions",
      "knowledge_nodes",
      "knowledge_claims",
    ].every((name) => tables.has(name))
  )
    return "0";
  const retiredNotes = ["doc_annotation", "person_annotation"]
    .map((kind) => {
      const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
      return tables.has(table)
        ? `(n.kind='${kind}' AND NOT EXISTS(SELECT 1 FROM ${table} owner WHERE owner.id=COALESCE(n.owner_id,n.id) AND owner.invalidated_at IS NULL AND owner.superseded_by IS NULL))`
        : `(n.kind='${kind}')`;
    })
    .join(" OR ");
  const retired = `${retiredNotes} OR ${
    tables.has("open_loops")
      ? "(n.kind='loop' AND NOT EXISTS(SELECT 1 FROM open_loops owner WHERE owner.id=COALESCE(n.owner_id,n.id)))"
      : "(n.kind='loop')"
  }`;
  // Keep the lookup bounded by this batch’s reserved region, not all nodes of a kind.
  return `(kind='synthesis' AND EXISTS(
    SELECT 1 FROM knowledge_batches b CROSS JOIN knowledge_batch_regions r ON r.batch_id=b.id
    CROSS JOIN knowledge_nodes n ON n.id=r.node_id
    CROSS JOIN knowledge_work w ON w.subject_kind='node' AND w.subject_id=n.id AND w.batch_id=b.id
    WHERE b.id=json_extract(cognition_runs.payload_json,'$.batchId')
      AND b.run_id=cognition_runs.id AND b.status IN ('pending','running','deferred')
      AND w.subject_kind='node' AND w.reason='review' AND w.status='batched'
      AND n.kind IN ('wiki','root','loop','doc_annotation','person_annotation')
      AND COALESCE(json_extract(n.fields_json,'$.withdrawn'),0)!=1
      AND NOT (${retired})
      AND EXISTS(SELECT 1 FROM knowledge_claims c WHERE c.node_id=n.id
        AND c.verification='verified'
        AND COALESCE(c.verifier,'')!=CASE WHEN n.kind IN ('wiki','root','loop')
          THEN '${CONTEXTUAL_VERIFIER}' ELSE '${ANNOTATION_CONTEXT_VERIFIER}' END)))`;
}
