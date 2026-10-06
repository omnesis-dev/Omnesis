// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

const HIDDEN_ANCESTOR_CONDITION = `
  (a.kind='source' AND s.deleted=1)
  OR (a.kind='node' AND (n.id IS NULL OR t.id IS NOT NULL))
  OR EXISTS (SELECT 1 FROM knowledge_cascade_jobs j
             WHERE j.kind='purge' AND j.target_kind=a.kind AND j.target_id=a.id)`;

/** A source-wide removal tombstone precedes the bounded document deletion sweep. */
function hiddenAncestorCondition(db: Database.Database): string {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'").get()
  )
    return HIDDEN_ANCESTOR_CONDITION;
  return `${HIDDEN_ANCESTOR_CONDITION}
    OR (a.kind='source' AND EXISTS (
      SELECT 1 FROM documents source_document
      JOIN removed_sources removed ON removed.id=source_document.source_id
      WHERE source_document.id=a.id))`;
}

/** Canonical loop-to-brief privacy edges also apply before their physical cascade. */
function relatedLoopPrivacyEdges(
  db: Database.Database,
  ownerColumn: string,
  recursive = false,
): string {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='brief_related_loops'")
      .get()
  )
    return "";
  return `UNION SELECT 'node', brl.loop_id FROM brief_related_loops brl
    ${recursive ? "JOIN ancestors a ON a.kind='node'" : ""}
    WHERE brl.brief_id=${ownerColumn}
      AND (EXISTS (SELECT 1 FROM knowledge_nodes known_loop WHERE known_loop.id=brl.loop_id)
        OR EXISTS (SELECT 1 FROM knowledge_node_tombstones tomb_loop WHERE tomb_loop.id=brl.loop_id))`;
}

/** Intentional retirement retains its source ancestry without requiring a live owner mirror. */
function retiredLoopPrivacyEdges(
  db: Database.Database,
  ownerColumn: string,
  recursive = false,
): string {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_retired_loop_sources'",
      )
      .get()
  )
    return "";
  return `UNION SELECT 'source', retired.document_id FROM knowledge_retired_loop_sources retired
    ${recursive ? "JOIN ancestors a ON a.kind='node'" : ""}
    WHERE retired.loop_id=${ownerColumn}`;
}

/**
 * A correlated owner fence, applied before LIMIT so hidden rows cannot swallow
 * a serving page. The ID expression is a trusted SQL column supplied by stores.
 * Owners without a knowledge mirror retain their existing serving rules.
 */
export function knowledgeOwnerReadPredicate(db: Database.Database, idColumn: string): string {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return "1";
  return `NOT EXISTS (
    WITH RECURSIVE ancestors(kind,id) AS (
      SELECT 'node', ${idColumn}
        WHERE EXISTS (SELECT 1 FROM knowledge_nodes known WHERE known.id=${idColumn})
           OR EXISTS (SELECT 1 FROM knowledge_node_tombstones tomb WHERE tomb.id=${idColumn})
      ${relatedLoopPrivacyEdges(db, idColumn)}
      ${retiredLoopPrivacyEdges(db, idColumn)}
      UNION
      SELECT d.target_kind,d.target_id FROM knowledge_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
      UNION
      SELECT d.target_kind,d.target_id FROM knowledge_revision_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
      ${relatedLoopPrivacyEdges(db, "a.id", true)}
      ${retiredLoopPrivacyEdges(db, "a.id", true)}
    )
    SELECT 1 FROM ancestors a
      LEFT JOIN knowledge_nodes n ON a.kind='node' AND n.id=a.id
      LEFT JOIN knowledge_source_revisions s ON a.kind='source' AND s.document_id=a.id
      LEFT JOIN knowledge_node_tombstones t ON a.kind='node' AND t.id=a.id
      WHERE ${hiddenAncestorCondition(db)}
  )`;
}

export function isKnowledgeOwnerReadable(db: Database.Database, id: string): boolean {
  return !!db
    .prepare<[string], { readable: number }>(
      `SELECT ${knowledgeOwnerReadPredicate(db, "candidate.id")} AS readable
       FROM (SELECT ? AS id) candidate`,
    )
    .get(id)?.readable;
}

