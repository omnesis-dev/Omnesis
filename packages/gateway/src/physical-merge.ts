// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Physical merge primitive + helpers.
 *
 * For unambiguous-identifier dedup (two `people` rows carrying the same
 * email / phone / lid). Strong identifiers can't be shared by distinct
 * digital identities, so this collapse is non-reversible by design —
 * unlike `mergePeople` (logical, sets `merged_into`), this physically
 * moves aliases + document_people from loser → winner and DELETES the
 * loser row.
 *
 * Distinction from the rule-driven logical merge (people.ts:mergePeople):
 *
 *   - Logical merge: `loser.merged_into = winner`. Aliases + docs stay
 *     on loser. Reads dereference. Reversible. Used for cross-identifier
 *     bridges (operator + fuzzy candidate accept).
 *
 *   - Physical merge: aliases + docs *move*; loser is deleted. The
 *     `merge_rules` table never references this collapse. Reversibility
 *     is impossible — but for "two rows share an email", the merge is
 *     a write-time invariant, not a judgment call, so reversibility is
 *     unwanted.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

import { createLogger } from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty, resolvePersonId } from "./people.js";
import { isHubPerson, distinctNameGroups } from "./domain/MergeCandidateDetector.js";

const log = createLogger("gateway:physical-merge");

// The strong-identifier list lives with the alias types it is a subset of.
import { STRONG_IDENTIFIER_PLACEHOLDERS, STRONG_IDENTIFIER_TYPES } from "./domain/merge/types.js";

export interface PhysicalMergeResult {
  aliasesMoved: number;
  aliasesDuplicateDropped: number;
  docPeopleMoved: number;
  docPeopleDuplicateDropped: number;
}

export class PhysicalMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhysicalMergeError";
  }
}

/**
 * Collapse `loserId` into `winnerId` by physically moving every alias
 * and document_people edge from loser to winner, then deleting the
 * loser row. Atomic — wrapped in a single SQLite transaction; partial
 * failure rolls back. Idempotent in the trivial sense (a no-op if the
 * loser doesn't exist; refuses if loser is the self-person).
 *
 * Returns counts so callers / tests can assert what moved vs. what was
 * a duplicate that got cascade-deleted on the loser row.
 *
 * After the merge:
 *   - All `person_aliases` previously on loser are now on winner.
 *   - All `document_people` edges are on winner.
 *   - Any `person_equivalences` rows referencing loser are dropped
 *     (these are derived state — the next eval pass rebuilds them).
 *   - `interaction_scores_meta.dirty_version` is bumped — the periodic
 *     refresh will recompute scores for winner with its new alias set.
 *   - `merge_rules_meta.dirty_version` is bumped — the alias graph
 *     changed, so dormant rules might wake or the graph might shrink.
 */
