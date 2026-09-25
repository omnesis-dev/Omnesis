// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cross-loop collision candidates — the structural half of proactive
 * cross-loop inference, and the complement of `identity-candidates.ts`.
 * Identity reconcile asks "is this new datum the SAME obligation as an
 * existing loop?"; collision detection asks the complementary question over
 * the loop store itself: "do two DISTINCT open loops RELATE — compete for
 * the same slot, batch together, or contradict each other?".
 *
 * Such relations are invisible to similarity search by construction:
 * similarity finds SAMENESS, whereas a collision is DIFFERENT things sharing
 * a structural key. So we enumerate them deterministically by inverting the
 * open/snoozed loops on three keys and emitting any key that carries >1 loop:
 *   - `person`       — loops sharing an actor/involved person (self excluded,
 *                      since self is on nearly everything);
 *   - `doc`          — loops citing the same source document;
 *   - `deadline-day` — loops due on the same local day (a schedule conflict,
 *                      or a batchable day).
 *
 * A candidate is only a HINT. The generative `synthesis` run it seeds
 * re-reads the member loops' source documents and decides whether the
 * relation is real and worth a brief — over-produce cheaply here, ground
 * against atoms there. Deterministic (bounded SQL + JS grouping, no model
 * call), mirroring `identity-candidates.ts`. Candidates already covered by an
 * active brief that spans them are dropped, so a relation the user is already
 * seeing is never re-proposed.
 */

import { deadlineDueDay } from "../ranking.js";
import { SYNTHESIS_DEDUPE_PREFIX } from "../run-payloads.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The loop states a collision may be found among — never resolved loops. */
const CANDIDATE_STATES: readonly string[] = ["open", "snoozed"];

/** The brief states that still count as "the user is already seeing this". */
const ACTIVE_BRIEF_STATES: readonly string[] = ["unread", "read", "dismissed_snoozed"];

/**
 * Cap on how many loops one collision group carries into a judge run. A
 * super-connected key (a landlord on eight loops) is a real batching signal,
 * but the whole group need not ride one prompt — keep the most important
 * members so the seeded run stays bounded.
 */
const MAX_GROUP_MEMBERS = 8;

export interface CollisionCandidate {
  /** The colliding loops (≥2 ids), sorted — a stable identity for the group. */
  loopIds: string[];
  /**
   * Why they collided, one tag per shared key: `person:<id>`, `doc:<id>`,
   * `deadline-day:<YYYY-MM-DD>`. A group merged across several keys carries
   * all of them.
   */
  matchedBy: string[];
  /** Ranking signal: the greatest importance among the member loops. */
  score: number;
}

export interface FindCollisionCandidatesOptions {
  /** Max candidate groups returned (most important first). */
  limit: number;
  /** Self person id, excluded from the `person` signal (on nearly everything). */
  selfPersonId: string | null;
}

