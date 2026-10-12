// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { navigationTargets } from "./navigation.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import type Database from "better-sqlite3";

// Investigation safety bounds, independent of the number of retained revisions.
const MAX_SCANNED_REVISIONS = 100;
const MAX_MEANINGFUL_REVISIONS = 5;
const MAX_HISTORY_BYTES = 65536;
const MAX_TARGETS = 128;

export interface RecoverableNavigation {
  candidates: Array<{ id: string; title: string; revision: number }>;
  /** Bounded investigation hints, never a complete historical inventory. */
  incomplete: boolean;
}

export const ROOT_NAVIGATION_RECOVERY_TASK =
  "This root has no current wiki navigation. recoverableNavigation names currently readable pages linked by bounded historical orientation, not historical facts or current proof. Investigate a relevant bounded selection with knowledge_fetch; select useful current context and navigation within the root budget, or explain why none fits. Do not automatically restore old links, infer facts from titles, or link every candidate. Current claims and references still require their normal evidence reads.";

/** Historical identities only: no old prose, claim refs, proof or read receipts. */
export function recoverRootNavigation(
  db: Database.Database,
  rootId: string,
  limit: number,
): RecoverableNavigation | undefined {
  return db.transaction(() => {
    const root = db
      .prepare<[string], { plain_text: string | null }>(
        `SELECT CASE WHEN length(CAST(plain_text AS BLOB))<=${MAX_HISTORY_BYTES}
          THEN plain_text END AS plain_text FROM knowledge_nodes
         WHERE id=? AND kind='root' AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1`,
      )
      .get(rootId);
    if (!root || root.plain_text === null || knowledgeNodeFence(db, rootId).hidden)
      return undefined;
    const target = db.prepare<[string], { id: string; title: string; revision: number }>(
      `SELECT id,substr(title,1,200) AS title,revision FROM knowledge_nodes
       WHERE id=? AND kind='wiki' AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1`,
    );
    // A healthy root with wiki navigation needs no automatic history scan.
    const currentTarget = (link: { id: string; kind: string }) => {
      if (link.kind !== "wiki" && link.kind !== "node") return undefined;
      const row = target.get(link.id);
      return row && !knowledgeNodeFence(db, row.id).hidden ? row : undefined;
    };
    const currentLinks = [...navigationTargets(root.plain_text).values()];
    if (currentLinks.length > MAX_TARGETS || currentLinks.some(currentTarget)) return undefined;
    const revisions = db
      .prepare<[string], { revision: number; meaningful: number; bytes: number }>(
        `SELECT r.revision,
          CASE WHEN p.revision IS NULL
            OR length(CAST(r.markdown AS BLOB))>${MAX_HISTORY_BYTES}
            OR length(CAST(p.markdown AS BLOB))>${MAX_HISTORY_BYTES}
            OR length(CAST(r.title AS BLOB))>${MAX_HISTORY_BYTES}
            OR length(CAST(p.title AS BLOB))>${MAX_HISTORY_BYTES}
          THEN 1 ELSE (r.markdown IS NOT p.markdown OR r.title IS NOT p.title
           OR r.revision=(SELECT MAX(revision) FROM knowledge_revisions WHERE node_id=r.node_id)) END AS meaningful,
          max(length(CAST(r.plain_text AS BLOB)),length(CAST(r.markdown AS BLOB))) AS bytes
         FROM knowledge_revisions r LEFT JOIN knowledge_revisions p
          ON p.node_id=r.node_id AND p.revision=r.previous_revision
         WHERE r.node_id=? ORDER BY r.revision DESC LIMIT ${MAX_SCANNED_REVISIONS + 1}`,
      )
      .all(rootId);
    const meaningful = revisions.slice(0, MAX_SCANNED_REVISIONS).filter((row) => row.meaningful);
    let incomplete =
      revisions.length > MAX_SCANNED_REVISIONS || meaningful.length > MAX_MEANINGFUL_REVISIONS;
    let bytes = 0;
    const seen = new Set<string>();
    const candidateIds = new Set<string>();
    const candidates: RecoverableNavigation["candidates"] = [];
    for (const row of meaningful.slice(0, MAX_MEANINGFUL_REVISIONS)) {
      if (bytes + row.bytes > MAX_HISTORY_BYTES) {
        incomplete = true;
        continue;
      }
      bytes += row.bytes;
      const snapshot = db
        .prepare<
          [string, number],
          { plain_text: string }
        >("SELECT plain_text FROM knowledge_revisions WHERE node_id=? AND revision=?")
        .get(rootId, row.revision);
      if (!snapshot) continue;
      for (const link of navigationTargets(snapshot.plain_text).values()) {
        const key = JSON.stringify([link.kind, link.id]);
        if (seen.has(key)) continue;
        if (seen.size >= MAX_TARGETS) {
          incomplete = true;
          break;
        }
        seen.add(key);
        const current = currentTarget(link);
        if (!current || candidateIds.has(current.id)) continue;
        if (candidates.length >= Math.max(1, Math.min(MAX_TARGETS, limit))) {
          incomplete = true;
          continue;
        }
        candidates.push(current);
        candidateIds.add(current.id);
      }
    }
    return candidates.length || incomplete ? { candidates, incomplete } : undefined;
  })();
}
