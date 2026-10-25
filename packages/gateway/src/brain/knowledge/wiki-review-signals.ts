// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { KnowledgeNode } from "./types.js";

/** Numeric editorial context only; historical prose is never added to the decision request. */
export function wikiEditorialSignals(db: Database.Database, node: KnowledgeNode) {
  if (node.kind !== "wiki" || node.metadata.lastReviewedAt == null) return null;
  const baseline = db
    .prepare<
      [string, number],
      {
        revision: number;
        claims: number;
        characters: number;
        changedClaims: number;
        titleChanged: number;
      }
    >(
      `SELECT revision,json_array_length(claims_json) AS claims,length(plain_text) AS characters,
    COALESCE(json_array_length(diff_json,'$.changedClaimIds'),0) AS changedClaims,
    COALESCE(json_extract(diff_json,'$.titleChanged'),0) AS titleChanged
    FROM knowledge_revisions WHERE node_id=? AND created_at<=?
    ORDER BY revision DESC LIMIT 1`,
    )
    .get(node.id, node.metadata.lastReviewedAt);
  if (!baseline) return null;
  const current = db
    .prepare<[string], { claims: number; characters: number }>(
      `
    SELECT (SELECT COUNT(*) FROM knowledge_claims WHERE node_id=n.id) AS claims,
    length(n.plain_text) AS characters FROM knowledge_nodes n WHERE n.id=?`,
    )
    .get(node.id);
  if (!current) return null;
  return {
    baselineRevision: baseline.revision,
    reviewedClaims: baseline.claims,
    reviewedCharacters: baseline.characters,
    currentClaims: current.claims,
    currentCharacters: current.characters,
    reviewedRevisionChangedClaims: baseline.changedClaims,
    reviewedRevisionChangedTitle: !!baseline.titleChanged,
    substantialGrowth:
      (baseline.claims > 0 && current.claims >= baseline.claims * 2) ||
      (baseline.characters > 0 && current.characters >= baseline.characters * 2),
  };
}

/** Same relative growth predicate for bounded nomination before the gate is called. */
export const WIKI_EDITORIAL_GROWTH_SQL = `(n.kind='wiki' AND json_extract(n.metadata_json,'$.lastReviewedAt') IS NOT NULL AND EXISTS(
  SELECT 1 FROM knowledge_revisions r WHERE r.node_id=n.id
  AND r.revision=(SELECT revision FROM knowledge_revisions WHERE node_id=n.id
    AND created_at<=json_extract(n.metadata_json,'$.lastReviewedAt') ORDER BY revision DESC LIMIT 1)
  AND ((json_array_length(r.claims_json)>0 AND
    (SELECT COUNT(*) FROM knowledge_claims c WHERE c.node_id=n.id)>=2*json_array_length(r.claims_json))
    OR (length(r.plain_text)>0 AND length(n.plain_text)>=2*length(r.plain_text)))))`;
