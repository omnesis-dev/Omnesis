// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import type Database from "better-sqlite3";

/**
 * A record is hidden only when it is itself gone or being erased. Losing an
 * ancestor, a deleted source or a deleted owner it cited, makes a record stale
 * for review, never hidden.
 */
const HIDDEN_RECORD_CONDITION = `
  n.id IS NULL OR t.id IS NOT NULL
  OR EXISTS (SELECT 1 FROM knowledge_cascade_jobs j
             WHERE j.kind='purge' AND j.target_kind='node' AND j.target_id=a.id)`;

/**
 * An observation attached to a deleted loop is erased with it, so it is hidden
 * from the moment the loop is, before its own physical cascade.
 */
function relatedLoopPrivacyEdges(db: Database.Database, ownerColumn: string): string {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_related_loops'",
      )
      .get()
  )
    return "";
  return `UNION SELECT brl.loop_id FROM observation_related_loops brl
    WHERE brl.observation_id=${ownerColumn}
      AND (EXISTS (SELECT 1 FROM knowledge_nodes known_loop WHERE known_loop.id=brl.loop_id)
        OR EXISTS (SELECT 1 FROM knowledge_node_tombstones tomb_loop WHERE tomb_loop.id=brl.loop_id))`;
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
    WITH records(id) AS (
      SELECT ${idColumn}
        WHERE EXISTS (SELECT 1 FROM knowledge_nodes known WHERE known.id=${idColumn})
           OR EXISTS (SELECT 1 FROM knowledge_node_tombstones tomb WHERE tomb.id=${idColumn})
      ${relatedLoopPrivacyEdges(db, idColumn)}
    )
    SELECT 1 FROM records a
      LEFT JOIN knowledge_nodes n ON n.id=a.id
      LEFT JOIN knowledge_node_tombstones t ON t.id=a.id
      WHERE ${HIDDEN_RECORD_CONDITION}
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
 * The dependencies a node currently reads through, each with the version it
 * observed. A claim selector narrows a node to that claim's dependencies, and a
 * wiki or root claim also reads its parent claim. Binds: node id, selector kind,
 * selector id.
 */
const CURRENT_ANCESTORS_CTE = `current_ancestors(kind,id,selector_kind,selector_id,observed_version,context_parent) AS (
      SELECT 'node', ?, ?, ?, NULL,0 UNION
      SELECT d.target_kind,d.target_id,
        CASE WHEN instr(d.ref,'#claim:')>0 THEN 'claim' WHEN instr(d.ref,'#field:')>0 THEN 'field' ELSE NULL END,
        CASE WHEN instr(d.ref,'#claim:')>0 THEN substr(d.ref,instr(d.ref,'#claim:')+7) WHEN instr(d.ref,'#field:')>0 THEN substr(d.ref,instr(d.ref,'#field:')+7) ELSE NULL END,
        d.input_version_json,0
      FROM knowledge_dependencies d JOIN current_ancestors a ON a.kind='node' AND d.node_id=a.id
      WHERE d.relation!='context' AND (a.selector_kind IS NULL OR (a.selector_kind='claim' AND d.claim_id=a.selector_id))
      UNION
      SELECT 'node',a.id,'claim',c.parent_id,NULL,1
      FROM current_ancestors a JOIN knowledge_claims c ON c.node_id=a.id AND c.id=a.selector_id
      JOIN knowledge_nodes context_node ON context_node.id=a.id
      WHERE a.kind='node' AND a.selector_kind='claim' AND c.parent_id IS NOT NULL
        AND context_node.kind IN ('wiki','root')
    )`;

/** Joins that let {@link STALE_ANCESTOR_CONDITION} read a current ancestor `a`. */
const STALE_ANCESTOR_JOINS = `
        LEFT JOIN documents doc ON a.kind='source' AND doc.id=a.id
        LEFT JOIN knowledge_source_revisions tombstone ON a.kind='source' AND tombstone.document_id=a.id AND tombstone.deleted=1
        LEFT JOIN knowledge_nodes n ON a.kind='node' AND n.id=a.id
        LEFT JOIN knowledge_claims c ON a.kind='node' AND a.selector_kind='claim' AND c.node_id=a.id AND c.id=a.selector_id`;

const OWNER_UPDATE_PENDING = `EXISTS(SELECT 1 FROM knowledge_owner_changes o WHERE o.owner_id=a.id AND o.operation IN ('update','review'))`;

