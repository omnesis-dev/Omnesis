// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger, normalizeEmail } from "@omnesis/core";
import { resolvePersonId, CONTACT_NAME_FLOOR } from "../../domain/PeopleResolutionService.js";
import {
  MATCH_RANK,
  MATCH_RANK_NONE,
  boundedEditDistance,
  escapeLike,
  matchRankExpr,
  matchRankParams,
  maxEditDistanceFor,
} from "./person-match.js";

const log = createLogger("gateway:people");

/**
 * Parameter-group prefixes for the match-tier expression: the query as the
 * user typed it, and its canonical email form. A row scores as the better of
 * the two, so a dotted / `+tag` address ranks against the no-dot alias stored
 * at ingestion instead of matching the filter but scoring no tier.
 */
const MATCH_RAW = "matchRaw";
const MATCH_NORM = "matchNorm";

/** Best tier `column` reaches against either form of the query. */
function bestMatchRankExpr(column: string): string {
  return `MIN(${matchRankExpr(column, MATCH_RAW)}, ${matchRankExpr(column, MATCH_NORM)})`;
}

/**
 * Best tier the person reaches across their canonical name and every alias.
 * Applied only to rows the containment filter already selected, so the
 * correlated alias minimum runs over candidates rather than the whole table.
 */
function matchRankSql(): string {
  return `MIN(
         ${bestMatchRankExpr("p.canonical_name")},
         COALESCE((SELECT MIN(${bestMatchRankExpr("pa.alias")})
                     FROM person_aliases pa
                    WHERE pa.person_id = p.id), ${MATCH_RANK_NONE})
       )`;
}

/**
 * Document count for a person, reading the materialized column once the
 * refresh tasks have populated it and falling back to a correlated count
 * before that.
 */
function docCountExpr(hasMaterializedData: boolean): string {
  return hasMaterializedData
    ? "p.doc_count"
    : "(SELECT COUNT(DISTINCT document_id) FROM document_people WHERE person_id = p.id)";
}

/**
 * Whether the materialized people-stat columns hold anything yet. They are
 * empty on a fresh migration and in unit tests that never run the periodic
 * refresh tasks; those DBs fall back to correlated counts. Detected
 * corpus-wide rather than from the rows at hand: a cursor walk can
 * legitimately reach an all-zero tail even though an earlier page proved the
 * materialization is live, and switching strategies at that boundary would
 * reorder the tail and duplicate or skip people.
 */
function hasMaterializedPeopleStats(db: Db): boolean {
  return (
    db
      .prepare<[], { present: number }>(
        `SELECT EXISTS(
           SELECT 1 FROM people
            WHERE merged_into IS NULL
              AND (doc_count > 0 OR interaction_score > 0 OR interaction_score_recent > 0)
         ) AS present`,
      )
      .get()?.present === 1
  );
}

/**
 * ORDER BY tail that ranks people of equal match tier by how much the user
 * deals with them, ending on `p.id` so ties never fall back to arbitrary
 * row order. Aliased on `people p`.
 */
function popularityOrderSql(sortBy: PersonSortBy, hasMaterializedData: boolean): string {
  return sortBy === "interaction" && hasMaterializedData
    ? "p.interaction_score_recent DESC, p.doc_count DESC, p.id ASC"
    : `${docCountExpr(hasMaterializedData)} DESC, p.id ASC`;
}

/** Raw row shape shared by every `searchPeople` query variant. */
interface PersonSummaryRow {
  id: string;
  canonical_name: string;
  source: string;
  is_self: number;
  first_seen: string;
  last_seen: string;
  alias_count: number;
  doc_count: number;
  inbound_count: number;
  outbound_count: number;
  inbound_score: number;
  outbound_score: number;
  interaction_score: number;
  inbound_score_recent: number;
  outbound_score_recent: number;
  interaction_score_recent: number;
  source_ids: string | null;
  match_rank: number | null;
}

