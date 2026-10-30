// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { brainSourceInclusionSql } from "../source-exclusion.js";
import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { getKnowledgeNode, knowledgeNodeFence } from "./storage.js";
import { assertCandidateGrounded } from "./discovery.js";
import { KnowledgeStorageError } from "./types.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { knowledgeWorkParkedSql } from "./work-retry.js";
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

/** Member content_hash columns retain their historical name but store Knowledge revisions. */
export interface OrganizationCohortSelection {
  sourceVersions: Record<string, string>;
  inputFingerprint: string;
  /** Set when the cohort is grouped around an important outcome no wiki covers. */
  subjectLoopId?: string;
  /** Set when the selection reopens a completed cohort after a published search gap. */
  publicationRetry?: true;
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
  /** Sources excluded from the Brain (`brain.excludedSources`): never selected. */
  excludedSources?: readonly string[];
  /** Pace of subject cohorts; absent disables them. */
  subjectIntervalMs?: number;
  /** Subjects (by anchor outcome) the caller could not start lately; passed over. */
  skipSubjects?: ReadonlySet<string>;
  /** Other selections (by input fingerprint) the caller could not start lately; passed over. */
  skipFingerprints?: ReadonlySet<string>;
  /** Receives the subject pass's counts, for reporting why it offered nothing. */
  subjectTally?: SubjectCohortTally;
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
    AND ${knowledgeSourceRevisionSql()}=c.input_revision WHERE c.subject_id=? AND c.input_revision=?
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
    .prepare<[], { created_at: number }>(
      "SELECT created_at FROM knowledge_organization_cohorts ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  return !latest || latest.created_at + intervalMs <= now;
}

function publicationRetryConsumed(db: Database.Database, inputFingerprint: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM knowledge_organization_cohorts
    WHERE input_fingerprint=? AND policy_version=? AND retrieval_reconsidered=1 LIMIT 1`,
    )
    .get(inputFingerprint, KNOWLEDGE_DISCOVERY_POLICY);
}

/** A published search gap reopens its exact joint decision, not an arbitrary source mixture. */
function publishedRetry(
  db: Database.Database,
  now: number,
  options: {
    ownBatchId?: string;
    limit?: number;
    excludedSources?: readonly string[];
    /** Only the retry with this fingerprint: admission confirms the one selected. */
    matching?: string;
    skip?: ReadonlySet<string>;
  } = {},
): OrganizationCohort | null {
  const { ownBatchId = "", limit = 8, excludedSources = [] } = options;
  const removed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get();
  const included = brainSourceInclusionSql(excludedSources, "d.source_id");
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT c.id FROM knowledge_organization_cohorts c WHERE c.retrieval_reconsider_at<=?
      AND c.status IN ('completed','deferred') AND c.policy_version=?
      AND (SELECT COUNT(*) FROM knowledge_organization_members m WHERE m.cohort_id=c.id)<=?
      AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m
        LEFT JOIN documents d ON d.id=m.source_id AND ${knowledgeSourceRevisionSql()}=m.content_hash
        LEFT JOIN knowledge_source_revisions r ON r.document_id=m.source_id
        WHERE m.cohort_id=c.id AND (d.id IS NULL OR COALESCE(r.deleted,0)!=0 OR NOT (${included.sql})
          ${removed ? "OR EXISTS(SELECT 1 FROM removed_sources rs WHERE rs.id=d.source_id)" : ""}))
      AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m JOIN knowledge_work w
        ON w.subject_id=m.source_id AND w.subject_kind='source'
        WHERE m.cohort_id=c.id AND w.status IN ('pending','batched')
          AND (w.batch_id IS NULL OR w.batch_id!=?))
      -- Parked work answers a new batch's enqueue with the parked row, so a
      -- member parked at its revision could never be admitted again.
      AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m WHERE m.cohort_id=c.id
        AND ${knowledgeWorkParkedSql("'source'", "m.source_id", "m.content_hash")})
      ORDER BY c.retrieval_reconsider_at,c.id LIMIT 32`,
    )
    .all(now, KNOWLEDGE_DISCOVERY_POLICY, limit, ...included.params, ownBatchId);
  for (const row of rows) {
    const cohort = getOrganizationCohort(db, row.id);
    if (!cohort) continue;
    if (options.matching !== undefined && cohort.inputFingerprint !== options.matching) continue;
    if (options.skip?.has(cohort.inputFingerprint)) continue;
    if (isOrganizationCohortCurrent(db, cohort)) return cohort;
  }
  return null;
}

