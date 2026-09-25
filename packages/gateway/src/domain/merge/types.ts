// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared types + canonicalization helpers for the merge subsystem.
 *
 * Live across all merge files (primitives, rule-crud, rule-evaluator,
 * auto-detect, full-rebuild) so this module owns them centrally rather
 * than threading them through circular imports.
 */

export type MergeRuleAliasType = "email" | "phone" | "lid" | "name";

/**
 * The alias types that identify a person on their own.
 *
 * Sharing one of these means same person, with no judgement called for: an
 * address, a number and a platform id each name one person by construction,
 * where a name names as many as happen to have it. Every automatic merge is
 * gated on this list, so what is in it decides what Omnesis will join without
 * asking.
 *
 * Declared once, and declared as a subset of the alias types rather than beside
 * them, so adding a type is a decision about whether it belongs here rather
 * than a literal to remember to update in four SQL strings.
 */
export const STRONG_IDENTIFIER_TYPES = [
  "email",
  "phone",
  "lid",
] as const satisfies readonly MergeRuleAliasType[];

export type StrongIdentifierType = (typeof STRONG_IDENTIFIER_TYPES)[number];

/** The same list as a comma-separated `?` run, for an `IN (…)` clause. */
export const STRONG_IDENTIFIER_PLACEHOLDERS = STRONG_IDENTIFIER_TYPES.map(() => "?").join(",");
export type MergeRuleKind = "system" | "user";
export type MergeWinnerSide = "a" | "b";

export interface MergeRuleSide {
  aliasType: MergeRuleAliasType;
  alias: string;
}

export interface MergeRule {
  id: string;
  kind: MergeRuleKind;
  sideA: MergeRuleSide;
  sideB: MergeRuleSide;
  winnerSide: MergeWinnerSide;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
  active: boolean;
  deactivatedAt: string | null;
  /** Correlation id shared by all rules from one cluster-merge action;
   *  null for single-pair and auto-detected rules. */
  groupId: string | null;
}

export interface CreateMergeRuleInput {
  sideA: MergeRuleSide;
  sideB: MergeRuleSide;
  winnerSide: MergeWinnerSide;
  kind?: MergeRuleKind;
  reason?: string | null;
  createdBy?: string | null;
  /** Tags the rule as part of a cluster-merge batch. Omitted for
   *  single-pair / auto-detected rules (stored as NULL). */
  groupId?: string | null;
}

export interface CreateMergeRuleResult {
  rule: MergeRule;
  /** True if a brand new rule was inserted. False when an existing
   *  rule for the same (sideA, sideB, kind) was already active and
   *  was returned unchanged. */
  created: boolean;
}

export interface ListMergeRulesOpts {
  active?: boolean;
  kind?: MergeRuleKind;
  /** Internal bounded-enrichment filter used by grouped list pages. */
  ruleIds?: readonly string[];
  /** Filter to rules that touch this person (either side resolves to them). */
  touchesPersonId?: string;
  limit?: number;
  beforeCreated?: { createdAt: string; id: string };
  /**
   * When true, augments each rule with the people each side currently
   * resolves to (id + canonical_name). Useful for the portal's
   * /portal/merge-rules page so the user can click through to see
   * which contacts a rule actually merges. Skipped by default to keep
   * list calls cheap when the resolved set isn't needed.
   */
  withResolved?: boolean;
  /**
   * When true (and `withResolved` is true), also fills `aliases` and
   * `sourceIds` on each resolved person — the same per-side detail
   * the merge-candidates view shows. Costs extra SQL per unique
   * (aliasType, alias) so opt in only where the rich card is rendered.
   */
  withDetails?: boolean;
  /**
   * When true (and `withResolved` is true), each side resolves to the
   * pre-merge identity row that originally carried the alias instead
   * of walking `merged_into` to the canonical. This is what the
   * merge-rules page wants — the merge has already happened, so the
   * canonical view collapses both sides to the same row and renders
   * two identical cards. Pre-merge view shows what was actually
   * merged.
   */
  preMerge?: boolean;
}

export interface ResolvedSidePerson {
  id: string;
  canonicalName: string;
  /** Recent-decay interaction score, only filled when withDetails. */
  interactionScoreRecent?: number;
  /** Aliases shown to the user. Scope depends on `preMerge`:
   *    - canonical mode (default): every alias on the canonical row.
   *    - pre-merge mode: just this row's own aliases (pre-merge view).
   *  Only filled when withDetails. */
  aliases?: Array<{ aliasType: string; alias: string }>;
  /** Distinct source IDs that contributed a document to this person.
   *  Powers the source-icon strip on the merge cards. Scope depends
   *  on `preMerge`:
   *    - canonical mode: sources across the whole equivalence class.
   *    - pre-merge mode: just this row's directly-attributed sources.
   *  Only filled when withDetails. Capped at 6. */
  sourceIds?: string[];
  /** When this row is a merged-loser, the canonical's name. Filled
   *  only in pre-merge mode (canonical mode never returns losers). */
  mergedIntoCanonicalName?: string;
}

export interface MergeRuleWithResolved extends MergeRule {
  resolvedSideA?: ResolvedSidePerson[];
  resolvedSideB?: ResolvedSidePerson[];
}

/**
 * Snapshot emitted by `computeMergeEquivalences` and consumed by
 * `upsertMergeEquivalences`. Carries:
 *  - `equivalences`: the final (loser_id → root_id) mapping for every
 *    person that should be merged, post-component-resolution
 *  - `dirtyVersion`: captured at compute start, written back to
 *    `last_evaluated_version` on successful upsert (OCC token)
 *  - `computedAt`: ISO timestamp at compute end
 */
