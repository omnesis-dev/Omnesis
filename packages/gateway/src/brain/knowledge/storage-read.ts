// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeNodeFence } from "./storage-fence.js";
import type Database from "better-sqlite3";
import type {
  KnowledgeChange,
  KnowledgeClaim,
  KnowledgeDependency,
  KnowledgeNode,
} from "./types.js";

type Db = Database.Database;
export interface KnowledgeNodeRow {
  id: string;
  kind: KnowledgeNode["kind"];
  owner_id: string | null;
  title: string;
  markdown: string;
  plain_text: string;
  revision: number;
  meaning_revision: number;
  meaning_hash: string;
  validity: KnowledgeNode["validity"];
  metadata_json: string;
  fields_json: string;
  created_at: number;
  updated_at: number;
}
export function readKnowledgeNodeRow(db: Db, id: string): KnowledgeNodeRow | undefined {
  return db.prepare<[string], KnowledgeNodeRow>("SELECT * FROM knowledge_nodes WHERE id=?").get(id);
}
function nodeFromRow(row: KnowledgeNodeRow): KnowledgeNode {
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    title: row.title,
    markdown: row.markdown,
    plainText: row.plain_text,
    revision: row.revision,
    meaningRevision: row.meaning_revision,
    validity: row.validity,
    metadata: JSON.parse(row.metadata_json) as KnowledgeNode["metadata"],
    canonicalFields: JSON.parse(row.fields_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function getKnowledgeNode(db: Db, id: string): KnowledgeNode | null {
  const row = readKnowledgeNodeRow(db, id);
  if (!row) return null;
  const fence = knowledgeNodeFence(db, id);
  if (fence.hidden) return null;
  return nodeFromRow(fence.stale ? { ...row, validity: "stale" } : row);
}
export function listKnowledgeNodes(
  db: Db,
  options: { kind?: KnowledgeNode["kind"]; afterId?: string; limit?: number } = {},
): KnowledgeNode[] {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const result: KnowledgeNode[] = [];
  let after = options.afterId ?? "";
  while (result.length < limit) {
    const rows = db
      .prepare<
        [string | null, string | null, string, number],
        KnowledgeNodeRow
      >("SELECT * FROM knowledge_nodes WHERE (? IS NULL OR kind=?) AND id>? ORDER BY id LIMIT ?")
      .all(options.kind ?? null, options.kind ?? null, after, limit - result.length);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      const fence = knowledgeNodeFence(db, row.id);
      if (!fence.hidden)
        result.push(nodeFromRow(fence.stale ? { ...row, validity: "stale" } : row));
    }
  }
  return result;
}
export function getKnowledgeClaims(db: Db, nodeId: string): KnowledgeClaim[] {
  const fence = knowledgeNodeFence(db, nodeId);
  if (fence.hidden) return [];
  const rows = db
    .prepare<
      [string],
      {
        id: string;
        node_id: string;
        text: string;
        parent_id: string | null;
        span_start: number;
        span_end: number;
        support_logic: KnowledgeClaim["supportLogic"];
        verification: KnowledgeClaim["verification"];
        fingerprint: string;
        witness_refs_json: string;
        meaning_revision: number;
        valid_from: number | null;
        valid_until: number | null;
      }
    >("SELECT * FROM knowledge_claims WHERE node_id=? ORDER BY span_start")
    .all(nodeId);
  const deps = getKnowledgeDependencies(db, nodeId);
  return rows.map((r) => ({
    id: r.id,
    meaningRevision: r.meaning_revision,
    nodeId: r.node_id,
    text: r.text,
    parentId: r.parent_id,
    start: r.span_start,
    end: r.span_end,
    refs: deps.filter((d) => d.claimId === r.id).map((d) => d.ref),
    supportLogic: r.support_logic,
    verification: knowledgeNodeFence(db, nodeId, { kind: "claim", id: r.id }).stale
      ? "stale"
      : r.verification,
    fingerprint: r.fingerprint,
    witnessRefs: JSON.parse(r.witness_refs_json),
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }));
}
export function getKnowledgeDependencies(db: Db, nodeId: string): KnowledgeDependency[] {
  return db
    .prepare<
      [string],
      {
        node_id: string;
        claim_id: string;
        ref: string;
        target_id: string;
        target_kind: "source" | "node";
        relation: KnowledgeDependency["relation"];
        input_version_json: string;
      }
    >("SELECT * FROM knowledge_dependencies WHERE node_id=? ORDER BY claim_id,ref")
    .all(nodeId)
    .map((r) => ({
      nodeId: r.node_id,
      claimId: r.claim_id,
      ref: r.ref,
      targetId: r.target_id,
      targetKind: r.target_kind,
      relation: r.relation,
      inputVersion: JSON.parse(r.input_version_json) as string | number,
    }));
}
export function listKnowledgeChanges(
  db: Db,
  options: { afterSeq?: number; limit?: number } = {},
): KnowledgeChange[] {
  return db
    .prepare<
      [number, number],
      {
        seq: number;
        kind: KnowledgeChange["kind"];
        entity_id: string;
        revision: string;
        at: number;
      }
    >("SELECT * FROM knowledge_changes WHERE seq>? ORDER BY seq LIMIT ?")
    .all(options.afterSeq ?? 0, Math.max(1, Math.min(1000, options.limit ?? 100)))
    .map((r) => ({
      seq: r.seq,
      kind: r.kind,
      entityId: r.entity_id,
      revision: r.revision,
      at: r.at,
    }));
}
/** Only acknowledge a contiguous prefix once its durable downstream work exists. */
export function ackKnowledgeChanges(db: Db, throughSeq: number): void {
  db.prepare("DELETE FROM knowledge_changes WHERE seq<=?").run(throughSeq);
}
export function appendKnowledgeChange(db: Db, change: Omit<KnowledgeChange, "seq">): void {
  db.prepare("INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES(?,?,?,?)").run(
    change.kind,
    change.entityId,
    change.revision,
    change.at,
  );
}
