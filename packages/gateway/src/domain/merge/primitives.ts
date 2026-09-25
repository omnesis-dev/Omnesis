// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { markPeopleGraphDirty } from "../../data/DirtyMarks.js";

const log = createLogger("gateway:people");

/**
 * Logical merge: mark `loserId` as merged into `winnerId` by setting
 * `loser.merged_into = winnerId`. NO data is physically moved —
 * `person_aliases` and `document_people` rows stay on their original
 * person. Read paths (`getPersonById`, `getDocumentPeople`,
 * `computeInteractionScores`, `computePeopleCounts`, `searchPeople`)
 * dereference through `merged_into` (or its transitively-collapsed
 * version) to attribute aliases / documents / scores to the canonical
 * person.
 *
 * This is the logical-merge shape — the alternative to a "physical
 * merge" that moves aliases + document_people. The
 * non-movement is the property that makes unmerge cheap (just clear
 * `merged_into`) and rule-based: `mergeRulesEvalTask` re-derives
 * `merged_into` from active rules every cycle.
 *
 * Direct callers (tests, admin merge endpoint) get the same observable
 * post-merge state via the read-path dereferencing. Loser keeps its
 * `is_self`, `canonical_name`, `source` columns intact — they're never
 * read for the loser since `searchPeople` filters `merged_into IS NULL`
 * and detail/aggregation queries dereference to the canonical first.
 */
export function mergePeople(db: Db, winnerId: string, loserId: string): void {
  if (winnerId === loserId) return;

  // Update winner's date range so it spans both — the canonical's
  // first_seen / last_seen should reflect the union of both lifetimes.
  // The loser's row keeps its own first_seen / last_seen unchanged
  // (never user-visible since searchPeople filters merged_into IS NULL).
  const loser = db
    .prepare<
      [string],
      { first_seen: string; last_seen: string }
    >("SELECT first_seen, last_seen FROM people WHERE id = ?")
    .get(loserId);

  const now = new Date().toISOString();
  if (loser) {
    db.prepare(
      `UPDATE people SET
         first_seen = MIN(first_seen, ?),
         last_seen = MAX(last_seen, ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(loser.first_seen, loser.last_seen, now, winnerId);
  }

  // The merged_into pointer is the only state change. Read paths
  // follow it via `resolvePersonId` (chain walk) or `COALESCE(merged_into, id)`
  // in aggregations.
  db.prepare("UPDATE people SET merged_into = ?, updated_at = ? WHERE id = ?").run(
    winnerId,
    now,
    loserId,
  );

  // Score graph reshuffled — interaction scores need re-attribution.
  markPeopleGraphDirty(db);

  log.debug(`Merged person ${loserId} into ${winnerId} (logical)`);
}

/**
 * Inverse of `mergePeople`: clear `merged_into` on `personId`. Aliases
 * and document_people rows haven't moved, so reverting the
 * `merged_into` pointer fully restores the loser to its pre-merge state.
 *
 * Used by the merge-rule evaluator when a rule that was holding two
 * people merged gets deactivated and the equivalence class breaks.
 */
export function unmergePerson(db: Db, personId: string): void {
  const result = db
    .prepare(
      "UPDATE people SET merged_into = NULL, updated_at = ? WHERE id = ? AND merged_into IS NOT NULL",
    )
    .run(new Date().toISOString(), personId);
  if (result.changes > 0) {
    markPeopleGraphDirty(db);
    log.debug(`Unmerged person ${personId}`);
  }
}

export function pickWinner(db: Db, a: string, b: string): { winner: string; loser: string } {
  const pA = db
    .prepare<[string], { first_seen: string }>("SELECT first_seen FROM people WHERE id = ?")
    .get(a);
  const pB = db
    .prepare<[string], { first_seen: string }>("SELECT first_seen FROM people WHERE id = ?")
    .get(b);
  const winner = (pA?.first_seen ?? "") <= (pB?.first_seen ?? "") ? a : b;
  return { winner, loser: winner === a ? b : a };
}
