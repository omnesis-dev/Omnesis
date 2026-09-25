// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { physicalMergePeopleByAlias } from "../../physical-merge.js";
import { createMergeRule } from "./rule-crud.js";
import {
  canonicalizeRuleSides,
  STRONG_IDENTIFIER_PLACEHOLDERS,
  STRONG_IDENTIFIER_TYPES,
  type AutoDetectedRule,
  type AutoDetectIoData,
  type MergeRuleAliasType,
  type MergeRuleKind,
} from "./types.js";

const log = createLogger("gateway:people");

/**
 * Pure-read scan for auto-detect candidates. Same SQL shape as the
 * legacy `computeAutoMergePairs` but emits rule sides (alias-typed
 * pairs) instead of person id pairs. There is no per-pass throttle —
 * at thousands of candidates the rule eval is fast enough not to need
 * a per-pass cap.
 *
 * Two flavors:
 *   1. Shared strong identifier (email/phone/lid) — both sides are the
 *      same alias type+value (the auto-detect case where two people
 *      happen to share an email).
 *   2. Contact-curated multi-token canonical name match — both sides
 *      use `aliasType=name` with the matched name. Only fires when
 *      both candidate people are `source='contacts'` (address book is
 *      curated; bulk-mail display labels stay out via the same
 *      restriction the legacy code had).
 */
/** IO-only: runs the GROUP BY queries, returns raw rows. */
export function fetchAutoDetectData(db: Db): AutoDetectIoData {
  const aliasPairs = db
    .prepare<string[], { alias_type: string; alias: string }>(
      `SELECT alias_type, alias
       FROM person_aliases
       WHERE alias_type IN (${STRONG_IDENTIFIER_PLACEHOLDERS})
       GROUP BY alias_type, alias
       HAVING COUNT(DISTINCT person_id) > 1`,
    )
    .all(...STRONG_IDENTIFIER_TYPES)
    .map((r) => ({ aliasType: r.alias_type, alias: r.alias }));

  const namePairs = db
    .prepare<[], { name: string }>(
      `SELECT DISTINCT LOWER(p1.canonical_name) AS name
       FROM people p1
       JOIN people p2 ON LOWER(p1.canonical_name) = LOWER(p2.canonical_name)
       WHERE p1.merged_into IS NULL
         AND p2.merged_into IS NULL
         AND p1.source = 'contacts'
         AND p2.source = 'contacts'
         AND p1.id < p2.id
         AND p1.canonical_name LIKE '% %'`,
    )
    .all();

  return { aliasPairs, namePairs };
}

/** Pure-compute: maps raw IO data to AutoDetectedRule candidates. */
export function computeAutoDetectedRulesFromData(data: AutoDetectIoData): AutoDetectedRule[] {
  const out: AutoDetectedRule[] = [];
  for (const r of data.aliasPairs) {
    const aliasType = r.aliasType as MergeRuleAliasType;
    out.push({
      sideA: { aliasType, alias: r.alias },
      sideB: { aliasType, alias: r.alias },
    });
  }
  for (const r of data.namePairs) {
    out.push({
      sideA: { aliasType: "name", alias: r.name },
      sideB: { aliasType: "name", alias: r.name },
    });
  }
  return out;
}

/** Combined IO + CPU for backward compat. */
export function computeAutoDetectedRules(db: Db): AutoDetectedRule[] {
  return computeAutoDetectedRulesFromData(fetchAutoDetectData(db));
}

/** Continuation state threaded across a yield of `upsertAutoDetectedRules`. */
export interface AutoDetectUpsertResumeState {
  candidates: AutoDetectedRule[];
  inserted: number;
  skipped: number;
}

/**
 * What one call of the applicator did. `resume` is present only when the
 * caller's preempt token asked for the writer back before the candidate set
 * was exhausted; the handler carries it into the next call.
 */
export interface AutoDetectUpsertResult {
  inserted: number;
  skipped: number;
  resume?: AutoDetectUpsertResumeState;
}

