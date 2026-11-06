// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeEmail } from "@omnesis/core";
import { escapeLike } from "../data/repositories/person-match.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { sourceScopeReadiness } from "./scope-editor-readiness.js";
import { scopePersonIdentifiers, scopeIdentifierProposals } from "./scope-editor-people.js";
import {
  decodeScopeEditorCursor,
  encodeScopeEditorCursor,
  scopeEditorCursorScope,
} from "./scope-editor-cursor.js";
import { parseScopePolicyV1 } from "./scope-policy.js";
import { sourceScopeInclusionSql, scopePolicyKnownSql, scopeSourceReadySql } from "./scope-sql.js";
import type {
  ScopePolicy,
  ScopeRef,
  SourceScopeOptions,
  SourceScopePreview,
  SourceScopes,
} from "@omnesis/types";
import type { Db } from "../data/types.js";
import type { ReadPort } from "../scheduler/read-port.js";

export type ScopeEditorResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: "source-not-found" | "unsupported-kind" | "invalid-policy" | "invalid-cursor";
    };
export interface SourceScopeOptionsRequest {
  sourceId: string;
  kind: ScopeRef["kind"];
  q?: string;
  parentId?: string;
  cursor?: string;
}

function sourceContext(
  db: Db,
  sourceId: string,
): { sourceType: string; scopes: SourceScopes } | null {
  const row = db
    .prepare<[string], { type: string }>("SELECT type FROM sources WHERE id=?")
    .get(sourceId);
  const scopes = row && getSourceScopes(db, row.type);
  return row && scopes ? { sourceType: row.type, scopes } : null;
}
function itemPolicy(sourceId: string, ref: ScopeRef): ScopePolicy {
  return {
    sourceId,
    audience: { accessLevel: "new", capability: "direct" },
    rules: [{ match: [ref], action: "share" }],
    otherwise: "hide",
  };
}
/** Share one source scan across a bounded group, using the enforcement predicate verbatim. */
function countItems(db: Db, sourceId: string, refs: readonly ScopeRef[]): number[] {
  const counts: number[] = [];
  for (let offset = 0; offset < refs.length; offset += 16) {
    const clauses = refs
      .slice(offset, offset + 16)
      .map((ref) => sourceScopeInclusionSql([itemPolicy(sourceId, ref)], "d.id", "d.source_id"));
    const row = db
      .prepare<unknown[], Record<string, number>>(
        `SELECT ${clauses
          .map(
            (clause, index) =>
              `coalesce(sum(CASE WHEN (${clause.sql}) THEN 1 ELSE 0 END),0) AS n${index}`,
          )
          .join(",")}
        FROM documents d WHERE d.source_id=?`,
      )
      .get(...clauses.flatMap((clause) => clause.params), sourceId)!;
    counts.push(...clauses.map((_, index) => row[`n${index}`]!));
  }
  return counts;
}

/** Owner-only typeahead and tree reads; expensive counts run on the IO worker. */
export function readSourceScopeOptions(
  db: Db,
  request: SourceScopeOptionsRequest,
): ScopeEditorResult<SourceScopeOptions> {
  return db.transaction((): ScopeEditorResult<SourceScopeOptions> => {
    const context = sourceContext(db, request.sourceId);
    if (!context) return { ok: false, error: "source-not-found" } as const;
    if (!context.scopes.items.some((item) => item.kind === request.kind))
      return { ok: false, error: "unsupported-kind" } as const;
    const query = (request.q ?? "").trim();
    const scope = scopeEditorCursorScope(request.sourceId, request.kind, query, request.parentId);
    let after;
    try {
      after = decodeScopeEditorCursor(request.cursor, scope);
    } catch {
      return { ok: false, error: "invalid-cursor" } as const;
    }
    const readiness = sourceScopeReadiness(db, request.sourceId);
    const value: SourceScopeOptions = {
      sourceId: request.sourceId,
      ...context,
      readiness,
      items: [],
    };
    if (!readiness.find((state) => state.kind === request.kind)?.ready) return { ok: true, value };
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    const parameters: unknown[] = [];
    let rows: Array<{ id: string; label: string; parent_id?: string | null; children?: number }>;
    if (request.kind === "participant") {
      const cursor = after
        ? "AND (p.canonical_name COLLATE NOCASE > ? OR (p.canonical_name COLLATE NOCASE = ? AND p.id > ?))"
        : "";
      parameters.push(pattern, `%${escapeLike(normalizeEmail(query))}%`);
      if (after) parameters.push(after.label, after.label, after.id);
      rows = db
        .prepare<unknown[], { id: string; label: string }>(
          `SELECT p.id,p.canonical_name AS label FROM people p
        WHERE p.merged_into IS NULL AND (lower(p.canonical_name) LIKE ? ESCAPE '\\' OR EXISTS
          (SELECT 1 FROM person_aliases a WHERE a.person_id=p.id AND lower(a.alias) LIKE ? ESCAPE '\\'))
        ${cursor} ORDER BY p.canonical_name COLLATE NOCASE,p.id LIMIT 51`,
        )
        .all(...parameters);
    } else {
      const tree = request.kind === "folder" && query === "";
      let parent = "";
      parameters.push(request.sourceId, request.kind, pattern);
      if (tree) {
        if (request.parentId) {
          parent = "AND e.parent_id=?";
          parameters.push(request.parentId);
        } else {
          parent =
            "AND (e.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM scope_entities p WHERE p.source_id=e.source_id AND p.kind=e.kind AND p.entity_id=e.parent_id))";
        }
      }
      const cursor = after
        ? "AND (e.label COLLATE NOCASE > ? OR (e.label COLLATE NOCASE = ? AND e.entity_id > ?))"
        : "";
      if (after) parameters.push(after.label, after.label, after.id);
      rows = db
        .prepare<
          unknown[],
          { id: string; label: string; parent_id: string | null; children: number }
        >(
          `SELECT e.entity_id AS id,e.label,e.parent_id,
        EXISTS(SELECT 1 FROM scope_entities child WHERE child.source_id=e.source_id AND child.kind=e.kind AND child.parent_id=e.entity_id) AS children
        FROM scope_entities e WHERE e.source_id=? AND e.kind=? AND lower(e.label) LIKE ? ESCAPE '\\'
        ${parent} ${cursor} ORDER BY e.label COLLATE NOCASE,e.entity_id LIMIT 51`,
        )
        .all(...parameters);
    }
    const page = rows.slice(0, 50);
    for (const row of page) {
      let ref: ScopeRef;
      if (request.kind === "participant") {
        const identifiers = scopePersonIdentifiers(db, row.id, context.scopes);
        if (!identifiers?.length) continue;
        ref = { kind: "participant", label: row.label, identifiers };
      } else ref = { kind: request.kind, id: row.id };
      value.items.push({
        ref,
        label: row.label,
        count: 0,
        ...(request.kind === "participant" ? { personId: row.id } : {}),
        ...(row.parent_id ? { parentId: row.parent_id } : {}),
        ...(request.kind === "folder" ? { hasChildren: !!row.children } : {}),
      });
    }
    const counts = countItems(
      db,
      request.sourceId,
      value.items.map((item) => item.ref),
    );
    value.items.forEach((item, index) => {
      item.count = counts[index]!;
    });
    const last = page.at(-1);
    if (rows.length > 50 && last)
      value.nextCursor = encodeScopeEditorCursor(scope, last.label, last.id);
    return { ok: true, value };
  })();
}

