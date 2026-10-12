// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { getOrganizationCohort, isOrganizationCohortCurrent } from "./organization-cohorts.js";
import type Database from "better-sqlite3";

/**
 * Arm at most one ordinary discovery reconsideration per evidence revision.
 * Publication, rather than a wall-clock retry, releases a captured search gap.
 * The marker and due time share a commit, so restart cannot repeatedly arm it.
 */
export function reconsiderPublishedRetrieval(
  db: Database.Database,
  input: { publishedThrough: string; limit: number },
  now: number,
): number {
  const removalFence = readableSourceFence(db);
  return db.transaction(() => {
    const rows = db
      .prepare<[string, string, number], { subject_id: string; input_revision: string }>(
        `
      SELECT c.subject_id,c.input_revision FROM knowledge_discovery_coverage c
      JOIN documents d ON d.id=c.subject_id AND ${knowledgeSourceRevisionSql()}=c.input_revision
      LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
      WHERE COALESCE(r.deleted,0)=0 ${removalFence} AND c.phase='organization' AND c.policy_version=? AND c.status='considered'
        AND c.retrieval_boundary IS NOT NULL AND c.retrieval_reconsidered=0 AND c.retrieval_boundary<=?
      ORDER BY c.retrieval_boundary,c.subject_id LIMIT ?
    `,
      )
      .all(
        KNOWLEDGE_DISCOVERY_POLICY,
        input.publishedThrough,
        Math.max(1, Math.min(500, input.limit)),
      );
    const update = db.prepare(`UPDATE knowledge_discovery_coverage
      SET reconsider_at=?,retrieval_reconsidered=1,retrieval_boundary=NULL
      WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=?
        AND retrieval_reconsidered=0`);
    for (const row of rows)
      update.run(now, row.subject_id, row.input_revision, KNOWLEDGE_DISCOVERY_POLICY);
    // Joint decisions keep their own debt: source completion/release must not
    // erase an editorial decision made before its searches were available.
    const cohorts = db
      .prepare<[string, string, number], { id: string }>(
        `SELECT id FROM knowledge_organization_cohorts
       WHERE policy_version=? AND status IN ('completed','deferred')
         AND retrieval_boundary IS NOT NULL AND retrieval_boundary<=? AND retrieval_reconsidered=0
       ORDER BY retrieval_boundary,id LIMIT ?`,
      )
      .all(
        KNOWLEDGE_DISCOVERY_POLICY,
        input.publishedThrough,
        Math.max(1, Math.min(500, input.limit)),
      );
    let released = 0;
    const settle = db.prepare(`UPDATE knowledge_organization_cohorts
      SET retrieval_reconsidered=1,retrieval_reconsider_at=?,updated_at=? WHERE id=? AND retrieval_reconsidered=0`);
    for (const row of cohorts) {
      const cohort = getOrganizationCohort(db, row.id);
      const consumed =
        cohort &&
        db
          .prepare(
            `SELECT 1 FROM knowledge_organization_cohorts
        WHERE input_fingerprint=? AND policy_version=? AND retrieval_reconsidered=1 LIMIT 1`,
          )
          .get(cohort.inputFingerprint, KNOWLEDGE_DISCOVERY_POLICY);
      const current = cohort && !consumed && isOrganizationCohortCurrent(db, cohort);
      // Consume obsolete debt without scheduling stale/private evidence. Each
      // bounded cohort has at most eight members and retains its audit history.
      settle.run(current ? now : null, now, row.id);
      if (current) released += 1;
    }
    return rows.length + released;
  })();
}

/** Considered source facts and pending search reconciliation are distinct progress. */
export function readRetrievalReconsiderationStatus(db: Database.Database) {
  const removalFence = readableSourceFence(db);
  return db
    .prepare(
      `SELECT
    COALESCE(SUM(c.retrieval_boundary IS NOT NULL AND c.retrieval_reconsidered=0),0) AS awaitingPublication,
    COALESCE(SUM(c.retrieval_reconsidered=1 AND c.reconsider_at IS NOT NULL),0) AS reconsiderationDue
    FROM knowledge_discovery_coverage c JOIN documents d ON d.id=c.subject_id AND ${knowledgeSourceRevisionSql()}=c.input_revision
    LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
    WHERE COALESCE(r.deleted,0)=0 ${removalFence} AND c.phase='organization' AND c.policy_version=? AND c.status='considered'`,
    )
    .get(KNOWLEDGE_DISCOVERY_POLICY);
}

function readableSourceFence(db: Database.Database): string {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get()
    ? "AND NOT EXISTS(SELECT 1 FROM removed_sources rs WHERE rs.id=d.source_id)"
    : "";
}