/**
 * Applicator for auto-detected matches. Two paths:
 *
 *   - **Tautology candidate** (`sideA === sideB`): physical-merge any
 *     people sharing the alias and DON'T create a rule. Strong-identifier
 *     shares (email/phone/lid) and contact-name shares both flow here —
 *     these are unambiguous-enough to merge without operator review.
 *     The previous architecture wrapped them in `kind='system'` rules
 *     so the operator could "Veto" — but vetoing
 *     `(email=X) ↔ (email=X)` was never a real judgment call, and
 *     having ~17 of these dominate the merge-rules page was pure
 *     UI noise.
 *
 *   - **Cross-identifier candidate** (`sideA !== sideB`): unchanged —
 *     insert a `kind='system'` rule, respecting any existing
 *     deactivated rule as an operator veto. (auto-detect doesn't
 *     currently produce these, but the path is preserved for future
 *     fuzzy-bridge detectors.)
 *
 * Idempotent: re-running with the same candidate set re-runs the
 * physical merges (no-ops if already merged) and re-skips existing
 * cross-identifier rules.
 *
 * Returns `{ inserted, skipped }`. `inserted` counts physical merges
 * performed PLUS rules created. `skipped` counts cross-identifier
 * candidates that hit a pre-existing rule. A `resume` alongside them means
 * the pass yielded the writer with candidates still to apply.
 */
export function upsertAutoDetectedRules(
  db: Db,
  candidates: readonly AutoDetectedRule[],
  token?: { requested(): boolean },
  resume?: AutoDetectUpsertResumeState,
): AutoDetectUpsertResult {
  // Each candidate is its own bounded unit — a physical merge of one alias
  // cluster, or one rule insert — so no single transaction is O(corpus). What
  // is unbounded is the writer occupancy across the whole candidate set, and
  // the set does not shrink to nothing: a cluster the applicator permanently
  // refuses (a shared mailbox the hub guard rejects, a pair already
  // rule-equivalent) is detected again on every pass. Poll the token between
  // candidates and hand the rest back, the way the boot-time twin
  // `physicalDedupSharedAliases` does. Carrying stale candidates across a
  // yield is safe: each is re-resolved against the live graph at apply time
  // and no-ops when the cluster has since collapsed.
  const pending = resume ? [...resume.candidates] : [...candidates];
  let inserted = resume?.inserted ?? 0;
  let skipped = resume?.skipped ?? 0;
  while (pending.length > 0) {
    const c = pending.shift()!;
    const isTautology = c.sideA.aliasType === c.sideB.aliasType && c.sideA.alias === c.sideB.alias;
    if (isTautology) {
      const { peopleMerged } = physicalMergePeopleByAlias(db, c.sideA.aliasType, c.sideA.alias);
      if (peopleMerged > 0) inserted += peopleMerged;
      // Don't bump `skipped` for already-merged tautologies — they're
      // a successful no-op, not a vetoed proposal.
      if (pending.length > 0 && token?.requested()) {
        return { inserted, skipped, resume: { candidates: pending, inserted, skipped } };
      }
      continue;
    }

    // Cross-identifier path (legacy, currently unreachable from
    // computeAutoDetectedRules but kept for forward-compat with any
    // future fuzzy-bridge auto-detectors).
    const canon = canonicalizeRuleSides(c.sideA, c.sideB, "a");
    const existing = db
      .prepare<
        [string, string, string, string],
        { id: string; active: number; kind: MergeRuleKind }
      >(
        `SELECT id, active, kind FROM merge_rules
         WHERE side_a_alias_type = ? AND side_a_alias = ?
           AND side_b_alias_type = ? AND side_b_alias = ?
           AND kind = 'system'
         LIMIT 1`,
      )
      .get(canon.sideA.aliasType, canon.sideA.alias, canon.sideB.aliasType, canon.sideB.alias);
    if (existing) {
      skipped += 1;
    } else {
      createMergeRule(db, {
        sideA: c.sideA,
        sideB: c.sideB,
        winnerSide: "a",
        kind: "system",
        reason: null,
      });
      inserted += 1;
    }
    if (pending.length > 0 && token?.requested()) {
      return { inserted, skipped, resume: { candidates: pending, inserted, skipped } };
    }
  }
  if (inserted > 0) {
    log.info(`Auto-detect: ${inserted} merges/rules applied (${skipped} pre-existing skipped)`);
  }
  return { inserted, skipped };
}
