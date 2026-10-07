// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { getKnowledgeNode, knowledgeNodeFence } from "./storage.js";
import { assertCandidateGrounded } from "./discovery.js";
import { KnowledgeStorageError } from "./types.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type Database from "better-sqlite3";

export const ORGANIZATION_REASON_CODES = [
  "new_context_published",
  "existing_context_updated",
  "already_organized",
  "insufficient_shared_context",
  "insufficient_evidence",
  "awaiting_more_evidence",
] as const;
export type OrganizationReasonCode = (typeof ORGANIZATION_REASON_CODES)[number];
const OUTCOME_REASONS: Record<
  "organized" | "no_page" | "deferred",
  readonly OrganizationReasonCode[]
> = {
  organized: ["new_context_published", "existing_context_updated", "already_organized"],
  no_page: ["insufficient_shared_context", "insufficient_evidence"],
  deferred: ["awaiting_more_evidence", "insufficient_evidence"],
};

export interface OrganizationCohortSelection {
  sourceVersions: Record<string, string>;
  inputFingerprint: string;
}
export interface OrganizationCohort extends OrganizationCohortSelection {
  id: string;
  batchId: string;
  status: "pending" | "completed" | "deferred" | "abandoned";
  retryAt: number;
}
export interface OrganizationCohortOptions {
  now: number;
  limit?: number;
  intervalMs: number;
  retryMs: number;
}
function fingerprint(versions: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        KNOWLEDGE_DISCOVERY_POLICY,
        Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}
function current(db: Database.Database, id: string, revision: string): boolean {
  return (
    !!db
      .prepare(
        `SELECT 1 FROM knowledge_discovery_coverage c JOIN documents d ON d.id=c.subject_id
    AND d.content_hash=c.input_revision WHERE c.subject_id=? AND c.input_revision=?
    AND c.phase='organization' AND c.policy_version=? AND c.status='considered'`,
      )
      .get(id, revision, KNOWLEDGE_DISCOVERY_POLICY) && isKnowledgeEvidenceReadable(db, id)
  );
}
function due(db: Database.Database, id: string, revision: string, now: number): boolean {
  return !db
    .prepare(
      `SELECT 1 FROM knowledge_organization_members m
    JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
    JOIN knowledge_batches b ON b.id=c.batch_id
    WHERE m.source_id=? AND m.content_hash=? AND c.policy_version=?
    AND ((c.status='pending' AND b.status IN ('pending','running')) OR (c.status!='abandoned' AND c.retry_at>?)) LIMIT 1`,
    )
    .get(id, revision, KNOWLEDGE_DISCOVERY_POLICY, now);
}
function hasActiveCohort(db: Database.Database): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM knowledge_organization_cohorts c
    JOIN knowledge_batches b ON b.id=c.batch_id
    WHERE c.status!='abandoned' AND b.status IN ('pending','running') LIMIT 1`,
    )
    .get();
}
function previouslyCohorted(db: Database.Database, id: string, revision: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM knowledge_organization_members m
    JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
    WHERE m.source_id=? AND m.content_hash=? AND c.policy_version=? LIMIT 1`,
    )
    .get(id, revision, KNOWLEDGE_DISCOVERY_POLICY);
}
function cadenceReady(db: Database.Database, now: number, intervalMs: number): boolean {
  const latest = db
    .prepare<
      [],
      { created_at: number }
    >("SELECT created_at FROM knowledge_organization_cohorts ORDER BY created_at DESC LIMIT 1")
    .get();
  return !latest || latest.created_at + intervalMs <= now;
}

