// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { advanceOccWatermark, captureOccVersion, readOccMeta } from "../data/occ-materialized.js";

/**
 * One row in the result of `computeInteractionScores`. Carries the
 * raw counts AND both the lifetime + exponentially-decayed scores so
 * future consumers can pick the variant that fits (search ranking
 * may want decayed; trust / privacy gates may want lifetime).
 *
 * Each score lives in `[0, 1]`. The harmonic mean makes a one-sided
 * relationship (newsletters, gym bills) collapse to near-zero even at
 * high inbound volume — a friend with 50 in / 40 out scores far higher
 * than a list with 500 in / 0 out.
 */
export interface InteractionScoreRow {
  personId: string;
  inboundCount: number;
  outboundCount: number;
  inboundScore: number;
  outboundScore: number;
  interactionScore: number;
  inboundScoreRecent: number;
  outboundScoreRecent: number;
  interactionScoreRecent: number;
}

/**
 * The per-row aggregation summary returned by `computeInteractionScores`.
 * `dirtyVersion` is the singleton meta version captured at compute
 * time — the writer's `upsertInteractionScores` advances
 * `last_computed_version` to this value so the next periodic tick can
 * tell whether anything has moved since.
 */
export interface InteractionScoresSnapshot {
  rows: InteractionScoreRow[];
  /** `interaction_scores_meta.dirty_version` value at compute start. */
  dirtyVersion: number;
  /** ISO timestamp at compute end. */
  computedAt: string;
}

/**
 * Decay half-life in days. A 1-year half-life means a doc from 1 year
 * ago contributes half as much to the "_recent" scores as a doc today,
 * a 2-year-old doc contributes 1/4, etc. Picked as a balance between
 * "old-but-strong relationships shouldn't vanish" and "current best
 * friend should outrank a college acquaintance from a decade ago".
 *
 * Hardcoded for v1. Promote to a config knob if/when consumers want
 * different decay profiles per use case (search vs privacy vs UI sort).
 */
const DECAY_HALF_LIFE_DAYS = 365;

/**
 * Producer roles: the person authored / sent / owns the doc — they
 * pushed information out. Documents the user authored count as
 * outbound contributions to whoever consumed them.
 */
const PRODUCER_ROLES: ReadonlySet<string> = new Set(["author", "sender", "owner"]);

/**
 * Consumer roles: the person received / attended / participated —
 * they were on the receiving side. WhatsApp 1:1 chats list both
 * parties as `participant`; that's the symmetric "co-consumption"
 * case (no clear producer; counts as both inbound + outbound).
 */
const CONSUMER_ROLES: ReadonlySet<string> = new Set(["recipient", "attendee", "participant"]);

/**
 * Map a role name to a kind: 2 = producer, 1 = consumer, 0 = neutral.
 * `mentioned` and `contact` are neutral — a self-note that mentions
 * Sara doesn't strengthen the user/Sara interaction; a contact card
 * is just a directory entry.
 */
function roleKind(role: string): number {
  if (PRODUCER_ROLES.has(role)) return 2;
  if (CONSUMER_ROLES.has(role)) return 1;
  return 0;
}

/**
 * Pure math helper for the harmonic-mean step. Returns 0 when either
 * side is zero — that's the exact property that makes a one-sided
 * relationship score zero regardless of how lopsided the volume is.
 */
