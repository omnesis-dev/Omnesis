// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scopeIdentifierSchema } from "./scope-policy.js";
import type {
  ScopeIdentifier,
  ScopePolicy,
  SourceScopes,
  SourceScopePreview,
} from "@omnesis/types";
import type { Db } from "../data/types.js";

/** A picker snapshots typed aliases; it never installs a mutable person reference. */
export function scopePersonIdentifiers(
  db: Db,
  personId: string,
  scopes: SourceScopes,
): ScopeIdentifier[] | null {
  const declaration = scopes.items.find((item) => item.kind === "participant");
  if (!declaration || declaration.kind !== "participant") return [];
  const rows = db
    .prepare<[string, string], { alias_type: string; alias: string }>(
      `WITH RECURSIVE members(id) AS (
    SELECT id FROM people WHERE id=? UNION SELECT p.id FROM people p JOIN members m ON p.merged_into=m.id
  ) SELECT DISTINCT a.alias_type,a.alias FROM person_aliases a JOIN members m ON m.id=a.person_id
    WHERE a.alias_type IN (SELECT value FROM json_each(?)) ORDER BY a.alias_type,a.alias LIMIT 257`,
    )
    .all(personId, JSON.stringify(declaration.identifiers.filter((type) => type !== "domain")));
  // Do not silently offer a partial identity for an unusually large alias set.
  if (rows.length > 256) return null;
  const result = new Map<string, ScopeIdentifier>();
  for (const row of rows) {
    const parsed = scopeIdentifierSchema.safeParse({ type: row.alias_type, value: row.alias });
    if (parsed.success) result.set(`${parsed.data.type}:${parsed.data.value}`, parsed.data);
  }
  return [...result.values()];
}

/** Explicit proposals only, resolved by saved identifiers, never by a display label. */
export function scopeIdentifierProposals(
  db: Db,
  policy: ScopePolicy,
  scopes: SourceScopes,
): NonNullable<SourceScopePreview["identifierProposals"]> {
  const result: NonNullable<SourceScopePreview["identifierProposals"]> = [];
  for (const [itemIndex, ref] of (policy.rules[0]?.match ?? []).entries()) {
    if (ref.kind !== "participant") continue;
    const identifiers = ref.identifiers.filter((item) => item.type !== "domain");
    if (!identifiers.length) continue;
    const roots = db
      .prepare<[string], { id: string }>(
        `WITH RECURSIVE matches(id) AS (
      SELECT a.person_id FROM person_aliases a JOIN json_each(?) j
        ON a.alias_type=json_extract(j.value,'$.type') AND a.alias=json_extract(j.value,'$.value')
      UNION SELECT p.merged_into FROM people p JOIN matches m ON p.id=m.id WHERE p.merged_into IS NOT NULL
    ) SELECT DISTINCT p.id FROM matches m JOIN people p ON p.id=m.id WHERE p.merged_into IS NULL LIMIT 2`,
      )
      .all(JSON.stringify(identifiers));
    if (roots.length !== 1) continue;
    const current = scopePersonIdentifiers(db, roots[0]!.id, scopes);
    if (!current) continue;
    const saved = new Set(ref.identifiers.map((item) => `${item.type}:${item.value}`));
    const extra = current.filter((item) => !saved.has(`${item.type}:${item.value}`));
    if (extra.length) result.push({ itemIndex, label: ref.label, identifiers: extra });
  }
  return result;
}
