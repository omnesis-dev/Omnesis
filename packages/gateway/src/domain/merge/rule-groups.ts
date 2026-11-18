// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The People → Rules page (`GET /people/merge-rule-groups`): active merge
 * rules grouped by the identity they merged into, newest first.
 *
 * Grouping needs every active rule's current identity, so the page's first
 * query resolves each rule's winning alias to a person. That lookup must seek:
 * it runs once per rule, and the table grows with every merge. A non-name
 * winner seeks `(alias_type, alias)`; a name winner is matched without regard
 * to case and seeks the name index on `LOWER(alias)`
 * ({@link PERSON_NAME_ALIAS_INDEX}), named with `INDEXED BY` so that losing it
 * is an error rather than a scan of every name.
 *
 * The read runs on an io worker (`io.mergeRuleGroups`); the gateway's main
 * thread only awaits its result.
 */

import { PERSON_NAME_ALIAS_INDEX } from "../../data/migration-218-person-name-alias-index.js";
import { listMergeRules, resolveAliasSide } from "./rule-crud.js";
import type { MergeRuleKind } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface MergeRuleGroupItem {
  key: string;
  person: {
    id: string;
    canonicalName: string;
    interactionScoreRecent?: number;
    aliases?: Array<{ aliasType: string; alias: string }>;
    sourceIds?: string[];
  } | null;
  name: string;
  canonicalEmail: string | null;
  sourceIds: string[];
  kinds: MergeRuleKind[];
  ruleIds: string[];
  groupIds: string[];
  latest: string;
  sources: Array<{
    ruleId: string;
    groupId: string | null;
    alias: string;
    aliasType: string;
    name: string | null;
    personId: string | null;
    sourceIds: string[];
    when: string | null;
    reason: string | null;
  }>;
}

export interface MergeRuleGroupsOptions {
  limit: number;
  q?: string;
  kind?: MergeRuleKind;
  before?: { latest: string; key: string };
}

export interface MergeRuleGroupsPage {
  items: MergeRuleGroupItem[];
  hasMore: boolean;
  last?: { latest: string; key: string };
}

const WINNER_TYPE =
  "CASE mr.winner_side WHEN 'a' THEN mr.side_a_alias_type ELSE mr.side_b_alias_type END";
const WINNER_ALIAS = "CASE mr.winner_side WHEN 'a' THEN mr.side_a_alias ELSE mr.side_b_alias END";
const LOSER_ALIAS = "CASE mr.winner_side WHEN 'a' THEN mr.side_b_alias ELSE mr.side_a_alias END";

/**
 * The person a rule's winning alias belongs to now: the lowest current
 * identity among the people carrying it. Each arm is a single index seek; a
 * `CASE` evaluates only the arm it takes.
 */
const CANONICAL_ID = `CASE WHEN winner_type = 'name' THEN (
      SELECT COALESCE(p.merged_into, p.id)
        FROM person_aliases pa INDEXED BY ${PERSON_NAME_ALIAS_INDEX}
        JOIN people p ON p.id = pa.person_id
       WHERE pa.alias_type = 'name' AND LOWER(pa.alias) = LOWER(winner_alias)
       ORDER BY COALESCE(p.merged_into, p.id), p.id
       LIMIT 1
    ) ELSE (
      SELECT COALESCE(p.merged_into, p.id)
        FROM person_aliases pa
        JOIN people p ON p.id = pa.person_id
       WHERE pa.alias_type = winner_type AND pa.alias = winner_alias
       ORDER BY COALESCE(p.merged_into, p.id), p.id
       LIMIT 1
    ) END`;

/** Every rule with its winning alias and the identity it resolves to. */
const RESOLVED_RULES = `winner AS (
       SELECT mr.*, ${WINNER_TYPE} AS winner_type,
              ${WINNER_ALIAS} AS winner_alias, ${LOSER_ALIAS} AS loser_alias
         FROM merge_rules mr
     ),
     resolved AS (
       SELECT mr.*, ${CANONICAL_ID} AS canonical_id
         FROM winner mr
     )`;

/**
 * The statement that selects one page of identities, for the filters given.
 * Exported so a test can read its plan.
 */
export function mergeRuleGroupsPageSql(opts: {
  kind: boolean;
  q: boolean;
  before: boolean;
}): string {
  const filters = ["mr.active = 1"];
  if (opts.kind) filters.push("mr.kind = ?");
  if (opts.q)
    filters.push(`(
        LOWER(winner_alias) LIKE ? ESCAPE '\\'
        OR LOWER(loser_alias) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM people qp
           WHERE qp.id = canonical_id AND LOWER(qp.canonical_name) LIKE ? ESCAPE '\\'
        )
      )`);
  return `WITH ${RESOLVED_RULES},
     grouped AS (
       SELECT COALESCE(canonical_id, winner_type || '=' || winner_alias) AS display_key,
              canonical_id, MAX(created_at) AS latest
         FROM resolved mr
        WHERE ${filters.join(" AND ")}
        GROUP BY display_key, canonical_id
     )
     SELECT display_key, canonical_id, latest
       FROM grouped
       ${opts.before ? "WHERE (latest, display_key) < (?, ?)" : ""}
      ORDER BY latest DESC, display_key DESC
      LIMIT ?`;
}