/**
 * A current ancestor that changed since the node observed it: a source document
 * whose revision moved or which is gone, a claim or node that changed meaning, is
 * itself stale or was deleted, or an owner with an update not yet mirrored. Binds: the
 * candidate node's id, which is never stale on account of its own validity.
 */
const STALE_ANCESTOR_CONDITION = `(a.kind='source' AND (doc.id IS NULL OR tombstone.document_id IS NOT NULL OR ${knowledgeSourceRevisionSql("doc")} IS NOT json_extract(a.observed_version,'$')))
          OR (a.kind='node' AND a.selector_kind='claim' AND (c.id IS NULL OR c.verification='stale' OR (a.context_parent=1 AND (c.verification!='verified' OR c.epistemic_status!='asserted' OR c.verifier IS NOT '${CONTEXTUAL_VERIFIER}')) OR (a.observed_version IS NOT NULL AND c.meaning_revision IS NOT json_extract(a.observed_version,'$'))))
          OR (a.kind='node' AND a.selector_kind IS NOT 'claim' AND ((a.observed_version IS NOT NULL AND n.meaning_revision IS NOT json_extract(a.observed_version,'$')) OR (a.selector_kind IS NULL AND n.validity='stale' AND n.id!=?)))
          OR (a.kind='node' AND n.id IS NULL)
          OR (a.kind='node' AND ${OWNER_UPDATE_PENDING})`;

/**
 * Whether one node is hidden (itself deleted or being erased) and whether it is
 * stale: a current ancestor, scoped to the selected claim or field, changed or
 * was deleted since the node observed it.
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
    seed(id) AS (SELECT ?),
    records(id) AS (
      SELECT id FROM seed
      ${relatedLoopPrivacyEdges(db, "(SELECT id FROM seed)")}
    ),
    ${CURRENT_ANCESTORS_CTE} SELECT
      EXISTS(SELECT 1 FROM records a LEFT JOIN knowledge_nodes n ON n.id=a.id
        LEFT JOIN knowledge_node_tombstones t ON t.id=a.id
        WHERE ${HIDDEN_RECORD_CONDITION}) AS hidden,
      EXISTS(SELECT 1 FROM current_ancestors a ${STALE_ANCESTOR_JOINS}
        WHERE ${STALE_ANCESTOR_CONDITION})
 AS stale
  `,
    )
    .get(id, id, selector?.kind ?? null, selector?.id ?? null, id)!;
  return { hidden: !!result.hidden, stale: !!result.stale };
}

export type KnowledgeStaleAncestorCause =
  "source_changed" | "source_deleted" | "node_changed" | "owner_changed";

/**
 * The current ancestors that make a node stale, by the same rule as
 * {@link knowledgeNodeFence}: sources first, then knowledge nodes, each once,
 * with the number found before the limit.
 */
export function knowledgeNodeStaleAncestors(
  db: Database.Database,
  id: string,
  limit: number,
): {
  total: number;
  items: Array<{ kind: "source" | "node"; id: string; cause: KnowledgeStaleAncestorCause }>;
} {
  const rows = db
    .prepare<
      [string, null, null, string, number],
      { kind: "source" | "node"; id: string; cause: KnowledgeStaleAncestorCause; total: number }
    >(
      `
    WITH RECURSIVE ${CURRENT_ANCESTORS_CTE},
    stale(kind,id,cause) AS (
      SELECT a.kind,a.id,
        CASE
          WHEN a.kind='source' AND (doc.id IS NULL OR tombstone.document_id IS NOT NULL) THEN 'source_deleted'
          WHEN a.kind='source' THEN 'source_changed'
          WHEN ${OWNER_UPDATE_PENDING} THEN 'owner_changed'
          ELSE 'node_changed'
        END
      FROM current_ancestors a ${STALE_ANCESTOR_JOINS}
      WHERE ${STALE_ANCESTOR_CONDITION}
    )
    SELECT kind,id,MIN(cause) AS cause,COUNT(*) OVER () AS total FROM stale
    GROUP BY kind,id ORDER BY kind='node',id LIMIT ?`,
    )
    .all(id, null, null, id, limit);
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({ kind: row.kind, id: row.id, cause: row.cause })),
  };
}
export function isKnowledgeNodeReadable(db: Database.Database, id: string): boolean {
  return !knowledgeNodeFence(db, id).hidden;
}
