// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { queueKnowledgeProjectionCleanup } from "./mirror-storage.js";
import { purgeNextOrganizationCohort } from "./storage-organization-purge.js";
import { purgeKnowledgeOwner } from "./storage-owner-purge.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import { snapshotKnowledgeRevision } from "./storage-history.js";
import { appendKnowledgeChange } from "./storage-read.js";
import type { KnowledgeNodeKind } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
type Target = { kind: "source" | "node"; id: string };
function enqueueCascade(
  db: Db,
  kind: "invalidate" | "purge",
  target: Target,
  revision: string,
  now: number,
): number {
  db.prepare(
    "INSERT OR IGNORE INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES(?,?,?,?,?)",
  ).run(kind, target.kind, target.id, revision, now);
  const job = db
    .prepare<
      [string, string, string, string],
      { id: number }
    >("SELECT id FROM knowledge_cascade_jobs WHERE kind=? AND target_kind=? AND target_id=? AND revision=?")
    .get(kind, target.kind, target.id, revision)!;
  db.prepare(
    "INSERT OR IGNORE INTO knowledge_cascade_frontier(job_id,target_kind,target_id) VALUES(?,?,?)",
  ).run(job.id, target.kind, target.id);
  return job.id;
}

/** Immediate read fencing plus durable bounded physical invalidation; no LLM. */
export function invalidateKnowledgeDependents(db: Db, target: Target, now: number): string[] {
  return db.transaction(() => {
    const jobId = enqueueCascade(db, "invalidate", target, String(now), now);
    return advanceKnowledgeCascade(db, 100, now, jobId).invalidatedNodeIds;
  })();
}
/** Source tombstones block reads and new writes before any bounded cleanup runs. */
export function purgeKnowledgeBySource(db: Db, documentId: string, now: number): string[] {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES(?,'',1,?)
      ON CONFLICT(document_id) DO UPDATE SET content_hash='',deleted=1,updated_at=excluded.updated_at`,
    ).run(documentId, now);
    db.prepare("DELETE FROM knowledge_evidence WHERE document_id=?").run(documentId);
    db.prepare("DELETE FROM knowledge_changes WHERE entity_id=?").run(documentId);
    const jobId = enqueueCascade(db, "purge", { kind: "source", id: documentId }, "deleted", now);
    const result = advanceKnowledgeCascade(db, 100, now, jobId);
    appendKnowledgeChange(db, {
      kind: "source_deleted",
      entityId: documentId,
      revision: "deleted",
      at: now,
    });
    return result.deletedNodeIds;
  })();
}

/** Each step discovers at most one edge or finishes one node; callers yield between chunks. */
export function advanceKnowledgeCascade(
  db: Db,
  limit: number,
  now: number,
  onlyJobId?: number,
): { pending: boolean; deletedNodeIds: string[]; invalidatedNodeIds: string[] } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Cascade limit must be between 1 and 1000");
  return db.transaction(() => {
    const hasCandidateSources = !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_candidate_sources'",
      )
      .get();
    const hasOrganizationCohorts = !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_organization_members'",
      )
      .get();
    const hasBriefLinks = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='brief_related_loops'")
      .get();
    const hasRetiredLoops = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_loops'")
      .get();
    const deletedNodeIds: string[] = [];
    const invalidatedNodeIds: string[] = [];
    for (let count = 0; count < limit; count++) {
      const item = db
        .prepare<
          [number | null, number | null],
          {
            job_id: number;
            kind: "purge" | "invalidate";
            target_kind: "source" | "node";
            target_id: string;
            after_node_id: string;
            root_kind: string;
            root_id: string;
          }
        >(
          `
        SELECT f.*,j.kind,j.target_kind AS root_kind,j.target_id AS root_id
        FROM knowledge_cascade_frontier f JOIN knowledge_cascade_jobs j ON j.id=f.job_id
        WHERE f.done=0 AND (? IS NULL OR f.job_id=?) ORDER BY CASE j.kind WHEN 'purge' THEN 0 ELSE 1 END,j.id,f.rowid LIMIT 1
      `,
        )
        .get(onlyJobId ?? null, onlyJobId ?? null);
      if (!item) break;
      // One indexed candidate removal consumes one cascade step. Its read fence
      // already hides deleted evidence while this durable source job is pending.
      if (hasCandidateSources && item.kind === "purge" && item.target_kind === "source") {
        const candidate = db
          .prepare<
            [string],
            { candidate_id: string }
          >("SELECT candidate_id FROM knowledge_candidate_sources WHERE document_id=? ORDER BY candidate_id LIMIT 1")
          .get(item.target_id);
        if (candidate) {
          db.prepare("DELETE FROM knowledge_candidates WHERE id=?").run(candidate.candidate_id);
          db.prepare("DELETE FROM knowledge_candidate_sources WHERE candidate_id=?").run(
            candidate.candidate_id,
          );
          continue;
        }
      }

      if (
        hasOrganizationCohorts &&
        item.kind === "purge" &&
        purgeNextOrganizationCohort(db, item.target_id, item.target_kind)
      )
        continue;

      const expands =
        item.kind === "purge" ||
        (item.target_kind === item.root_kind && item.target_id === item.root_id);
      const child = expands
        ? db
            .prepare<
              [
                string,
                string,
                string,
                number,
                number,
                string,
                string,
                string,
                number,
                string,
                string,
                string,
              ],
              { node_id: string }
            >(
              `
        SELECT node_id FROM (
          SELECT node_id FROM knowledge_dependencies WHERE target_kind=? AND target_id=? AND node_id>?
            AND (? OR relation!='context')
          UNION SELECT node_id FROM knowledge_revision_dependencies WHERE ? AND target_kind=? AND target_id=? AND node_id>?
          UNION SELECT loop_id AS node_id FROM knowledge_retired_loop_sources WHERE ? AND ?='source' AND document_id=? AND loop_id>?
        ) ORDER BY node_id LIMIT 1
      `,
            )
            .get(
              item.target_kind,
              item.target_id,
              item.after_node_id,
              Number(item.kind === "purge"),
              Number(item.kind === "purge"),
              item.target_kind,
              item.target_id,
              item.after_node_id,
              Number(item.kind === "purge"),
              item.target_kind,
              item.target_id,
              item.after_node_id,
            )
        : undefined;
      if (child) {
        db.prepare(
          "INSERT OR IGNORE INTO knowledge_cascade_frontier(job_id,target_kind,target_id) VALUES(?,'node',?)",
        ).run(item.job_id, child.node_id);
        db.prepare(
          "UPDATE knowledge_cascade_frontier SET after_node_id=? WHERE job_id=? AND target_kind=? AND target_id=?",
        ).run(child.node_id, item.job_id, item.target_kind, item.target_id);
        continue;
      }
      // The seed is the changed input, not itself a dependent to invalidate/delete.
      if (
        item.target_kind === "node" &&
        (item.kind === "purge" || !(item.root_kind === "node" && item.root_id === item.target_id))
      ) {
        if (item.kind === "purge") queueKnowledgeProjectionCleanup(db, [item.target_id], now);
        if (item.kind === "purge" && hasBriefLinks) {
          const brief = db
            .prepare<
              [string],
              { brief_id: string }
            >("SELECT brief_id FROM brief_related_loops WHERE loop_id=? ORDER BY brief_id LIMIT 1")
            .get(item.target_id);
          if (brief) {
            db.prepare(
              "INSERT OR IGNORE INTO knowledge_node_tombstones(id,deleted_at) VALUES(?,?)",
            ).run(brief.brief_id, now);
            enqueueCascade(db, "purge", { kind: "node", id: brief.brief_id }, "deleted", now);
            db.prepare("DELETE FROM briefs WHERE id=?").run(brief.brief_id);
            db.prepare("DELETE FROM brief_related_loops WHERE brief_id=?").run(brief.brief_id);
            continue;
          }
        }
        const row = db
          .prepare<
            [string],
            { revision: number; validity: string; kind: KnowledgeNodeKind; owner_id: string | null }
          >("SELECT revision,validity,kind,owner_id FROM knowledge_nodes WHERE id=?")
          .get(item.target_id);
        if (item.kind === "purge") {
          if (
            !row &&
            db
              .prepare("SELECT 1 FROM knowledge_retired_loop_sources WHERE loop_id=? LIMIT 1")
              .get(item.target_id)
          )
            purgeKnowledgeOwner(db, "loop", item.target_id);
          if (hasRetiredLoops)
            db.prepare("DELETE FROM retired_loops WHERE id=?").run(item.target_id);
          db.prepare("DELETE FROM knowledge_retired_loop_sources WHERE loop_id=?").run(
            item.target_id,
          );
          db.prepare(
            "INSERT OR IGNORE INTO knowledge_node_tombstones(id,deleted_at) VALUES(?,?)",
          ).run(item.target_id, now);
        }
        if (!row && item.kind === "purge") deletedNodeIds.push(item.target_id);
        if (row && item.kind === "purge") {
          purgeKnowledgeOwner(db, row.kind, row.owner_id);
          db.prepare(
            "INSERT OR IGNORE INTO knowledge_node_tombstones(id,deleted_at) VALUES(?,?)",
          ).run(item.target_id, now);
          db.prepare("DELETE FROM knowledge_revision_dependencies WHERE node_id=?").run(
            item.target_id,
          );
          db.prepare("DELETE FROM knowledge_revisions WHERE node_id=?").run(item.target_id);
          db.prepare("DELETE FROM knowledge_changes WHERE entity_id=?").run(item.target_id);
          db.prepare("DELETE FROM knowledge_dependencies WHERE node_id=?").run(item.target_id);
          db.prepare("DELETE FROM knowledge_claims WHERE node_id=?").run(item.target_id);
          db.prepare("DELETE FROM knowledge_nodes WHERE id=?").run(item.target_id);
          appendKnowledgeChange(db, {
            kind: "node_deleted",
            entityId: item.target_id,
            revision: "deleted",
            at: now,
          });
          deletedNodeIds.push(item.target_id);
        } else if (row) {
          const affectedClaims = db
            .prepare<[string], { id: string; verification: string }>(
              "SELECT id,verification FROM knowledge_claims WHERE node_id=?",
            )
            .all(item.target_id)
            .filter(
              (claim) =>
                claim.verification !== "stale" &&
                knowledgeNodeFence(db, item.target_id, { kind: "claim", id: claim.id }).stale,
            )
            .map((claim) => claim.id);
          if (affectedClaims.length) {
            db.prepare(
              "UPDATE knowledge_nodes SET validity='stale',revision=revision+1,updated_at=? WHERE id=?",
            ).run(now, item.target_id);
            const markClaim = db.prepare(
              "UPDATE knowledge_claims SET verification='stale',verifier=NULL WHERE node_id=? AND id=?",
            );
            for (const claimId of affectedClaims) markClaim.run(item.target_id, claimId);
            appendKnowledgeChange(db, {
              kind: "node_invalidated",
              entityId: item.target_id,
              revision: String(row.revision + 1),
              at: now,
            });
            snapshotKnowledgeRevision(
              db,
              item.target_id,
              {
                changedClaimIds: affectedClaims,
                changedRefs: [],
                changedFieldKeys: [],
                titleChanged: false,
                validityChanged: true,
              },
              now,
            );
            invalidatedNodeIds.push(item.target_id);
          }
        }
      }
      if (item.kind === "purge" && item.target_kind === "node")
        db.prepare("DELETE FROM knowledge_owner_changes WHERE owner_id=?").run(item.target_id);
      db.prepare(
        "UPDATE knowledge_cascade_frontier SET done=1 WHERE job_id=? AND target_kind=? AND target_id=?",
      ).run(item.job_id, item.target_kind, item.target_id);
      if (
        !db
          .prepare("SELECT 1 FROM knowledge_cascade_frontier WHERE job_id=? AND done=0 LIMIT 1")
          .get(item.job_id)
      ) {
        db.prepare("DELETE FROM knowledge_cascade_frontier WHERE job_id=?").run(item.job_id);
        db.prepare("DELETE FROM knowledge_cascade_jobs WHERE id=?").run(item.job_id);
      }
    }
    const pending = !!db.prepare("SELECT 1 FROM knowledge_cascade_jobs LIMIT 1").get();
    return { pending, deletedNodeIds, invalidatedNodeIds };
  })();
}
export function recordKnowledgeSourceChange(
  db: Db,
  input: { documentId: string; contentHash: string; deleted?: boolean },
  now: number,
): { changed: boolean; affectedNodeIds: string[]; deletedNodeIds: string[] } {
  return db.transaction(() => {
    const prior = db
      .prepare<
        [string],
        { content_hash: string; deleted: number }
      >("SELECT content_hash,deleted FROM knowledge_source_revisions WHERE document_id=?")
      .get(input.documentId);
    if (prior?.deleted) return { changed: false, affectedNodeIds: [], deletedNodeIds: [] };
    if (input.deleted) {
      const deletedNodeIds = purgeKnowledgeBySource(db, input.documentId, now);
      return { changed: true, affectedNodeIds: [], deletedNodeIds };
    }
    if (prior?.content_hash === input.contentHash)
      return { changed: false, affectedNodeIds: [], deletedNodeIds: [] };
    db.prepare(
      `INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES(?,?,0,?)
      ON CONFLICT(document_id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
    ).run(input.documentId, input.contentHash, now);
    db.prepare("DELETE FROM knowledge_evidence WHERE document_id=? AND content_hash!=?").run(
      input.documentId,
      input.contentHash,
    );
    const jobId = enqueueCascade(
      db,
      "invalidate",
      { kind: "source", id: input.documentId },
      input.contentHash,
      now,
    );
    const affectedNodeIds = advanceKnowledgeCascade(db, 100, now, jobId).invalidatedNodeIds;
    appendKnowledgeChange(db, {
      kind: "source_changed",
      entityId: input.documentId,
      revision: input.contentHash,
      at: now,
    });
    return { changed: true, affectedNodeIds, deletedNodeIds: [] };
  })();
}

/** Direct deletion of a canonical synthesis owner has the same privacy authority as source deletion. */
export function purgeKnowledgeNode(db: Db, nodeId: string, now: number): string[] {
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO knowledge_node_tombstones(id,deleted_at) VALUES(?,?)").run(
      nodeId,
      now,
    );
    const jobId = enqueueCascade(db, "purge", { kind: "node", id: nodeId }, "deleted", now);
    return advanceKnowledgeCascade(db, 100, now, jobId).deletedNodeIds;
  })();
}