/**
 * Page the merge-rule audit by whole identity. SQL first selects a bounded
 * page of identities; only those identities' rules receive the alias and
 * source enrichment.
 */
export function listMergeRuleGroups(db: Db, opts: MergeRuleGroupsOptions): MergeRuleGroupsPage {
  const params: Array<string | number> = [];
  if (opts.kind) params.push(opts.kind);
  const q = opts.q?.trim().toLowerCase() ?? "";
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(pattern, pattern, pattern);
  }
  if (opts.before) params.push(opts.before.latest, opts.before.key);
  params.push(opts.limit + 1);
  const groupRows = db
    .prepare<
      (string | number)[],
      { display_key: string; canonical_id: string | null; latest: string }
    >(mergeRuleGroupsPageSql({ kind: !!opts.kind, q: !!q, before: !!opts.before }))
    .all(...params);
  const hasMore = groupRows.length > opts.limit;
  const pageRows = hasMore ? groupRows.slice(0, opts.limit) : groupRows;
  if (pageRows.length === 0) return { items: [], hasMore };

  const keys = pageRows.map((row) => row.display_key);
  const keyPlaceholders = keys.map(() => "?").join(", ");
  const selected = db
    .prepare<(string | number)[], { id: string; display_key: string }>(
      `WITH ${RESOLVED_RULES}
       SELECT id, COALESCE(canonical_id, winner_type || '=' || winner_alias) AS display_key
         FROM resolved mr
        WHERE mr.active = 1
          ${opts.kind ? "AND mr.kind = ?" : ""}
          AND COALESCE(canonical_id, winner_type || '=' || winner_alias)
              IN (${keyPlaceholders})`,
    )
    .all(...(opts.kind ? [opts.kind, ...keys] : keys));
  const keyByRuleId = new Map(selected.map((row) => [row.id, row.display_key]));
  const rules = listMergeRules(db, {
    active: true,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ruleIds: selected.map((row) => row.id),
    withResolved: true,
    withDetails: true,
    preMerge: true,
  });
  const rulesByKey = new Map<string, typeof rules>();
  for (const rule of rules) {
    const key = keyByRuleId.get(rule.id);
    if (!key) continue;
    const bucket = rulesByKey.get(key) ?? [];
    bucket.push(rule);
    rulesByKey.set(key, bucket);
  }
  const canonicalCache = new Map<string, ReturnType<typeof resolveAliasSide>>();
  const items = pageRows.map((group): MergeRuleGroupItem => {
    const groupRules = rulesByKey.get(group.display_key) ?? [];
    const first = groupRules[0];
    const winnerKey = first?.winnerSide === "b" ? "B" : "A";
    const winnerSide = first ? first[`side${winnerKey}`] : null;
    const person = winnerSide
      ? (resolveAliasSide(db, winnerSide, {
          withDetails: true,
          cache: canonicalCache,
        })[0] ?? null)
      : null;
    const canonicalEmail =
      person?.aliases?.find((alias) => alias.aliasType === "email")?.alias ??
      (winnerSide?.aliasType === "email" ? winnerSide.alias : null);
    const sources = groupRules.map((rule) => {
      const ruleWinnerKey = rule.winnerSide === "a" ? "A" : "B";
      const ruleLoserKey = ruleWinnerKey === "A" ? "B" : "A";
      const loser = (rule[`resolvedSide${ruleLoserKey}`] ?? [])[0] ?? null;
      const side = rule[`side${ruleLoserKey}`];
      return {
        ruleId: rule.id,
        groupId: rule.groupId ?? null,
        alias: side.alias,
        aliasType: side.aliasType,
        name: loser?.canonicalName ?? null,
        personId: loser?.id ?? null,
        sourceIds: loser?.sourceIds ?? [],
        when: rule.createdAt ?? null,
        reason: rule.reason ?? null,
      };
    });
    return {
      key: group.display_key,
      person,
      name:
        person?.canonicalName ??
        (winnerSide ? `${winnerSide.aliasType}=${winnerSide.alias}` : group.display_key),
      canonicalEmail,
      sourceIds: person?.sourceIds ?? [],
      kinds: [...new Set(groupRules.map((rule) => rule.kind))],
      ruleIds: groupRules.map((rule) => rule.id),
      groupIds: [...new Set(groupRules.flatMap((rule) => (rule.groupId ? [rule.groupId] : [])))],
      latest: group.latest,
      sources,
    };
  });
  const lastRow = pageRows.at(-1);
  return {
    items,
    hasMore,
    ...(lastRow ? { last: { latest: lastRow.latest, key: lastRow.display_key } } : {}),
  };
}
