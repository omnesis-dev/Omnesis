// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeNodeFence } from "./storage-fence.js";
import { readKnowledgeNodeRow } from "./storage-read.js";
import type Database from "better-sqlite3";

export interface KnowledgeRevisionDiff {
  changedClaimIds: string[];
  changedRefs: string[];
  changedFieldKeys: string[];
  titleChanged: boolean;
  validityChanged: boolean;
}
export interface KnowledgeNodeRevision {
  nodeId: string;
  revision: number;
  previousRevision: number;
  title: string;
  markdown: string;
  plainText: string;
  canonicalFields: Record<string, unknown>;
  validity: "current" | "stale";
  diff: KnowledgeRevisionDiff;
  createdAt: number;
}
/** Internal snapshot, in the same transaction as its canonical revision. */
export function snapshotKnowledgeRevision(
  db: Database.Database,
  nodeId: string,
  diff: KnowledgeRevisionDiff,
  now: number,
): void {
  const node = readKnowledgeNodeRow(db, nodeId);
  if (!node) return;
  const claims = db
    .prepare(
      "SELECT id,text,parent_id,verification,fingerprint,meaning_revision,witness_refs_json FROM knowledge_claims WHERE node_id=? ORDER BY id",
    )
    .all(nodeId);
  db.prepare(
    `INSERT INTO knowledge_revisions(node_id,revision,previous_revision,title,markdown,plain_text,fields_json,validity,claims_json,diff_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    nodeId,
    node.revision,
    node.revision - 1,
    node.title,
    node.markdown,
    node.plain_text,
    node.fields_json,
    node.validity,
    JSON.stringify(claims),
    JSON.stringify(diff),
    now,
  );
  db.prepare(
    `INSERT INTO knowledge_revision_dependencies(node_id,revision,target_kind,target_id)
    SELECT DISTINCT node_id,?,target_kind,target_id FROM knowledge_dependencies WHERE node_id=?`,
  ).run(node.revision, nodeId);
}
/** Newest first. History is context about previous beliefs, never current proof. */
export function listKnowledgeNodeRevisions(
  db: Database.Database,
  nodeId: string,
  options: { beforeRevision?: number; limit?: number } = {},
): KnowledgeNodeRevision[] {
  if (knowledgeNodeFence(db, nodeId).hidden) return [];
  return db
    .prepare<
      [string, number, number],
      {
        node_id: string;
        revision: number;
        previous_revision: number;
        title: string;
        markdown: string;
        plain_text: string;
        fields_json: string;
        validity: "current" | "stale";
        diff_json: string;
        created_at: number;
      }
    >(
      "SELECT * FROM knowledge_revisions WHERE node_id=? AND revision<? ORDER BY revision DESC LIMIT ?",
    )
    .all(
      nodeId,
      options.beforeRevision ?? Number.MAX_SAFE_INTEGER,
      Math.max(1, Math.min(100, options.limit ?? 20)),
    )
    .map((row) => ({
      nodeId: row.node_id,
      revision: row.revision,
      previousRevision: row.previous_revision,
      title: row.title,
      markdown: row.markdown,
      plainText: row.plain_text,
      canonicalFields: JSON.parse(row.fields_json) as Record<string, unknown>,
      validity: row.validity,
      diff: JSON.parse(row.diff_json) as KnowledgeRevisionDiff,
      createdAt: row.created_at,
    }));
}
