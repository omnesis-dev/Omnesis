// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { getKnowledgeNode } from "./storage.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export type KnowledgeLinkKind =
  | "related_to"
  | "belongs_to_project"
  | "part_of"
  | "supersedes"
  | "duplicate_of";
export interface KnowledgeLinkInput {
  fromId: string;
  toId: string;
  kind: KnowledgeLinkKind;
  fromRevision: number;
  toRevision: number;
  remove?: boolean;
}
/** Navigation and organization are independent of evidence dependency edges. */
export function setKnowledgeLink(
  db: Database.Database,
  input: KnowledgeLinkInput,
  runFence?: KnowledgeRunFence,
): void {
  db.transaction(() => {
    assertKnowledgeRunFence(db, runFence);
    const from = getKnowledgeNode(db, input.fromId);
    const to = getKnowledgeNode(db, input.toId);
    if (!from || !to)
      throw new KnowledgeStorageError("reference_invalid", "Both link endpoints must exist");
    if (from.revision !== input.fromRevision || to.revision !== input.toRevision)
      throw new KnowledgeStorageError("revision_conflict", "A link endpoint changed");
    if (input.fromId === input.toId)
      throw new KnowledgeStorageError("claim_invalid", "A node cannot link to itself");
    if (input.kind === "belongs_to_project" && to.kind !== "wiki")
      throw new KnowledgeStorageError("claim_invalid", "Project context belongs on a wiki");
    if (
      input.kind === "part_of" &&
      !(
        (from.kind === "loop" && to.kind === "loop") ||
        (["wiki", "root"].includes(from.kind) && ["wiki", "root"].includes(to.kind))
      )
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Task decomposition connects loops; page organization connects wikis",
      );
    if (input.remove) {
      db.prepare("DELETE FROM knowledge_links WHERE from_id=? AND to_id=? AND kind=?").run(
        input.fromId,
        input.toId,
        input.kind,
      );
      return;
    }
    if (input.kind === "part_of" || input.kind === "supersedes") {
      const ancestors = db
        .prepare<
          [string, KnowledgeLinkKind],
          { id: string }
        >(`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT l.to_id FROM knowledge_links l JOIN ancestors a ON l.from_id=a.id WHERE l.kind=? LIMIT 8193) SELECT id FROM ancestors`)
        .all(input.toId, input.kind);
      if (ancestors.some((ancestor) => ancestor.id === input.fromId))
        throw new KnowledgeStorageError("cycle", "This organizational link would form a cycle");
      if (ancestors.length > 8192)
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Organizational hierarchy exceeds the bounded write budget",
        );
    }
    db.prepare("INSERT OR IGNORE INTO knowledge_links(from_id,to_id,kind) VALUES(?,?,?)").run(
      input.fromId,
      input.toId,
      input.kind,
    );
  })();
}
export function listKnowledgeLinks(
  db: Database.Database,
  id: string,
): Array<{ fromId: string; toId: string; kind: KnowledgeLinkKind }> {
  if (!getKnowledgeNode(db, id)) return [];
  return db
    .prepare<[string, string], { fromId: string; toId: string; kind: KnowledgeLinkKind }>(
      "SELECT from_id AS fromId,to_id AS toId,kind FROM knowledge_links WHERE from_id=? OR to_id=? ORDER BY from_id,to_id,kind",
    )
    .all(id, id)
    .filter((link) => getKnowledgeNode(db, link.fromId) && getKnowledgeNode(db, link.toId));
}
