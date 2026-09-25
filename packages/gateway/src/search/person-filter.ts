// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Person-filter pre-resolution.
 *
 * Resolving `from:jamesbond` / `to:sara` to a set of allowed `document_id`
 * values BEFORE the BM25 + vector candidate SQL runs is the only way to
 * preserve the `resultLimit` contract: applying the filter
 * post-fusion (the previous shape) trimmed an already-limited set, so a
 * a search with `limit=10` could return as few as 0–3 rows even
 * when the candidate pool had dozens of matches.
 *
 * The two databases are separate handles — `document_people` lives in
 * the gateway DB, `chunks` in the index DB. We resolve docIds against
 * the gateway DB up-front, then pass them as a docId filter into both
 * candidate stages.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/**
 * Resolve a set of canonical person IDs (with optional role filter) to
 * the set of `document_id` values they appear on, expanded across merges
 * so a canonical also picks up documents attached to its merged-away
 * sub-entities. The role filter is the same shape `PersonFilterStage`
 * used: `roles=["sender","author","owner"]` matches a `from:` query;
 * `roles=["recipient","attendee"]` matches `to:`.
 *
 * Returns an empty array when `personIds` is empty or all matches
 * resolve to zero docs. Caller can decide whether to short-circuit
 * (no docs → empty result) or pass the empty filter through.
 */
export function resolvePersonDocIds(
  gatewayDb: Db,
  personIds: readonly string[],
  roles?: readonly string[] | undefined,
): string[] {
  if (personIds.length === 0) return [];
  // The returned doc set is unbounded for very high-volume people; downstream
  // candidate queries stage it into a temp table rather than an inline
  // `IN (…)` list, so it never overflows SQLite's variable limit (see
  // withDocIdRestriction). `personIds`/`roles` here are small (a handful
  // of canonical ids and roles), so this query's inline lists are safe.
  const idPlaceholders = personIds.map(() => "?").join(",");
  const roleClause = roles?.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
  // The caller resolves `from:`/`to:`/`with:` aliases to the *canonical*
  // person id (merges are followed via resolvePersonId upstream). But
  // `document_people` rows are never rewritten on merge: a logically
  // merged-away sub-entity keeps its own person_id on every document it
  // appears on. Matching the canonical id alone would therefore miss every
  // document attached to a merged loser. Expand each id to its full
  // merge-equivalence class — the canonical plus every person that merges
  // into it, transitively — and match documents against the whole class.
  //
  // The recursive walk descends the `merged_into` graph from the queried
  // canonicals, so it stays correct even for multi-level chains (A→B→C)
  // that exist transiently before `collapseTransitiveChains` flattens them;
  // a one-hop expansion would drop the deepest member's documents.
  const rows = gatewayDb
    .prepare<string[], { document_id: string }>(
      `WITH RECURSIVE merge_class(id) AS (
         SELECT id FROM people WHERE id IN (${idPlaceholders})
         UNION
         SELECT p.id FROM people p JOIN merge_class mc ON p.merged_into = mc.id
       )
       SELECT DISTINCT document_id FROM document_people
       WHERE person_id IN (SELECT id FROM merge_class)${roleClause}`,
    )
    .all(...(personIds as string[]), ...((roles ?? []) as string[]));
  return rows.map((r) => r.document_id);
}
