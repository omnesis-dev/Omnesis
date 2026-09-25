// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty } from "./data/DirtyMarks.js";
export { markPeopleGraphDirty, markMergeRulesDirty };

const log = createLogger("gateway:people");

// ─── Lookup + person query helpers (PersonRepository) ──────────────

export {
  findAliasOwnerAndCanonical,
  findPersonByAlias,
  AliasLookupCache,
  findAliasOwnerCached,
  findPersonByAliasCached,
  getPersonById,
  searchPeople,
  resolvePersonIdsFromQuery,
  computePeopleCounts,
  upsertPeopleCounts,
  refreshPeopleCounts,
} from "./data/repositories/PersonRepository.js";
export type {
  AliasResolution,
  PersonAlias,
  MergedFromPerson,
  PersonDetail,
  PersonSummary,
  PersonSortBy,
  PeopleCountRow,
} from "./data/repositories/PersonRepository.js";

// ─── Resolution (PeopleResolutionService) ──────────────────────────

export {
  resolvePersonId,
  findOrCreatePerson,
  resolveDocumentPeople,
  backfillOnePerson,
  backfillManyPeople,
} from "./domain/PeopleResolutionService.js";

// `resolvePersonId` is re-exported above and *also* imported here for
// internal use (computeTransitiveCollapse). `export ... from` doesn't
// bring the symbol into this module's value namespace, so the local
// `import` is required, not redundant. This pair
// disappears when computeTransitiveCollapse moves out as part of
// `merge-service-decomposition`.
import { resolvePersonId } from "./domain/PeopleResolutionService.js";

// ─── Seeding from contact documents (ContactCardBootstrap) ─────────

export {
  computeSeedFromContacts,
  upsertSeedFromContacts,
  seedFromContacts,
  detectSelfFromSourceIds,
} from "./domain/ContactCardBootstrap.js";
export type { SeedContactDoc, SeedFromContactsPlan } from "./domain/ContactCardBootstrap.js";

// ─── Merge (MergeService) ──────────────────────────────────────────

export {
  mergePeople,
  unmergePerson,
  createMergeRule,
  deleteMergeRule,
  deleteMergeRuleGroup,
  listMergeRules,
  countMergeRules,
  getMergeRuleById,
  resolveAliasSide,
  readMergeRulesMeta,
  computeMergeEquivalences,
  upsertMergeEquivalences,
  computeAutoDetectedRules,
  upsertAutoDetectedRules,
  rebuildPeopleFromDocuments,
} from "./domain/MergeService.js";
export type {
  MergeRuleAliasType,
  MergeRuleKind,
  MergeWinnerSide,
  MergeRuleSide,
  MergeRule,
  CreateMergeRuleInput,
  CreateMergeRuleResult,
  ListMergeRulesOpts,
  ResolvedSidePerson,
  MergeRuleWithResolved,
  MergeEquivalenceRow,
  MergeEquivalenceSnapshot,
  UpsertMergeEquivalencesResult,
  AutoDetectedRule,
} from "./domain/MergeService.js";

// `pickWinner` is internal-only (drives `pickMergeWinner` below); the
// other four are already re-exported above and re-imported here for
// `runMergePass`'s local use. Local import is
// required because `export ... from` doesn't add the symbols to the
// value namespace. The pair-shape disappears when runMergePass moves
// out under `merge-service-decomposition`.
import {
  pickWinner,
  computeMergeEquivalences,
  upsertMergeEquivalences,
  computeAutoDetectedRules,
  upsertAutoDetectedRules,
} from "./domain/MergeService.js";
import { STRONG_IDENTIFIER_PLACEHOLDERS, STRONG_IDENTIFIER_TYPES } from "./domain/merge/types.js";

// ─── Interaction scores (InteractionScoreService) ──────────────────

export {
  computeInteractionScores,
  upsertInteractionScores,
  readInteractionScoresMeta,
  refreshInteractionScores,
} from "./domain/InteractionScoreService.js";
export type {
  InteractionScoreRow,
  InteractionScoresSnapshot,
} from "./domain/InteractionScoreService.js";

// ─── Document/person link helpers (DocumentPeopleRepository) ───────

export {
  getDocumentPeople,
  getDocumentsPeopleSummary,
  getPersonDocuments,
  getSelfPersonId,
  getPeopleStats,
  type DocumentPeopleSummary,
  type PersonDocumentEntry,
} from "./data/repositories/DocumentPeopleRepository.js";

/** People-table portion of the stats summary. Owned here pending the
 *  rest of the people-stats split — see DocumentPeopleRepository.getPeopleStats. */
export interface PeopleBaseStats {
  totalPeople: number;
  totalAliases: number;
  totalLinks: number;
  selfDetected: boolean;
}

