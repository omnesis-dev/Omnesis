// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ScopePolicy, ScopeRef } from "@omnesis/types";

export interface ScopeSql {
  sql: string;
  params: string[];
}

/**
 * SQL identifiers come from code, never a request or a saved policy. The
 * outer alias is mandatory: an unqualified name can bind to the inner facts
 * table and turn a document correlation into a tautology.
 */
function column(value: string): string {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid scope SQL column.");
  }
  if (
    ["sf", "sc", "ss", "sp", "sb", "cm", "sr", "nr", "nw", "rp", "hd", "ht"].includes(
      value.split(".")[0]!.toLowerCase(),
    )
  ) {
    throw new Error("Invalid scope SQL column.");
  }
  return value;
}

function effectiveDocument(documentColumn: string, kind: ScopeRef["kind"]): string {
  const outer = column(documentColumn);
  const parent = `COALESCE((SELECT CASE WHEN EXISTS (SELECT 1 FROM document_scope_subjects sp WHERE sp.document_id = ss.subject_document_id) THEN '' ELSE ss.subject_document_id END FROM document_scope_subjects ss WHERE ss.document_id = ${outer}), ${outer})`;
  return kind === "participant"
    ? `COALESCE((SELECT cm.subject_document_id FROM document_scope_conversations cm WHERE cm.document_id = ${parent}), ${parent})`
    : parent;
}

function ruleMatch(refs: readonly ScopeRef[], documentColumn: string): ScopeSql {
  const byKind = new Map<ScopeRef["kind"], Set<string>>();
  for (const ref of refs) {
    const values = byKind.get(ref.kind) ?? new Set<string>();
    if (ref.kind === "participant") {
      for (const identifier of ref.identifiers)
        values.add(`${identifier.type}:${identifier.value}`);
    } else values.add(ref.id);
    byKind.set(ref.kind, values);
  }
  const expressions: string[] = [];
  const params: string[] = [];
  for (const [kind, values] of byKind) {
    if (!values.size) continue;
    expressions.push(
      `EXISTS (SELECT 1 FROM document_scope_facts sf WHERE sf.document_id = ${effectiveDocument(documentColumn, kind)} AND sf.kind = ? AND sf.entity_id IN (SELECT value FROM json_each(?)))`,
    );
    params.push(kind, JSON.stringify([...values]));
  }
  return { sql: expressions.join(" OR ") || "0", params };
}

/**
 * Compile an ordered policy to an allow predicate. Completeness is checked
 * before any rule: even a positive match cannot override an unresolved fact.
 * Folder facts contain the transitive ancestors, not just the immediate parent.
 * Reserved actions fail closed until their enforcement is implemented.
 */
export function scopePolicyKnownSql(policy: ScopePolicy, documentColumn: string): ScopeSql {
  column(documentColumn);
  if (policy.maxAge !== undefined) return { sql: "0", params: [] };
  const kinds = [...new Set(policy.rules.flatMap((rule) => rule.match.map((ref) => ref.kind)))];
  return {
    sql:
      kinds
        .map(
          (kind) =>
            `(EXISTS (SELECT 1 FROM document_scope_completeness sc WHERE sc.document_id = ${effectiveDocument(documentColumn, kind)} AND sc.kind = ? AND sc.complete = 1
              AND NOT EXISTS (SELECT 1 FROM source_scope_refresh_requirements nr WHERE nr.source_id=? AND nr.kind=sc.kind
                AND NOT EXISTS (SELECT 1 FROM scope_native_refresh_witnesses nw WHERE nw.document_id=sc.document_id AND nw.kind=sc.kind AND nw.epoch=nr.epoch))${kind === "participant" ? " AND NOT EXISTS (SELECT 1 FROM scope_native_reprojection_sources rp WHERE rp.source_id=? AND rp.pending>0)" : ""})${kind === "folder" ? ` AND NOT EXISTS (SELECT 1 FROM scope_hierarchy_dependencies hd JOIN scope_hierarchy_dirty ht ON ht.source_id=hd.source_id AND ht.kind=hd.kind AND ht.entity_id=hd.entity_id WHERE hd.document_id=${effectiveDocument(documentColumn, kind)} AND hd.kind='folder')` : ""})`,
        )
        .join(" AND ") || "1",
    params: kinds.flatMap((kind) =>
      kind === "participant" ? [kind, policy.sourceId, policy.sourceId] : [kind, policy.sourceId],
    ),
  };
}

export function scopePolicySql(policy: ScopePolicy, documentColumn: string): ScopeSql {
  column(documentColumn);
  const known = scopePolicyKnownSql(policy, documentColumn);
  const params = [...known.params];
  const rules = policy.rules.map((rule) => {
    const match = ruleMatch(rule.match, documentColumn);
    params.push(...match.params);
    return `WHEN (${match.sql}) THEN ${rule.action === "share" ? "1" : "0"}`;
  });
  return {
    sql: `(${known.sql} AND CASE ${rules.join(" ")} ELSE ${policy.otherwise === "share" ? "1" : "0"} END = 1)`,
    params,
  };
}

/** Explicit native metadata refreshes fence only the kinds a policy uses. */
export function scopeSourceReadySql(policy: ScopePolicy): ScopeSql {
  const kinds = [...new Set(policy.rules.flatMap((rule) => rule.match.map((ref) => ref.kind)))];
  if (kinds.length === 0) return { sql: "1", params: [] };
  return {
    sql: `(EXISTS (SELECT 1 FROM scope_fact_backfill sb WHERE sb.source_id = ? AND sb.ready = 1)
      AND NOT EXISTS (SELECT 1 FROM source_scope_refreshes sr WHERE sr.source_id = ? AND sr.active = 1 AND sr.kind IN (SELECT value FROM json_each(?))))`,
    params: [policy.sourceId, policy.sourceId, JSON.stringify(kinds)],
  };
}

/** Source selection remains a separate outer authorization check. */
export function sourceScopeInclusionSql(
  policies: readonly ScopePolicy[],
  documentColumn: string,
  sourceColumn: string,
): ScopeSql {
  const doc = column(documentColumn);
  const source = column(sourceColumn);
  if (policies.length === 0) return { sql: "1", params: [] };
  const expressions: string[] = [];
  const params: string[] = [];
  for (const policy of policies) {
    const decision = scopePolicySql(policy, doc);
    const ready = scopeSourceReadySql(policy);
    expressions.push(`(${source} <> ? OR (${ready.sql} AND ${decision.sql}))`);
    params.push(policy.sourceId, ...ready.params, ...decision.params);
  }
  return { sql: expressions.join(" AND "), params };
}