export interface MergeEquivalenceRow {
  fromId: string;
  toId: string;
}
export interface MergeEquivalenceSnapshot {
  equivalences: MergeEquivalenceRow[];
  dirtyVersion: number;
  computedAt: string;
  /**
   * Active rules whose two sides resolve to a single shared person —
   * the rule is doing no useful work and is auto-cleaned by the upsert
   * phase. This happens when:
   *   (a) a candidate detector false-positive proposed aliases that
   *       were already on one person; or
   *   (b) a logical user merge drifted to physical over time as new
   *       documents added the loser's alias to the canonical, then
   *       periodic shared-alias dedup deleted the loser.
   * Either way: the merge has already happened, the rule is a no-op
   * audit record, and lingering rules clutter the operator UI.
   */
  collapsedRuleIds: string[];
}

export interface UpsertMergeEquivalencesResult {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Rules deleted because both sides resolved to the same person — see
   *  `MergeEquivalenceSnapshot.collapsedRuleIds`. */
  deletedCollapsed: number;
}

/**
 * One auto-detected pair candidate. Used to seed `kind='system'` rules
 * that the rule evaluator then applies. The auto-detector finds these
 * the same way the legacy `runMergePass` did (shared identifier or
 * contact-curated multi-token canonical name) — but instead of
 * mutating `merged_into` directly, emits rule rows that flow through
 * the standard eval pipeline. This makes auto-merges equally
 * reversible to user merges (operator can deactivate a system rule
 * via the same UI / API).
 */
export interface AutoDetectedRule {
  sideA: MergeRuleSide;
  sideB: MergeRuleSide;
}

/**
 * Intermediate data structure for the IO → CPU split of merge
 * equivalences computation. The IO worker fetches this from the DB;
 * the CPU worker runs union-find + canonical selection on it.
 */
export interface MergeEquivalencesIoData {
  dirtyVersion: number;
  computedAt: string;
  resolvedRules: Array<{
    ruleId: string;
    sideA: string[];
    sideB: string[];
    winnerSide: "a" | "b";
  }>;
  collapsedRuleIds: string[];
  personMeta: Array<{ id: string; firstSeen: string; isSelf: boolean }>;
}

/**
 * Intermediate data for the auto-detect IO → CPU split.
 * IO fetches the raw shared-alias and contact-name pairs;
 * CPU maps them to AutoDetectedRule objects.
 */
export interface AutoDetectIoData {
  aliasPairs: Array<{ aliasType: string; alias: string }>;
  namePairs: Array<{ name: string }>;
}

/** Raw merge_rules row shape — internal to the merge subsystem. */
export interface MergeRuleDbRow {
  id: string;
  kind: MergeRuleKind;
  side_a_alias_type: string;
  side_a_alias: string;
  side_b_alias_type: string;
  side_b_alias: string;
  winner_side: MergeWinnerSide;
  reason: string | null;
  created_at: string;
  created_by: string | null;
  active: number;
  deactivated_at: string | null;
  group_id: string | null;
}

export const VALID_ALIAS_TYPES: ReadonlySet<string> = new Set(["email", "phone", "lid", "name"]);

/**
 * Canonicalize an alias value for rule storage. Name aliases are
 * lowercased to make the same-name match case-insensitive (an existing
 * person with name "James Bond" and another with "james BOND"
 * should be merged by a name-based rule). Other alias types are left
 * as-is (emails are already normalized at extraction time;
 * phones are E.164; LIDs are opaque).
 */
export function normalizeRuleAlias(side: MergeRuleSide): MergeRuleSide {
  if (side.aliasType === "name") {
    return { aliasType: side.aliasType, alias: side.alias.toLowerCase() };
  }
  return side;
}

/**
 * Sort the two rule sides into canonical (a, b) order so a rule
 * `(email=foo) ↔ (phone=bar)` and its mirror `(phone=bar) ↔
 * (email=foo)` map to the same row in `merge_rules`. The canonical
 * order is lexicographic on `(aliasType, alias)`. Used by every
 * rule-create path to enforce a consistent layout — the unique index
 * on the table assumes this ordering.
 *
 * `winnerSide` is flipped to track the original choice when sides
 * swap, so the user's "this side wins" intent isn't lost.
 */
export function canonicalizeRuleSides(
  sideA: MergeRuleSide,
  sideB: MergeRuleSide,
  winnerSide: MergeWinnerSide,
): { sideA: MergeRuleSide; sideB: MergeRuleSide; winnerSide: MergeWinnerSide } {
  const cmp =
    sideA.aliasType !== sideB.aliasType
      ? sideA.aliasType.localeCompare(sideB.aliasType)
      : sideA.alias.localeCompare(sideB.alias);
  if (cmp <= 0) return { sideA, sideB, winnerSide };
  return {
    sideA: sideB,
    sideB: sideA,
    winnerSide: winnerSide === "a" ? "b" : "a",
  };
}

export function mapMergeRuleRow(row: MergeRuleDbRow): MergeRule {
  return {
    id: row.id,
    kind: row.kind,
    sideA: { aliasType: row.side_a_alias_type as MergeRuleAliasType, alias: row.side_a_alias },
    sideB: { aliasType: row.side_b_alias_type as MergeRuleAliasType, alias: row.side_b_alias },
    winnerSide: row.winner_side,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    active: row.active === 1,
    deactivatedAt: row.deactivated_at,
    groupId: row.group_id,
  };
}
