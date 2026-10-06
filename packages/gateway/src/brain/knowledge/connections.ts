// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { BadRequestError, NotFoundError } from "../../http/errors.js";
import { getKnowledgeNode } from "./storage-read.js";
import { parseClaimReference } from "./references.js";
import type Database from "better-sqlite3";
import type { KnowledgeNode } from "./types.js";

const cursorSchema = z.object({
  node: z.string().max(128),
  bucket: z.number().int().min(0).max(3),
  row: z.number().int().nonnegative().safe(),
});
interface EdgeRow {
  bucket: number;
  row: number;
  neighbor: string;
  source: number;
  relationship: string;
  claimId: string | null;
  ref: string | null;
}
export interface KnowledgeConnection {
  id: string;
  direction: "incoming" | "outgoing";
  relationship: string;
  dependency: boolean;
  claimId: string | null;
  targetClaimId: string | null;
  ref: string | null;
  node: { id: string; kind: KnowledgeNode["kind"] | "source"; title: string };
}

/** Bounded adjacency reads fence each endpoint before exposing its identity or title. */
export function readKnowledgeConnections(
  db: Database.Database,
  id: string,
  options: { cursor?: string; limit?: number } = {},
): { items: KnowledgeConnection[]; nextCursor: string | null } {
  return db.transaction(() => readConnectionsSnapshot(db, id, options))();
}
function readConnectionsSnapshot(
  db: Database.Database,
  id: string,
  options: { cursor?: string; limit?: number },
): { items: KnowledgeConnection[]; nextCursor: string | null } {
  if (!getKnowledgeNode(db, id)) throw new NotFoundError("Knowledge node not found");
  let after = { bucket: 0, row: 0 };
  if (options.cursor) {
    try {
      if (options.cursor.length > 1024) throw new Error("oversized");
      const parsed = cursorSchema.parse(
        JSON.parse(Buffer.from(options.cursor, "base64url").toString()),
      );
      if (parsed.node !== id) throw new Error("different node");
      after = parsed;
    } catch {
      throw new BadRequestError("Invalid connections cursor");
    }
  }
  const limit = Math.max(1, Math.min(100, options.limit ?? 30));
  const rows = db
    .prepare<[string, string, string, string, number, number, number, number], EdgeRow>(
      `
    SELECT * FROM (
      SELECT 0 AS bucket, rowid AS row, target_id AS neighbor, target_kind='source' AS source,
        relation AS relationship, claim_id AS claimId, ref
        FROM knowledge_dependencies WHERE node_id=?
      UNION ALL
      SELECT 1, rowid, node_id, 0, relation, claim_id, ref
        FROM knowledge_dependencies WHERE target_kind='node' AND target_id=?
      UNION ALL
      SELECT 2, rowid, to_id, 0, kind, NULL, NULL FROM knowledge_links WHERE from_id=?
      UNION ALL
      SELECT 3, rowid, from_id, 0, kind, NULL, NULL FROM knowledge_links WHERE to_id=?
    ) WHERE bucket>? OR (bucket=? AND row>?) ORDER BY bucket,row LIMIT ?
  `,
    )
    .all(id, id, id, id, after.bucket, after.bucket, after.row, limit + 1);
  const page = rows.slice(0, limit);
  const items: KnowledgeConnection[] = [];
  const neighbors = new Map<string, KnowledgeConnection["node"] | null>();
  for (const edge of page) {
    const key = `${edge.source ? "source" : "node"}:${edge.neighbor}`;
    if (!neighbors.has(key)) {
      if (edge.source) {
        // The selected node's transitive fence covers source deletion and source removal.
        const source = db
          .prepare<[string], { title: string }>("SELECT title FROM documents WHERE id=?")
          .get(edge.neighbor);
        neighbors.set(
          key,
          source ? { id: `source:${edge.neighbor}`, kind: "source", title: source.title } : null,
        );
      } else {
        const neighbor = getKnowledgeNode(db, edge.neighbor);
        neighbors.set(
          key,
          neighbor ? { id: neighbor.id, kind: neighbor.kind, title: neighbor.title } : null,
        );
      }
    }
    const node = neighbors.get(key);
    if (!node) continue;
    const selector = edge.ref ? parseClaimReference(edge.ref).selector : undefined;
    items.push({
      id: `${edge.bucket}:${edge.row}`,
      direction: edge.bucket === 1 || edge.bucket === 3 ? "incoming" : "outgoing",
      relationship: edge.relationship,
      dependency: edge.bucket < 2 && edge.relationship !== "context",
      claimId: edge.claimId,
      targetClaimId: selector?.kind === "claim" ? selector.id : null,
      ref: edge.ref,
      node,
    });
  }
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ node: id, bucket: last.bucket, row: last.row })).toString(
            "base64url",
          )
        : null,
  };
}
