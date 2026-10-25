// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";

/** Distinct source revisions, independent of retries, batching and discovery phase count. */
export const KNOWLEDGE_COVERAGE_CTE = `WITH admitted AS (
  SELECT subject_id,input_revision,MAX(updated_at) AS progress FROM knowledge_work
    WHERE subject_kind='source' GROUP BY subject_id,input_revision
  UNION ALL
  SELECT subject_id,input_revision,MAX(reviewed_at) AS progress FROM knowledge_discovery_coverage
    WHERE phase='organization' AND policy_version='${KNOWLEDGE_DISCOVERY_POLICY}' GROUP BY subject_id,input_revision
), revisions AS (
  SELECT subject_id,input_revision,MAX(progress) AS progress FROM admitted GROUP BY subject_id,input_revision
), classified AS (
  SELECT d.source_id,r.subject_id,r.input_revision,MAX(r.progress,COALESCE(c.reviewed_at,0)) AS progress,c.status
  FROM revisions r JOIN documents d ON d.id=r.subject_id
  LEFT JOIN knowledge_discovery_coverage c ON c.subject_id=r.subject_id AND c.input_revision=r.input_revision
    AND c.phase='organization' AND c.policy_version='${KNOWLEDGE_DISCOVERY_POLICY}'
), knowledge_counts AS (
  SELECT source_id,COUNT(*) AS eligible,COALESCE(SUM(status='considered'),0) AS processed,
    COALESCE(SUM(status='gated'),0) AS skipped,MAX(progress) AS last_progress_at
  FROM classified GROUP BY source_id
), coverage_view AS (
  SELECT *, 'documents' AS unit,'workflow-ledger' AS cost_attribution FROM cognition_coverage
    WHERE workflow_id!='knowledge-maintenance'
  UNION ALL
  SELECT source_id,'knowledge-maintenance' AS workflow_id,1 AS workflow_version,eligible,processed,skipped,
    NULL AS prompt_tokens,NULL AS completion_tokens,last_progress_at,
    CASE WHEN processed+skipped>=eligible THEN 'settled' ELSE 'in-progress' END AS status,
    'source-revisions' AS unit,'shared-run-ledger' AS cost_attribution
  FROM knowledge_counts
)`;
