// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { markMergeRulesDirty } from "../../data/DirtyMarks.js";
import { readOccMeta } from "../../data/occ-materialized.js";
import {
  VALID_ALIAS_TYPES,
  canonicalizeRuleSides,
  mapMergeRuleRow,
  normalizeRuleAlias,
  type CreateMergeRuleInput,
  type CreateMergeRuleResult,
  type ListMergeRulesOpts,
  type MergeRule,
  type MergeRuleDbRow,
  type MergeRuleKind,
  type MergeRuleSide,
  type MergeRuleWithResolved,
  type ResolvedSidePerson,
} from "./types.js";

const log = createLogger("gateway:people");

/**
 * Insert a merge rule. Idempotent on (canonical sideA, canonical sideB,
 * kind): re-creating an active rule returns it unchanged with
 * `created=false`.
 *
 * Validates: alias values are non-empty trimmed strings; alias types
 * are one of email/phone/lid/name; the two sides aren't identical
 * (would be a no-op rule).
 */
export function createMergeRule(db: Db, input: CreateMergeRuleInput): CreateMergeRuleResult {
  const kind: MergeRuleKind = input.kind ?? "user";

  // Validate inputs early — prevents bad rows getting into the table.
  for (const side of [input.sideA, input.sideB]) {
    if (!VALID_ALIAS_TYPES.has(side.aliasType)) {
      throw new Error(
        `Invalid alias type "${side.aliasType}" — expected one of email/phone/lid/name`,
      );
    }
    if (typeof side.alias !== "string" || side.alias.trim().length === 0) {
      throw new Error(`Merge rule alias must be a non-empty string`);
    }
  }
  // User rules with identical sides are nonsensical (asserts a person
  // is the same as themselves). Reject them — the user can't have
  // intended this. System rules ARE allowed identical sides — the
  // auto-detect's "two people share email=foo" case becomes a rule
  // with email=foo on both sides, which means "merge any people
  // sharing this alias".
  if (
    kind === "user" &&
    input.sideA.aliasType === input.sideB.aliasType &&
    input.sideA.alias === input.sideB.alias
  ) {
    throw new Error(`Merge rule sides must reference different aliases`);
  }
  if (input.winnerSide !== "a" && input.winnerSide !== "b") {
    throw new Error(`winnerSide must be "a" or "b"`);
  }

  // Normalize each side first (lowercases name aliases) so the unique
  // index doesn't admit case-variant duplicates. THEN canonicalize the
  // (a, b) ordering so mirrors collapse to one row.
  const normA = normalizeRuleAlias(input.sideA);
  const normB = normalizeRuleAlias(input.sideB);
  const canon = canonicalizeRuleSides(normA, normB, input.winnerSide);

  // Check for an existing active rule for the same canonical pair AND
  // kind. Deactivated rules don't exist anymore (Remove deletes the
  // row outright), so this is purely an "already active → no-op"
  // check. We allow user + system rules for the same pair to coexist
  // (rare but possible — e.g. user pre-emptively creating a rule that
  // the auto-detector would also propose).
  const existing = db
    .prepare<[string, string, string, string, MergeRuleKind], { id: string }>(
      `SELECT id FROM merge_rules
       WHERE side_a_alias_type = ? AND side_a_alias = ?
         AND side_b_alias_type = ? AND side_b_alias = ?
         AND kind = ?
       LIMIT 1`,
    )
    .get(canon.sideA.aliasType, canon.sideA.alias, canon.sideB.aliasType, canon.sideB.alias, kind);

  const now = new Date().toISOString();
  if (existing) {
    const row = readMergeRuleRowOrThrow(db, existing.id);
    return { rule: row, created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO merge_rules
       (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
        winner_side, reason, created_at, created_by, active, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    kind,
    canon.sideA.aliasType,
    canon.sideA.alias,
    canon.sideB.aliasType,
    canon.sideB.alias,
    canon.winnerSide,
    input.reason ?? null,
    now,
    input.createdBy ?? null,
    input.groupId ?? null,
  );
  markMergeRulesDirty(db);
  log.info(
    `Created ${kind} merge rule ${id}: (${canon.sideA.aliasType}=${canon.sideA.alias}) ↔ (${canon.sideB.aliasType}=${canon.sideB.alias})`,
  );

  const row = readMergeRuleRowOrThrow(db, id);
  return { rule: row, created: true };
}

/**
 * Permanently deletes a merge rule. Bumps the rules dirty version so
 * the next eval tick unwinds the merge it was holding (or re-applies
 * via remaining rules in the same equivalence class).
 *
 * Returns true if a row was actually deleted; false if the id didn't
 * exist. Replaces the previous "deactivate" soft-delete — durable
 * vetoes were a rules-era artifact that no longer carry meaning now
 * that shared-identifier dedup is physical (auto-detect never creates
 * tautology rules anymore, so there's nothing to veto).
 */
export function deleteMergeRule(db: Db, ruleId: string): boolean {
  const result = db.prepare("DELETE FROM merge_rules WHERE id = ?").run(ruleId);
  if (result.changes === 0) return false;
  markMergeRulesDirty(db);
  log.info(`Deleted merge rule ${ruleId}`);
  return true;
}

/**
 * Permanently delete every rule of one cluster-merge batch (all rules sharing
 * `groupId`). Undoes a whole cluster merge in one action: the eval re-derives
 * `merged_into` on the next tick, splitting the component back into its members
 * (modulo any other rules that independently relate some of them).
 *
 * Returns the number of rules deleted (0 if the group id is unknown).
 */
export function deleteMergeRuleGroup(db: Db, groupId: string): number {
  const result = db.prepare("DELETE FROM merge_rules WHERE group_id = ?").run(groupId);
  if (result.changes === 0) return 0;
  markMergeRulesDirty(db);
  log.info(`Deleted merge-rule group ${groupId}: ${result.changes} rule(s)`);
  return result.changes;
}

function readMergeRuleRowOrThrow(db: Db, id: string): MergeRule {
  const row = db
    .prepare<[string], MergeRuleDbRow>("SELECT * FROM merge_rules WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`Merge rule ${id} not found after insert/update`);
  return mapMergeRuleRow(row);
}

/**
 * Resolves an `(aliasType, alias)` pair to the person rows that carry
 * the alias. Caller passes a shared cache keyed by
 * `aliasType:alias|preMerge` so repeated lookups within one request
 * collapse.
 *
 * Two resolution modes — caller picks based on what the UI shows:
 *
 *   - **canonical mode** (default): walks `merged_into` to the
 *     canonical and returns ONE row per equivalence class. Aliases /
 *     docs include the whole class (losers' contributions surfaced via
 *     UNION). This is what the **candidates** view wants — the merge
 *     hasn't happened yet, so each side's "person" is the current
 *     canonical with all its identifiers in scope.
 *
 *   - **pre-merge mode** (`preMerge: true`): returns the row whose
 *     `person_aliases` row directly carries the alias. NO `merged_into`
 *     walk; aliases / docs are scoped to JUST that row. This is what
 *     the **merge-rules** view wants — the merge has already happened,
 *     and the operator wants to see "what got merged" (i.e. the two
 *     pre-merge identities), not "what they all collapse into now"
 *     (which would render as two identical canonical cards on every
 *     row, hiding the rule's intent).
 *
 * `withDetails: true` fills `aliases` + `sourceIds` per the mode.
 */
export function resolveAliasSide(
  db: Db,
  side: MergeRuleSide,
  opts: {
    withDetails?: boolean;
    preMerge?: boolean;
    cache?: Map<string, ResolvedSidePerson[]>;
  } = {},
): ResolvedSidePerson[] {
  const cache = opts.cache;
  const cacheKey = `${side.aliasType}:${side.alias}|${opts.preMerge ? "pre" : "canon"}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }
  // Cap source-icon strip at 6 — anything beyond that is visual noise.
  const MAX_SOURCES = 6;

  // The big shape difference between the two modes is whether we
  // resolve through `merged_into` to the canonical (canonical mode)
  // or stop at the row that carries the alias (pre-merge mode).
  // In pre-merge we ALSO surface `merged_into`'s name so the UI can
  // tag merged-losers ("merged into <X>") without an extra round-trip.
  const baseSelect = opts.preMerge
    ? `SELECT DISTINCT p.id AS id,
              p.canonical_name AS canonical_name,
              COALESCE(p.interaction_score_recent, 0) AS interaction_score_recent,
              p.merged_into AS merged_into,
              c.canonical_name AS merged_into_canonical_name`
    : opts.withDetails
      ? `SELECT DISTINCT canonical.id AS id,
                canonical.canonical_name AS canonical_name,
                COALESCE(canonical.interaction_score_recent, 0) AS interaction_score_recent,
                NULL AS merged_into, NULL AS merged_into_canonical_name`
      : `SELECT DISTINCT canonical.id AS id,
                canonical.canonical_name AS canonical_name,
                NULL AS merged_into, NULL AS merged_into_canonical_name`;
  const fromJoin = opts.preMerge
    ? `FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       LEFT JOIN people c ON c.id = p.merged_into`
    : `FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       JOIN people canonical ON canonical.id = COALESCE(p.merged_into, p.id) AND canonical.merged_into IS NULL`;
  const where =
    side.aliasType === "name"
      ? `WHERE pa.alias_type = 'name' AND LOWER(pa.alias) = ?`
      : `WHERE pa.alias_type = ? AND pa.alias = ?`;
  const sql = `${baseSelect} ${fromJoin} ${where}`;
  // Name lookups are case-insensitive (`LOWER(pa.alias) = ?`), so the bound
  // value must be lowercased too — otherwise any name carrying an uppercase
  // letter ("Maya Reeves") never matches and the side resolves to nobody.
  const args =
    side.aliasType === "name" ? [side.alias.toLowerCase()] : [side.aliasType, side.alias];
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        canonical_name: string;
        interaction_score_recent?: number;
        merged_into: string | null;
        merged_into_canonical_name: string | null;
      }
    >(sql)
    .all(...args);

  if (!opts.withDetails) {
    const out = rows.map((r) => ({
      id: r.id,
      canonicalName: r.canonical_name,
      ...(r.merged_into_canonical_name
        ? { mergedIntoCanonicalName: r.merged_into_canonical_name }
        : {}),
    }));
    cache?.set(cacheKey, out);
    return out;
  }

  // Source-id sample shape:
  //   - canonical mode: equivalence-aware (canonical + merged-in losers).
  //   - pre-merge mode: this row only.
  // We pick the most-recently-touched sources first so the strip
  // surfaces the live provenance of the identity, not historical
  // long-tail sources.
  const sourceIdsStmt = opts.preMerge
    ? db.prepare<[string, number], { source_id: string }>(
        `SELECT d.source_id, MAX(COALESCE(d.source_created_at, d.ingested_at)) AS last_seen
         FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         WHERE dp.person_id = ?
         GROUP BY d.source_id
         ORDER BY last_seen DESC
         LIMIT ?`,
      )
    : db.prepare<[string, string, number], { source_id: string }>(
        `SELECT d.source_id, MAX(COALESCE(d.source_created_at, d.ingested_at)) AS last_seen
         FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         WHERE dp.person_id = ?
            OR dp.person_id IN (SELECT id FROM people WHERE merged_into = ?)
         GROUP BY d.source_id
         ORDER BY last_seen DESC
         LIMIT ?`,
      );
  const aliasListStmt = db.prepare<[string], { alias_type: string; alias: string }>(
    `SELECT alias_type, alias FROM person_aliases WHERE person_id = ?
     ORDER BY alias_type, alias`,
  );
  const enriched: ResolvedSidePerson[] = rows.map((r) => {
    const sourceRows = opts.preMerge
      ? (
          sourceIdsStmt as ReturnType<typeof db.prepare<[string, number], { source_id: string }>>
        ).all(r.id, MAX_SOURCES)
      : (
          sourceIdsStmt as ReturnType<
            typeof db.prepare<[string, string, number], { source_id: string }>
          >
        ).all(r.id, r.id, MAX_SOURCES);
    const aliasRows = aliasListStmt.all(r.id);
    return {
      id: r.id,
      canonicalName: r.canonical_name,
      interactionScoreRecent: r.interaction_score_recent ?? 0,
      aliases: aliasRows.map((a) => ({ aliasType: a.alias_type, alias: a.alias })),
      sourceIds: sourceRows.map((s) => s.source_id),
      ...(r.merged_into_canonical_name
        ? { mergedIntoCanonicalName: r.merged_into_canonical_name }
        : {}),
    };
  });
  cache?.set(cacheKey, enriched);
  return enriched;
}

export function listMergeRules(db: Db, opts: ListMergeRulesOpts = {}): MergeRuleWithResolved[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.active !== undefined) {
    where.push("active = ?");
    params.push(opts.active ? 1 : 0);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.ruleIds) {
    if (opts.ruleIds.length === 0) return [];
    where.push(`id IN (${opts.ruleIds.map(() => "?").join(", ")})`);
    params.push(...opts.ruleIds);
  }
  if (opts.touchesPersonId) {
    // A rule "touches" a person if either side's alias maps to them
    // via person_aliases. This handles both canonical and merged-loser
    // membership in the equivalence class — searchPeople semantics.
    where.push(`(
      EXISTS (SELECT 1 FROM person_aliases pa
              WHERE pa.alias_type = side_a_alias_type
                AND pa.alias = side_a_alias
                AND pa.person_id = ?)
      OR
      EXISTS (SELECT 1 FROM person_aliases pa
              WHERE pa.alias_type = side_b_alias_type
                AND pa.alias = side_b_alias
                AND pa.person_id = ?)
    )`);
    params.push(opts.touchesPersonId, opts.touchesPersonId);
  }
  if (opts.beforeCreated) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(opts.beforeCreated.createdAt, opts.beforeCreated.createdAt, opts.beforeCreated.id);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM merge_rules ${whereSql}
               ORDER BY created_at DESC, id DESC
               ${opts.limit === undefined ? "" : "LIMIT ?"}`;
  if (opts.limit !== undefined) params.push(Math.max(1, opts.limit));
  const rows = db.prepare<unknown[], MergeRuleDbRow>(sql).all(...params);
  const mapped = rows.map(mapMergeRuleRow);
  if (!opts.withResolved) return mapped;

  // The withDetails enrichment path used to issue 4 queries per rule (2
  // sides × {aliases, sourceIds}). Batch them into 3 queries total so
  // the cost is O(distinct persons) rather than O(rules) — closes the
  // N+1.
  if (opts.withDetails) {
    return listMergeRulesWithBatchedDetails(db, mapped, opts);
  }

  // No-details paths still go through the per-rule resolver. The
  // single-side SQL is small (one alias→canonical-id JOIN) and the
  // shared cache deduplicates repeats inside the same call.
  const cache = new Map<string, ResolvedSidePerson[]>();
  const resolverOpts = {
    withDetails: opts.withDetails,
    preMerge: opts.preMerge,
    cache,
  };
  return mapped.map((rule) => ({
    ...rule,
    resolvedSideA: resolveAliasSide(db, rule.sideA, resolverOpts),
    resolvedSideB: resolveAliasSide(db, rule.sideB, resolverOpts),
  }));
}

/**
 * Count merge rules without materialising (or resolving) the list — the
 * cheap primitive behind the People list view's "N merge rules" badge.
 * `active` filters on the same column `listMergeRules` does, so the count
 * matches the rules screen's default (active-only) view.
 */
export function countMergeRules(db: Db, opts: { active?: boolean } = {}): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.active !== undefined) {
    where.push("active = ?");
    params.push(opts.active ? 1 : 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = db
    .prepare<unknown[], { c: number }>(`SELECT COUNT(*) AS c FROM merge_rules ${whereSql}`)
    .get(...params);
  return row?.c ?? 0;
}

/**
 * withDetails-mode batched resolver. For N rules with M distinct resolved
 * persons across both sides:
 *
 *   1. Resolve each distinct (aliasType, alias, mode) tuple to its person
 *      rows via the existing single-side SQL (caller-cached).
 *   2. ONE `SELECT person_id, alias_type, alias FROM person_aliases
 *      WHERE person_id IN (...)` to fetch every person's aliases.
 *   3. ONE `ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY last_seen
 *      DESC)` query to fetch the top-MAX_SOURCES sources per person —
 *      preserves the per-person LIMIT semantics of the old per-row query.
 *
 * Total: 3 batched queries + N×2 single-side resolves (cache-deduped).
 * Pre-fix: N×2×(1 alias-side resolve + N×2 per-person enrichment) ≈
 * O(N²) on a table where N can be 100+.
 */
function listMergeRulesWithBatchedDetails(
  db: Db,
  rules: MergeRule[],
  opts: ListMergeRulesOpts,
): MergeRuleWithResolved[] {
  const MAX_SOURCES = 6;

  // Step 1 — distinct sides → bare person rows (id + canonical_name +
  // interaction_score_recent + merged-into hints). The SQL mirrors
  // resolveAliasSide's withDetails:true SELECT but DROPS its per-person
  // aliasListStmt / sourceIdsStmt loop — the batched queries below
  // replace those.
  const sideCache = new Map<
    string,
    Array<{
      id: string;
      canonicalName: string;
      interactionScoreRecent: number;
      mergedIntoCanonicalName?: string;
    }>
  >();
  const sideKey = (s: MergeRuleSide): string =>
    `${s.aliasType}:${s.alias}|${opts.preMerge ? "pre" : "canon"}`;

  // Per-mode SELECT/JOIN; same canonical/preMerge logic as
  // resolveAliasSide. Prepared once and reused across distinct sides.
  const bareSelect = opts.preMerge
    ? `SELECT DISTINCT p.id AS id,
              p.canonical_name AS canonical_name,
              COALESCE(p.interaction_score_recent, 0) AS interaction_score_recent,
              c.canonical_name AS merged_into_canonical_name
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       LEFT JOIN people c ON c.id = p.merged_into`
    : `SELECT DISTINCT canonical.id AS id,
              canonical.canonical_name AS canonical_name,
              COALESCE(canonical.interaction_score_recent, 0) AS interaction_score_recent,
              NULL AS merged_into_canonical_name
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       JOIN people canonical
         ON canonical.id = COALESCE(p.merged_into, p.id)
        AND canonical.merged_into IS NULL`;

  type BareRow = {
    id: string;
    canonical_name: string;
    interaction_score_recent: number;
    merged_into_canonical_name: string | null;
  };
  const bareNameStmt = db.prepare<[string], BareRow>(
    `${bareSelect} WHERE pa.alias_type = 'name' AND LOWER(pa.alias) = ?`,
  );
  const bareOtherStmt = db.prepare<[string, string], BareRow>(
    `${bareSelect} WHERE pa.alias_type = ? AND pa.alias = ?`,
  );

  for (const rule of rules) {
    for (const side of [rule.sideA, rule.sideB]) {
      const key = sideKey(side);
      if (sideCache.has(key)) continue;
      const rows =
        side.aliasType === "name"
          ? bareNameStmt.all(side.alias)
          : bareOtherStmt.all(side.aliasType, side.alias);
      sideCache.set(
        key,
        rows.map((r) => ({
          id: r.id,
          canonicalName: r.canonical_name,
          interactionScoreRecent: r.interaction_score_recent ?? 0,
          ...(r.merged_into_canonical_name
            ? { mergedIntoCanonicalName: r.merged_into_canonical_name }
            : {}),
        })),
      );
    }
  }

  // Step 2 — collect every distinct person id in scope.
  const allPersonIds = new Set<string>();
  for (const persons of sideCache.values()) {
    for (const p of persons) allPersonIds.add(p.id);
  }
  if (allPersonIds.size === 0) {
    return rules.map((r) => ({ ...r, resolvedSideA: [], resolvedSideB: [] }));
  }

  // Step 3 — batched aliases by person.
  const personIdList = [...allPersonIds];
  const placeholders = personIdList.map(() => "?").join(",");
  const aliasesByPerson = new Map<string, Array<{ aliasType: string; alias: string }>>();
  const aliasRows = db
    .prepare<unknown[], { person_id: string; alias_type: string; alias: string }>(
      `SELECT person_id, alias_type, alias FROM person_aliases
       WHERE person_id IN (${placeholders})
       ORDER BY person_id, alias_type, alias`,
    )
    .all(...personIdList);
  for (const r of aliasRows) {
    let arr = aliasesByPerson.get(r.person_id);
    if (!arr) {
      arr = [];
      aliasesByPerson.set(r.person_id, arr);
    }
    arr.push({ aliasType: r.alias_type, alias: r.alias });
  }

  // Step 4 — batched source-ids by person, top MAX_SOURCES per person via
  // a ROW_NUMBER() window. Pre-merge mode walks document_people directly;
  // canonical mode joins through `merged_into` so loser-row docs roll up
  // into the canonical's strip — same equivalence-class semantics as the
  // old per-person SQL.
  const sourceIdsByPerson = new Map<string, string[]>();
  const sourceSql = opts.preMerge
    ? `WITH ranked AS (
         SELECT dp.person_id AS person_id,
                d.source_id AS source_id,
                MAX(COALESCE(d.source_created_at, d.ingested_at)) AS last_seen,
                ROW_NUMBER() OVER (
                  PARTITION BY dp.person_id
                  ORDER BY MAX(COALESCE(d.source_created_at, d.ingested_at)) DESC
                ) AS rn
         FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         WHERE dp.person_id IN (${placeholders})
         GROUP BY dp.person_id, d.source_id
       )
       SELECT person_id, source_id FROM ranked WHERE rn <= ?`
    : `WITH ranked AS (
         SELECT canonical.id AS person_id,
                d.source_id AS source_id,
                MAX(COALESCE(d.source_created_at, d.ingested_at)) AS last_seen,
                ROW_NUMBER() OVER (
                  PARTITION BY canonical.id
                  ORDER BY MAX(COALESCE(d.source_created_at, d.ingested_at)) DESC
                ) AS rn
         FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         JOIN people p ON p.id = dp.person_id
         JOIN people canonical
           ON canonical.id = COALESCE(p.merged_into, p.id)
          AND canonical.merged_into IS NULL
         WHERE canonical.id IN (${placeholders})
         GROUP BY canonical.id, d.source_id
       )
       SELECT person_id, source_id FROM ranked WHERE rn <= ?`;
  const srcRows = db
    .prepare<unknown[], { person_id: string; source_id: string }>(sourceSql)
    .all(...personIdList, MAX_SOURCES);
  for (const r of srcRows) {
    let arr = sourceIdsByPerson.get(r.person_id);
    if (!arr) {
      arr = [];
      sourceIdsByPerson.set(r.person_id, arr);
    }
    arr.push(r.source_id);
  }

  // Step 5 — stitch enrichment back into per-side persons.
  const enrichedBySide = new Map<string, ResolvedSidePerson[]>();
  for (const [key, persons] of sideCache) {
    enrichedBySide.set(
      key,
      persons.map((p) => ({
        id: p.id,
        canonicalName: p.canonicalName,
        interactionScoreRecent: p.interactionScoreRecent,
        aliases: aliasesByPerson.get(p.id) ?? [],
        sourceIds: sourceIdsByPerson.get(p.id) ?? [],
        ...(p.mergedIntoCanonicalName
          ? { mergedIntoCanonicalName: p.mergedIntoCanonicalName }
          : {}),
      })),
    );
  }

  return rules.map((rule) => ({
    ...rule,
    resolvedSideA: enrichedBySide.get(sideKey(rule.sideA)) ?? [],
    resolvedSideB: enrichedBySide.get(sideKey(rule.sideB)) ?? [],
  }));
}

/** Single-row lookup for a merge rule by id. Used by candidate accept
 *  to round-trip the freshly-created rule back to callers. */
export function getMergeRuleById(db: Db, id: string): MergeRule | null {
  const row = db
    .prepare<[string], MergeRuleDbRow>("SELECT * FROM merge_rules WHERE id = ?")
    .get(id);
  return row ? mapMergeRuleRow(row) : null;
}

export function readMergeRulesMeta(db: Db): {
  dirtyVersion: number;
  lastEvaluatedVersion: number;
  lastEvaluatedAt: number | null;
} {
  // The shared `OccMetaSnapshot` shape uses `lastComputed*` field
  // names (it has to pick one); the legacy `merge_rules_meta` row
  // had `last_evaluated_*` columns, which an earlier migration
  // copied into `refresh_meta.last_computed_*`. Map at the call site
  // so the public surface stays stable.
  const meta = readOccMeta(db, "merge_rules");
  return {
    dirtyVersion: meta.dirtyVersion,
    lastEvaluatedVersion: meta.lastComputedVersion,
    lastEvaluatedAt: meta.lastComputedAt,
  };
}