interface LoopMeta {
  importance: number;
  deadlineDay: string | null;
  lastUpdate: number;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function inClause(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * Enumerate cross-loop collision candidates over the current open/snoozed
 * loop store. See the module doc for the three keys and the ranking.
 */
export function findCollisionCandidates(
  db: Db,
  opts: FindCollisionCandidatesOptions,
): CollisionCandidate[] {
  const { limit, selfPersonId } = opts;
  if (limit <= 0) return [];

  // The candidate loop set, with the two signals we group by that live on the
  // loop row (importance for ranking, deadline day for the time key).
  const loops = db
    .prepare<
      string[],
      { id: string; importance: number; deadline_json: string | null; last_update: number }
    >(
      `SELECT id, importance, deadline_json, last_update FROM open_loops
        WHERE state IN (${inClause(CANDIDATE_STATES.length)})`,
    )
    .all(...CANDIDATE_STATES);
  if (loops.length < 2) return [];

  const meta = new Map<string, LoopMeta>();
  for (const l of loops) {
    const deadline = l.deadline_json === null ? null : safeJson(l.deadline_json);
    meta.set(l.id, {
      importance: l.importance,
      deadlineDay: deadline === null ? null : deadlineDueDay(deadline),
      lastUpdate: l.last_update,
    });
  }

  // Accumulate the raw groups: keyTag -> the set of loops sharing that key.
  const rawGroups = new Map<string, Set<string>>();
  const addMember = (keyTag: string, loopId: string): void => {
    let set = rawGroups.get(keyTag);
    if (!set) {
      set = new Set();
      rawGroups.set(keyTag, set);
    }
    set.add(loopId);
  };

  // (a) person key — shared actor/involved person, self excluded.
  const personRows = db
    .prepare<string[], { person_id: string; loop_id: string }>(
      `SELECT olp.person_id, olp.loop_id
         FROM open_loop_people olp
         JOIN open_loops ol ON ol.id = olp.loop_id
        WHERE ol.state IN (${inClause(CANDIDATE_STATES.length)})`,
    )
    .all(...CANDIDATE_STATES);
  for (const r of personRows) {
    if (selfPersonId !== null && r.person_id === selfPersonId) continue;
    addMember(`person:${r.person_id}`, r.loop_id);
  }

  // (b) doc key — shared source document.
  const docRows = db
    .prepare<string[], { doc_id: string; loop_id: string }>(
      `SELECT old.doc_id, old.loop_id
         FROM open_loop_docs old
         JOIN open_loops ol ON ol.id = old.loop_id
        WHERE ol.state IN (${inClause(CANDIDATE_STATES.length)})`,
    )
    .all(...CANDIDATE_STATES);
  for (const r of docRows) addMember(`doc:${r.doc_id}`, r.loop_id);

  // (c) deadline-day key — loops due on the same local day.
  for (const [loopId, m] of meta) {
    if (m.deadlineDay !== null) addMember(`deadline-day:${m.deadlineDay}`, loopId);
  }

  // Merge raw groups by their loop-id set: a pair colliding on BOTH a person
  // and a doc is one candidate carrying both tags, not two. Keyed on the
  // sorted member ids so the same set from different signals collapses.
  interface Merged {
    loopIds: string[];
    tags: Set<string>;
  }
  const merged = new Map<string, Merged>();
  for (const [tag, set] of rawGroups) {
    if (set.size < 2) continue; // not a collision — a lone loop shares nothing
    const members = [...set].sort();
    const capped =
      members.length <= MAX_GROUP_MEMBERS
        ? members
        : members
            .slice()
            .sort((a, b) => (meta.get(b)?.importance ?? 0) - (meta.get(a)?.importance ?? 0))
            .slice(0, MAX_GROUP_MEMBERS)
            .sort();
    const setKey = capped.join(",");
    let m = merged.get(setKey);
    if (!m) {
      m = { loopIds: capped, tags: new Set() };
      merged.set(setKey, m);
    }
    m.tags.add(tag);
  }
  if (merged.size === 0) return [];

  // Drop candidates already covered by an active brief that spans them — a
  // relation the user is already seeing must not be re-proposed. A brief
  // covers a candidate when its related-loop set is a SUPERSET of the group.
  const activeBriefLoopSets = loadActiveBriefLoopSets(db);
  const isCovered = (loopIds: readonly string[]): boolean =>
    activeBriefLoopSets.some((briefSet) => loopIds.every((id) => briefSet.has(id)));

  // Negative-verdict memory: a set the judge already settled (a completed
  // collision run exists for it) is not re-proposed unless one of its loops was
  // touched since — so a "no real relationship" verdict isn't paid for every
  // sweep, and a false collision on a high-importance shared contact can't
  // perpetually starve genuine lower-ranked ones. A POSITIVE verdict is instead
  // caught by `isCovered` (it left an active brief spanning the set).
  const judgedAt = loadSettledCollisionRunTimes(db);
  const isJudgedAndUnchanged = (loopIds: readonly string[]): boolean => {
    const at = judgedAt.get(loopIds.join(","));
    if (at === undefined) return false;
    const touched = Math.max(...loopIds.map((id) => meta.get(id)?.lastUpdate ?? 0));
    return touched <= at;
  };

  const candidates: CollisionCandidate[] = [];
  for (const m of merged.values()) {
    if (isCovered(m.loopIds) || isJudgedAndUnchanged(m.loopIds)) continue;
    const score = Math.max(...m.loopIds.map((id) => meta.get(id)?.importance ?? 0));
    candidates.push({ loopIds: m.loopIds, matchedBy: [...m.tags].sort(), score });
  }

  // Most important first; larger groups (more to reconcile at once) break ties;
  // then the group identity for a total, deterministic order.
  candidates.sort(
    (x, y) =>
      y.score - x.score ||
      y.loopIds.length - x.loopIds.length ||
      (x.loopIds.join(",") < y.loopIds.join(",") ? -1 : 1),
  );
  return candidates.slice(0, limit);
}

/**
 * The completion time of the most recent SETTLED collision-judge run per loop
 * set, keyed by the sorted member-id suffix (matching `collisionDedupeSuffix`).
 * Only `completed` runs count — a failed run never rendered a verdict, so its
 * set should be re-judged.
 */
function loadSettledCollisionRunTimes(db: Db): Map<string, number> {
  const prefix = `${SYNTHESIS_DEDUPE_PREFIX}collision:`;
  const rows = db
    .prepare<[string], { dedupe_key: string; at: number }>(
      `SELECT dedupe_key, MAX(completed_at) AS at FROM cognition_runs
        WHERE kind = 'synthesis' AND status = 'completed' AND completed_at IS NOT NULL
          AND dedupe_key LIKE ?
        GROUP BY dedupe_key`,
    )
    .all(`${prefix}%`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.dedupe_key.slice(prefix.length), r.at);
  return map;
}

/** Related-loop sets of every active (still-showable) brief. */
function loadActiveBriefLoopSets(db: Db): Array<Set<string>> {
  const rows = db
    .prepare<string[], { brief_id: string; loop_id: string }>(
      `SELECT brl.brief_id, brl.loop_id
         FROM brief_related_loops brl
         JOIN briefs b ON b.id = brl.brief_id
        WHERE b.state IN (${inClause(ACTIVE_BRIEF_STATES.length)})`,
    )
    .all(...ACTIVE_BRIEF_STATES);
  const byBrief = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = byBrief.get(r.brief_id);
    if (!set) {
      set = new Set();
      byBrief.set(r.brief_id, set);
    }
    set.add(r.loop_id);
  }
  return [...byBrief.values()];
}

/**
 * Stable run dedupe suffix for a collision candidate: the sorted member ids.
 * Keyed on the member SET (not the tags), so the same pair re-detected via a
 * different signal on a later sweep folds into the one pending judge run.
 * Loop ids and temporal-annotation ids share the suffix
 * space without colliding — the id prefixes keep them distinct.
 */
export function collisionDedupeSuffix(memberIds: readonly string[]): string {
  return [...memberIds].sort().join(",");
}

// ── time-interval collisions ───────────────────────────────────────────────

/**
 * Widest temporal annotation that may join a temporal collision. Coarse periods
 * (years, months, long validity ranges) overlap too broadly by
 * construction and carry no schedulable tension — the join is for concrete
 * occupancy: trips, bookings, deadlines, windows.
 */
const TEMPORAL_ANNOTATION_MAX_SPAN_DAYS = 35;

export interface TemporalAnnotationCollisionCandidate {
  /** The overlapping annotations (2 ids), sorted — a stable identity for the pair. */
  temporalAnnotationIds: string[];
  /** One tag: `time-overlap:<YYYY-MM-DD..YYYY-MM-DD>` — the intersection window. */
  matchedBy: string[];
}

export interface FindTemporalAnnotationCollisionCandidatesOptions {
  /** Max candidate pairs returned (soonest overlap first). */
  limit: number;
  /** Clock reading for the forward horizon. */
  now: number;
  /** How far ahead an overlap may start and still be judged. */
  horizonDays: number;
}

/**
 * Enumerate pairs of DISTINCT live temporal annotations whose intervals
 * overlap inside the forward horizon — the interval-arithmetic relation
 * similarity search cannot see (a trip and a deadline share no vocabulary,
 * yet conflict absolutely if they occupy the same days). Deterministic
 * bounded SQL; the seeded judge decides conflict / synergy / nothing.
 *
 * Exclusions, in the same spirit as the loop joins: coarse entries (year /
 * month precision, or ranges wider than
 * {@link TEMPORAL_ANNOTATION_MAX_SPAN_DAYS})
 * carry no schedulable tension; pairs sharing a source document are the
 * SAME event seen twice (reconcile's problem, not a collision); pairs the
 * judge already settled re-enter only when an entry was updated since.
 */
export function findTemporalAnnotationCollisionCandidates(
  db: Db,
  opts: FindTemporalAnnotationCollisionCandidatesOptions,
): TemporalAnnotationCollisionCandidate[] {
  const { limit, now, horizonDays } = opts;
  if (limit <= 0) return [];
  const horizonEndMs = now + horizonDays * 24 * 3_600_000;
  const maxSpanMs = TEMPORAL_ANNOTATION_MAX_SPAN_DAYS * 24 * 3_600_000;

  // The settled-verdict exclusion lives INSIDE the query (not a post-LIMIT
  // JS filter) so a dense stretch of already-judged pairs at the head of
  // the window can never starve a fresh pair further out. `a.id < b.id`
  // makes `a.id||','||b.id` exactly the sorted dedupe suffix.
  const rows = db
    .prepare<
      [number, number, number, number, number],
      {
        a_id: string;
        b_id: string;
        overlap_start: number;
        overlap_end: number;
      }
    >(
      `SELECT a.id AS a_id, b.id AS b_id,
              MAX(a.interval_start_ms, b.interval_start_ms) AS overlap_start,
              MIN(a.interval_end_ms, b.interval_end_ms) AS overlap_end
         FROM temporal_annotations a
         JOIN temporal_annotations b ON a.id < b.id
        WHERE a.invalidated_at IS NULL AND b.invalidated_at IS NULL
          AND a.precision NOT IN ('year', 'month')
          AND b.precision NOT IN ('year', 'month')
          AND (a.interval_end_ms - a.interval_start_ms) <= ?
          AND (b.interval_end_ms - b.interval_start_ms) <= ?
          AND a.interval_start_ms <= b.interval_end_ms
          AND a.interval_end_ms >= b.interval_start_ms
          AND MIN(a.interval_end_ms, b.interval_end_ms) >= ?
          AND MAX(a.interval_start_ms, b.interval_start_ms) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM temporal_annotation_documents da
              JOIN temporal_annotation_documents dbx ON dbx.document_id = da.document_id
             WHERE da.annotation_id = a.id AND dbx.annotation_id = b.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM cognition_runs r
             WHERE r.kind = 'synthesis' AND r.status = 'completed'
               AND r.dedupe_key = 'synthesis:collision:' || a.id || ',' || b.id
               AND r.completed_at >= MAX(a.updated_at, b.updated_at)
          )
        ORDER BY overlap_start ASC, a.id ASC, b.id ASC
        LIMIT ?`,
    )
    .all(maxSpanMs, maxSpanMs, now, horizonEndMs, limit);

  return rows.map((r) => ({
    temporalAnnotationIds: [r.a_id, r.b_id].sort(),
    matchedBy: [`time-overlap:${utcDay(r.overlap_start)}..${utcDay(r.overlap_end)}`],
  }));
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── annotation contradictions ──────────────────────────────────────────────

/**
 * Cap on how many disagreeing annotations one contradiction group carries
 * into a judge run — mirrors {@link MAX_GROUP_MEMBERS}. A runaway subject
 * with dozens of same-claimType priors keeps its most recently touched
 * members; the rest surface on a later sweep once the head is repaired.
 */
const MAX_CONTRADICTION_GROUP_MEMBERS = 8;

/**
 * Recursive CTE mapping every person id appearing in `person_annotations` to
 * its merge-chain ROOT (`person_roots(person_id, root_id)`): the walk follows
 * `people.merged_into` to 10 hops — matching `resolvePersonId` — and the root
 * is the deepest node reached (a person unknown to `people`, or never merged,
 * roots at itself). Chains A→B→C are routine, so a one-hop resolution would
 * put A-rows and C-rows in different groups and miss their contradiction.
 * The depth bound also terminates a pathological `merged_into` cycle.
 */
const PERSON_ROOTS_CTE = `RECURSIVE walk(start_id, id, depth) AS (
    SELECT DISTINCT person_id, person_id, 0 FROM person_annotations
    UNION ALL
    SELECT w.start_id, p.merged_into, w.depth + 1
      FROM walk w JOIN people p ON p.id = w.id
     WHERE p.merged_into IS NOT NULL AND w.depth < 10
  ),
  person_roots(person_id, root_id) AS (
    SELECT start_id, id FROM walk w
     WHERE NOT EXISTS (
       SELECT 1 FROM walk w2 WHERE w2.start_id = w.start_id AND w2.depth > w.depth
     )
  )`;

export interface AnnotationContradictionCandidate {
  /** Which annotation store the group lives in (same-store pairs only). */
  store: "doc" | "person";
  /** The disagreeing live annotation ids (≥2, sorted) — the group's identity. */
  annotationIds: string[];
  /** The shared subject: a document id or a person id. */
  subjectId: string;
  /** The claim type the group disagrees within. */
  claimType: string;
}

export interface FindAnnotationContradictionCandidatesOptions {
  /** Max candidate groups returned across both stores (doc store first). */
  max: number;
}

/**
 * Enumerate groups of LIVE annotations that share a (subject, claimType) key
 * yet carry more than one distinct claim text — the contradiction the
 * reconcile-before-create refusal should have prevented, caught after the
 * fact. Doc-store and person-store groups are found separately (same-store
 * pairs only; the two stores never share a subject). Cheap SQL-first
 * grouping, no model call — the seeded `synthesis` judge re-grounds each
 * claim against its evidence and repairs by supersession.
 *
 * Liveness matches the serving reads: not invalidated AND the evidence doc
 * still exists — a dangling annotation is un-regroundable, so it must never
 * seed a judge run. The person arm groups by the CANONICAL person id — the
 * full merge-chain root ({@link PERSON_ROOTS_CTE}), mirroring
 * `listLivePersonAnnotationsForPerson`'s class expansion: a merge is
 * precisely the event that mints a contradiction with no create to refuse,
 * so claims authored against since-merged-away ids (however many hops down)
 * must land in one group. Claim types group case-insensitively, matching the
 * tool boundary's claimType normalization (stored rows may predate it).
 *
 * The member cap keeps the freshest row of every DISTINCT claim text first,
 * then fills by recency — so the emitted group always carries the
 * disagreement the HAVING clause detected, even when the freshest rows all
 * agree with each other.
 *
 * Negative-verdict memory (the loop-collision convention): a group the judge
 * already settled — a COMPLETED run exists for its sorted-id dedupe key — is
 * not re-proposed until a member is revised, so a "both true, different
 * aspects" verdict is not re-paid every sweep. A repaired group changes its
 * member set (the successor has a new id), so it re-enters on its own.
 */
export function findAnnotationContradictionCandidates(
  db: Db,
  opts: FindAnnotationContradictionCandidatesOptions,
): AnnotationContradictionCandidate[] {
  if (opts.max <= 0) return [];
  const settledAt = loadSettledAnnotationContradictionRunTimes(db);
  const out: AnnotationContradictionCandidate[] = [];
  for (const store of ["doc", "person"] as const) {
    if (out.length >= opts.max) break;
    const table = store === "doc" ? "doc_annotations" : "person_annotations";
    // The person subject is the canonical id — every row's person_id resolves
    // to its full merge-chain root through the person_roots CTE, so merged
    // identities (any chain depth) share one group.
    const withClause = store === "doc" ? "" : `WITH ${PERSON_ROOTS_CTE} `;
    const subjectExpr = store === "doc" ? "a.doc_id" : "pr.root_id";
    const joinClause = store === "doc" ? "" : " JOIN person_roots pr ON pr.person_id = a.person_id";
    const liveClause = `a.invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = a.evidence_doc_id)`;
    // Group heads first (most recently touched leads); members per group in a
    // second bounded query.
    const groups = db
      .prepare<[], { subject: string; claim_type: string }>(
        `${withClause}SELECT ${subjectExpr} AS subject, a.claim_type AS claim_type
           FROM ${table} a${joinClause}
          WHERE ${liveClause}
          GROUP BY subject, a.claim_type COLLATE NOCASE
         HAVING COUNT(DISTINCT a.claim_text) > 1
          ORDER BY MAX(COALESCE(a.updated_at, a.created_at)) DESC, subject ASC, claim_type ASC`,
      )
      .all();
    for (const g of groups) {
      if (out.length >= opts.max) break;
      // Rank the freshest row of each distinct claim text ahead of the rest
      // (freshness_rank = 1), then fill by recency: the cap can never emit a
      // group whose kept members all share one claim text.
      const members = db
        .prepare<[string, string, number], { id: string; touched: number }>(
          `${withClause}SELECT id, touched FROM (
             SELECT a.id AS id, COALESCE(a.updated_at, a.created_at) AS touched,
                    ROW_NUMBER() OVER (
                      PARTITION BY a.claim_text
                      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id ASC
                    ) AS freshness_rank
               FROM ${table} a${joinClause}
              WHERE ${subjectExpr} = ? AND a.claim_type = ? COLLATE NOCASE AND ${liveClause})
            ORDER BY (freshness_rank = 1) DESC, touched DESC, id ASC LIMIT ?`,
        )
        .all(g.subject, g.claim_type, MAX_CONTRADICTION_GROUP_MEMBERS);
      const ids = members.map((m) => m.id).sort();
      const at = settledAt.get(ids.join(","));
      if (at !== undefined && Math.max(...members.map((m) => m.touched)) <= at) continue;
      out.push({ store, annotationIds: ids, subjectId: g.subject, claimType: g.claim_type });
    }
  }
  return out;
}

/**
 * The completion time of the most recent SETTLED annotation-contradiction
 * judge run per group, keyed by the sorted member-id suffix. Only `completed`
 * runs count — a failed run never rendered a verdict (the loop-collision
 * convention, see {@link loadSettledCollisionRunTimes}).
 */
function loadSettledAnnotationContradictionRunTimes(db: Db): Map<string, number> {
  const prefix = `${SYNTHESIS_DEDUPE_PREFIX}anno-contradiction:`;
  const rows = db
    .prepare<[string], { dedupe_key: string; at: number }>(
      `SELECT dedupe_key, MAX(completed_at) AS at FROM cognition_runs
        WHERE kind = 'synthesis' AND status = 'completed' AND completed_at IS NOT NULL
          AND dedupe_key LIKE ?
        GROUP BY dedupe_key`,
    )
    .all(`${prefix}%`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.dedupe_key.slice(prefix.length), r.at);
  return map;
}
