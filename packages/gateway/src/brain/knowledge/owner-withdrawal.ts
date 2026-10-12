// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { deleteDocAnnotation } from "../storage/annotations.js";
import { deletePersonAnnotation } from "../storage/person-annotations.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { readKnowledgeNodeRow, appendKnowledgeChange } from "./storage-read.js";
import { invalidateKnowledgeDependents } from "./storage-invalidation.js";
import { snapshotKnowledgeRevision } from "./storage-history.js";
import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Belief withdrawal preserves stale dependents for repair; privacy deletion remains a purge. */
export function withdrawKnowledgeOwner(
  db: Database.Database,
  kind: "doc_annotation" | "person_annotation",
  id: string,
  now: number,
): boolean {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return kind === "doc_annotation" ? deleteDocAnnotation(db, id) : deletePersonAnnotation(db, id);
  return db.transaction(() => {
    const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
    const subjectColumn = kind === "doc_annotation" ? "doc_id" : "person_id";
    const owner = db
      .prepare<
        [string],
        { subjectId: string }
      >(`SELECT ${subjectColumn} AS subjectId FROM ${table} WHERE id=?`)
      .get(id);
    if (!owner) return false;
    try {
      convertKnowledgeOwner(db, kind, id, now);
    } catch (error) {
      // An already unavailable legacy prior has no new synthesis to retain.
      if (!(error instanceof KnowledgeStorageError) || error.code !== "reference_invalid")
        throw error;
    }
    db.prepare("INSERT INTO knowledge_owner_withdraw_guard(owner_id) VALUES(?)").run(id);
    const deleted =
      kind === "doc_annotation" ? deleteDocAnnotation(db, id) : deletePersonAnnotation(db, id);
    db.prepare("DELETE FROM knowledge_owner_withdraw_guard WHERE owner_id=?").run(id);
    db.prepare("DELETE FROM knowledge_owner_changes WHERE owner_id=?").run(id);
    const node = readKnowledgeNodeRow(db, id);
    if (node) {
      // Capture the current canonical subject before removing its owner; a
      // mirror may still describe an older person association.
      const fields = {
        ...JSON.parse(node.fields_json),
        subjectId: owner.subjectId,
        withdrawn: true,
        withdrawnAt: now,
      };
      const metadata = {
        ...JSON.parse(node.metadata_json),
        activity: "historical",
        nextReviewAt: null,
      };
      db.prepare(
        "UPDATE knowledge_nodes SET validity='stale',revision=revision+1,meaning_revision=meaning_revision+1,meaning_hash=?,fields_json=?,metadata_json=?,updated_at=? WHERE id=?",
      ).run(
        knowledgeHash([node.meaning_hash, "withdrawn", now]),
        JSON.stringify(fields),
        JSON.stringify(metadata),
        now,
        id,
      );
      db.prepare(
        "UPDATE knowledge_claims SET verification='stale',verifier=NULL,meaning_revision=? WHERE node_id=?",
      ).run(node.revision + 1, id);
      snapshotKnowledgeRevision(
        db,
        id,
        {
          changedClaimIds: [],
          changedRefs: [],
          changedFieldKeys: ["subjectId", "withdrawn", "withdrawnAt"],
          titleChanged: false,
          validityChanged: true,
        },
        now,
      );
      appendKnowledgeChange(db, {
        kind: "node_changed",
        entityId: id,
        revision: String(node.meaning_revision + 1),
        at: now,
      });
      invalidateKnowledgeDependents(db, { kind: "node", id }, now);
    }
    return deleted;
  })();
}