/** Outcomes at least this important can seed a subject cohort. */
export const SUBJECT_MIN_IMPORTANCE = 0.6;
/** How far back an outcome's last update still makes its subject current. */
export const SUBJECT_WINDOW_MS = 120 * 86_400_000;
/** A person on more outcomes than this is not specific enough to join subjects. */
const SUBJECT_PERSON_MAX_LOOPS = 6;

/**
 * What one subject pass saw, in counts only. Filled when the pass runs (the
 * subject cadence is ready and no publication retry comes first), so a pass
 * that offers no cohort can say why without naming any matter.
 */
export interface SubjectCohortTally {
  evaluated: boolean;
  /** Important outcomes updated within the window that cite documents. */
  important: number;
  /** Of those, outcomes no wiki claim covers. */
  uncovered: number;
  /** Subjects the uncovered outcomes form. */
  subjects: number;
  /** Subjects grouped recently, or still pending, that wait their retry interval. */
  waiting: number;
  /** Subjects the caller passed over after a failed start. */
  skipped: number;
  /** Subjects with fewer than two documents already considered for organization. */
  lackingEvidence: number;
  /** Documents attached to the subjects lacking evidence. */
  lackingDocuments: number;
  /** Of those documents, the ones already considered for organization. */
  lackingConsidered: number;
}
export function newSubjectCohortTally(): SubjectCohortTally {
  return {
    evaluated: false,
    important: 0,
    uncovered: 0,
    subjects: 0,
    waiting: 0,
    skipped: 0,
    lackingEvidence: 0,
    lackingDocuments: 0,
    lackingConsidered: 0,
  };
}