export function physicalMergePeople(
  db: Db,
  opts: { loserId: string; winnerId: string; reason?: string },
): PhysicalMergeResult {
  const { loserId, winnerId, reason } = opts;

  if (loserId === winnerId) {
    throw new PhysicalMergeError(
      `physicalMergePeople: loserId and winnerId are the same (${loserId})`,
    );
  }

  const loser = db
    .prepare<
      [string],
      { id: string; is_self: number; first_seen: string; last_seen: string }
    >("SELECT id, is_self, first_seen, last_seen FROM people WHERE id = ?")
    .get(loserId);
  const winnerExists = db
    .prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?")
    .get(winnerId);

  if (!winnerExists) {
    throw new PhysicalMergeError(`physicalMergePeople: winner ${winnerId} does not exist`);
  }
  if (!loser) {
    // Already deleted — physical merge is a no-op. Return zeros so
    // callers can blindly retry without extra existence checks.
    return {
      aliasesMoved: 0,
      aliasesDuplicateDropped: 0,
      docPeopleMoved: 0,
      docPeopleDuplicateDropped: 0,
    };
  }
  if (loser.is_self === 1) {
    throw new PhysicalMergeError(
      `physicalMergePeople: refusing to delete is_self=TRUE person ${loserId} ` +
        `(caller must pick the self-person as the winner)`,
    );
  }

  // Single transaction so a partial failure can't leave the DB
  // half-merged. SQLite raises on the inner `run` calls if any
  // constraint trips — the transaction rolls back automatically.
  const txn = db.transaction((): PhysicalMergeResult => {
    // Move aliases that don't already exist on winner. The unique
    // constraint is `(alias_type, alias, person_id)`, so a winner
    // already carrying the same `(alias_type, alias)` would collide.
    // Skip those — they'll cascade-delete with the loser row in the
    // final DELETE.
    const aliasesBefore = countAliases(db, loserId);
    const aliasMove = db
      .prepare(
        `UPDATE person_aliases SET person_id = ?
         WHERE person_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM person_aliases pa2
             WHERE pa2.person_id = ?
               AND pa2.alias_type = person_aliases.alias_type
               AND pa2.alias = person_aliases.alias
           )`,
      )
      .run(winnerId, loserId, winnerId);
    const aliasesMoved = aliasMove.changes;
    const aliasesDuplicateDropped = aliasesBefore - aliasesMoved;

    // The duplicates that stayed behind are about to cascade away with the
    // loser, and `person_alias_assertions` cascades with them. Those rows are
    // the record of which sources vouch for the identifier, and the two people
    // being merged are two people precisely because they shared one — so the
    // duplicate almost always carries a voucher the winner's copy does not.
    //
    // Losing it means the surviving row is vouched for by fewer sources than
    // actually assert it, and removing one of those later takes an identifier
    // the others still hold. That is the exact chain migration 172 exists to
    // break, reached through the merge path instead of the insert path.
    db.prepare(
      `INSERT INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
       SELECT winner.id, a.source_id, a.first_seen, a.last_seen
         FROM person_alias_assertions a
         JOIN person_aliases loser ON loser.id = a.alias_id AND loser.person_id = ?
         JOIN person_aliases winner
           ON winner.person_id = ?
          AND winner.alias_type = loser.alias_type
          AND winner.alias = loser.alias
          ON CONFLICT(alias_id, source_id) DO UPDATE SET
            first_seen = MIN(person_alias_assertions.first_seen, excluded.first_seen),
            last_seen = MAX(person_alias_assertions.last_seen, excluded.last_seen)`,
    ).run(loserId, winnerId);

    // Move document_people edges that don't conflict on the composite
    // PK `(document_id, person_id, role)`. Conflicts (same doc + same
    // role on winner already) are skipped and cascade-delete with the
    // loser row.
    const docPeopleBefore = countDocPeople(db, loserId);
    const dpMove = db
      .prepare(
        `UPDATE document_people SET person_id = ?
         WHERE person_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM document_people dp2
             WHERE dp2.document_id = document_people.document_id
               AND dp2.person_id = ?
               AND dp2.role = document_people.role
           )`,
      )
      .run(winnerId, loserId, winnerId);
    const docPeopleMoved = dpMove.changes;
    const docPeopleDuplicateDropped = docPeopleBefore - docPeopleMoved;

    // Move the cognitive-graph person backlinks from loser → winner. These
    // tables carry NO foreign key to `people`, so a loser-keyed row neither
    // cascade-deletes nor moves on its own — it would dangle under the
    // about-to-be-deleted loser id and vanish from the canonical person's
    // reads. `person_annotations` has a unique `id` PK so every row moves; the
    // composite-PK join tables move the non-conflicting rows (`UPDATE OR
    // IGNORE`) then drop the conflicting remainder (which cannot cascade).
    db.prepare("UPDATE person_annotations SET person_id = ? WHERE person_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare(
      "UPDATE OR IGNORE temporal_annotation_people SET person_id = ? WHERE person_id = ?",
    ).run(winnerId, loserId);
    db.prepare("DELETE FROM temporal_annotation_people WHERE person_id = ?").run(loserId);
    db.prepare("UPDATE OR IGNORE open_loop_people SET person_id = ? WHERE person_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("DELETE FROM open_loop_people WHERE person_id = ?").run(loserId);

    const now = new Date().toISOString();

    // Drop derived state referring to loser — `person_equivalences` is
    // rebuilt on the next merge-rules eval pass, so we don't have to
    // care about transitively-merged-in losers here.
    db.prepare("DELETE FROM person_equivalences WHERE from_id = ? OR to_id = ?").run(
      loserId,
      loserId,
    );

    // Clear any `people.merged_into` pointer aimed at the loser. Without
    // this, deleting the loser leaves dangling pointers — `merged_into`
    // has no FK constraint, so resolvePersonId returns the deleted id
    // and downstream `addNewAliases` etc. crash with FK errors. Common
    // case: a user rule already mapped winner→loser via the eval task
    // before this physical pass picks loser as the one to delete (rule
    // eval picks canonical by `is_self > earliest first_seen` and
    // physical-dedup picks the same — but the rule's resolution can
    // pick the OPPOSITE direction when only one side has the alias
    // post-merge). NULLing the dangling pointers is safe: the next
    // eval pass re-derives merged_into from active rules.
    const cleared = db
      .prepare("UPDATE people SET merged_into = NULL, updated_at = ? WHERE merged_into = ?")
      .run(now, loserId);
    if (cleared.changes > 0) {
      log.warn(
        `physicalMergePeople: cleared ${cleared.changes} merged_into pointer(s) ` +
          `dangling at deleted loser ${loserId}`,
      );
    }

    // Update winner's first_seen / last_seen to span both lifetimes —
    // mirrors the bookkeeping in mergePeople so the canonical reflects
    // the union timeline.
    db.prepare(
      `UPDATE people SET
         first_seen = MIN(first_seen, ?),
         last_seen = MAX(last_seen, ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(loser.first_seen, loser.last_seen, now, winnerId);

    // Final delete — cascades through `person_aliases` and
    // `document_people` (FK ON DELETE CASCADE), removing any rows we
    // didn't move because of duplicate-key conflicts.
    db.prepare("DELETE FROM people WHERE id = ?").run(loserId);

    // Bump dirty versions so periodic tasks recompute. Single bump per
    // merge — the calling loop in `physicalDedupSharedAliases` may do
    // many merges, but every bump compounds and the next refresh
    // catches up.
    markMergeRulesDirty(db);
    markPeopleGraphDirty(db);

    return {
      aliasesMoved,
      aliasesDuplicateDropped,
      docPeopleMoved,
      docPeopleDuplicateDropped,
    };
  });

  const result = txn();
  log.info(
    `Physical merge ${loserId} → ${winnerId}: aliases moved=${result.aliasesMoved} ` +
      `dropped=${result.aliasesDuplicateDropped}, ` +
      `doc_people moved=${result.docPeopleMoved} dropped=${result.docPeopleDuplicateDropped}` +
      (reason ? ` (${reason})` : ""),
  );
  return result;
}

function countAliases(db: Db, personId: string): number {
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM person_aliases WHERE person_id = ?")
      .get(personId)?.n ?? 0
  );
}

function countDocPeople(db: Db, personId: string): number {
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_people WHERE person_id = ?")
      .get(personId)?.n ?? 0
  );
}

// ─── Strong-identifier dedup ────────────────────────────────────────

export interface PhysicalDedupResult {
  clustersProcessed: number;
  peopleMerged: number;
}

/** One strong-identifier cluster key (a `(aliasType, alias)` pair). */
export type DedupCluster = { alias_type: string; alias: string };

/**
 * Yieldable result of {@link physicalDedupSharedAliases}. When `done` is
 * false, `resumeClusters` holds the clusters not yet processed — the handler
 * carries them (plus the running counts) into the next call's resume state.
 */
export interface PhysicalDedupYieldable extends PhysicalDedupResult {
  done: boolean;
  resumeClusters: DedupCluster[];
}

/** Continuation state threaded across a yield of `physicalDedupSharedAliases`. */
export interface PhysicalDedupResumeState {
  clusters: DedupCluster[];
  clustersProcessed: number;
  peopleMerged: number;
}

interface PersonRow {
  id: string;
  is_self: number;
  first_seen: string;
}

/**
 * Collapse every `people` row sharing the given `(aliasType, alias)`
 * into a single canonical via physical merge. Returns the number of
 * losers actually deleted. No-op when fewer than 2 rows carry the
 * alias.
 *
 * Cluster membership depends on the alias type:
 *
 *   - Strong identifiers (email/phone/lid) — any row owning the alias.
 *     Sharing one of these means same identity, whatever the source.
 *
 *   - `name` — only contact-curated canonical rows (`source='contacts'`,
 *     `merged_into IS NULL`) whose *canonical* name matches. A name is
 *     not an identifier: two humans share one routinely, and an
 *     extracted display label is not evidence of identity. The only
 *     producer of name clusters is auto-detect's contact-card pass,
 *     which proposes a name only when two curated cards carry it as
 *     their canonical name; membership is scoped to the same set so a
 *     merge — which DELETES the loser, irreversibly — can never reach a
 *     bystander who merely carries the string as one of their aliases.
 *
 * Winner-picking is deterministic (see `pickWinner`).
 */
export function physicalMergePeopleByAlias(
  db: Db,
  aliasType: string,
  alias: string,
): { peopleMerged: number; winnerId: string | null } {
  // Names are case-insensitive (mirrors the rule-eval semantics in
  // computeMergeEquivalences); strong identifiers are exact-match
  // because they're already normalized at ingest time (email lower,
  // phone E.164, lid opaque).
  const sql =
    aliasType === "name"
      ? `SELECT p.id, p.is_self, p.first_seen
       FROM people p
       WHERE LOWER(p.canonical_name) = LOWER(?)
         AND p.source = 'contacts'
         AND p.merged_into IS NULL`
      : `SELECT DISTINCT p.id, p.is_self, p.first_seen
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       WHERE pa.alias_type = ? AND pa.alias = ?`;
  const rows =
    aliasType === "name"
      ? db.prepare<[string], PersonRow>(sql).all(alias)
      : db.prepare<[string, string], PersonRow>(sql).all(aliasType, alias);

  if (rows.length < 2) {
    return { peopleMerged: 0, winnerId: rows[0]?.id ?? null };
  }

  // Shared-mailbox guard. A strong identifier shared by people who carry ≥2
  // distinct personal names is a shared mailbox — a household's joint address,
  // a forwarding alias, a couple's phone — not one digital identity. Physically
  // merging would irreversibly DELETE a distinct human (and, when the winner is
  // self, fold a family member into the operator). Skip it: read paths tolerate
  // the duplicate alias, and a genuinely-same person can still be logical-merged
  // by the operator. Inert for `name` clusters (their members share the name).
  if (aliasType !== "name") {
    const clusterNames = db
      .prepare<string[], { alias: string }>(
        `SELECT alias FROM person_aliases
         WHERE alias_type = 'name' AND person_id IN (${rows.map(() => "?").join(",")})`,
      )
      .all(...rows.map((r) => r.id))
      .map((r) => r.alias);
    if (isHubPerson(clusterNames)) {
      log.warn(
        `physicalMergePeopleByAlias: refusing shared ${aliasType}=${alias} — fronts ` +
          `${distinctNameGroups(clusterNames)} distinct people (shared mailbox); not merging`,
      );
      return { peopleMerged: 0, winnerId: pickWinner(rows).id };
    }
  }

  const winner = pickWinner(rows);
  const losers = rows.filter((r) => r.id !== winner.id);
  let peopleMerged = 0;
  let stickySkipped = 0;
  // The winner's canonical (walks merged_into). Losers whose canonical
  // matches this are already in the same rule-derived equivalence class
  // and should NOT be physical-merged — that would destroy the loser
  // identity even though the operator (or system rule) only asserted a
  // logical merge. Read paths union aliases across the equivalence
  // class anyway, so the duplicate alias is benign.
  //
  // This is the sticky-logical-merge fix. Without it, every gateway
  // boot triggers `seedFromContacts` to re-attach contact-card aliases
  // to canonicals via merged_into walks, then `physicalDedupSharedAliases`
  // sees the duplicate and silently deletes the logical loser. With
  // it, logical merges survive boots indefinitely.
  const winnerCanonical = resolvePersonId(db, winner.id);
  for (const loser of losers) {
    if (resolvePersonId(db, loser.id) === winnerCanonical) {
      stickySkipped += 1;
      continue;
    }
    try {
      physicalMergePeople(db, {
        loserId: loser.id,
        winnerId: winner.id,
        reason: `shared ${aliasType}=${alias}`,
      });
      peopleMerged += 1;
    } catch (err) {
      log.warn(
        `physicalMergePeopleByAlias: failed to merge ${loser.id} → ${winner.id} ` +
          `(shared ${aliasType}=${alias}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (stickySkipped > 0) {
    log.info(
      `physicalMergePeopleByAlias: skipped ${stickySkipped} would-be physical merge(s) on shared ${aliasType}=${alias} — already rule-equivalent (sticky logical merge)`,
    );
  }
  return { peopleMerged, winnerId: winner.id };
}

/**
 * Find every cluster of `people` rows sharing a strong-identifier alias
 * (email, phone, lid) and physical-merge them. The winner inside each
 * cluster is picked deterministically:
 *
 *   1. is_self=TRUE wins (only one self row should exist per workspace;
 *      if there's a tie we still want self to survive)
 *   2. earliest first_seen wins
 *   3. lex-smallest id breaks any remaining tie
 *
 * Returns counts. Idempotent — running on a clean DB is a no-op.
 *
 * Strong identifiers are normally unambiguous — two distinct digital
 * identities don't share an email or phone — so there's no operator veto
 * step. The one exception is a genuinely shared mailbox (a household's
 * joint address, a forwarding alias): `physicalMergePeopleByAlias` guards
 * against it by refusing to merge a cluster that fronts ≥2 distinct
 * personal names, so a family member is never irreversibly folded into
 * another person (or into self).
 *
 * Restricted to email/phone/lid. Name shares are intentionally excluded
 * — the contact-name path runs through `physicalMergePeopleByAlias`
 * with explicit gating in auto-detect.
 */
export function physicalDedupSharedAliases(
  db: Db,
  token?: { requested(): boolean },
  resume?: PhysicalDedupResumeState,
): PhysicalDedupYieldable {
  let clusters: DedupCluster[];
  let clustersProcessed: number;
  let peopleMerged: number;
  if (resume) {
    clusters = [...resume.clusters]; // own a mutable copy — we shift() below
    clustersProcessed = resume.clustersProcessed;
    peopleMerged = resume.peopleMerged;
  } else {
    const placeholders = STRONG_IDENTIFIER_PLACEHOLDERS;
    clusters = db
      .prepare<string[], DedupCluster>(
        `SELECT alias_type, alias
         FROM person_aliases
         WHERE alias_type IN (${placeholders})
         GROUP BY alias_type, alias
         HAVING COUNT(DISTINCT person_id) > 1`,
      )
      .all(...STRONG_IDENTIFIER_TYPES);
    clustersProcessed = 0;
    peopleMerged = 0;
  }

  // Each `physicalMergePeopleByAlias` is its own bounded transaction, so no
  // single transaction is O(corpus); the only cost is writer occupancy across
  // the whole cluster set. Poll the token between clusters and hand the
  // remaining cluster keys back on a yield. Carrying stale keys across the
  // yield is safe: `physicalMergePeopleByAlias` re-resolves each cluster's
  // live membership at call time and no-ops when <2 rows carry the alias, so a
  // concurrent merge that already collapsed a carried cluster just makes it a
  // no-op.
  while (clusters.length > 0) {
    const cluster = clusters.shift()!;
    const { peopleMerged: merged } = physicalMergePeopleByAlias(
      db,
      cluster.alias_type,
      cluster.alias,
    );
    if (merged > 0) clustersProcessed += 1;
    peopleMerged += merged;
    if (clusters.length > 0 && token?.requested()) {
      return { clustersProcessed, peopleMerged, done: false, resumeClusters: clusters };
    }
  }

  if (clustersProcessed > 0 || peopleMerged > 0) {
    log.info(
      `physicalDedupSharedAliases: ${clustersProcessed} clusters processed, ${peopleMerged} people merged`,
    );
  }
  return { clustersProcessed, peopleMerged, done: true, resumeClusters: [] };
}

/**
 * Deterministic winner from a cluster. Self wins; else earliest
 * first_seen; else lex-smallest id. Mirrors the canonical-picking
 * algorithm used by the merge-rules eval task so a logical and
 * physical merge of the same cluster end up with the same canonical.
 */
function pickWinner(rows: PersonRow[]): PersonRow {
  const sorted = [...rows].sort((a, b) => {
    if (a.is_self !== b.is_self) return b.is_self - a.is_self;
    if (a.first_seen !== b.first_seen) return a.first_seen.localeCompare(b.first_seen);
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}
