// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** A topology input, never support for a factual claim. Only its digest is exposed.
 * The bound matches the organizational hierarchy's existing write budget. */
export function knowledgeOrganizationVersion(db: Database.Database, nodeId: string): string {
  const rows = db
    .prepare<
      [string, string, string],
      { from_id: string; to_id: string; kind: string; unavailable: number }
    >(
      `SELECT l.from_id,l.to_id,l.kind,
        (n.id IS NULL OR t.id IS NOT NULL OR COALESCE(json_extract(n.fields_json,'$.withdrawn'),0)=1
          OR EXISTS(SELECT 1 FROM knowledge_cascade_jobs j WHERE j.kind='purge' AND j.target_kind='node' AND j.target_id=n.id)) AS unavailable
       FROM knowledge_links l LEFT JOIN knowledge_nodes n ON n.id=CASE WHEN l.from_id=? THEN l.to_id ELSE l.from_id END
       LEFT JOIN knowledge_node_tombstones t ON t.id=n.id
       WHERE (l.to_id=? OR l.from_id=?) AND l.kind IN ('part_of','belongs_to_project')
       ORDER BY l.from_id,l.to_id,l.kind LIMIT 8193`,
    )
    .all(nodeId, nodeId, nodeId);
  if (rows.length > 8192)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Organizational context exceeds the bounded review budget",
    );
  // Source-ancestry privacy is checked by knowledge_links and cited reference
  // validation; this digest does not certify that a child supplies evidence.
  return knowledgeHash(rows);
}