function subjectCadenceReady(db: Database.Database, now: number, intervalMs: number): boolean {
  const latest = db
    .prepare<[], { created_at: number }>(
      `SELECT created_at FROM knowledge_organization_cohorts WHERE subject_loop_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    )
    .get();
  return !latest || latest.created_at + intervalMs <= now;
}

/** A subject recently grouped, or grouped and still pending, waits its retry interval. */
function subjectDue(db: Database.Database, loopId: string, now: number): boolean {
  return !db
    .prepare(
      `SELECT 1 FROM knowledge_organization_cohorts c JOIN knowledge_batches b ON b.id=c.batch_id
      WHERE c.subject_loop_id=? AND ((c.status='pending' AND b.status IN ('pending','running'))
        OR (c.status!='abandoned' AND c.retry_at>?)) LIMIT 1`,
    )
    .get(loopId, now);
}

/** Important outcomes updated within the window that cite at least one document. */
const IMPORTANT_LOOP_SQL = `l.state IN ('open','snoozed','done') AND l.importance>=? AND l.last_update>=?
  AND EXISTS(SELECT 1 FROM open_loop_docs d WHERE d.loop_id=l.id)`;

/**
 * Wiki claims that cite the outcome, or any of its documents, already cover it.
 * Each probe starts from the outcome's own rows (CROSS JOIN fixes that order)
 * and reaches the dependency index by target, so it costs per outcome, not per
 * dependency.
 */
const UNCOVERED_LOOP_SQL = `NOT EXISTS(SELECT 1 FROM open_loop_docs o
    CROSS JOIN knowledge_dependencies dep ON dep.target_kind='source' AND dep.target_id=o.doc_id
    JOIN knowledge_nodes w ON w.id=dep.node_id AND w.kind='wiki' WHERE o.loop_id=l.id)
  AND NOT EXISTS(SELECT 1 FROM knowledge_nodes k
    JOIN knowledge_dependencies dep ON dep.target_kind='node' AND dep.target_id=k.id
    JOIN knowledge_nodes w ON w.id=dep.node_id AND w.kind='wiki'
    WHERE k.kind='loop' AND (k.owner_id=l.id OR (k.owner_id IS NULL AND k.id=l.id)))`;

/**
 * Important tracked outcomes whose subject no wiki covers, grouped into
 * subjects. Outcomes join one subject when they share a document or a person
 * specific to a few outcomes; a person on many outcomes (the owner's partner,
 * a colleague) would merge unrelated matters. Subjects rank by the summed
 * importance of their outcomes, so a matter with many important threads leads.
 */
function uncoveredSubjects(
  db: Database.Database,
  now: number,
  tally?: SubjectCohortTally,
): Array<{ anchor: string; loops: string[]; documents: number; score: number }> {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loops'").get() ||
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loop_people'").get()
  )
    return [];
  const since = now - SUBJECT_WINDOW_MS;
  if (tally)
    tally.important = db
      .prepare<[number, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM open_loops l WHERE ${IMPORTANT_LOOP_SQL}`,
      )
      .get(SUBJECT_MIN_IMPORTANCE, since)!.n;
  const loops = db
    .prepare<[number, number], { id: string; importance: number; last_update: number }>(
      `SELECT l.id,l.importance,l.last_update FROM open_loops l
      WHERE ${IMPORTANT_LOOP_SQL} AND ${UNCOVERED_LOOP_SQL}`,
    )
    .all(SUBJECT_MIN_IMPORTANCE, since);
  if (tally) tally.uncovered = loops.length;
  if (!loops.length) return [];
  const parent = new Map(loops.map((loop) => [loop.id, loop.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const ids = new Set(parent.keys());
  const selfTable = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='people'")
    .get();
  const links = db
    .prepare<[], { loop_id: string; key: string }>(
      `SELECT loop_id,'doc:'||doc_id AS key FROM open_loop_docs
      UNION SELECT p.loop_id,'person:'||p.person_id FROM open_loop_people p
      WHERE (SELECT COUNT(DISTINCT q.loop_id) FROM open_loop_people q WHERE q.person_id=p.person_id)<=${SUBJECT_PERSON_MAX_LOOPS}
      ${selfTable ? "AND NOT EXISTS(SELECT 1 FROM people s WHERE s.id=p.person_id AND s.is_self)" : ""}`,
    )
    .all();
  const firstByKey = new Map<string, string>();
  const documentKeys = new Map<string, string[]>();
  for (const { loop_id: loopId, key } of links) {
    if (!ids.has(loopId)) continue;
    if (key.startsWith("doc:"))
      documentKeys.set(loopId, [...(documentKeys.get(loopId) ?? []), key]);
    const first = firstByKey.get(key);
    if (first) join(loopId, first);
    else firstByKey.set(key, loopId);
  }
  const clusters = new Map<string, typeof loops>();
  for (const loop of loops) {
    const root = find(loop.id);
    clusters.set(root, [...(clusters.get(root) ?? []), loop]);
  }
  return [...clusters.values()]
    .map((members) => {
      const anchor = [...members].sort(
        (a, b) =>
          b.importance - a.importance || b.last_update - a.last_update || a.id.localeCompare(b.id),
      )[0]!;
      return {
        anchor: anchor.id,
        loops: members.map((member) => member.id),
        documents: new Set(members.flatMap((member) => documentKeys.get(member.id) ?? [])).size,
        score: members.reduce((sum, member) => sum + member.importance, 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.anchor.localeCompare(b.anchor));
}

interface SubjectEvidence {
  id: string;
  revision: string;
  attached: number;
}

/**
 * The documents of these outcomes that already passed organization discovery
 * at their current revision and are free for a cohort, read in one pass so
 * every subject can be judged without a query per subject.
 */
function consideredSubjectEvidence(
  db: Database.Database,
  loopIds: readonly string[],
  excluded: readonly string[],
): Map<string, SubjectEvidence[]> {
  const included = brainSourceInclusionSql(excluded, "d.source_id");
  const removed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get();
  const rows = db
    .prepare<unknown[], SubjectEvidence & { loop: string }>(
      `SELECT o.loop_id AS loop,d.id,${knowledgeSourceRevisionSql()} AS revision,o.rowid AS attached
      FROM open_loop_docs o JOIN documents d ON d.id=o.doc_id
      LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
      WHERE o.loop_id IN (SELECT value FROM json_each(?)) AND COALESCE(r.deleted,0)=0
      AND d.source_id NOT IN (?,?) AND ${included.sql}
      ${removed ? "AND NOT EXISTS(SELECT 1 FROM removed_sources s WHERE s.id=d.source_id)" : ""}
      AND EXISTS(SELECT 1 FROM knowledge_discovery_coverage c WHERE c.subject_id=d.id
        AND c.input_revision=${knowledgeSourceRevisionSql()} AND c.phase='organization'
        AND c.policy_version=? AND c.status='considered')
      AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='source' AND w.subject_id=d.id AND w.status IN ('pending','batched'))
      AND NOT ${knowledgeWorkParkedSql("'source'", "d.id", knowledgeSourceRevisionSql())}`,
    )
    .all(
      JSON.stringify(loopIds),
      KNOWLEDGE_SOURCE_ID,
      OPEN_LOOP_SOURCE_ID,
      ...included.params,
      KNOWLEDGE_DISCOVERY_POLICY,
    );
  const byLoop = new Map<string, SubjectEvidence[]>();
  for (const { loop, ...row } of rows) byLoop.set(loop, [...(byLoop.get(loop) ?? []), row]);
  return byLoop;
}

/**
 * One cohort over the interpreted evidence of the most important subject no
 * wiki covers yet. Chronological cohorts group whatever was read together, so
 * a matter whose evidence spans months may never meet in one; this lets the
 * Brain notice it and decide whether it deserves a page. Every subject is
 * judged, so subjects that wait, were passed over or lack evidence never hide
 * a lower-ranked one that could start.
 */
function selectSubjectCohort(
  db: Database.Database,
  options: OrganizationCohortOptions,
  limit: number,
): OrganizationCohortSelection | null {
  if (options.subjectIntervalMs === undefined) return null;
  if (!subjectCadenceReady(db, options.now, options.subjectIntervalMs)) return null;
  const tally = options.subjectTally ?? newSubjectCohortTally();
  tally.evaluated = true;
  const subjects = uncoveredSubjects(db, options.now, tally);
  tally.subjects = subjects.length;
  if (!subjects.length) return null;
  const evidence = consideredSubjectEvidence(
    db,
    subjects.flatMap((subject) => subject.loops),
    options.excludedSources ?? [],
  );
  for (const subject of subjects) {
    if (options.skipSubjects?.has(subject.anchor)) {
      tally.skipped++;
      continue;
    }
    if (!subjectDue(db, subject.anchor, options.now)) {
      tally.waiting++;
      continue;
    }
    const byDocument = new Map<string, SubjectEvidence>();
    for (const loop of subject.loops)
      for (const row of evidence.get(loop) ?? []) {
        const seen = byDocument.get(row.id);
        if (!seen || seen.attached < row.attached) byDocument.set(row.id, row);
      }
    // The most recently attached evidence leads, as the outcome's current state does.
    const rows = [...byDocument.values()]
      .sort((a, b) => b.attached - a.attached || a.id.localeCompare(b.id))
      .filter(
        (row) =>
          isKnowledgeEvidenceReadable(db, row.id) && !inActiveCohort(db, row.id, row.revision),
      )
      .slice(0, limit);
    if (rows.length < 2) {
      tally.lackingEvidence++;
      tally.lackingDocuments += subject.documents;
      tally.lackingConsidered += byDocument.size;
      continue;
    }
    const sourceVersions = Object.fromEntries(rows.map((row) => [row.id, row.revision]));
    return {
      sourceVersions,
      inputFingerprint: fingerprint(sourceVersions),
      subjectLoopId: subject.anchor,
    };
  }
  return null;
}

/**
 * The same selection over a subset of its sources, for a caller that must
 * shed sources whose maintenance region does not fit. The subset keeps the
 * selection's subject and gets its own fingerprint.
 */
export function narrowOrganizationSelection(
  selection: OrganizationCohortSelection,
  sourceIds: readonly string[],
): OrganizationCohortSelection {
  const sourceVersions = Object.fromEntries(
    sourceIds.map((id) => [id, selection.sourceVersions[id]!]),
  );
  return {
    sourceVersions,
    inputFingerprint: fingerprint(sourceVersions),
    ...(selection.subjectLoopId ? { subjectLoopId: selection.subjectLoopId } : {}),
  };
}

function inActiveCohort(db: Database.Database, id: string, revision: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM knowledge_organization_members m
    JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
    JOIN knowledge_batches b ON b.id=c.batch_id WHERE m.source_id=? AND m.content_hash=?
    AND c.status='pending' AND b.status IN ('pending','running') LIMIT 1`,
    )
    .get(id, revision);
}

/** Read-only selection over previously interpreted evidence, never fresh history. */
export function selectOrganizationCohort(
  db: Database.Database,
  options: OrganizationCohortOptions,
): OrganizationCohortSelection | null {
  if (hasActiveCohort(db)) return null;
  const limit = Math.max(2, Math.min(8, Math.trunc(options.limit ?? 8)));
  const excluded = options.excludedSources ?? [];
  const retry = publishedRetry(db, options.now, {
    limit,
    excludedSources: excluded,
    skip: options.skipFingerprints,
  });
  if (retry)
    return {
      sourceVersions: retry.sourceVersions,
      inputFingerprint: retry.inputFingerprint,
      publicationRetry: true,
    };
  const subject = selectSubjectCohort(db, options, limit);
  if (subject) return subject;
  const cadenceElapsed = cadenceReady(db, options.now, options.intervalMs);
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
  const included = brainSourceInclusionSql(excluded, "d.source_id");
  const rows = (onlyDue: boolean, count: number, initialOnly = false) =>
    db
      .prepare<unknown[], { id: string; revision: string }>(
        `
    SELECT d.id,${knowledgeSourceRevisionSql()} AS revision FROM knowledge_discovery_coverage v
    JOIN documents d ON d.id=v.subject_id AND ${knowledgeSourceRevisionSql()}=v.input_revision
    LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
    WHERE v.phase='organization' AND v.policy_version=? AND v.status='considered'
    AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='source' AND w.subject_id=d.id AND w.status IN ('pending','batched'))
    AND NOT ${knowledgeWorkParkedSql("'source'", "d.id", knowledgeSourceRevisionSql())}
    AND COALESCE(r.deleted,0)=0
    AND d.source_id NOT IN (?,?) AND ${included.sql}
    ${metadata ? "AND COALESCE(json_extract(d.metadata,'$.documentType'),'') NOT IN (?,?)" : ""}
    ${removed ? "AND NOT EXISTS(SELECT 1 FROM removed_sources s WHERE s.id=d.source_id)" : ""}
    AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m
      JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
      JOIN knowledge_batches b ON b.id=c.batch_id
      WHERE m.source_id=d.id AND m.content_hash=${knowledgeSourceRevisionSql()} AND c.policy_version=?
      AND ((c.status='pending' AND b.status IN ('pending','running')) ${onlyDue ? "OR (c.status!='abandoned' AND c.retry_at>?)" : ""}))
    ${
      initialOnly
        ? `AND NOT EXISTS(SELECT 1 FROM knowledge_organization_members m
      JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id
      WHERE m.source_id=d.id AND m.content_hash=${knowledgeSourceRevisionSql()} AND c.policy_version=?)`
        : ""
    }
    ORDER BY v.reviewed_at,d.id LIMIT ?`,
      )
      .all(
        KNOWLEDGE_DISCOVERY_POLICY,
        KNOWLEDGE_SOURCE_ID,
        OPEN_LOOP_SOURCE_ID,
        ...included.params,
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
  const inputFingerprint = fingerprint(sourceVersions);
  // The same inputs would be selected again; they wait out the caller's back-off.
  if (options.skipFingerprints?.has(inputFingerprint)) return null;
  return { sourceVersions, inputFingerprint };
}

/** Call in the same transaction that reserves the actual maintenance regions. */
export function createOrganizationCohort(
  db: Database.Database,
  input: OrganizationCohortSelection & {
    id: string;
    batchId: string;
    intervalMs: number;
    retryMs: number;
    subjectIntervalMs?: number;
  },
  now: number,
): boolean {
  return db.transaction(() => {
    const entries = Object.entries(input.sourceVersions);
    // Match the selected retry by fingerprint: an earlier retry the selection
    // skipped (excluded sources, a member it could not admit) must not decide.
    const retry = publishedRetry(db, now, {
      ownBatchId: input.batchId,
      matching: input.inputFingerprint,
    });
    const isPublicationRetry = retry !== null;
    // A subject cohort regroups evidence chronological cohorts already saw, so
    // it is paced and retried per subject rather than per member revision.
    const subject = input.subjectLoopId;
    if (
      entries.length < 2 ||
      entries.length > 8 ||
      input.inputFingerprint !== fingerprint(input.sourceVersions) ||
      hasActiveCohort(db) ||
      (subject !== undefined &&
        (input.subjectIntervalMs === undefined ||
          !subjectCadenceReady(db, now, input.subjectIntervalMs) ||
          !subjectDue(db, subject, now))) ||
      (subject === undefined &&
        !isPublicationRetry &&
        !cadenceReady(db, now, input.intervalMs) &&
        !entries.every(([id, revision]) => !previouslyCohorted(db, id, revision))) ||
      !entries.every(([id, revision]) => current(db, id, revision)) ||
      (subject === undefined &&
        !isPublicationRetry &&
        !entries.some(([id, revision]) => due(db, id, revision, now)))
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
      (id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at,retrieval_reconsidered,subject_loop_id)
      VALUES(?,?,?,?,'pending',?,?,?,?,?)`,
    ).run(
      input.id,
      input.batchId,
      input.inputFingerprint,
      KNOWLEDGE_DISCOVERY_POLICY,
      now + input.retryMs,
      now,
      now,
      publicationRetryConsumed(db, input.inputFingerprint) ? 1 : 0,
      subject ?? null,
    );
    if (isPublicationRetry)
      db.prepare(
        "UPDATE knowledge_organization_cohorts SET retrieval_reconsider_at=NULL WHERE id=?",
      ).run(retry!.id);
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
        subjectLoopId: string | null;
      }
    >(
      "SELECT id,batch_id AS batchId,input_fingerprint AS inputFingerprint,status,retry_at AS retryAt,subject_loop_id AS subjectLoopId FROM knowledge_organization_cohorts WHERE id=?",
    )
    .get(id);
  if (!row) return null;
  const { subjectLoopId, ...cohort } = row;
  const members = db
    .prepare<[string], { id: string; revision: string }>(
      "SELECT source_id AS id,content_hash AS revision FROM knowledge_organization_members WHERE cohort_id=? ORDER BY source_id",
    )
    .all(id);
  return {
    ...cohort,
    ...(subjectLoopId ? { subjectLoopId } : {}),
    sourceVersions: Object.fromEntries(members.map((m) => [m.id, m.revision])),
  };
}

export type OrganizationCompletionResult =
  { accepted: true } | { accepted: false; reason: "snapshot" | "target" | "grounding" | "budget" };

export function completeOrganizationCohortResult(
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
    /** Trusted run search observation; never a model-supplied completion field. */
    retrievalBoundary?: string;
  },
  now: number,
): OrganizationCompletionResult {
  return db.transaction((): OrganizationCompletionResult => {
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
      (input.outcome === "organized" && !input.targetIds?.length)
    )
      return { accepted: false, reason: "snapshot" };
    if (input.outcome === "organized") {
      const targetIds = input.targetIds!;
      const versions = input.targetVersions ?? {};
      if (
        Object.keys(versions).length !== targetIds.length ||
        new Set(targetIds).size !== targetIds.length
      )
        return { accepted: false, reason: "target" };
      const groundingBudget = { remaining: 8192 };
      for (const id of targetIds) {
        const node = getKnowledgeNode(db, id);
        const fence = knowledgeNodeFence(db, id);
        if (
          !node ||
          node.kind !== "wiki" ||
          node.canonicalFields.withdrawn === true ||
          node.revision !== versions[id] ||
          fence.hidden ||
          fence.stale
        )
          return { accepted: false, reason: "target" };
        try {
          assertCandidateGrounded(db, id, Object.keys(cohort.sourceVersions), groundingBudget);
        } catch (error) {
          if (error instanceof KnowledgeStorageError)
            return {
              accepted: false,
              reason: groundingBudget.remaining < 0 ? "budget" : "grounding",
            };
          throw error;
        }
      }
    }
    const insertTarget = db.prepare(
      "INSERT INTO knowledge_organization_targets(cohort_id,node_id) VALUES(?,?)",
    );
    for (const targetId of input.targetIds ?? []) insertTarget.run(input.id, targetId);
    const memberBoundary = db
      .prepare<[string, string], { boundary: string | null }>(
        `SELECT MAX(v.retrieval_boundary) AS boundary FROM knowledge_organization_members m
       JOIN knowledge_discovery_coverage v ON v.subject_id=m.source_id AND v.input_revision=m.content_hash
       WHERE m.cohort_id=? AND v.phase='organization' AND v.policy_version=? AND v.status='considered'
         AND v.retrieval_reconsidered=0`,
      )
      .get(input.id, KNOWLEDGE_DISCOVERY_POLICY)?.boundary;
    const retrievalBoundary = publicationRetryConsumed(db, input.inputFingerprint)
      ? null
      : ([memberBoundary, input.retrievalBoundary]
          .filter((value): value is string => !!value)
          .sort()
          .at(-1) ?? null);
    db.prepare(
      `UPDATE knowledge_organization_cohorts SET status=?,outcome_json=?,retry_at=?,updated_at=?,retrieval_boundary=? WHERE id=?`,
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
      retrievalBoundary,
      input.id,
    );
    return { accepted: true };
  })();
}