/** Read-only selection over previously interpreted evidence, never fresh history. */
export function selectOrganizationCohort(
  db: Database.Database,
  options: OrganizationCohortOptions,
): OrganizationCohortSelection | null {
  if (hasActiveCohort(db)) return null;
  const cadenceElapsed = cadenceReady(db, options.now, options.intervalMs);
  const limit = Math.max(2, Math.min(8, Math.trunc(options.limit ?? 8)));
  // SQL filters the ledger before LIMIT so settled history cannot hide new inputs.
  // Readability is also applied before LIMIT, using the same source exclusions as
  // the source fence; the writer rechecks the full fence before admission.
  const removed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get();
  const metadata = db
    .prepare<[], { name: string }>("PRAGMA table_info(documents)")
    .all()
    .some((c) => c.name === "metadata");
  const rows = (onlyDue: boolean, count: number, initialOnly = false) =>
    db
      .prepare<unknown[], { id: string; revision: string }>(
        `
    SELECT d.id,d.content_hash AS revision FROM knowledge_discovery_coverage v
    JOIN documents d ON d.id=v.subject_id AND d.content_hash=v.input_revision
    LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
    WHERE v.phase='organization' AND v.policy_version=? AND v.status='considered'
    AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='source' AND w.subject_id=d.id AND w.status IN ('pending','batched'))
    AND COALESCE(r.deleted,0)=0
    AND d.source_id NOT IN (?,?)
    ${metadata ? "AND COALESCE(json_extract(d.metadata,'$.documentType'),'') NOT IN (?,?)" : ""}
    ${removed ? "AND NOT EXISTS(SELECT 1 FROM removed_sources s WHERE s.id=d.source_id)" : ""}
    AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m
      JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
      JOIN knowledge_batches b ON b.id=c.batch_id
      WHERE m.source_id=d.id AND m.content_hash=d.content_hash AND c.policy_version=?
      AND ((c.status='pending' AND b.status IN ('pending','running')) ${onlyDue ? "OR (c.status!='abandoned' AND c.retry_at>?)" : ""}))
    ${
      initialOnly
        ? `AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m
      JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
      WHERE m.source_id=d.id AND m.content_hash=d.content_hash AND c.policy_version=?)`
        : ""
    }
    ORDER BY v.reviewed_at,d.id LIMIT ?`,
      )
      .all(
        KNOWLEDGE_DISCOVERY_POLICY,
        KNOWLEDGE_SOURCE_ID,
        OPEN_LOOP_SOURCE_ID,
        ...(metadata ? [KNOWLEDGE_DOCUMENT_TYPE, OPEN_LOOP_DOCUMENT_TYPE] : []),
        KNOWLEDGE_DISCOVERY_POLICY,
        ...(onlyDue ? [options.now] : []),
        ...(initialOnly ? [KNOWLEDGE_DISCOVERY_POLICY] : []),
        count,
      );
  // Drain first-pass backlog independently of routine repeat cadence. Requiring
  // two fresh revisions avoids one extra model run for every isolated arrival.
  const initial = rows(true, limit, true);
  const selected = initial.length >= 2 ? initial : cadenceElapsed ? rows(true, limit) : [];

  if (!selected.length) return null;
  if (selected.length === 1) {
    const context = rows(false, 2).find((row) => row.id !== selected[0]!.id);
    if (context) selected.push(context);
  }
  if (selected.length < 2) return null;
  const sourceVersions = Object.fromEntries(selected.map((row) => [row.id, row.revision]));
  return { sourceVersions, inputFingerprint: fingerprint(sourceVersions) };
}

/** Call in the same transaction that reserves the actual maintenance regions. */
export function createOrganizationCohort(
  db: Database.Database,
  input: OrganizationCohortSelection & {
    id: string;
    batchId: string;
    intervalMs: number;
    retryMs: number;
  },
  now: number,
): boolean {
  return db.transaction(() => {
    const entries = Object.entries(input.sourceVersions);
    if (
      entries.length < 2 ||
      entries.length > 8 ||
      input.inputFingerprint !== fingerprint(input.sourceVersions) ||
      hasActiveCohort(db) ||
      (!cadenceReady(db, now, input.intervalMs) &&
        !entries.every(([id, revision]) => !previouslyCohorted(db, id, revision))) ||
      !entries.every(([id, revision]) => current(db, id, revision)) ||
      !entries.some(([id, revision]) => due(db, id, revision, now))
    )
      return false;
    // Context can have been reviewed before, but must not be owned by another
    // active cohort. Do not infer dependency edges from shared scheduling.
    for (const [id, revision] of entries) {
      if (
        db
          .prepare(
            `SELECT 1 FROM knowledge_work WHERE subject_kind='source' AND subject_id=?
        AND status IN ('pending','batched') AND (batch_id IS NULL OR batch_id!=?) LIMIT 1`,
          )
          .get(id, input.batchId)
      )
        return false;
      if (
        db
          .prepare(
            `SELECT 1 FROM knowledge_organization_members m
        JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
        JOIN knowledge_batches b ON b.id=c.batch_id WHERE m.source_id=? AND m.content_hash=?
        AND c.status='pending' AND b.status IN ('pending','running') LIMIT 1`,
          )
          .get(id, revision)
      )
        return false;
    }
    db.prepare(
      `INSERT INTO knowledge_organization_cohorts
      (id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?,?)`,
    ).run(
      input.id,
      input.batchId,
      input.inputFingerprint,
      KNOWLEDGE_DISCOVERY_POLICY,
      now + input.retryMs,
      now,
      now,
    );
    const insert = db.prepare(
      "INSERT INTO knowledge_organization_members(cohort_id,source_id,content_hash) VALUES(?,?,?)",
    );
    for (const [id, revision] of entries) insert.run(input.id, id, revision);
    return true;
  })();
}