/**
 * Indexed ancestor traversal, scoped to one candidate node. Source tombstones are
 * authoritative before physical cleanup finishes. Missing intermediate nodes also
 * fence descendants while a privacy cascade progressively removes their parents.
 */
export function knowledgeNodeFence(
  db: Database.Database,
  id: string,
  selector?: { kind: "claim" | "field"; id: string },
): { hidden: boolean; stale: boolean } {
  const result = db
    .prepare<
      [string, string, string | null, string | null, string],
      { hidden: number; stale: number }
    >(
      `
    WITH RECURSIVE
    ancestors(kind,id) AS (
      SELECT 'node', ? UNION
      SELECT d.target_kind,d.target_id FROM knowledge_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
      UNION SELECT d.target_kind,d.target_id FROM knowledge_revision_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
      ${relatedLoopPrivacyEdges(db, "a.id", true)}
      ${retiredLoopPrivacyEdges(db, "a.id", true)}
    ),
    current_ancestors(kind,id,selector_kind,selector_id,observed_version) AS (
      SELECT 'node', ?, ?, ?, NULL UNION
      SELECT d.target_kind,d.target_id,
        CASE WHEN instr(d.ref,'#claim:')>0 THEN 'claim' WHEN instr(d.ref,'#field:')>0 THEN 'field' ELSE NULL END,
        CASE WHEN instr(d.ref,'#claim:')>0 THEN substr(d.ref,instr(d.ref,'#claim:')+7) WHEN instr(d.ref,'#field:')>0 THEN substr(d.ref,instr(d.ref,'#field:')+7) ELSE NULL END,
        d.input_version_json
      FROM knowledge_dependencies d JOIN current_ancestors a ON a.kind='node' AND d.node_id=a.id
      WHERE d.relation!='context' AND (a.selector_kind IS NULL OR (a.selector_kind='claim' AND d.claim_id=a.selector_id))
    ) SELECT
      EXISTS(SELECT 1 FROM ancestors a LEFT JOIN knowledge_nodes n ON a.kind='node' AND n.id=a.id
        LEFT JOIN knowledge_source_revisions s ON a.kind='source' AND s.document_id=a.id
        LEFT JOIN knowledge_node_tombstones t ON a.kind='node' AND t.id=a.id
        WHERE ${hiddenAncestorCondition(db)}) AS hidden,
      EXISTS(SELECT 1 FROM current_ancestors a
        LEFT JOIN documents doc ON a.kind='source' AND doc.id=a.id
        LEFT JOIN knowledge_nodes n ON a.kind='node' AND n.id=a.id
        LEFT JOIN knowledge_claims c ON a.kind='node' AND a.selector_kind='claim' AND c.node_id=a.id AND c.id=a.selector_id
        WHERE (a.kind='source' AND (doc.id IS NULL OR doc.content_hash IS NOT json_extract(a.observed_version,'$')))
          OR (a.kind='node' AND a.selector_kind='claim' AND (c.id IS NULL OR c.verification='stale' OR (a.observed_version IS NOT NULL AND c.meaning_revision IS NOT json_extract(a.observed_version,'$'))))
          OR (a.kind='node' AND a.selector_kind IS NOT 'claim' AND ((a.observed_version IS NOT NULL AND n.meaning_revision IS NOT json_extract(a.observed_version,'$')) OR (a.selector_kind IS NULL AND n.validity='stale' AND n.id!=?)))
          OR (a.kind='node' AND EXISTS(SELECT 1 FROM knowledge_owner_changes o WHERE o.owner_id=a.id AND o.operation='update')))
 AS stale
  `,
    )
    .get(id, id, selector?.kind ?? null, selector?.id ?? null, id)!;
  return { hidden: !!result.hidden, stale: !!result.stale };
}
export function isKnowledgeNodeReadable(db: Database.Database, id: string): boolean {
  return !knowledgeNodeFence(db, id).hidden;
}