function toPersonSummary(r: PersonSummaryRow): PersonSummary {
  return {
    id: r.id,
    canonicalName: r.canonical_name,
    source: r.source,
    isSelf: !!r.is_self,
    aliasCount: r.alias_count,
    documentCount: r.doc_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    inboundCount: r.inbound_count,
    outboundCount: r.outbound_count,
    inboundScore: r.inbound_score,
    outboundScore: r.outbound_score,
    interactionScore: r.interaction_score,
    inboundScoreRecent: r.inbound_score_recent,
    outboundScoreRecent: r.outbound_score_recent,
    interactionScoreRecent: r.interaction_score_recent,
    sourceIds: r.source_ids ? r.source_ids.split(",").filter(Boolean) : [],
    ...(r.match_rank === null ? {} : { matchRank: r.match_rank }),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of resolving an alias to a person row, with both the row that
 * directly owns the alias (`ownerId` — pre-merged_into walk) and its
 * canonical (`canonicalId` — post-walk). When the alias is on a row
 * that's a logical-merge loser, `ownerId !== canonicalId`.
 *
 * Most callers want `canonicalId` (the equivalence class root) — see
 * `findPersonByAlias`. The exception is `findOrCreatePerson`, which
 * needs the owner to attach NEW aliases to the same row that already
 * owns the matching alias (instead of cross-walking onto canonical
 * and polluting its identity over time).
 */
export interface AliasResolution {
  ownerId: string;
  canonicalId: string;
}

export interface PersonAlias {
  id: string;
  aliasType: string;
  alias: string;
  sourceId: string | null;
}

/**
 * One person who has been merged INTO this canonical, surfaced on the
 * portal detail page so the user can see "this card represents these
 * other people too". Includes the merged person's original aliases +
 * edge counts and the rule(s) that bridged it — so the user can see
 * exactly what's being aggregated and remove the merge if it's wrong.
 */
export interface MergedFromPerson {
  id: string;
  canonicalName: string;
  /** Aliases owned by this merged person (NOT the canonical's own). */
  aliases: PersonAlias[];
  /** Raw edge counts on the merged person's row (pre-merge state). */
  inboundCount: number;
  outboundCount: number;
  /** ISO timestamp the merge took effect. */
  appliedAt: string;
  /**
   * Distinct source-ids that contributed an alias OR a document to
   * THIS loser specifically — does NOT walk merged_into to the
   * canonical. Used by the portal to render a per-loser source-icon
   * strip that shows which platforms originally produced this
   * particular pre-merge identity (e.g. just `apple-contacts` for a
   * contacts-card-only loser, even when its canonical aggregates
   * gmail/whatsapp/calendar etc.).
   */
  sourceIds: string[];
}

export interface PersonDetail {
  id: string;
  canonicalName: string;
  mergedInto: string | null;
  /**
   * When `mergedInto` is non-null (this row is a logical-merge loser),
   * the canonical's display name — so the portal can show "merged into
   * X" with a working link without a second fetch. Null on canonical
   * rows (no merge target to point at).
   */
  mergedIntoCanonicalName: string | null;
  source: string;
  isSelf: boolean;
  firstSeen: string;
  lastSeen: string;
  /**
   * Aliases owned by THIS person row only — does NOT include aliases
   * inherited from merged-loser people. Use `mergedFrom[].aliases`
   * for those.
   */
  aliasesOwn: PersonAlias[];
  /**
   * Union of all aliases across the equivalence class — own + every
   * merged-loser's aliases. Kept for back-compat (the portal alias
   * panel rendered the union before the redesign); also handy for
   * any consumer that just wants "all identifiers for this person".
   */
  aliases: PersonAlias[];
  /** People merged INTO this canonical. Empty when no merges. */
  mergedFrom: MergedFromPerson[];
  /**
   * Materialized interaction scores. Same semantics as
   * `PersonSummary` — see field docs there. Surfaced on the portal
   * detail page alongside the alias list. Always present (zero when
   * no scores have been computed yet).
   */
  inboundCount: number;
  outboundCount: number;
  inboundScore: number;
  outboundScore: number;
  interactionScore: number;
  inboundScoreRecent: number;
  outboundScoreRecent: number;
  interactionScoreRecent: number;
  /** ISO timestamp of the last interaction-score refresh; null if never. */
  interactionScoresAt: string | null;
}

export interface PersonSummary {
  id: string;
  canonicalName: string;
  source: string;
  isSelf: boolean;
  aliasCount: number;
  documentCount: number;
  firstSeen: string;
  lastSeen: string;
  /**
   * Per-person interaction scores. All values live in `[0, 1]`.
   * `interactionScore` is the harmonic mean of inbound + outbound;
   * the `_recent` variants apply a 1-year exponential decay so
   * relationships that have gone quiet drop in rank. Lifetime
   * variants are kept around for use cases (e.g. privacy gates)
   * that don't want to forget old strong relationships.
   *
   * Maintained by `interactionScoresRefreshTask`. Zero on a fresh
   * boot until the first refresh tick fires.
   */
  inboundCount: number;
  outboundCount: number;
  inboundScore: number;
  outboundScore: number;
  interactionScore: number;
  inboundScoreRecent: number;
  outboundScoreRecent: number;
  interactionScoreRecent: number;
  /**
   * Distinct source-ids that contributed an alias / document for this
   * person. Used by the portal People list to render a small source-icon
   * strip (provenance at a glance). Empty array if the person has no
   * documents linked yet.
   */
  sourceIds: string[];
  /**
   * How this row matched the search — one of {@link MATCH_RANK}, and the
   * primary sort key ahead of any score. Absent on a browse, which has no
   * query to match against. Carried so cursor paging can continue on the
   * same tuple the ordering used.
   */
  matchRank?: number;
}

/**
 * Sort key for `searchPeople`. `interaction` (default) orders by the
 * decayed interaction score, falling back to `doc_count` so freshly
 * resolved people without a score yet still appear in a sensible
 * order. `documents` preserves the legacy raw-document-count ordering
 * for callers that want it explicitly.
 */
export type PersonSortBy = "interaction" | "documents";

/**
 * Complete sort tuple for cursor-paging {@link searchPeople}. All fields are
 * carried even for document-count sorting so callers can switch sort modes
 * only by starting a new page walk.
 */
export interface PersonBrowseCursor {
  isSelf: number;
  interactionScoreRecent: number;
  documentCount: number;
  id: string;
  /**
   * Match tier of the row this cursor points at, present only when the walk
   * carries a query (a browse does not rank by match). Optional so a cursor
   * minted before this field existed still resumes.
   */
  matchRank?: number;
}

/** One row in the result of `computePeopleCounts`. */
export interface PeopleCountRow {
  personId: string;
  docCount: number;
  aliasCount: number;
}

/**
 * Owner-aware alias lookup. Returns the row that directly owns the
 * alias and its canonical (after walking `merged_into`). Verifies the
 * canonical row actually exists in `people` — protects callers from
 * dangling pointers (a person deleted while another row still pointed
 * at it). Returns null on miss or when the canonical doesn't exist.
 */
export function findAliasOwnerAndCanonical(
  db: Db,
  aliasType: string,
  alias: string,
): AliasResolution | null {
  // Deterministic order ensures earliest-seen winner survives multi-owner
  // alias collisions (e.g. noisy upstream extraction polluting a phantom
  // person with someone else's email — issue #219).
  const row = db
    .prepare<[string, string], { person_id: string }>(
      `SELECT pa.person_id
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       WHERE pa.alias_type = ? AND pa.alias = ?
       ORDER BY p.first_seen ASC, p.id ASC
       LIMIT 1`,
    )
    .get(aliasType, alias);
  if (!row) return null;
  const canonicalId = resolvePersonId(db, row.person_id);
  const exists = db
    .prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?")
    .get(canonicalId);
  if (!exists) return null;
  return { ownerId: row.person_id, canonicalId };
}

/** Find person by exact alias match. Returns canonical (non-merged)
 *  person_id or null. Verifies the resolved id actually exists in
 *  `people` — protects callers from dangling `merged_into` pointers
 *  (a person row deleted while another row still pointed at it).
 *  Without this guard, callers like `findOrCreatePerson` would happily
 *  try to write aliases against a phantom person_id and trip the FK. */
export function findPersonByAlias(db: Db, aliasType: string, alias: string): string | null {
  return findAliasOwnerAndCanonical(db, aliasType, alias)?.canonicalId ?? null;
}

/**
 * In-memory alias lookup cache scoped to a single backfill batch. Emails +
 * phones repeat across neighboring documents (an email thread, a group chat),
 * so within a 50-doc batch we save dozens of redundant round-trips. The cache
 * lives for the duration of one batch and is discarded after.
 *
 * Stores the rich `AliasResolution` (owner + canonical) so consumers that
 * want the alias-owning row (e.g. `findOrCreatePerson` for the no-cross-walk
 * fix) don't have to query a second time. `null` means "cached miss";
 * `undefined` from `get` means "not cached yet, ask the DB".
 */
export class AliasLookupCache {
  private map = new Map<string, AliasResolution | null>();
  private writes = 0;

  get(aliasType: string, alias: string): AliasResolution | null | undefined {
    return this.map.get(`${aliasType}:${alias}`);
  }

  set(aliasType: string, alias: string, value: AliasResolution | null): void {
    this.map.set(`${aliasType}:${alias}`, value);
  }

  /** Invalidate the cache when we know it may be stale (after a new person / alias insert). */
  invalidate(): void {
    this.map.clear();
    this.writes += 1;
  }

  get invalidations(): number {
    return this.writes;
  }
}

/**
 * Load the learned non-identifying ("shared / firehose") email blocklist as
 * a Set of normalized addresses. Populated by `demoteSharedAddresses`;
 * consulted on the people-resolution path so a demoted shared address never
 * re-forms a person bucket. The table is tiny (one row per detected shared
 * address), so callers load it once per resolution batch.
 */
export function loadNonIdentifyingEmails(db: Db): Set<string> {
  const rows = db.prepare<[], { email: string }>("SELECT email FROM non_identifying_emails").all();
  return new Set(rows.map((r) => r.email));
}

export function findAliasOwnerCached(
  db: Db,
  cache: AliasLookupCache | null,
  aliasType: string,
  alias: string,
): AliasResolution | null {
  if (cache) {
    const cached = cache.get(aliasType, alias);
    if (cached !== undefined) return cached;
  }
  const result = findAliasOwnerAndCanonical(db, aliasType, alias);
  if (cache) cache.set(aliasType, alias, result);
  return result;
}

export function findPersonByAliasCached(
  db: Db,
  cache: AliasLookupCache | null,
  aliasType: string,
  alias: string,
): string | null {
  return findAliasOwnerCached(db, cache, aliasType, alias)?.canonicalId ?? null;
}

// ---------------------------------------------------------------------------
// Person detail / search query helpers
// ---------------------------------------------------------------------------

export function getPersonById(db: Db, id: string): PersonDetail | null {
  // Read the row at the requested id directly. Do NOT walk
  // `merged_into` — losers should resolve to their own pre-merge
  // identity so the operator can navigate to it from the merge-rules
  // page and see what aliases / docs the loser actually carries
  // (which is what justified the merge in the first place). The UI
  // surfaces a "merged into X" banner for loser rows so the user can
  // jump to the canonical from there.
  const row = db
    .prepare<
      [string],
      {
        id: string;
        canonical_name: string;
        merged_into: string | null;
        source: string;
        is_self: number;
        first_seen: string;
        last_seen: string;
        inbound_count: number | null;
        outbound_count: number | null;
        inbound_score: number | null;
        outbound_score: number | null;
        interaction_score: number | null;
        inbound_score_recent: number | null;
        outbound_score_recent: number | null;
        interaction_score_recent: number | null;
        interaction_scores_at: string | null;
      }
    >("SELECT * FROM people WHERE id = ?")
    .get(id);

  if (!row) return null;

  const isLoser = row.merged_into !== null;

  // Aliases owned by THIS person row.
  const ownAliasRows = db
    .prepare<[string], { id: string; alias_type: string; alias: string; source_id: string | null }>(
      `SELECT id, alias_type, alias, source_id
       FROM person_aliases
       WHERE person_id = ?
       ORDER BY alias_type, alias`,
    )
    .all(row.id);
  const aliasesOwn = ownAliasRows.map((a) => ({
    id: a.id,
    aliasType: a.alias_type,
    alias: a.alias,
    sourceId: a.source_id,
  }));

  // Merged-loser people only exist on a CANONICAL row. A loser
  // doesn't have its own losers — the equivalence class fans in
  // toward exactly one canonical, so `mergedFrom` is empty when this
  // row is itself a loser.
  const mergedFromRows = isLoser
    ? []
    : db
        .prepare<
          [string],
          {
            id: string;
            canonical_name: string;
            inbound_count: number;
            outbound_count: number;
            applied_at: string;
          }
        >(
          `SELECT
         p.id,
         p.canonical_name,
         p.inbound_count,
         p.outbound_count,
         COALESCE(eq.applied_at, p.updated_at) AS applied_at
       FROM people p
       LEFT JOIN person_equivalences eq ON eq.from_id = p.id
       WHERE p.merged_into = ?
       ORDER BY p.canonical_name`,
        )
        .all(row.id);
  // Batch-fetch document-attribution source ids per loser so we can
  // surface a per-loser source-icon strip on the canonical's
  // "merged into this canonical" list. Crucially: the join restricts
  // `dp.person_id = p.id` (the loser's own row), NOT the canonical —
  // logical merge keeps `document_people` rows on the loser, so this
  // query naturally returns the loser's pre-merge document provenance.
  const docSourceIdsByLoser = new Map<string, string[]>();
  if (mergedFromRows.length > 0) {
    const rows = db
      .prepare<[string], { person_id: string; source_ids: string | null }>(
        `SELECT dp.person_id, GROUP_CONCAT(DISTINCT dp.source_id) AS source_ids
         FROM document_people dp
         JOIN people p ON p.id = dp.person_id
         WHERE p.merged_into = ?
         GROUP BY dp.person_id`,
      )
      .all(row.id);
    for (const r of rows) {
      docSourceIdsByLoser.set(
        r.person_id,
        r.source_ids ? r.source_ids.split(",").filter(Boolean) : [],
      );
    }
  }

  const mergedFrom: MergedFromPerson[] = mergedFromRows.map((m) => {
    const aliases = db
      .prepare<
        [string],
        { id: string; alias_type: string; alias: string; source_id: string | null }
      >(
        `SELECT id, alias_type, alias, source_id
         FROM person_aliases
         WHERE person_id = ?
         ORDER BY alias_type, alias`,
      )
      .all(m.id)
      .map((a) => ({
        id: a.id,
        aliasType: a.alias_type,
        alias: a.alias,
        sourceId: a.source_id,
      }));
    const aliasSourceIds = aliases.map((a) => a.sourceId).filter((s): s is string => Boolean(s));
    const docSourceIds = docSourceIdsByLoser.get(m.id) ?? [];
    const sourceIds = Array.from(new Set([...aliasSourceIds, ...docSourceIds]));
    return {
      id: m.id,
      canonicalName: m.canonical_name,
      aliases,
      inboundCount: m.inbound_count,
      outboundCount: m.outbound_count,
      appliedAt: m.applied_at,
      sourceIds,
    };
  });

  // Union across the equivalence class — own + every merged loser's
  // aliases — deduped by `(aliasType, alias)`. The same alias often
  // appears on both the canonical and a loser (e.g. "name=Eve"
  // attached at both ingest paths), and the portal renders one chip
  // per row from this list, so leaving duplicates in produces visual
  // duplicates. Name aliases dedupe case-insensitively to match the
  // rule-eval resolver. First occurrence wins so we keep the
  // original-case display value when available.
  const aliasesSeen = new Set<string>();
  const aliases: PersonAlias[] = [];
  for (const a of [...aliasesOwn, ...mergedFrom.flatMap((m) => m.aliases)]) {
    const key = `${a.aliasType}::${a.aliasType === "name" ? a.alias.toLowerCase() : a.alias}`;
    if (aliasesSeen.has(key)) continue;
    aliasesSeen.add(key);
    aliases.push(a);
  }
  aliases.sort((a, b) =>
    a.aliasType === b.aliasType
      ? a.alias.localeCompare(b.alias)
      : a.aliasType.localeCompare(b.aliasType),
  );

  // Look up the canonical's display name when this row is a loser, so
  // the portal can render a "merged into X" banner with a link without
  // a second fetch.
  const mergedIntoCanonicalName = row.merged_into
    ? (db
        .prepare<
          [string],
          { canonical_name: string }
        >("SELECT canonical_name FROM people WHERE id = ?")
        .get(row.merged_into)?.canonical_name ?? null)
    : null;

  return {
    id: row.id,
    canonicalName: row.canonical_name,
    mergedInto: row.merged_into,
    mergedIntoCanonicalName,
    source: row.source,
    isSelf: !!row.is_self,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    aliasesOwn,
    aliases,
    mergedFrom,
    // SELECT * works even when columns are added by ALTER TABLE; the
    // `?? 0` guards against the test fallback case where the DB was
    // created before the migration ran in the same process.
    inboundCount: row.inbound_count ?? 0,
    outboundCount: row.outbound_count ?? 0,
    inboundScore: row.inbound_score ?? 0,
    outboundScore: row.outbound_score ?? 0,
    interactionScore: row.interaction_score ?? 0,
    inboundScoreRecent: row.inbound_score_recent ?? 0,
    outboundScoreRecent: row.outbound_score_recent ?? 0,
    interactionScoreRecent: row.interaction_score_recent ?? 0,
    interactionScoresAt: row.interaction_scores_at,
  };
}

/**
 * Display names for a set of person ids, for a surface that holds ids.
 *
 * Ids that name nobody are simply absent from the result, which is what makes
 * this safe to hand a mixed bag of identifiers: a caller that cannot tell a
 * person id from a thread id asks about all of them and renders a name for
 * whichever came back. A merged loser resolves to its winner's name, so a value
 * recorded before a merge still reads as the person it now belongs to.
 */
export function getPersonNames(db: Db, ids: readonly string[]): Map<string, string> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = db
    .prepare<string[], { id: string; canonical_name: string; merged_into: string | null }>(
      `SELECT id, canonical_name, merged_into FROM people
        WHERE id IN (${wanted.map(() => "?").join(", ")})`,
    )
    .all(...wanted);
  // One extra pass for the winners, rather than a self-join: the losers are the
  // rare case, and the winner is usually already in the rows above.
  const byId = new Map(rows.map((row) => [row.id, row.canonical_name]));
  const missingWinners = [
    ...new Set(
      rows.flatMap((row) =>
        row.merged_into !== null && !byId.has(row.merged_into) ? [row.merged_into] : [],
      ),
    ),
  ];
  if (missingWinners.length > 0) {
    for (const row of db
      .prepare<string[], { id: string; canonical_name: string }>(
        `SELECT id, canonical_name FROM people
          WHERE id IN (${missingWinners.map(() => "?").join(", ")})`,
      )
      .all(...missingWinners)) {
      byId.set(row.id, row.canonical_name);
    }
  }
  const names = new Map<string, string>();
  for (const row of rows) {
    const name =
      (row.merged_into !== null ? byId.get(row.merged_into) : null) ?? row.canonical_name;
    names.set(row.id, name);
  }
  return names;
}

export function searchPeople(
  db: Db,
  query: string,
  limit: number = 50,
  options: { sortBy?: PersonSortBy; after?: PersonBrowseCursor } = {},
): PersonSummary[] {
  const pattern = `%${escapeLike(query.toLowerCase())}%`;
  // Also match the canonical form of the query so a Gmail dotted / +tag
  // address (which a human naturally types) finds the no-dot alias stored at
  // ingestion. `normalizeEmail` strips Gmail dots + `+tag` and lowercases for
  // an email; for a plain name it just lowercases, so `normPattern` collapses
  // to `pattern` and the extra clause is a harmless no-op. Mirrors the same
  // fix on the `from:`/`by:` filter path (`resolvePersonIdsFromQuery`, #298).
  const normPattern = `%${escapeLike(normalizeEmail(query))}%`;
  const sortBy: PersonSortBy = options.sortBy ?? "interaction";
  const after = options.after;
  const browse = query === "";

  const params = {
    pattern,
    normPattern,
    limit,
    afterIsSelf: after?.isSelf ?? 0,
    afterScore: after?.interactionScoreRecent ?? 0,
    afterDocuments: after?.documentCount ?? 0,
    afterId: after?.id ?? "",
    // A query walk always carries the tier it stopped at. Absent means the
    // cursor predates the tier joining the sort tuple, and there is no way to
    // know where in the new ordering it pointed. Standing in the worst tier
    // ends that walk after its current page: every literal row scores better,
    // so none compares as "after" it. The alternative — standing in the best
    // tier — makes the comparison true for nearly every row and re-serves the
    // same page indefinitely.
    afterMatchRank: after?.matchRank ?? MATCH_RANK.FUZZY,
    ...matchRankParams(query, MATCH_RAW),
    ...matchRankParams(normalizeEmail(query), MATCH_NORM),
  };

  const hasMaterializedData = hasMaterializedPeopleStats(db);

  const run = (filter: string, rank: string | null, rowLimit: number): PersonSummary[] => {
    if (rowLimit <= 0) return [];
    // Bound rather than interpolated: nothing user-controlled should reach SQL
    // by concatenation, even a value the callers happen to type as a number.
    const runParams = { ...params, limit: rowLimit };
    const rankKey = rank ? `${rank} ASC, ` : "";
    const rankAhead = rank ? `${rank} > @afterMatchRank` : "0";
    const rankSame = rank ? `${rank} = @afterMatchRank AND ` : "";
    const afterFilter = !after
      ? ""
      : sortBy === "interaction" && hasMaterializedData
        ? `AND (
             p.is_self < @afterIsSelf
             OR (p.is_self = @afterIsSelf AND ${rankAhead})
             OR (p.is_self = @afterIsSelf AND ${rankSame}p.interaction_score_recent < @afterScore)
             OR (p.is_self = @afterIsSelf AND ${rankSame}p.interaction_score_recent = @afterScore
                 AND p.doc_count < @afterDocuments)
             OR (p.is_self = @afterIsSelf AND ${rankSame}p.interaction_score_recent = @afterScore
                 AND p.doc_count = @afterDocuments AND p.id > @afterId)
           )`
        : `AND (
             p.is_self < @afterIsSelf
             OR (p.is_self = @afterIsSelf AND ${rankAhead})
             OR (p.is_self = @afterIsSelf AND ${rankSame}${docCountExpr(hasMaterializedData)} < @afterDocuments)
             OR (p.is_self = @afterIsSelf AND ${rankSame}${docCountExpr(hasMaterializedData)} = @afterDocuments
                 AND p.id > @afterId)
           )`;
    const orderBy = `p.is_self DESC, ${rankKey}${popularityOrderSql(sortBy, hasMaterializedData)}`;
    const counts = hasMaterializedData
      ? "p.alias_count, p.doc_count"
      : `(SELECT COUNT(*) FROM person_aliases WHERE person_id = p.id) AS alias_count,
         ${docCountExpr(false)} AS doc_count`;
    const rows = db
      .prepare<typeof runParams, PersonSummaryRow>(
        `SELECT p.id, p.canonical_name, p.source, p.is_self, p.first_seen, p.last_seen,
                ${counts},
                p.inbound_count, p.outbound_count,
                p.inbound_score, p.outbound_score, p.interaction_score,
                p.inbound_score_recent, p.outbound_score_recent, p.interaction_score_recent,
                (SELECT GROUP_CONCAT(DISTINCT dp.source_id)
                   FROM document_people dp
                   WHERE dp.person_id = p.id) AS source_ids,
                ${rank ?? "NULL"} AS match_rank
         FROM people p
         WHERE p.merged_into IS NULL
           ${filter}
           ${afterFilter}
         ORDER BY ${orderBy}
         LIMIT @limit`,
      )
      .all(runParams);
    return rows.map(toPersonSummary);
  };

  if (browse) {
    // No query means no tier to rank by, which is also what lets the ORDER BY
    // be satisfied by an ordered walk of idx_people_interaction_recent instead
    // of a full sort of every person.
    return run("", null, limit);
  }

  // One cheap containment filter selects the candidates; the tier expression
  // then orders them. Ranking costs a sort of the whole match set instead of
  // an index walk, which is immaterial for a name query (a handful of matches)
  // and adds tens of milliseconds only when a one- or two-letter query matches
  // a large fraction of the corpus — a result that was arbitrary either way.
  // Filtering on the tiers directly instead would be worse: it evaluates a
  // pattern per tier per row over the whole people and alias tables, which
  // costs more than the sort it avoids.
  const results = run(
    `AND (LOWER(p.canonical_name) LIKE @pattern ESCAPE '\\'
          OR p.id IN (SELECT person_id FROM person_aliases
                      WHERE LOWER(alias) LIKE @pattern ESCAPE '\\'
                         OR LOWER(alias) LIKE @normPattern ESCAPE '\\'))`,
    matchRankSql(),
    limit,
  );

  // A literal search that reached only accidental infix matches has, in
  // practice, missed. A one-letter slip on a short nickname is not a substring
  // of it, but often is a substring of some unrelated longer name, so the page
  // fills with the wrong people and the intended one is absent entirely. Retry
  // such a search against edit distance before concluding there is nothing to
  // find.
  //
  // Only when the page holds the whole literal result set. A full page proves
  // nothing about what sits below it — `is_self` is pinned ahead of the tier,
  // so a short page can be a single accidental substring while a genuine
  // prefix match waits just outside it — and the rescue replaces the page
  // rather than extending it. Declining to rescue costs a near-miss; rescuing
  // over a truncated page discards real matches.
  if (
    !after &&
    results.length < limit &&
    !results.some((r) => (r.matchRank ?? MATCH_RANK_NONE) <= MATCH_RANK.WORD)
  ) {
    const fuzzy = fuzzySearchPeople(db, query, limit, sortBy, hasMaterializedData);
    if (fuzzy.length > 0) return fuzzy;
  }
  return results;
}

/**
 * Ceiling on how many near-miss people the fuzzy pass hydrates in one call.
 *
 * Sits far above any page size, so it binds only when a single edit-distance
 * bucket is pathologically large — where the alternative is an unbounded
 * `IN (…)` list and one correlated aggregate per member.
 */
const FUZZY_HYDRATION_CAP = 500;

/**
 * Hydrate full {@link PersonSummary} rows for an explicit, already-bounded set
 * of person ids, in no particular order.
 *
 * `hasMaterializedData` selects the same count source the caller's main query
 * used — the materialized `doc_count` / `alias_count` columns once the refresh
 * tasks have run, correlated counts before that — so a fuzzy result and a
 * literal result of the same search never disagree about a person's totals.
 */
function getPersonSummariesByIds(
  db: Db,
  ids: readonly string[],
  hasMaterializedData: boolean,
): PersonSummary[] {
  if (ids.length === 0) return [];
  const counts = hasMaterializedData
    ? "p.alias_count, p.doc_count"
    : `(SELECT COUNT(*) FROM person_aliases WHERE person_id = p.id) AS alias_count,
       ${docCountExpr(false)} AS doc_count`;
  return db
    .prepare<string[], PersonSummaryRow>(
      `SELECT p.id, p.canonical_name, p.source, p.is_self, p.first_seen, p.last_seen,
              ${counts},
              p.inbound_count, p.outbound_count,
              p.inbound_score, p.outbound_score, p.interaction_score,
              p.inbound_score_recent, p.outbound_score_recent, p.interaction_score_recent,
              (SELECT GROUP_CONCAT(DISTINCT dp.source_id)
                 FROM document_people dp
                 WHERE dp.person_id = p.id) AS source_ids,
              NULL AS match_rank
         FROM people p
        WHERE p.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids)
    .map(toPersonSummary);
}

/**
 * Rescue pass for a query that matched nothing well literally: find people
 * whose name or one of whose aliases is within a small edit distance of it.
 *
 * Runs only when the literal pass came back with no word-start match and the
 * caller is on the first page, so the common path never pays for it. Results
 * are a single page — every row carries {@link MATCH_RANK.FUZZY}, the last
 * tier, so a cursor built from one of them yields an empty next page rather
 * than silently continuing into the literal accidental-substring matches the
 * rescue was meant to replace.
 *
 * Candidates are pre-filtered in SQL on length, which is free and exact: two
 * strings differing by more than `k` in length cannot be within `k` edits.
 * Only the survivors reach the quadratic distance computation.
 */
function fuzzySearchPeople(
  db: Db,
  query: string,
  limit: number,
  sortBy: PersonSortBy,
  hasMaterializedData: boolean,
): PersonSummary[] {
  const q = query.toLowerCase();
  const maxDistance = maxEditDistanceFor(q);
  if (maxDistance === 0) return [];

  const candidates = db
    .prepare<{ minLen: number; maxLen: number }, { person_id: string; candidate: string }>(
      `SELECT p.id AS person_id, LOWER(p.canonical_name) AS candidate
         FROM people p
        WHERE p.merged_into IS NULL
          AND LENGTH(p.canonical_name) BETWEEN @minLen AND @maxLen
       UNION ALL
       SELECT pa.person_id AS person_id, LOWER(pa.alias) AS candidate
         FROM person_aliases pa
         JOIN people p ON p.id = pa.person_id
        WHERE p.merged_into IS NULL
          AND LENGTH(pa.alias) BETWEEN @minLen AND @maxLen`,
    )
    .all({ minLen: q.length - maxDistance, maxLen: q.length + maxDistance });

  // Best distance per person: a person matched by both a near-miss name and a
  // near-miss alias is one result, ranked by whichever came closer.
  const best = new Map<string, number>();
  for (const row of candidates) {
    const d = boundedEditDistance(q, row.candidate, maxDistance);
    if (d > maxDistance) continue;
    const prev = best.get(row.person_id);
    if (prev === undefined || d < prev) best.set(row.person_id, d);
  }
  if (best.size === 0) return [];

  // Distance is the primary sort key, so a person in a worse distance bucket
  // can never place ahead of one in a better bucket. Take buckets closest
  // first, and keep taking within a bucket until the page is covered — the
  // members of one bucket are ordered against each other by score, which needs
  // their hydrated rows.
  //
  // The take is capped because a bucket has no natural size: a short numeric
  // query can put thousands of similar phone aliases at the same distance, and
  // hydrating all of them would build an `IN (?, ?, …)` list past SQLite's
  // bound-parameter ceiling and run a correlated aggregate per row to return
  // one page. Past the cap the ordering within the final bucket is arbitrary,
  // which is the weakest tie-break in a pass that is already a rescue.
  const byDistance = new Map<number, string[]>();
  for (const [id, d] of best) {
    const bucket = byDistance.get(d);
    if (bucket) bucket.push(id);
    else byDistance.set(d, [id]);
  }
  const hydrationCap = Math.max(limit, FUZZY_HYDRATION_CAP);
  const ids: string[] = [];
  for (const d of [...byDistance.keys()].sort((a, b) => a - b)) {
    if (ids.length >= limit) break;
    for (const id of byDistance.get(d)!) {
      if (ids.length >= hydrationCap) break;
      ids.push(id);
    }
  }

  const summaries = getPersonSummariesByIds(db, ids, hasMaterializedData);
  return summaries
    .map((s) => ({ ...s, matchRank: MATCH_RANK.FUZZY }))
    .sort((a, b) => {
      // Closest spelling first — that is the whole signal a fuzzy match has.
      const byDistance = best.get(a.id)! - best.get(b.id)!;
      if (byDistance !== 0) return byDistance;
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const byScore =
        sortBy === "interaction"
          ? b.interactionScoreRecent - a.interactionScoreRecent
          : b.documentCount - a.documentCount;
      if (byScore !== 0) return byScore;
      if (b.documentCount !== a.documentCount) return b.documentCount - a.documentCount;
      return a.id < b.id ? -1 : 1;
    })
    .slice(0, limit);
}

/**
 * Default cap on the alias list returned by `listMergedAliasesForPerson`.
 * Trades wire payload size against the rare power-contact who has many
 * legitimate aliases. Callers that need the full set (the People detail
 * page, merge tooling) use `getPersonById` instead, which is uncapped.
 */
const PERSON_ALIAS_LIST_DEFAULT_CAP = 12;

/**
 * Return every alias the person owns plus every merged-loser's alias,
 * deduped by `(alias_type, lowercase-alias)` — the same dedup rule
 * `getPersonById` applies in its richer payload. Aliases come back in
 * a stable order so consumers (the `lookup_people` agent tool) can
 * pick a primary alias without re-sorting: emails first (most useful
 * for follow-up `from:` filters), then phones, then handles, then
 * name aliases.
 *
 * Pass `personId` for a canonical row. Loser-row callers don't need
 * the merged fan-in (a loser doesn't have its own losers) so passing
 * a loser id is harmless: the second leg of the predicate matches
 * nothing.
 */
export function listMergedAliasesForPerson(
  db: Db,
  personId: string,
  cap: number = PERSON_ALIAS_LIST_DEFAULT_CAP,
): string[] {
  const rows = db
    .prepare<[string, string], { alias_type: string; alias: string }>(
      `SELECT alias_type, alias
       FROM person_aliases
       WHERE person_id = ?
          OR person_id IN (SELECT id FROM people WHERE merged_into = ?)
       ORDER BY
         CASE alias_type
           WHEN 'email' THEN 0
           WHEN 'phone' THEN 1
           WHEN 'lid' THEN 2
           WHEN 'name' THEN 3
           ELSE 4
         END,
         alias`,
    )
    .all(personId, personId);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = `${r.alias_type}:${r.alias.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.alias);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Split a person's distinct-document count across three interaction
 * channels: emails, chats, meetings. Counts include every doc
 * attributed to the person OR to one of their merged losers. Channels
 * with zero docs are omitted from the result so callers (the
 * `lookup_people` tool surface) can suppress them in the UI.
 *
 * The mapping is over the closed `KnownDocumentType` enum declared in
 * `@omnesis/core` — source-agnostic. A future provider that ships a
 * document type outside this enum simply doesn't roll into any of the
 * three buckets (graceful degradation).
 */
interface PersonInteractionCounts {
  email?: number;
  chat?: number;
  meeting?: number;
}

export function getPersonInteractionCountsByChannel(
  db: Db,
  personId: string,
): PersonInteractionCounts {
  // `documentType` lives inside the `metadata` JSON blob on every
  // document row (set by the source's normaliser via `defineSource`).
  // No dedicated column — `json_extract` is fine because the predicate
  // filters down to one person's documents first, then groups.
  //
  // The merge-class CTE walks the full `merged_into` graph down from the
  // queried person, so the counts include documents attached to every loser
  // in the equivalence class — even a multi-level chain (A→B→C) that exists
  // transiently before `collapseTransitiveChains` flattens it. A one-hop
  // expansion (direct losers only) would drop the deepest member's docs.
  const rows = db
    .prepare<[string], { document_type: string | null; n: number }>(
      `WITH RECURSIVE merge_class(id) AS (
         SELECT id FROM people WHERE id = ?
         UNION
         SELECT p.id FROM people p JOIN merge_class mc ON p.merged_into = mc.id
       )
       SELECT json_extract(d.metadata, '$.documentType') AS document_type,
              COUNT(DISTINCT d.id) AS n
       FROM document_people dp
       JOIN documents d ON d.id = dp.document_id
       WHERE dp.person_id IN (SELECT id FROM merge_class)
       GROUP BY document_type`,
    )
    .all(personId);
  const out: PersonInteractionCounts = {};
  for (const r of rows) {
    if (r.document_type === "email") out.email = r.n;
    else if (r.document_type === "conversation") {
      out.chat = (out.chat ?? 0) + r.n;
    } else if (r.document_type === "event") out.meeting = r.n;
  }
  return out;
}

/**
 * Most people one `from:`/`to:`/`with:` ref resolves to. A ref that matches
 * more is truncated to its best-ranked members and a warning is logged; the
 * caller sees only the kept ids.
 */
const PERSON_REF_CAP = 10;

/** Resolve person IDs from a search term (name or email). For search filters. */
export function resolvePersonIdsFromQuery(db: Db, query: string): string[] {
  // Try exact email match first. Aliases are stored under the
  // `normalizeEmail` canonical, so the query is normalized the same way
  // before lookup — otherwise a Gmail dotted (`vance.car.75@gmail.com`) or
  // `+suffix` form would miss the stored no-dot alias. normalizeEmail is
  // idempotent for names / non-Gmail addresses, so it's safe unconditionally.
  // Same path backs `from:`/`by:` author filters via search/pipeline.ts.
  const emailMatch = findPersonByAlias(db, "email", normalizeEmail(query));
  if (emailMatch) return [emailMatch];

  // Try exact phone match
  const phoneMatch = findPersonByAlias(db, "phone", query);
  if (phoneMatch) return [phoneMatch];

  // Name containment match. Names that live only on a merged-away loser
  // (e.g. a contact's full "Maya Reeves" form attached to a sub-entity that
  // was merged into the canonical "Maya") must still resolve, so the aliases
  // of every person are searched and each hit climbs `merged_into` to its
  // canonical. The climb is recursive because multi-level chains (A→B→C)
  // exist transiently before `collapseTransitiveChains` flattens them; a
  // one-hop expansion would leave the deepest member's hit on a loser row.
  //
  // The ref keeps at most `PERSON_REF_CAP` people, so the candidates are
  // ordered the way `searchPeople` orders them — best match tier first, then
  // the popularity tuple — and the cap keeps the ten worth keeping rather than
  // the ten that happen to sort first by alias. The sort covers every match,
  // which for a broad ref is a walk of the whole name slice; a `from:` filter
  // is one such walk per search, which is affordable on the request path.
  const hasMaterializedData = hasMaterializedPeopleStats(db);
  const params = {
    pattern: `%${escapeLike(query.toLowerCase())}%`,
    limit: PERSON_REF_CAP + 1,
    ...matchRankParams(query, MATCH_RAW),
    ...matchRankParams(normalizeEmail(query), MATCH_NORM),
  };
  const rows = db
    .prepare<typeof params, { id: string; matched: number }>(
      `WITH RECURSIVE
         hit(person_id, match_rank) AS (
           SELECT pa.person_id, MIN(${bestMatchRankExpr("pa.alias")})
             FROM person_aliases pa
            WHERE pa.alias_type = 'name' AND LOWER(pa.alias) LIKE @pattern ESCAPE '\\'
            GROUP BY pa.person_id
         ),
         merge_class(person_id, match_rank) AS (
           SELECT person_id, match_rank FROM hit
           UNION
           SELECT p.merged_into, mc.match_rank
             FROM merge_class mc JOIN people p ON p.id = mc.person_id
            WHERE p.merged_into IS NOT NULL
         )
       SELECT p.id, (SELECT COUNT(*) FROM hit) AS matched
         FROM people p JOIN merge_class mc ON mc.person_id = p.id
        WHERE p.merged_into IS NULL
        GROUP BY p.id
        ORDER BY MIN(mc.match_rank) ASC, ${popularityOrderSql("interaction", hasMaterializedData)}
        LIMIT @limit`,
    )
    .all(params);

  if (rows.length > PERSON_REF_CAP) {
    log.warn(
      `Person ref matched ${rows[0]!.matched} people before merge collapse; keeping the ${PERSON_REF_CAP} best-ranked`,
    );
  }
  return rows.slice(0, PERSON_REF_CAP).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// People-counts compute / upsert (split for the writer worker)
// ---------------------------------------------------------------------------

/**
 * Pure-read aggregation over `document_people` + `person_aliases`.
 * Returns one row per `people` entry with the recomputed counts.
 *
 * Designed to run on a read-only handle (the backfill worker's
 * `openReadConn`) so the heavy JOINs don't park the writer worker.
 * Single statement: GROUP-BY against each child table, LEFT JOIN'd
 * back onto `people`. Plan-driven by `idx_document_people_person_id`
 * + `idx_person_aliases_person_id`; same total work as the previous
 * correlated-subquery UPDATE but without holding the writer
 * connection for the duration. Rows where both counts are 0 ARE
 * still emitted — `upsertPeopleCounts` is responsible for any
 * skip-if-unchanged optimization.
 */
export function computePeopleCounts(db: Db): PeopleCountRow[] {
  // Counts attributed to canonical (post-merge) ids. Aggregations
  // GROUP BY COALESCE(merged_into, id) so a logically-merged loser's
  // documents and aliases roll up onto the canonical. The materialized
  // `doc_count` / `alias_count` columns on `people` reflect this
  // aggregated view; the raw per-person counts (loser's own row) are
  // not directly exposed anywhere user-visible.
  //
  // Loser rows still get their counts populated (with 0) in the
  // SELECT below — the upsert layer will write 0 there since they're
  // never queried but we don't want stale non-zero values lingering.
  const rows = db
    .prepare<[], { person_id: string; doc_count: number; alias_count: number }>(
      `SELECT
         p.id AS person_id,
         COALESCE(d.cnt, 0) AS doc_count,
         COALESCE(a.cnt, 0) AS alias_count
       FROM people p
       LEFT JOIN (
         SELECT
           COALESCE(p2.merged_into, p2.id) AS canonical,
           COUNT(DISTINCT dp.document_id) AS cnt
         FROM document_people dp
         JOIN people p2 ON p2.id = dp.person_id
         GROUP BY canonical
       ) d ON d.canonical = p.id
       LEFT JOIN (
         SELECT
           COALESCE(p2.merged_into, p2.id) AS canonical,
           COUNT(*) AS cnt
         FROM person_aliases pa
         JOIN people p2 ON p2.id = pa.person_id
         GROUP BY canonical
       ) a ON a.canonical = p.id`,
    )
    .all();
  return rows.map((r) => ({
    personId: r.person_id,
    docCount: r.doc_count,
    aliasCount: r.alias_count,
  }));
}

export interface PeopleCountsChunkResult {
  rows: PeopleCountRow[];
  nextCursor: string | null;
}

/**
 * The chunk query, exported so a test can hold its plan to the shape the
 * bound depends on. Both this and the expression-filtered query it replaced
 * return the same counts; only the plan says whether a chunk touched its
 * own edges or most of the graph, so the plan is what needs guarding.
 */
export function peopleCountsChunkSql(): string {
  return `WITH batch AS (
    SELECT id FROM people WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?
  ),
  members AS (
    SELECT id AS person_id, id AS canonical FROM batch
    UNION ALL
    SELECT p.id AS person_id, p.merged_into AS canonical
      FROM batch b CROSS JOIN people p INDEXED BY idx_people_merged
        ON p.merged_into = b.id
  )
  SELECT b.id AS person_id,
    COALESCE(d.cnt, 0) AS doc_count,
    COALESCE(a.cnt, 0) AS alias_count
  FROM batch b
  LEFT JOIN (
    SELECT m.canonical AS canonical, COUNT(DISTINCT dp.document_id) AS cnt
    FROM members m CROSS JOIN document_people dp INDEXED BY idx_document_people_person_source
      ON dp.person_id = m.person_id
    GROUP BY m.canonical
  ) d ON d.canonical = b.id
  LEFT JOIN (
    SELECT m.canonical AS canonical, COUNT(*) AS cnt
    FROM members m CROSS JOIN person_aliases pa INDEXED BY idx_person_aliases_person
      ON pa.person_id = m.person_id
    GROUP BY m.canonical
  ) a ON a.canonical = b.id`;
}

/**
 * Cursor-paginated variant of `computePeopleCounts`. Processes one
 * batch of canonical people (merged_into IS NULL) per call. Scopes
 * the GROUP BY to only the canonical IDs in the batch, keeping each
 * dispatch under ~200ms on a 440k-edge graph.
 *
 * cursor = null starts from the beginning. nextCursor = null means
 * the sweep is complete.
 */
export function computePeopleCountsChunk(
  db: Db,
  cursor: string | null,
  batchSize: number,
): PeopleCountsChunkResult {
  type Row = { person_id: string; doc_count: number; alias_count: number };
  // Bound the work by the batch, not just its output.
  //
  // Filtering the graph on `COALESCE(p2.merged_into, p2.id) IN (batch)` is
  // an expression no index can serve, so it walks most of
  // `document_people` and `person_aliases` to find the edges belonging to
  // this chunk's thousand people — the whole graph's work, once per chunk,
  // and there are fifty chunks in a sweep. Resolving the batch to concrete
  // member ids first makes them indexed lookups on
  // `document_people.person_id` and `person_aliases.person_id`, so a chunk
  // touches its own edges and no others.
  //
  // The joins are pinned (CROSS JOIN + INDEXED BY) so `members` drives and
  // the edge tables are probed by person id. Left free, SQLite is entitled
  // to scan the whole edge table and probe the member set instead — which
  // returns the same counts for the same per-chunk cost this is meant to
  // remove, and does it silently.
  //
  // `members` expands each canonical to itself plus the people merged into
  // it, one hop. One hop is exact because merge chains are kept flat:
  // rule-based merges write every member straight to its root, and
  // `collapseTransitiveChains` repairs chains left by hand-made merges
  // before this sweep runs.
  const sql = peopleCountsChunkSql();
  const rows = db.prepare<[string, number], Row>(sql).all(cursor ?? "", batchSize);

  const mapped = rows.map((r) => ({
    personId: r.person_id,
    docCount: r.doc_count,
    aliasCount: r.alias_count,
  }));
  const nextCursor = mapped.length === batchSize ? mapped[mapped.length - 1].personId : null;
  return { rows: mapped, nextCursor };
}

/**
 * Zero out doc_count / alias_count for merged losers. Called once at
 * the end of a people-counts sweep to clear stale non-zero values on
 * loser rows (whose counts roll up onto the canonical).
 */
export function zeroPeopleCountsForLosers(db: Db): { updated: number } {
  const { changes } = db
    .prepare(
      "UPDATE people SET doc_count = 0, alias_count = 0 WHERE merged_into IS NOT NULL AND (doc_count != 0 OR alias_count != 0)",
    )
    .run();
  return { updated: changes };
}

/**
 * Pure-write companion to `computePeopleCounts`. Bulk-updates only
 * the rows whose counts actually changed — saves ~99% of writes on
 * a steady-state pass where most counts haven't moved since the
 * previous refresh, which is exactly the workload in production.
 *
 * Wrapped in a single transaction so the per-row UPDATE statements
 * commit as one atomic group; with TRUNCATE journal mode that's one
 * fsync regardless of how many people changed.
 */
export function upsertPeopleCounts(db: Db, rows: PeopleCountRow[]): { updated: number } {
  if (rows.length === 0) return { updated: 0 };

  // Read current values for diffing. One statement, one round-trip.
  const current = new Map<string, { doc_count: number; alias_count: number }>();
  for (const r of db
    .prepare<
      [],
      { id: string; doc_count: number; alias_count: number }
    >("SELECT id, doc_count, alias_count FROM people")
    .iterate()) {
    current.set(r.id, { doc_count: r.doc_count, alias_count: r.alias_count });
  }

  const updateStmt = db.prepare("UPDATE people SET doc_count = ?, alias_count = ? WHERE id = ?");

  let updated = 0;
  const apply = db.transaction((batch: PeopleCountRow[]) => {
    for (const row of batch) {
      const prev = current.get(row.personId);
      if (!prev) continue; // person deleted between compute and upsert; skip
      if (prev.doc_count === row.docCount && prev.alias_count === row.aliasCount) {
        continue;
      }
      updateStmt.run(row.docCount, row.aliasCount, row.personId);
      updated++;
    }
  });
  apply(rows);

  return { updated };
}

/** Fold a name for frequency grouping — diacritic-stripped, lowercased, whitespace-collapsed. */
function foldName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recompute the dominant ("primary") name for every unmerged, non-self person
 * from `occurrence_count`, and sync `canonical_name` to it.
 *
 * Names are grouped by a folded form so case/diacritic variants of one name
 * aggregate. A contact-card name (seeded above `CONTACT_NAME_FLOOR` by the
 * resolver) wins the "curated" tier; within a tier the score is real sender
 * activity — the mentions on top of the floor, summed across variants — with the
 * floor counted ONCE per group so two floored variants can't out-rank a single
 * more-active floored name. Ties break by earliest `created_at`, then
 * lexicographic. The group's highest-count raw row carries `is_primary = 1`
 * (others 0) and becomes `canonical_name`. Only changed rows are written; self
 * and merged-loser people are left untouched.
 */
export function recomputeNamePrimaries(db: Db): { updated: number } {
  const rows = db
    .prepare<
      [],
      {
        id: string;
        person_id: string;
        alias: string;
        occurrence_count: number;
        created_at: string;
        is_primary: number;
      }
    >(
      `SELECT pa.id, pa.person_id, pa.alias, pa.occurrence_count, pa.created_at, pa.is_primary
         FROM person_aliases pa
         JOIN people p ON p.id = pa.person_id
        WHERE pa.alias_type = 'name'
          AND p.merged_into IS NULL
          AND COALESCE(p.is_self, 0) = 0
        ORDER BY pa.person_id, pa.created_at, pa.id`,
    )
    .all();

  const setPrimary = db.prepare("UPDATE person_aliases SET is_primary = ? WHERE id = ?");
  const setCanonical = db.prepare(
    "UPDATE people SET canonical_name = ?, updated_at = ? WHERE id = ? AND canonical_name <> ?",
  );
  const now = new Date().toISOString();
  type Row = (typeof rows)[number];

  let updated = 0;
  const apply = db.transaction(() => {
    let i = 0;
    while (i < rows.length) {
      const pid = rows[i].person_id;
      const group: Row[] = [];
      while (i < rows.length && rows[i].person_id === pid) group.push(rows[i++]);

      // Aggregate by folded name. A contact-card name carries the large floor;
      // its "activity" is the real sender mentions on top (the excess over the
      // floor). Crucially the floor counts ONCE per folded group — not summed
      // across variants — so two floored variants of one name can't out-rank a
      // single floored name that is genuinely more active.
      type Group = { floored: boolean; activity: number; best: Row };
      const byFold = new Map<string, Group>();
      for (const r of group) {
        const key = foldName(r.alias);
        const floored = r.occurrence_count >= CONTACT_NAME_FLOOR;
        const activity = floored ? r.occurrence_count - CONTACT_NAME_FLOOR : r.occurrence_count;
        const cur = byFold.get(key);
        if (!cur) byFold.set(key, { floored, activity, best: r });
        else {
          cur.floored = cur.floored || floored;
          cur.activity += activity;
          if (r.occurrence_count > cur.best.occurrence_count) cur.best = r;
        }
      }
      const scoreOf = (g: Group): number => (g.floored ? CONTACT_NAME_FLOOR : 0) + g.activity;
      // Winning group: highest score, then earliest, then lexicographic.
      let winner: Group | null = null;
      let winnerScore = -1;
      for (const g of byFold.values()) {
        const s = scoreOf(g);
        if (
          !winner ||
          s > winnerScore ||
          (s === winnerScore && g.best.created_at < winner.best.created_at) ||
          (s === winnerScore &&
            g.best.created_at === winner.best.created_at &&
            g.best.alias < winner.best.alias)
        ) {
          winner = g;
          winnerScore = s;
        }
      }
      if (!winner) continue;

      for (const r of group) {
        const want = r.id === winner.best.id ? 1 : 0;
        if (r.is_primary !== want) setPrimary.run(want, r.id);
      }
      if (setCanonical.run(winner.best.alias, now, pid, winner.best.alias).changes > 0)
        updated += 1;
    }
  });
  apply();
  return { updated };
}

/**
 * Recompute doc_count + alias_count for every person and persist.
 * Preserved as `compute + upsert` for direct callers that already
 * have a writable handle and don't want to split the work — e.g.
 * the boot-time seed and tests that exercise the combined path.
 *
 * The backfill worker should split into `computePeopleCounts`
 * (read handle) + `upsertPeopleCounts` (writer worker) instead, so
 * the heavy aggregation doesn't park the writer.
 */
export function refreshPeopleCounts(db: Db): void {
  upsertPeopleCounts(db, computePeopleCounts(db));
}
