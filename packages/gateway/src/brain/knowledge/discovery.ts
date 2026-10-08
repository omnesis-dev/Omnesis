// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { cognitionAuthoredSqlExclusion } from "../cognition-authored.js";
import { enqueueKnowledgeWork } from "./work.js";
import {
  assertKnowledgeReconciliation,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { KnowledgeStorageError } from "./types.js";
import { knowledgeHash } from "./storage-validation.js";
import { parseClaimMarkup } from "./claims.js";
import { saveKnowledgeNode, getKnowledgeNode } from "./storage.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { parseClaimReference } from "./references.js";

import {
  assertWikiPublicationReceipt,
  assertWikiSourceDiversity,
  type WikiPublicationReceipt,
} from "./wiki-publication.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import type Database from "better-sqlite3";
import type { SaveKnowledgeNodeInput } from "./types.js";
export { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
export type DiscoveryPhase = "interpretation" | "organization" | "conversion";
export interface KnowledgeCoverageInput {
  subjectId: string;
  inputRevision: string;
  phase: DiscoveryPhase;
  policyVersion: string;
  status: "considered" | "gated" | "deferred" | "failed";
  reconsiderAt?: number;
}

/** A discovery judgement never advances another phase's coverage. */
export function recordKnowledgeCoverage(
  db: Database.Database,
  input: KnowledgeCoverageInput,
  now: number,
): void {
  const source = db
    .prepare<
      [string],
      { content_hash: string }
    >("SELECT d.content_hash FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=? AND COALESCE(r.deleted,0)=0")
    .get(input.subjectId);
  if (
    !source ||
    !isKnowledgeEvidenceReadable(db, input.subjectId) ||
    source.content_hash !== input.inputRevision
  )
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Discovery input changed before coverage commit",
    );
  db.prepare(
    `INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at,reconsider_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject_id,input_revision,phase,policy_version) DO UPDATE SET
    status=excluded.status,reviewed_at=excluded.reviewed_at,reconsider_at=excluded.reconsider_at`,
  ).run(
    input.subjectId,
    input.inputRevision,
    input.phase,
    input.policyVersion,
    input.status,
    now,
    input.reconsiderAt ?? null,
  );
}

export interface DiscoveryDocument {
  id: string;
  contentHash: string;
  title: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
}
/**
 * Recent-first admission, not a recency cutoff on understanding. Durable coverage
 * makes a restart or a newly connected source naturally eligible. A document's
 * occurrence date is independent of the time it first becomes available here.
 */
export function listKnowledgeDiscoveryBacklog(
  db: Database.Database,
  options: {
    phase: DiscoveryPhase;
    limit: number;
    now: number;
    policyVersion?: string;
    direction?: "recent-first" | "oldest-first";
    sourceId?: string;
    /** Explicit initial inventory only; cutoff is fixed to the inventory start. */
    recentInventoryWindowMs?: number;
    /** Recent inventory belongs to the live allowance, not historical admission caps. */
    excludeRecentInventoryWindowMs?: number;
  },
): DiscoveryDocument[] {
  const exclusion = cognitionAuthoredSqlExclusion("d.source_id");
  const removalFence = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
    .get()
    ? "AND NOT EXISTS(SELECT 1 FROM removed_sources rs WHERE rs.id=d.source_id)"
    : "";
  return db
    .prepare<unknown[], DiscoveryDocument>(
      `SELECT d.id,d.content_hash AS contentHash,d.title,
    d.source_created_at AS sourceCreatedAt,d.source_updated_at AS sourceUpdatedAt FROM documents d
    LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
    WHERE COALESCE(r.deleted,0)=0 AND ${exclusion.sql || "1"} ${removalFence}
      ${options.sourceId === undefined ? "" : "AND d.source_id=?"}
      ${options.recentInventoryWindowMs === undefined ? "" : `AND EXISTS(SELECT 1 FROM source_inventory_documents si JOIN source_inventories inv ON inv.id=si.inventory_id WHERE si.document_id=d.id AND si.input_revision=d.content_hash AND julianday(d.source_created_at)>=julianday(inv.first_received_at/1000.0,'unixepoch')-?)`}
      ${options.excludeRecentInventoryWindowMs === undefined ? "" : `AND NOT EXISTS(SELECT 1 FROM source_inventory_documents si JOIN source_inventories inv ON inv.id=si.inventory_id WHERE si.document_id=d.id AND si.input_revision=d.content_hash AND julianday(d.source_created_at)>=julianday(inv.first_received_at/1000.0,'unixepoch')-?)`}
      AND NOT EXISTS(SELECT 1 FROM knowledge_discovery_coverage c WHERE c.subject_id=d.id
        AND c.input_revision=d.content_hash AND c.phase=? AND c.policy_version=?
        AND (c.reconsider_at IS NULL OR c.reconsider_at>?))
      AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='source' AND w.subject_id=d.id
        AND w.input_revision=d.content_hash AND w.status IN ('pending','batched'))
    ORDER BY d.source_created_at ${options.direction === "oldest-first" ? "ASC" : "DESC"},d.id LIMIT ?`,
    )
    .all(
      ...exclusion.params,
      ...(options.sourceId === undefined ? [] : [options.sourceId]),
      ...(options.recentInventoryWindowMs === undefined
        ? []
        : [options.recentInventoryWindowMs / 86_400_000]),
      ...(options.excludeRecentInventoryWindowMs === undefined
        ? []
        : [options.excludeRecentInventoryWindowMs / 86_400_000]),
      options.phase,
      options.policyVersion ?? KNOWLEDGE_DISCOVERY_POLICY,
      options.now,
      Math.max(1, Math.min(500, options.limit)),
    );
}

export interface KnowledgeCandidateInput {
  id: string;
  /** Trusted creation-inventory snapshot, supplied by the tool runtime only. */
  expectedInventoryRevision?: number;
  identityKey: string;
  title: string;
  scope: string;
  evidenceVersions: Record<string, string>;
}
export interface KnowledgeCandidate {
  id: string;
  identityKey: string;
  title: string;
  scope: string;
  evidenceIds: string[];
  revision: number;
  status: "proposed" | "deferred" | "published" | "merged" | "dismissed";
  nodeId: string | null;
}
export type KnowledgeCandidateWriteResult = KnowledgeCandidate & {
  creationInventoryRevision: number;
  /** Exact post-write generation, internal to the trusted maintenance runtime. */
  reconciliationReceipt?: KnowledgeReconciliationReceipt;
};
function candidateWriteResult(
  db: Database.Database,
  candidate: KnowledgeCandidate,
  fence?: KnowledgeRunFence,
): KnowledgeCandidateWriteResult {
  return {
    ...candidate,
    creationInventoryRevision: readKnowledgeCollectionRevision(db, "wiki_scope"),
    ...(fence?.reconciliation
      ? {
          reconciliationReceipt: {
            collection: "wiki" as const,
            revision: readKnowledgeCollectionRevision(db, "wiki"),
          },
        }
      : {}),
  };
}
interface CandidateRow extends Omit<KnowledgeCandidate, "evidenceIds"> {
  evidenceJson: string;
}
function candidateRow(row: CandidateRow): KnowledgeCandidate {
  const { evidenceJson, ...rest } = row;
  return { ...rest, evidenceIds: JSON.parse(evidenceJson) as string[] };
}
export function getKnowledgeCandidate(
  db: Database.Database,
  id: string,
): KnowledgeCandidate | null {
  const row = db
    .prepare<[string], CandidateRow>(
      `SELECT id,identity_key AS identityKey,title,scope,evidence_ids_json AS evidenceJson,
    revision,status,node_id AS nodeId FROM knowledge_candidates WHERE id=?`,
    )
    .get(id);
  if (!row) return null;
  const candidate = candidateRow(row);
  if (candidate.evidenceIds.some((id) => !isKnowledgeEvidenceReadable(db, id))) return null;
  return candidate;
}
/** Cursor advances over scanned identities too, so privacy filtering cannot strand pagination. */
export function listKnowledgeCandidates(
  db: Database.Database,
  options: { afterId?: string; limit?: number; status?: KnowledgeCandidate["status"] } = {},
): { items: KnowledgeCandidate[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(100, options.limit ?? 30));
  const rows = db
    .prepare<
      [string, string | null, string | null, number],
      { id: string }
    >("SELECT id FROM knowledge_candidates WHERE id>? AND (? IS NULL OR status=?) ORDER BY id LIMIT ?")
    .all(options.afterId ?? "", options.status ?? null, options.status ?? null, limit);
  return {
    items: rows.flatMap(({ id }) => {
      const value = getKnowledgeCandidate(db, id);
      return value ? [value] : [];
    }),
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}
/** Stable identity is chosen only after retrieval-based reconciliation, never inferred from a title alone. */
export function proposeKnowledgeCandidate(
  db: Database.Database,
  input: KnowledgeCandidateInput,
  now: number,
  runFence?: KnowledgeRunFence,
): KnowledgeCandidateWriteResult {
  if (
    !input.identityKey.trim() ||
    input.identityKey.length > 500 ||
    !input.title.trim() ||
    input.title.length > 1000 ||
    input.scope.length > 8000
  )
    throw new KnowledgeStorageError("claim_invalid", "Invalid page candidate scope");
  const ids = Object.keys(input.evidenceVersions);
  if (!ids.length || ids.length > 64)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "A page candidate needs between one and 64 evidence sources",
    );
  return db.transaction(() => {
    assertKnowledgeRunFence(db, runFence);
    if (input.expectedInventoryRevision !== undefined)
      assertKnowledgeReconciliation(db, {
        collection: "wiki_scope",
        revision: input.expectedInventoryRevision,
      });
    for (const id of ids) {
      const row = db
        .prepare<
          [string],
          { content_hash: string; deleted: number }
        >("SELECT d.content_hash,COALESCE(r.deleted,0) AS deleted FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=?")
        .get(id);
      if (
        !row ||
        row.deleted ||
        !isKnowledgeEvidenceReadable(db, id) ||
        row.content_hash !== input.evidenceVersions[id]
      )
        throw new KnowledgeStorageError("revision_conflict", "Candidate evidence changed");
    }
    const existing = db
      .prepare<[string], { id: string }>("SELECT id FROM knowledge_candidates WHERE identity_key=?")
      .get(input.identityKey);
    if (existing) {
      const candidate = getKnowledgeCandidate(db, existing.id);
      if (!candidate)
        throw new KnowledgeStorageError("reference_invalid", "Candidate evidence is unavailable");
      return candidateWriteResult(db, candidate, runFence);
    }
    db.prepare(
      `INSERT INTO knowledge_candidates(id,identity_key,title,scope,evidence_ids_json,created_at,updated_at,status)
      VALUES(?,?,?,?,?,?,?,'proposed')`,
    ).run(input.id, input.identityKey, input.title, input.scope, JSON.stringify(ids), now, now);
    return candidateWriteResult(db, getKnowledgeCandidate(db, input.id)!, runFence);
  })();
}
export function settleKnowledgeCandidate(
  db: Database.Database,
  input: {
    id: string;
    expectedRevision: number;
    status: KnowledgeCandidate["status"];
    nodeId?: string;
    reconsiderAt?: number;
  },
  now: number,
  runFence?: KnowledgeRunFence,
): KnowledgeCandidateWriteResult {
  return db.transaction(() => {
    assertKnowledgeRunFence(db, runFence);
    const candidate = getKnowledgeCandidate(db, input.id);
    if (!candidate || candidate.revision !== input.expectedRevision)
      throw new KnowledgeStorageError("revision_conflict", "Candidate changed");
    if (
      (candidate.status === "published" || candidate.status === "merged") &&
      (input.status !== candidate.status || input.nodeId !== candidate.nodeId)
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Published identity must remain attached to its canonical page",
      );
    if (input.status === "published" || input.status === "merged") {
      const node = input.nodeId ? getKnowledgeNode(db, input.nodeId) : null;
      if (!node || node.kind !== "wiki")
        throw new KnowledgeStorageError(
          "reference_invalid",
          "Candidate publication requires a live wiki",
        );
      assertCandidateGrounded(db, node.id, candidate.evidenceIds);
    }
    db.prepare(
      "UPDATE knowledge_candidates SET status=?,node_id=?,reconsider_at=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(input.status, input.nodeId ?? null, input.reconsiderAt ?? null, now, input.id);
    return candidateWriteResult(db, getKnowledgeCandidate(db, input.id)!, runFence);
  })();
}
export function knowledgeDiscoveryIdentity(
  documentId: string,
  revision: string,
  phase: DiscoveryPhase,
): string {
  return `discovery_${knowledgeHash([documentId, revision, phase, KNOWLEDGE_DISCOVERY_POLICY])}`;
}

export function assertCandidateGrounded(
  db: Database.Database,
  nodeId: string,
  evidenceIds: string[],
  budget: { remaining: number } = { remaining: 8192 },
): void {
  const expected = new Set(evidenceIds);
  const visited = new Set<string>();
  const pending: Array<{ id: string; claimId: string | null }> = [{ id: nodeId, claimId: null }];
  const dependencies = db.prepare<
    [string, string | null, string | null, number],
    { kind: string; id: string; ref: string }
  >(
    "SELECT target_kind AS kind,target_id AS id,ref FROM knowledge_dependencies WHERE node_id=? AND (? IS NULL OR claim_id=?) AND relation='supports' LIMIT ?",
  );
  while (pending.length) {
    const { id, claimId } = pending.pop()!;
    const key = JSON.stringify([id, claimId]);
    if (visited.has(key)) continue;
    visited.add(key);
    const rows = dependencies.all(id, claimId, claimId, Math.max(1, budget.remaining + 1));
    budget.remaining -= rows.length + 1;
    if (budget.remaining < 0)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Candidate grounding exceeds the bounded traversal budget",
      );
    for (const input of rows) {
      if (input.kind === "source" && expected.has(input.id)) return;
      if (input.kind === "node") {
        const ref = parseClaimReference(input.ref);
        if (ref.selector?.kind === "claim")
          pending.push({ id: input.id, claimId: ref.selector.id });
      }
    }
  }
  throw new KnowledgeStorageError(
    "claim_invalid",
    "Canonical page must connect to the candidate's declared evidence",
  );
}

/** Publication and identity ownership commit together: a racing proposal cannot leave an orphan wiki. */
export function publishKnowledgeCandidate(
  db: Database.Database,
  input: {
    candidateId: string;
    expectedCandidateRevision: number;
    node: SaveKnowledgeNodeInput;
    creationReceipt?: WikiPublicationReceipt;
  },
  now: number,
): ReturnType<typeof saveKnowledgeNode> {
  return db.transaction(() => {
    const candidate = getKnowledgeCandidate(db, input.candidateId);
    if (
      !candidate ||
      candidate.revision !== input.expectedCandidateRevision ||
      candidate.status !== "proposed"
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Page candidate changed before publication",
      );
    if (
      input.node.kind !== "wiki" ||
      input.node.expectedRevision !== 0 ||
      !parseClaimMarkup(input.node.markdown).claims.length
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "A new page must contain grounded claim spans",
      );
    assertWikiPublicationReceipt(db, candidate.id, input.creationReceipt);
    const result = saveKnowledgeNode(db, input.node, now);
    assertCandidateGrounded(db, result.node.id, candidate.evidenceIds);
    assertWikiSourceDiversity(db, result.node.id);
    // Publication must not depend on the creating turn remembering integration targets.
    // Review chooses placement; a standalone page remains a valid outcome.
    enqueueKnowledgeWork(
      db,
      {
        id: `kw_${randomUUID()}`,
        subjectId: result.node.id,
        subjectKind: "node",
        reason: "review",
        inputRevision: String(result.node.revision),
        tier: "soon",
        dueAt: now,
      },
      now,
    );
    settleKnowledgeCandidate(
      db,
      {
        id: candidate.id,
        expectedRevision: candidate.revision,
        status: "published",
        nodeId: result.node.id,
      },
      now,
    );
    return {
      ...result,
      ...(input.node.runFence?.reconciliation
        ? {
            reconciliationReceipt: {
              collection: "wiki" as const,
              revision: readKnowledgeCollectionRevision(db, "wiki"),
            },
          }
        : {}),
    };
  })();
}