export function getOrganizationCohort(
  db: Database.Database,
  id: string,
): OrganizationCohort | null {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        batchId: string;
        inputFingerprint: string;
        status: OrganizationCohort["status"];
        retryAt: number;
      }
    >(
      "SELECT id,batch_id AS batchId,input_fingerprint AS inputFingerprint,status,retry_at AS retryAt FROM knowledge_organization_cohorts WHERE id=?",
    )
    .get(id);
  if (!row) return null;
  const members = db
    .prepare<
      [string],
      { id: string; revision: string }
    >("SELECT source_id AS id,content_hash AS revision FROM knowledge_organization_members WHERE cohort_id=? ORDER BY source_id")
    .all(id);
  return { ...row, sourceVersions: Object.fromEntries(members.map((m) => [m.id, m.revision])) };
}

export function completeOrganizationCohort(
  db: Database.Database,
  input: {
    id: string;
    batchId: string;
    inputFingerprint: string;
    outcome: "no_page" | "organized" | "deferred";
    reasonCode: OrganizationReasonCode;
    targetIds?: string[];
    targetVersions?: Record<string, number>;
    retryAt: number;
  },
  now: number,
): boolean {
  return db.transaction(() => {
    const cohort = getOrganizationCohort(db, input.id);
    if (
      !cohort ||
      cohort.status !== "pending" ||
      cohort.batchId !== input.batchId ||
      cohort.inputFingerprint !== input.inputFingerprint ||
      !Number.isFinite(input.retryAt) ||
      input.retryAt <= now ||
      !OUTCOME_REASONS[input.outcome].includes(input.reasonCode) ||
      (input.targetIds?.length ?? 0) > 32 ||
      (input.outcome !== "organized" &&
        ((input.targetIds?.length ?? 0) > 0 ||
          Object.keys(input.targetVersions ?? {}).length > 0)) ||
      !isOrganizationCohortCurrent(db, cohort) ||
      (input.outcome === "organized" && !input.targetIds?.length) ||
      !(input.targetIds ?? []).every((id) => {
        const node = getKnowledgeNode(db, id);
        return node?.kind === "wiki" && node.canonicalFields.withdrawn !== true;
      })
    )
      return false;
    if (input.outcome === "organized") {
      const targetIds = input.targetIds!;
      const versions = input.targetVersions ?? {};
      if (
        Object.keys(versions).length !== targetIds.length ||
        new Set(targetIds).size !== targetIds.length
      )
        return false;
      const groundingBudget = { remaining: 8192 };
      for (const id of targetIds) {
        const node = getKnowledgeNode(db, id);
        const fence = knowledgeNodeFence(db, id);
        if (
          !node ||
          node.kind !== "wiki" ||
          node.revision !== versions[id] ||
          fence.hidden ||
          fence.stale
        )
          return false;
        try {
          assertCandidateGrounded(db, id, Object.keys(cohort.sourceVersions), groundingBudget);
        } catch (error) {
          if (error instanceof KnowledgeStorageError) return false;
          throw error;
        }
      }
    }
    const insertTarget = db.prepare(
      "INSERT INTO knowledge_organization_targets(cohort_id,node_id) VALUES(?,?)",
    );
    for (const targetId of input.targetIds ?? []) insertTarget.run(input.id, targetId);
    db.prepare(
      `UPDATE knowledge_organization_cohorts SET status=?,outcome_json=?,retry_at=?,updated_at=? WHERE id=?`,
    ).run(
      input.outcome === "deferred" ? "deferred" : "completed",
      JSON.stringify({
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        targetIds: input.targetIds ?? [],
        targetVersions: input.targetVersions ?? {},
      }),
      input.retryAt,
      now,
      input.id,
    );
    return true;
  })();
}

export function getOrganizationCohortForBatch(
  db: Database.Database,
  batchId: string,
): OrganizationCohort | null {
  const row = db
    .prepare<
      [string],
      { id: string }
    >("SELECT id FROM knowledge_organization_cohorts WHERE batch_id=?")
    .get(batchId);
  return row ? getOrganizationCohort(db, row.id) : null;
}
export function isOrganizationCohortCurrent(
  db: Database.Database,
  cohort: OrganizationCohort,
): boolean {
  return (
    cohort.inputFingerprint === fingerprint(cohort.sourceVersions) &&
    Object.entries(cohort.sourceVersions).every(([id, revision]) => current(db, id, revision))
  );
}
export function abandonOrganizationCohort(
  db: Database.Database,
  batchId: string,
  now: number,
): boolean {
  return (
    db
      .prepare(
        "UPDATE knowledge_organization_cohorts SET status='abandoned',updated_at=? WHERE batch_id=? AND status='pending'",
      )
      .run(now, batchId).changes > 0
  );
}