/** Full payload returned by `GET /people/stats`: the people-table counts
 *  plus the merge-queue summary the People list view badges on its two
 *  shortcut buttons. `pendingMergeCandidates` mirrors the candidates
 *  screen's default (pending) filter; `mergeRules` counts active rules. */
export interface PeopleStats extends PeopleBaseStats {
  pendingMergeCandidates: number;
  mergeRules: number;
}

/** One-row view of a person attached to a specific document, with their
 *  role in that doc. Owned here because it's a cross-table shape, not a
 *  single-table row; consumed by document detail surfaces. */
export interface DocumentPersonLink {
  personId: string;
  canonicalName: string;
  role: string;
  isSelf: boolean;
  aliases: import("./data/repositories/PersonRepository.js").PersonAlias[];
}

// ─── Merge candidates (kept here pending merge-service-decomposition) ─

/**
 * A merge pair: two people that match on either a strong identifier
 * (email/phone/lid) or a contact-sourced multi-token canonical name.
 * The actual merge winner/loser is decided per-pair via `pickMergeWinner`
 * at execution time (so a chain of merges sees the latest state).
 *
 * Distinct from `MergeCandidateProposal` (in `merge-candidates.ts`),
 * which is the fuzzy-scored proposal shape destined for the
 * user-review `merge_candidates` table.
 */
export interface AutoMergePair {
  personA: string;
  personB: string;
  /** "alias" for identifier matches, "name" for contact-name matches. */
  reason: "alias" | "name";
}

/**
 * Pure-read scan for auto-merge pairs. Used by the backfill worker
 * to drive a distributed merge pass — it computes the list on its
 * own read handle and dispatches one `mergePeople` writer call per
 * pair, so each pair is a small writer op that the priority queue
 * can interleave with user/realtime work.
 *
 * Capped per-step to 50 pairs (matches `runMergePass`) to bound the
 * worst-case backfill tick. The next tick (10 min later) picks up
 * any remaining candidates.
 *
 * Distinct from `computeFuzzyMergeCandidates` in `merge-candidates.ts`,
 * which scores cross-identifier candidates for the user-review queue;
 * this function only emits exact-match pairs that flow into automatic
 * merges.
 */
export function computeAutoMergePairs(db: Db, perStepLimit = 50): AutoMergePair[] {
  const out: AutoMergePair[] = [];
  const aliasPairs = db
    .prepare<[...string[], number], { person_a: string; person_b: string }>(
      `SELECT a1.person_id as person_a, a2.person_id as person_b
       FROM person_aliases a1
       JOIN person_aliases a2 ON a1.alias = a2.alias AND a1.alias_type = a2.alias_type
       JOIN people p1 ON a1.person_id = p1.id AND p1.merged_into IS NULL
       JOIN people p2 ON a2.person_id = p2.id AND p2.merged_into IS NULL
       WHERE a1.person_id < a2.person_id
         AND a1.alias_type IN (${STRONG_IDENTIFIER_PLACEHOLDERS})
       LIMIT ?`,
    )
    .all(...STRONG_IDENTIFIER_TYPES, perStepLimit);
  for (const r of aliasPairs)
    out.push({ personA: r.person_a, personB: r.person_b, reason: "alias" });

  const namePairs = db
    .prepare<[number], { person_a: string; person_b: string }>(
      `SELECT p1.id as person_a, p2.id as person_b
       FROM people p1
       JOIN people p2 ON LOWER(p1.canonical_name) = LOWER(p2.canonical_name)
       WHERE p1.merged_into IS NULL
         AND p2.merged_into IS NULL
         AND p1.source = 'contacts'
         AND p2.source = 'contacts'
         AND p1.id < p2.id
         AND p1.canonical_name LIKE '% %'
       LIMIT ?`,
    )
    .all(perStepLimit);
  for (const r of namePairs) out.push({ personA: r.person_a, personB: r.person_b, reason: "name" });

  return out;
}

/** One row in the result of `computeTransitiveCollapse`. */
export interface TransitiveCollapseRow {
  /** Person whose `merged_into` should be repointed to `rootId`. */
  personId: string;
  /** Direct root (`merged_into IS NULL`) for this chain. */
  rootId: string;
  /**
   * The `merged_into` value compute observed for `personId`. Writer
   * uses this as an optimistic-concurrency token: if a concurrent
   * `mergePeople` shifted `merged_into` between compute and upsert,
   * the writer's UPDATE sees no row to change and skips it (next
   * collapse pass picks it up).
   */
  expectedMergedInto: string;
}