function harmonicMean(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

/**
 * Pure-read aggregation that walks `document_people` once and returns
 * one InteractionScoreRow per non-self person reachable from the
 * self person.
 *
 * Algorithm (see role table in `people_tracking.md`):
 * - For each document where self has any non-neutral role, look up
 *   every OTHER person on the same doc with a non-neutral role.
 * - Classify the (self_kind, p_kind) pair into inbound (1/0) and
 *   outbound (1/0) edge contributions.
 * - For decayed scores, weight each edge by `exp(-ln(2) * age_days /
 *   half_life_days)`. We compute the decay in JS (SQLite math
 *   functions aren't available without an extension load).
 * - Normalize per-person counts by the global edge totals to land
 *   each score in `[0, 1]`. The interaction score is the harmonic
 *   mean of the inbound + outbound shares.
 *
 * Side effects: none. The compute pass holds a read-only handle and
 * reads `interaction_scores_meta.dirty_version` to seal the snapshot.
 *
 * Worst-case cost: ~one full scan of `document_people` joined to
 * `documents.source_created_at`. On a 440k-edge graph this is the
 * same order as `computePeopleCounts` — a few hundred milliseconds on
 * the read handle, which doesn't park the writer.
 */
export function computeInteractionScores(
  db: Db,
  options: { halfLifeDays?: number; nowMs?: number } = {},
): InteractionScoresSnapshot {
  const halfLifeDays = options.halfLifeDays ?? DECAY_HALF_LIFE_DAYS;
  const nowMs = options.nowMs ?? Date.now();
  const decayConstant = Math.LN2 / (halfLifeDays * 86_400_000);

  // Capture the dirty version before we read anything — pairs with the
  // writer's OCC check. If a mutation lands during compute, dirty_version
  // moves and the writer optionally skips (we currently always apply
  // because every consumer of the score table benefits more from a
  // fresh-but-slightly-stale value than from blocking a refresh). See
  // `data/occ-materialized.ts` for the shared primitive.
  const dirtyVersion = captureOccVersion(db, "interaction_scores");

  // Locate self. No self → no scores to compute (every relationship is
  // measured AGAINST the user).
  const selfRow = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  if (!selfRow) {
    return { rows: [], dirtyVersion, computedAt: new Date(nowMs).toISOString() };
  }
  const selfId = selfRow.id;

  // Pull every (doc, canonical_person, kind, doc_date) tuple where
  // both self and some other person have a non-neutral role on the
  // same doc. The CTEs map raw `document_people.person_id` to its
  // canonical via `COALESCE(p.merged_into, p.id)` — logical merges
  // attribute the loser's edges to the canonical.
  //
  // The MAX over kind collapses multi-role rows on the canonical (a
  // doc where the canonical was sender + the loser was recipient
  // becomes one (canonical, doc) row with kind=producer).
  //
  // The self-side CTE matches docs where ANY person in the self
  // equivalence class (canonical = selfId, or merged_into = selfId)
  // appears. So if the user has multiple person rows that resolved
  // to self via merge, all their docs count.
  const rowsIter = db
    .prepare<
      [string, string],
      { person_id: string; self_k: number; p_k: number; doc_date: string | null }
    >(
      `WITH self_role AS (
         SELECT dp.document_id,
                MAX(CASE
                  WHEN dp.role IN ('author','sender','owner') THEN 2
                  WHEN dp.role IN ('recipient','attendee','participant') THEN 1
                  ELSE 0 END) AS k
         FROM document_people dp
         JOIN people p ON p.id = dp.person_id
         WHERE COALESCE(p.merged_into, p.id) = ?
         GROUP BY dp.document_id
         HAVING k > 0
       ),
       person_role AS (
         SELECT dp.document_id,
                COALESCE(p.merged_into, p.id) AS canonical_person_id,
                MAX(CASE
                  WHEN dp.role IN ('author','sender','owner') THEN 2
                  WHEN dp.role IN ('recipient','attendee','participant') THEN 1
                  ELSE 0 END) AS k
         FROM document_people dp
         JOIN people p ON p.id = dp.person_id
         WHERE COALESCE(p.merged_into, p.id) != ?
         GROUP BY dp.document_id, canonical_person_id
         HAVING k > 0
       )
       SELECT pr.canonical_person_id AS person_id,
              sr.k AS self_k, pr.k AS p_k,
              d.source_created_at AS doc_date
       FROM self_role sr
       JOIN person_role pr ON pr.document_id = sr.document_id
       JOIN documents d ON d.id = sr.document_id
       JOIN people canonical
         ON canonical.id = pr.canonical_person_id
        AND canonical.merged_into IS NULL
       WHERE canonical.is_self IS NULL OR canonical.is_self = FALSE`,
    )
    .iterate(selfId, selfId);

  interface Acc {
    inRaw: number;
    outRaw: number;
    inDecayed: number;
    outDecayed: number;
  }
  const perPerson = new Map<string, Acc>();
  let totalInRaw = 0;
  let totalOutRaw = 0;
  let totalInDecayed = 0;
  let totalOutDecayed = 0;

  for (const row of rowsIter) {
    const inboundEdge = row.p_k === 2 || (row.p_k === 1 && row.self_k === 1) ? 1 : 0;
    const outboundEdge = row.self_k === 2 || (row.self_k === 1 && row.p_k === 1) ? 1 : 0;
    if (inboundEdge === 0 && outboundEdge === 0) continue;

    let weight = 1;
    if (row.doc_date) {
      const ts = Date.parse(row.doc_date);
      if (Number.isFinite(ts)) {
        const ageMs = Math.max(0, nowMs - ts);
        weight = Math.exp(-decayConstant * ageMs);
      }
    }

    let acc = perPerson.get(row.person_id);
    if (!acc) {
      acc = { inRaw: 0, outRaw: 0, inDecayed: 0, outDecayed: 0 };
      perPerson.set(row.person_id, acc);
    }
    acc.inRaw += inboundEdge;
    acc.outRaw += outboundEdge;
    acc.inDecayed += inboundEdge * weight;
    acc.outDecayed += outboundEdge * weight;
    totalInRaw += inboundEdge;
    totalOutRaw += outboundEdge;
    totalInDecayed += inboundEdge * weight;
    totalOutDecayed += outboundEdge * weight;
  }

  const computedAt = new Date(nowMs).toISOString();
  const rows: InteractionScoreRow[] = [];
  for (const [personId, acc] of perPerson) {
    const inScore = totalInRaw > 0 ? acc.inRaw / totalInRaw : 0;
    const outScore = totalOutRaw > 0 ? acc.outRaw / totalOutRaw : 0;
    const inScoreRecent = totalInDecayed > 0 ? acc.inDecayed / totalInDecayed : 0;
    const outScoreRecent = totalOutDecayed > 0 ? acc.outDecayed / totalOutDecayed : 0;
    rows.push({
      personId,
      inboundCount: acc.inRaw,
      outboundCount: acc.outRaw,
      inboundScore: inScore,
      outboundScore: outScore,
      interactionScore: harmonicMean(inScore, outScore),
      inboundScoreRecent: inScoreRecent,
      outboundScoreRecent: outScoreRecent,
      interactionScoreRecent: harmonicMean(inScoreRecent, outScoreRecent),
    });
  }

  return { rows, dirtyVersion, computedAt };
}

// ── Chunked variants for sweep-accumulate ──────────────────────────

export function fetchSelfPersonId(db: Db): string | null {
  const row = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  return row?.id ?? null;
}

export interface InteractionEdgeTuple {
  personId: string;
  selfK: number;
  pK: number;
  docDate: string | null;
}

export interface InteractionScoresChunkResult {
  rows: InteractionEdgeTuple[];
  nextCursor: string | null;
}

/**
 * The chunk query, exported so a test can hold its plan to the shape its
 * cost depends on. Correct output does not distinguish a chunk that reads
 * only its own edges from one that rebuilds a whole-graph aggregate to
 * find them — both return the same tuples. Only the plan does.
 */
export function interactionScoresChunkSql(): string {
  return `WITH batch_people AS (
    SELECT id FROM people
    WHERE merged_into IS NULL
      AND (is_self IS NULL OR is_self = FALSE)
      AND id > ?
    ORDER BY id LIMIT ?
  ),
  batch_members AS (
    SELECT id AS person_id, id AS canonical FROM batch_people
    UNION ALL
    SELECT p.id AS person_id, p.merged_into AS canonical
      FROM batch_people b CROSS JOIN people p INDEXED BY idx_people_merged
        ON p.merged_into = b.id
  ),
  self_members AS (
    SELECT ? AS person_id
    UNION
    SELECT p.id FROM people p INDEXED BY idx_people_merged WHERE p.merged_into = ?
  ),
  person_role AS (
    SELECT dp.document_id,
      m.canonical AS canonical_person_id,
      MAX(CASE
        WHEN dp.role IN ('author','sender','owner') THEN 2
        WHEN dp.role IN ('recipient','attendee','participant') THEN 1
        ELSE 0 END) AS k
    FROM batch_members m
    CROSS JOIN document_people dp INDEXED BY idx_document_people_person_source
      ON dp.person_id = m.person_id
    GROUP BY dp.document_id, m.canonical
    HAVING k > 0
  ),
  self_role AS (
    SELECT dp.document_id,
      MAX(CASE
        WHEN dp.role IN ('author','sender','owner') THEN 2
        WHEN dp.role IN ('recipient','attendee','participant') THEN 1
        ELSE 0 END) AS k
    FROM (SELECT DISTINCT document_id FROM person_role) docs
    CROSS JOIN document_people dp INDEXED BY idx_document_people_doc
      ON dp.document_id = docs.document_id
    WHERE dp.person_id IN (SELECT person_id FROM self_members)
    GROUP BY dp.document_id
    HAVING k > 0
  )
  SELECT pr.canonical_person_id AS person_id,
    sr.k AS self_k, pr.k AS p_k,
    d.source_created_at AS doc_date
  FROM self_role sr
  JOIN person_role pr ON pr.document_id = sr.document_id
  JOIN documents d ON d.id = sr.document_id`;
}

/**
 * Cursor-paginated edge fetch for the sweep-accumulate interaction
 * scores refresh. Returns raw edge tuples for a batch of non-self
 * canonical people, ordered by person ID.
 *
 * Each chunk reads its own people's edges and the self-side roles on the
 * documents those edges name, so its cost tracks the batch rather than the
 * size of the graph.
 */
export function computeInteractionScoresChunk(
  db: Db,
  cursor: string | null,
  batchSize: number,
  selfId: string,
): InteractionScoresChunkResult {
  type Row = { person_id: string; self_k: number; p_k: number; doc_date: string | null };
  // Work proportional to the batch, not to the graph.
  //
  // Two things are needed for that, and each has a shape that silently
  // gives it up. The self side must read only the documents this batch
  // touches — building "every document self has a role on" first is a
  // whole-graph aggregate, and self appears on nearly every document in
  // the corpus, so a chunk would cost the same whatever its size. And
  // neither side may filter through COALESCE(merged_into, id): no index
  // serves that expression, so it walks document_people and tests rows.
  //
  // Now the batch's own edges are read first, through the person_id index,
  // and self's role is looked up only on the documents those edges landed
  // on, through the document_id index. Both sides are indexed lookups
  // driven by the batch, so a chunk touches its own edges and the documents
  // they name, and nothing else.
  //
  // `batch_members` and `self_members` each expand a canonical to itself
  // plus the people merged into it, one hop — the same hop the COALESCE
  // took, exact because chains are kept flat (see collapseTransitiveChains).
  const sql = interactionScoresChunkSql();
  const rows = db
    .prepare<[string, number, string, string], Row>(sql)
    .all(cursor ?? "", batchSize, selfId, selfId);

  const mapped: InteractionEdgeTuple[] = rows.map((r) => ({
    personId: r.person_id,
    selfK: r.self_k,
    pK: r.p_k,
    docDate: r.doc_date,
  }));

  // Determine the cursor from the batch_people set directly — NOT from
  // the edge rows. A batch where every person has zero edges still needs
  // to advance the cursor past those people.
  const batchInfo = db
    .prepare<[string, number], { cnt: number; last_id: string | null }>(
      `SELECT COUNT(*) AS cnt, MAX(id) AS last_id
       FROM (SELECT id FROM people
             WHERE merged_into IS NULL AND (is_self IS NULL OR is_self = FALSE)
               AND id > ? ORDER BY id LIMIT ?)`,
    )
    .get(cursor ?? "", batchSize);
  const actualBatchSize = batchInfo?.cnt ?? 0;
  const batchLast = batchInfo?.last_id ?? null;
  const nextCursor = actualBatchSize >= batchSize && batchLast ? batchLast : null;
  return { rows: mapped, nextCursor };
}

/** Exported constants and helpers for use by the sweep orchestrator. */
export { DECAY_HALF_LIFE_DAYS, harmonicMean };

/**
 * Pure-write companion to `computeInteractionScores`. Persists the
 * snapshot, advances `interaction_scores_meta.last_computed_version`
 * and `last_computed_at`, and zeroes out scores for any unmerged,
 * non-self people who weren't touched in the snapshot (e.g. a person
 * lost their last document_people link via a source delete).
 *
 * Yieldable: when `options.token` is supplied, the per-row UPDATEs
 * commit in chunks of `chunkSize` (default 1000). Between chunks the
 * loop polls the preempt token; on flip, it commits the chunk and
 * returns, leaving the rest for the next periodic tick to re-emit.
 *
 * Idempotent: re-running with the same snapshot is a no-op (every row
 * matches the current state, the diff filter skips them).
 */
export function upsertInteractionScores(
  db: Db,
  snapshot: InteractionScoresSnapshot,
  options: { token?: { requested(): boolean }; chunkSize?: number } = {},
): { updated: number; zeroed: number } {
  const chunkSize = Math.max(1, options.chunkSize ?? 1000);
  const token = options.token;

  // Snapshot every person's current state in one read so the per-row
  // diff doesn't fire 50k SELECTs on the writer thread.
  interface CurrentRow {
    inbound_count: number;
    outbound_count: number;
    inbound_score: number;
    outbound_score: number;
    interaction_score: number;
    inbound_score_recent: number;
    outbound_score_recent: number;
    interaction_score_recent: number;
  }
  const current = new Map<string, CurrentRow>();
  for (const r of db
    .prepare<[], { id: string } & CurrentRow>(
      `SELECT id, inbound_count, outbound_count,
              inbound_score, outbound_score, interaction_score,
              inbound_score_recent, outbound_score_recent, interaction_score_recent
       FROM people
       WHERE merged_into IS NULL`,
    )
    .iterate()) {
    current.set(r.id, {
      inbound_count: r.inbound_count,
      outbound_count: r.outbound_count,
      inbound_score: r.inbound_score,
      outbound_score: r.outbound_score,
      interaction_score: r.interaction_score,
      inbound_score_recent: r.inbound_score_recent,
      outbound_score_recent: r.outbound_score_recent,
      interaction_score_recent: r.interaction_score_recent,
    });
  }

  const updateStmt = db.prepare(
    `UPDATE people SET
       inbound_count = ?, outbound_count = ?,
       inbound_score = ?, outbound_score = ?, interaction_score = ?,
       inbound_score_recent = ?, outbound_score_recent = ?, interaction_score_recent = ?,
       interaction_scores_at = ?
     WHERE id = ? AND merged_into IS NULL`,
  );

  const computedAt = snapshot.computedAt;
  const touched = new Set<string>();
  let updated = 0;
  let zeroed = 0;
  let yielded = false;

  // Compare scores with a small epsilon rather than `===`. Lifetime
  // scores depend only on the raw counts and compare exact, but
  // `_recent` scores depend on `Date.now()` for the decay weight —
  // every refresh produces a microscopically different value even
  // when zero edges moved (~10^-6 per minute since the per-tick decay
  // step at a 1-year half-life is exp(-ln2 · 60s / 365d) ≈ 1 - 1.3e-6).
  // Without epsilon comparison the diff filter never skips, and a
  // steady-state DB rewrites all rows every refresh tick — exactly
  // the pathology we're trying to avoid.
  //
  // Threshold: 1e-6. Below user-visible (portal renders 3-decimal
  // fixed) and below ranking-meaningful precision. Counts compare
  // exact (they're integers).
  const SCORE_EPS = 1e-6;
  const closeEnough = (a: number, b: number): boolean => Math.abs(a - b) < SCORE_EPS;
  const sameAsCurrent = (
    cur: CurrentRow | undefined,
    next: InteractionScoreRow | null,
  ): boolean => {
    if (!cur) return false;
    if (!next) {
      return (
        cur.inbound_count === 0 &&
        cur.outbound_count === 0 &&
        closeEnough(cur.inbound_score, 0) &&
        closeEnough(cur.outbound_score, 0) &&
        closeEnough(cur.interaction_score, 0) &&
        closeEnough(cur.inbound_score_recent, 0) &&
        closeEnough(cur.outbound_score_recent, 0) &&
        closeEnough(cur.interaction_score_recent, 0)
      );
    }
    return (
      cur.inbound_count === next.inboundCount &&
      cur.outbound_count === next.outboundCount &&
      closeEnough(cur.inbound_score, next.inboundScore) &&
      closeEnough(cur.outbound_score, next.outboundScore) &&
      closeEnough(cur.interaction_score, next.interactionScore) &&
      closeEnough(cur.inbound_score_recent, next.inboundScoreRecent) &&
      closeEnough(cur.outbound_score_recent, next.outboundScoreRecent) &&
      closeEnough(cur.interaction_score_recent, next.interactionScoreRecent)
    );
  };

  // First pass: emit the rows the snapshot actually contains.
  for (let i = 0; i < snapshot.rows.length; i += chunkSize) {
    const chunk = snapshot.rows.slice(i, i + chunkSize);
    const apply = db.transaction(() => {
      for (const row of chunk) {
        touched.add(row.personId);
        if (sameAsCurrent(current.get(row.personId), row)) continue;
        const result = updateStmt.run(
          row.inboundCount,
          row.outboundCount,
          row.inboundScore,
          row.outboundScore,
          row.interactionScore,
          row.inboundScoreRecent,
          row.outboundScoreRecent,
          row.interactionScoreRecent,
          computedAt,
          row.personId,
        );
        if (result.changes > 0) updated += 1;
      }
    });
    apply();
    if (token?.requested()) {
      yielded = true;
      break;
    }
  }

  if (yielded) {
    // Bail before the zeroing pass — re-running with the same snapshot
    // next tick (or a fresh snapshot if the dirty bump fired again)
    // will pick up where we left off. Skipping zeroing is safe: stale
    // scores will be re-zeroed on the next full pass.
    return { updated, zeroed };
  }

  // Second pass: zero out scores for anyone who didn't appear in the
  // snapshot. Catches sources being deleted, all docs of a person
  // being removed, or self being detached. Without this, deleted
  // edges leave their old scores frozen on `people`.
  const zeroRow = {
    inbound_count: 0,
    outbound_count: 0,
    inbound_score: 0,
    outbound_score: 0,
    interaction_score: 0,
    inbound_score_recent: 0,
    outbound_score_recent: 0,
    interaction_score_recent: 0,
  } satisfies CurrentRow;
  // Don't skip the self person here. Self is structurally absent from
  // the compute snapshot (the join SQL filters them out), so they'd
  // land in this pile. They MUST be zeroed — otherwise a previously-
  // extracted person whose `is_self` later flips to TRUE (e.g. user
  // adds Apple Contacts after months of email ingest, their isMe card
  // resolves to an existing extracted person by email match) would
  // keep their stale non-self scores frozen on the row forever and
  // appear at a misleading rank in the portal. The `sameAsCurrent`
  // diff filter below makes this nearly free for the common case
  // (brand-new self with no prior scores: current == zeros == next,
  // skip).
  const zeroIds: string[] = [];
  for (const id of current.keys()) {
    if (touched.has(id)) continue;
    if (sameAsCurrent(current.get(id), null)) continue;
    zeroIds.push(id);
  }
  for (let i = 0; i < zeroIds.length; i += chunkSize) {
    const chunk = zeroIds.slice(i, i + chunkSize);
    const apply = db.transaction(() => {
      for (const id of chunk) {
        const result = updateStmt.run(
          zeroRow.inbound_count,
          zeroRow.outbound_count,
          zeroRow.inbound_score,
          zeroRow.outbound_score,
          zeroRow.interaction_score,
          zeroRow.inbound_score_recent,
          zeroRow.outbound_score_recent,
          zeroRow.interaction_score_recent,
          computedAt,
          id,
        );
        if (result.changes > 0) zeroed += 1;
      }
    });
    apply();
    if (token?.requested()) {
      // Don't advance the meta version on a yield — the next tick
      // re-runs and finishes the zeroing, then advances it.
      return { updated, zeroed };
    }
  }

  // Advance the meta watermark only after both passes complete. The
  // refresh task uses (dirty_version > last_computed_version) to
  // decide whether to fire — under-bumping here would cause
  // re-runs; over-bumping would cause stale scores to outlast a
  // legitimate dirty bump.
  advanceOccWatermark(db, {
    job: "interaction_scores",
    capturedVersion: snapshot.dirtyVersion,
  });

  return { updated, zeroed };
}

/**
 * Read the dirty / computed version pair on the singleton meta row.
 * Used by the periodic refresh task to decide whether anything has
 * moved since the last successful upsert.
 */
export function readInteractionScoresMeta(db: Db): {
  dirtyVersion: number;
  lastComputedVersion: number;
  lastComputedAt: number | null;
} {
  return readOccMeta(db, "interaction_scores");
}

/**
 * Combined compute + upsert. Direct callers (tests, admin one-shots)
 * use this; the Scheduler-driven path splits the halves across
 * compute and writer workers.
 */
export function refreshInteractionScores(
  db: Db,
  options: { halfLifeDays?: number; nowMs?: number } = {},
): { updated: number; zeroed: number } {
  return upsertInteractionScores(db, computeInteractionScores(db, options));
}
