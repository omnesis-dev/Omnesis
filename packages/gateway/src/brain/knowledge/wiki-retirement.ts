// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { queueKnowledgeProjectionCleanup } from "./mirror-storage.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import { snapshotKnowledgeRevision } from "./storage-history.js";
import { invalidateKnowledgeDependents } from "./storage-invalidation.js";
import { appendKnowledgeChange, readKnowledgeNodeRow } from "./storage-read.js";
import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export const WIKI_RETIREMENT_REASON_MAX = 1000;

export interface RetireWikiPageInput {
  id: string;
  expectedRevision: number;
  reason: string;
}

/**
 * Retires one wiki page as a deliberate, reviewed act. The page keeps its
 * history and is withdrawn rather than deleted: it leaves search, the page
 * directory and maintenance, cannot be cited or revised again, and every page
 * that read it is invalidated for review. The reason is stored on the retired revision.
 * The root page is never retired.
 */
export function retireKnowledgeWikiPage(
  db: Database.Database,
  input: RetireWikiPageInput,
  fence: KnowledgeRunFence | undefined,
  now: number,
): { id: string; revision: number } {
  const reason = input.reason.trim();
  if (!reason || reason.length > WIKI_RETIREMENT_REASON_MAX)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `A retirement needs a specific reason of at most ${WIKI_RETIREMENT_REASON_MAX} characters`,
    );
  return db.transaction(() => {
    assertKnowledgeRunFence(db, fence);
    const node = readKnowledgeNodeRow(db, input.id);
    if (
      !node ||
      JSON.parse(node.fields_json).withdrawn === true ||
      knowledgeNodeFence(db, node.id).hidden
    )
      throw new KnowledgeStorageError("reference_invalid", "Synthesis page is unavailable");
    if (node.kind === "root")
      throw new KnowledgeStorageError(
        "claim_invalid",
        "The root page is never retired; revise it with knowledge_edit instead",
      );
    if (node.kind !== "wiki")
      throw new KnowledgeStorageError(
        "claim_invalid",
        "knowledge_retire retires wiki pages; other synthesis is retired through its own owner tools",
      );
    if (node.revision !== input.expectedRevision)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Node revision changed; fetch the current page before retiring it",
      );
    const fields = {
      ...JSON.parse(node.fields_json),
      withdrawn: true,
      withdrawnAt: now,
      retirementReason: reason,
    };
    const metadata = {
      ...JSON.parse(node.metadata_json),
      activity: "historical",
      nextReviewAt: null,
    };
    db.prepare(
      "UPDATE knowledge_nodes SET validity='stale',revision=revision+1,meaning_revision=meaning_revision+1,meaning_hash=?,fields_json=?,metadata_json=?,updated_at=? WHERE id=?",
    ).run(
      knowledgeHash([node.meaning_hash, "retired", now]),
      JSON.stringify(fields),
      JSON.stringify(metadata),
      now,
      node.id,
    );
    db.prepare(
      "UPDATE knowledge_claims SET verification='stale',verifier=NULL,meaning_revision=? WHERE node_id=?",
    ).run(node.meaning_revision + 1, node.id);
    snapshotKnowledgeRevision(
      db,
      node.id,
      {
        changedClaimIds: [],
        changedRefs: [],
        changedFieldKeys: ["withdrawn", "withdrawnAt", "retirementReason"],
        titleChanged: false,
        validityChanged: true,
      },
      now,
    );
    appendKnowledgeChange(db, {
      kind: "node_changed",
      entityId: node.id,
      revision: String(node.meaning_revision + 1),
      at: now,
    });
    queueKnowledgeProjectionCleanup(db, [node.id], now);
    invalidateKnowledgeDependents(db, { kind: "node", id: node.id }, now);
    return { id: node.id, revision: node.revision + 1 };
  })();
}