/** Compatibility facade for callers that only need acceptance, not recovery detail. */
export function completeOrganizationCohort(
  db: Database.Database,
  input: Parameters<typeof completeOrganizationCohortResult>[1],
  now: number,
): boolean {
  return completeOrganizationCohortResult(db, input, now).accepted;
}

export function getOrganizationCohortForBatch(
  db: Database.Database,
  batchId: string,
): OrganizationCohort | null {
  const row = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM knowledge_organization_cohorts WHERE batch_id=?",
    )
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

/** Organization cohorts by kind, status and recorded outcome; counts only. */
export function readOrganizationCohortSummary(db: Database.Database): Array<{
  kind: "subject" | "chronological";
  status: OrganizationCohort["status"];
  outcome: string | null;
  count: number;
  lastCreatedAt: number;
}> {
  return db
    .prepare<
      [],
      {
        kind: "subject" | "chronological";
        status: OrganizationCohort["status"];
        outcome: string | null;
        count: number;
        lastCreatedAt: number;
      }
    >(
      `SELECT CASE WHEN subject_loop_id IS NULL THEN 'chronological' ELSE 'subject' END AS kind,
      status,json_extract(outcome_json,'$.outcome') AS outcome,COUNT(*) AS count,MAX(created_at) AS lastCreatedAt
      FROM knowledge_organization_cohorts GROUP BY 1,2,3 ORDER BY 1,2,3`,
    )
    .all();
}

/**
 * Withdraw already-interpreted sources from organization once their current
 * worth verdict is low. Only their organization coverage changes, to `gated`,
 * so no chronological or subject cohort selects them again at this revision;
 * their interpretation and anything already built on them stay as they are.
 */
export function gateOrganizationSources(
  db: Database.Database,
  input: { sourceVersions: Record<string, string> },
  now: number,
): number {
  const update = db.prepare(
    `UPDATE knowledge_discovery_coverage SET status='gated',reviewed_at=?
    WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=? AND status='considered'`,
  );
  return db.transaction(() => {
    let changed = 0;
    for (const [id, revision] of Object.entries(input.sourceVersions))
      changed += update.run(now, id, revision, KNOWLEDGE_DISCOVERY_POLICY).changes;
    return changed;
  })();
}