/**
 * Pure-read companion to `upsertTransitiveCollapse`. For every person
 * with `merged_into IS NOT NULL`, walks the chain to its root and
 * emits ONLY rows whose current `merged_into` differs from that root
 * (i.e. rows the writer actually needs to touch).
 *
 * Designed to run on a read-only handle (IO worker) so the
 * heavy chain-walk doesn't park the writer worker. Uses the same
 * 10-hop limit as `resolvePersonId`; chains deeper than 10 hops are
 * partially collapsed and the next pass picks up the residue.
 */
export function computeTransitiveCollapse(db: Db): TransitiveCollapseRow[] {
  const rows = db
    .prepare<
      [],
      { id: string; merged_into: string }
    >("SELECT id, merged_into FROM people WHERE merged_into IS NOT NULL")
    .all();
  const out: TransitiveCollapseRow[] = [];
  for (const row of rows) {
    const root = resolvePersonId(db, row.merged_into);
    if (root === row.merged_into) continue; // already direct — nothing to write
    out.push({
      personId: row.id,
      rootId: root,
      expectedMergedInto: row.merged_into,
    });
  }
  return out;
}

/**
 * Pure-write companion to `computeTransitiveCollapse`. Repoints each
 * person's `merged_into` to its resolved root in a single transaction.
 *
 * Optimistic-concurrency invariant: the WHERE clause includes the
 * `merged_into` value compute observed (`expectedMergedInto`). If a
 * concurrent `mergePeople` shifted that value between compute and
 * upsert, the UPDATE matches no row, the row is skipped, and the
 * next collapse pass re-resolves it. This prevents the writer from
 * clobbering a fresh merge with a stale root.
 */
export function upsertTransitiveCollapse(
  db: Db,
  rows: TransitiveCollapseRow[],
): { collapsed: number } {
  if (rows.length === 0) return { collapsed: 0 };

  const updateStmt = db.prepare(
    "UPDATE people SET merged_into = ? WHERE id = ? AND merged_into = ?",
  );

  let collapsed = 0;
  const apply = db.transaction((batch: TransitiveCollapseRow[]) => {
    for (const row of batch) {
      const result = updateStmt.run(row.rootId, row.personId, row.expectedMergedInto);
      if (result.changes > 0) collapsed++;
    }
  });
  apply(rows);

  return { collapsed };
}

/**
 * Resolve transitive merges (people whose `merged_into` points at
 * another already-merged person). Idempotent. Back-compat wrapper
 * around `computeTransitiveCollapse` + `upsertTransitiveCollapse` for
 * callers that hold a writable handle (tests, `runMergePass`).
 *
 * The Scheduler-driven `peopleCountsRefreshTask` instead splits the two halves
 * across the compute + writer runners explicitly.
 */
export function collapseTransitiveChains(db: Db): { collapsed: number } {
  return upsertTransitiveCollapse(db, computeTransitiveCollapse(db));
}

/**
 * Public wrapper around `pickWinner` so the backfill worker can
 * decide a winner on its read handle before dispatching the merge
 * to the writer. Uses the same first-seen tiebreaker.
 */
export function pickMergeWinner(db: Db, a: string, b: string): { winner: string; loser: string } {
  return pickWinner(db, a, b);
}

/**
 * Combined auto-detect + rule eval pass. Used by tests + admin one-shot
 * operations. The scheduler-driven path splits this into (a)
 * `computeAutoDetectedRules` + `upsertAutoDetectedRules` on the writer
 * (cheap inserts/physical merges) and (b) `computeMergeEquivalences` +
 * `upsertMergeEquivalences` on the writer (chunked yieldable).
 *
 * Returns the total count of merges produced — physical merges from
 * the auto-detect phase (shared-identifier dedup) PLUS new logical
 * equivalences from the rules-eval phase (cross-identifier bridges).
 * Both shapes count toward the user-visible "this run merged N
 * people" summary.
 */
export function runMergePass(db: Db): { merged: number } {
  // Phase 1: auto-detect candidates → physical merges for shared
  // identifiers; cross-identifier rules (none from current detector)
  // would create system rules. `inserted` here is the count of
  // physical merges + new system rules combined.
  const candidates = computeAutoDetectedRules(db);
  const autoDetect = upsertAutoDetectedRules(db, candidates);

  // Phase 2: evaluate active rules → equivalences → merged_into.
  const before =
    db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_equivalences").get()?.c ?? 0;
  const snapshot = computeMergeEquivalences(db);
  upsertMergeEquivalences(db, snapshot);
  const after = snapshot.equivalences.length;

  const newEquivalences = Math.max(0, after - before);
  const merged = autoDetect.inserted + newEquivalences;
  if (merged > 0) {
    log.info(
      `Merge pass: ${candidates.length} candidates considered, ` +
        `${autoDetect.inserted} physical merges + ${newEquivalences} new equivalences`,
    );
  }
  return { merged };
}