/** Preview and enforcement compile the same predicates against one corpus snapshot. */
export function readSourceScopePreview(
  db: Db,
  sourceId: string,
  input: ScopePolicy,
): ScopeEditorResult<SourceScopePreview> {
  return db.transaction((): ScopeEditorResult<SourceScopePreview> => {
    const context = sourceContext(db, sourceId);
    if (!context) return { ok: false, error: "source-not-found" } as const;
    let policy: ScopePolicy;
    try {
      policy = parseScopePolicyV1(input, context.scopes);
      if (policy.sourceId !== sourceId) throw new Error("Wrong source");
    } catch {
      return { ok: false, error: "invalid-policy" } as const;
    }
    const visible = sourceScopeInclusionSql([policy], "d.id", "d.source_id");
    const completeness = scopePolicyKnownSql(policy, "d.id");
    const ready = scopeSourceReadySql(policy);
    const known = {
      sql: `(${completeness.sql}) AND (${ready.sql})`,
      params: [...completeness.params, ...ready.params],
    };
    const totals = db
      .prepare<unknown[], { total: number; visible: number; unknown: number }>(
        `SELECT count(*) AS total,
      coalesce(sum(CASE WHEN (${visible.sql}) THEN 1 ELSE 0 END),0) AS visible,
      coalesce(sum(CASE WHEN (${known.sql}) THEN 0 ELSE 1 END),0) AS unknown FROM documents d WHERE d.source_id=?`,
      )
      .get(...visible.params, ...known.params, sourceId)!;
    const items: SourceScopePreview["items"] = (policy.rules[0]?.match ?? []).map((ref) => {
      const entity =
        ref.kind === "participant"
          ? null
          : db
              .prepare<[string, string, string], { label: string; parent_id: string | null }>(
                "SELECT label,parent_id FROM scope_entities WHERE source_id=? AND kind=? AND entity_id=?",
              )
              .get(sourceId, ref.kind, ref.id);
      return {
        ref,
        label: ref.kind === "participant" ? ref.label : (entity?.label ?? ref.id),
        count: 0,
        ...(entity?.parent_id ? { parentId: entity.parent_id } : {}),
        ...(ref.kind !== "participant" && !entity ? { missing: true } : {}),
      };
    });
    const counts = countItems(
      db,
      sourceId,
      items.map((item) => item.ref),
    );
    items.forEach((item, index) => {
      item.count = counts[index]!;
    });
    const samples: SourceScopePreview["samples"] = [];
    const buckets = [
      { condition: visible, visible: true, unknown: false },
      {
        condition: {
          sql: `(${known.sql}) AND NOT (${visible.sql})`,
          params: [...known.params, ...visible.params],
        },
        visible: false,
        unknown: false,
      },
      {
        condition: { sql: `NOT (${known.sql})`, params: known.params },
        visible: false,
        unknown: true,
      },
    ];
    for (const bucket of buckets) {
      const rows = db
        .prepare<unknown[], { documentId: string; title: string }>(
          `SELECT d.id AS documentId,d.title FROM documents d WHERE d.source_id=? AND (${bucket.condition.sql}) LIMIT 4`,
        )
        .all(sourceId, ...bucket.condition.params);
      samples.push(
        ...rows.map((row) => ({ ...row, visible: bucket.visible, unknown: bucket.unknown })),
      );
    }
    return {
      ok: true,
      value: {
        sourceId,
        ...totals,
        hidden: totals.total - totals.visible,
        items,
        samples,
        identifierProposals: scopeIdentifierProposals(db, policy, context.scopes),
        readiness: sourceScopeReadiness(db, sourceId),
      },
    };
  })();
}

export const SOURCE_SCOPE_EDITOR_READS = {
  sourceScopeOptions: readSourceScopeOptions,
  sourceScopePreview: readSourceScopePreview,
};
export type SourceScopeEditorReads = ReadPort<typeof SOURCE_SCOPE_EDITOR_READS>;
