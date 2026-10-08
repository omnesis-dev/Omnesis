// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { getKnowledgeCandidate, type KnowledgeCandidate } from "./discovery.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import { enqueueKnowledgeWork } from "./work.js";
import type Database from "better-sqlite3";

export type OrganizationAdmission =
  | { kind: "candidate"; id: string; revision: number }
  | { kind: "coverage"; id: string; inputRevision: string; reviewedAt: number };

/** Revisit already authorized evidence; this does not expand historical consent. */
export function listOrganizationAdmissions(
  db: Database.Database,
  options: { now: number; limit: number; retryMs: number },
): OrganizationAdmission[] {
  const limit = Math.max(1, Math.min(100, options.limit));
  // Filter unreadable evidence before LIMIT. Privacy cleanup can be deferred;
  // hidden candidates must not occupy every bounded scheduling slot meanwhile.
  const removed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get();
  const metadata = db
    .prepare<[], { name: string }>("PRAGMA table_info(documents)")
    .all()
    .some((column) => column.name === "metadata");
  const readable = `EXISTS(SELECT 1 FROM documents oe LEFT JOIN knowledge_source_revisions r ON r.document_id=oe.id
    WHERE oe.id=e.value AND COALESCE(r.deleted,0)=0 AND oe.source_id NOT IN (?,?)
    ${metadata ? "AND COALESCE(json_extract(oe.metadata,'$.documentType'),'') NOT IN (?,?)" : ""}
    ${removed ? "AND NOT EXISTS(SELECT 1 FROM removed_sources rs WHERE rs.id=oe.source_id)" : ""})`;
  const evidenceParams = [
    KNOWLEDGE_SOURCE_ID,
    OPEN_LOOP_SOURCE_ID,
    ...(metadata ? [KNOWLEDGE_DOCUMENT_TYPE, OPEN_LOOP_DOCUMENT_TYPE] : []),
  ];
  const rows = db
    .prepare<
      unknown[],
      {
        kind: "candidate" | "coverage";
        id: string;
        revision: number;
        inputRevision: string;
        reviewedAt: number;
        due: number;
      }
    >(
      `SELECT 'candidate' AS kind,id,revision,'' AS inputRevision,0 AS reviewedAt,
      COALESCE(reconsider_at,updated_at+?) AS due FROM knowledge_candidates
      WHERE status IN ('proposed','deferred')
      AND NOT EXISTS(SELECT 1 FROM json_each(evidence_ids_json) e WHERE NOT (${readable}))
    UNION ALL
    SELECT 'coverage',c.subject_id,0,c.input_revision,c.reviewed_at,
      COALESCE(c.reconsider_at,c.reviewed_at+?) AS due FROM knowledge_discovery_coverage c
      JOIN documents d ON d.id=c.subject_id AND d.content_hash=c.input_revision
      WHERE c.phase='organization' AND c.policy_version=? AND c.status IN ('gated','deferred','failed')
      AND EXISTS(SELECT 1 FROM json_each(json_array(c.subject_id)) e WHERE ${readable})
    ORDER BY due,id LIMIT ?`,
    )
    .all(
      options.retryMs,
      ...evidenceParams,
      options.retryMs,
      KNOWLEDGE_DISCOVERY_POLICY,
      ...evidenceParams,
      limit,
    );
  return rows.flatMap((row): OrganizationAdmission[] => {
    // The due predicate belongs outside the union to share its computed deadline.
    if (row.due > options.now) return [];
    if (row.kind === "candidate")
      return getKnowledgeCandidate(db, row.id)
        ? [{ kind: "candidate", id: row.id, revision: row.revision }]
        : [];
    return isKnowledgeEvidenceReadable(db, row.id)
      ? [
          {
            kind: "coverage",
            id: row.id,
            inputRevision: row.inputRevision,
            reviewedAt: row.reviewedAt,
          },
        ]
      : [];
  });
}

/** Bounded writer transaction binds reconsideration backoff to durable admission. */
export function admitKnowledgeOrganization(
  db: Database.Database,
  input: { admission: OrganizationAdmission; workPrefix: string; retryAt: number },
  now: number,
): boolean {
  return db.transaction(() => {
    const admission = input.admission;
    let ids: string[];
    if (admission.kind === "candidate") {
      const candidate = getKnowledgeCandidate(db, admission.id);
      if (
        !candidate ||
        candidate.revision !== admission.revision ||
        !["proposed", "deferred"].includes(candidate.status)
      )
        return false;
      ids = candidate.evidenceIds;
    } else {
      const current = db
        .prepare(
          "SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=? AND reviewed_at=? AND status IN ('gated','deferred','failed') AND (reconsider_at IS NULL OR reconsider_at<=?)",
        )
        .get(
          admission.id,
          admission.inputRevision,
          KNOWLEDGE_DISCOVERY_POLICY,
          admission.reviewedAt,
          now,
        );
      if (!current) return false;
      ids = [admission.id];
    }
    const sources: Array<{ id: string; revision: string }> = [];
    for (const id of ids) {
      if (!isKnowledgeEvidenceReadable(db, id)) return false;
      const source = db
        .prepare<
          [string],
          { content_hash: string }
        >("SELECT content_hash FROM documents WHERE id=?")
        .get(id);
      if (!source) return false;
      if (admission.kind === "coverage" && source.content_hash !== admission.inputRevision)
        return false;
      sources.push({ id, revision: source.content_hash });
    }
    for (const [index, source] of sources.entries()) {
      enqueueKnowledgeWork(
        db,
        {
          id: `${input.workPrefix}_${index}`,
          subjectId: source.id,
          subjectKind: "source",
          reason: "review",
          inputRevision: source.revision,
          tier: "routine",
          dueAt: now,
        },
        now,
      );
    }
    if (admission.kind === "candidate")
      db.prepare(
        "UPDATE knowledge_candidates SET reconsider_at=?,revision=revision+1 WHERE id=? AND revision=?",
      ).run(input.retryAt, admission.id, admission.revision);
    else
      db.prepare(
        "UPDATE knowledge_discovery_coverage SET reconsider_at=? WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=?",
      ).run(input.retryAt, admission.id, admission.inputRevision, KNOWLEDGE_DISCOVERY_POLICY);
    return true;
  })();
}

/** Candidate context is orientation, never evidence that a claim is true. */
export function organizationCandidatesForSource(
  db: Database.Database,
  sourceId: string,
): KnowledgeCandidate[] {
  const rows = db
    .prepare<[string], { id: string }>(
      `SELECT c.id FROM knowledge_candidates c
    WHERE c.status IN ('proposed','deferred') AND EXISTS
    (SELECT 1 FROM json_each(c.evidence_ids_json) e WHERE e.value=?) ORDER BY c.updated_at,c.id LIMIT 20`,
    )
    .all(sourceId);
  return rows.flatMap(({ id }) => {
    const candidate = getKnowledgeCandidate(db, id);
    return candidate ? [candidate] : [];
  });
}
