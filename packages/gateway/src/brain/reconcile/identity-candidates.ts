// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Graph-based reconcile candidates — the identity half of
 * reconcile-before-create. Where `searchOpenLoopsLexical` matches a datum
 * to a loop by WORDING, this matches by real-world IDENTITY: the people on
 * it, the thread / linked documents around it, and a nearby deadline. It is
 * the difference between "these two messages use similar words" and "this
 * confirmation is a reply in the same thread that opened the loop, from the
 * same people" — the latter reconciles even when the wording shares nothing.
 *
 * Deterministic by construction: two bounded SQL joins, the existing
 * bounded `expandOneHop` BFS (≤48 vertices, hub-avoidance inherited for
 * free), and a linear scoring pass. No model call — the Cognition Steward still
 * judges the enriched candidates (over-matching is acceptable, exactly as
 * for the lexical overlay).
 *
 * Three identity signals, unioned:
 *   (a) shared actor/involved people — a datum's `document_people` joined
 *       to `open_loop_people`, excluding self (self is on everything);
 *   (b) shared thread / linked-doc membership — the one-hop neighbourhood
 *       of each seed doc joined to `open_loop_docs`;
 *   (c) deadline proximity — a loop whose deadline date falls within a
 *       window of the seed datum's date.
 *
 * Only `open`/`snoozed` loops are candidates — a resolved (`done`/
 * `dismissed`) loop is a deliberate past verdict and must never resurface.
 */

import { expandOneHop, ONE_HOP_DEFAULT_FANOUT } from "../../domain/DocumentGraphService.js";
import { getOpenLoop } from "../storage/open-loops.js";
import type Database from "better-sqlite3";
import type { OpenLoopRow } from "../storage/types.js";

type Db = Database.Database;

/**
 * Scoring weights, documented as a strict ranking rather than tuned magic:
 * a thread / linked-doc match is the strongest identity signal (one shared
 * neighbour outweighs any single shared person or a nearby deadline), a
 * shared person and a nearby deadline are secondary and comparable. Because
 * per-person and deadline contributions are each bounded to `[0, 1]`, one
 * link overlap (weight 3) always outranks a lone low-signal shared person —
 * a super-node contact can never drag an unrelated loop to the top.
 */
const W_LINK = 3;
const W_PERSON = 1;
const W_DEADLINE = 1;

/** The states a reconcile candidate may be in — never resolved loops. */
const CANDIDATE_STATES: readonly string[] = ["open", "snoozed"];

export interface SearchOpenLoopsByIdentityOptions {
  /** Documents the run is about — the datum(s) whose identity we reconcile from. */
  seedDocIds: readonly string[];
  /** Current time (unix ms) — reserved for future recency shaping; injectable. */
  now: number;
  /** Max candidates returned. */
  limit: number;
  /** Window (ms) around the seed date within which a deadline counts as a signal. */
  deadlineWindowMs: number;
  /** The self person id, excluded from the shared-people signal (on everything). */
  selfPersonId: string | null;
  /** 1-hop neighbour fanout per seed doc (default: the graph service default). */
  neighborFanout?: number;
}

/** A reconcile candidate: the loop, how it matched, and its combined score. */
export interface IdentityCandidate {
  loop: OpenLoopRow;
  /** Provenance tags: `person:<id>`, `linked-doc:<id>`, `deadline-proximity`. */
  matchedBy: string[];
  score: number;
}

interface Accum {
  personScore: number;
  personTags: Set<string>;
  linkOverlaps: number;
  linkTags: Set<string>;
  deadlineProximity: number;
}

function accumFor(map: Map<string, Accum>, loopId: string): Accum {
  let acc = map.get(loopId);
  if (!acc) {
    acc = {
      personScore: 0,
      personTags: new Set(),
      linkOverlaps: 0,
      linkTags: new Set(),
      deadlineProximity: 0,
    };
    map.set(loopId, acc);
  }
  return acc;
}

function inClause(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * The seed datum's anchor date (unix ms) — the most recent source-created
 * time among the seed docs, against which loop deadlines are measured.
 * Returns null when no seed doc has a parseable date, which disables the
 * deadline signal for this run.
 */
function seedAnchorMs(db: Db, seedDocIds: readonly string[]): number | null {
  if (seedDocIds.length === 0) return null;
  const rows = db
    .prepare<
      string[],
      { source_created_at: string }
    >(`SELECT source_created_at FROM documents WHERE id IN (${inClause(seedDocIds.length)})`)
    .all(...seedDocIds);
  let anchor: number | null = null;
  for (const r of rows) {
    const ms = Date.parse(r.source_created_at);
    if (!Number.isNaN(ms) && (anchor === null || ms > anchor)) anchor = ms;
  }
  return anchor;
}

/**
 * Union of reconcile candidates for the seed documents, ranked by identity
 * signal. See the module doc for the three signals and the ranking.
 */
export function searchOpenLoopsByIdentity(
  db: Db,
  opts: SearchOpenLoopsByIdentityOptions,
): IdentityCandidate[] {
  const { seedDocIds, limit, deadlineWindowMs, selfPersonId } = opts;
  if (seedDocIds.length === 0 || limit <= 0) return [];

  const acc = new Map<string, Accum>();

  // (a) Shared actor/involved people. The seed docs' people, minus self,
  // matched against every loop that carries one of them.
  const sharedPeople = db
    .prepare<string[], { person_id: string }>(
      `SELECT DISTINCT person_id FROM document_people WHERE document_id IN (${inClause(seedDocIds.length)})`,
    )
    .all(...seedDocIds)
    .map((r) => r.person_id)
    .filter((id) => id !== selfPersonId);
  if (sharedPeople.length > 0) {
    const scoreById = new Map<string, number>(
      db
        .prepare<string[], { id: string; interaction_score_recent: number }>(
          `SELECT id, interaction_score_recent FROM people WHERE id IN (${inClause(sharedPeople.length)})`,
        )
        .all(...sharedPeople)
        .map((r) => [r.id, r.interaction_score_recent] as const),
    );
    const rows = db
      .prepare<string[], { loop_id: string; person_id: string }>(
        `SELECT DISTINCT olp.loop_id, olp.person_id
           FROM open_loop_people olp
           JOIN open_loops ol ON ol.id = olp.loop_id
          WHERE olp.person_id IN (${inClause(sharedPeople.length)})
            AND ol.state IN (${inClause(CANDIDATE_STATES.length)})`,
      )
      .all(...sharedPeople, ...CANDIDATE_STATES);
    for (const r of rows) {
      const a = accumFor(acc, r.loop_id);
      // interaction_score_recent ∈ [0,1]; a bare match still counts a little
      // even when the person carries no recent-interaction weight yet.
      a.personScore += scoreById.get(r.person_id) ?? 0;
      a.personTags.add(`person:${r.person_id}`);
    }
  }

  // (b) Shared thread / linked-doc membership. The one-hop neighbourhood of
  // each seed doc (part-of-thread / replies-to / contains, hub-avoided),
  // matched against every loop that cites one of those neighbours.
  const neighborDocIds = new Set<string>();
  for (const seed of seedDocIds) {
    const expansion = expandOneHop(db, seed, {
      fanout: opts.neighborFanout ?? ONE_HOP_DEFAULT_FANOUT,
    });
    for (const n of expansion.neighbors) neighborDocIds.add(n.documentId);
  }
  if (neighborDocIds.size > 0) {
    const neighbors = [...neighborDocIds];
    const rows = db
      .prepare<string[], { loop_id: string; doc_id: string }>(
        `SELECT old.loop_id, old.doc_id
           FROM open_loop_docs old
           JOIN open_loops ol ON ol.id = old.loop_id
          WHERE old.doc_id IN (${inClause(neighbors.length)})
            AND ol.state IN (${inClause(CANDIDATE_STATES.length)})`,
      )
      .all(...neighbors, ...CANDIDATE_STATES);
    for (const r of rows) {
      const a = accumFor(acc, r.loop_id);
      a.linkOverlaps += 1;
      a.linkTags.add(`linked-doc:${r.doc_id}`);
    }
  }

  // (c) Deadline proximity. A loop whose deadline date falls within the
  // window of the seed datum's date. Scanned in JS over the small set of
  // open/snoozed loops carrying a deadline date — no fragile SQL ms-window
  // date arithmetic, and the compressed-time tests stay exact.
  const anchorMs = seedAnchorMs(db, seedDocIds);
  if (anchorMs !== null && deadlineWindowMs > 0) {
    const rows = db
      .prepare<string[], { id: string; date: string | null }>(
        `SELECT id, json_extract(deadline_json, '$.date') AS date
           FROM open_loops
          WHERE state IN (${inClause(CANDIDATE_STATES.length)})
            AND json_extract(deadline_json, '$.date') IS NOT NULL`,
      )
      .all(...CANDIDATE_STATES);
    for (const r of rows) {
      if (r.date === null) continue;
      const deadlineMs = Date.parse(r.date);
      if (Number.isNaN(deadlineMs)) continue;
      const delta = Math.abs(deadlineMs - anchorMs);
      if (delta > deadlineWindowMs) continue;
      const a = accumFor(acc, r.id);
      // Linear falloff to the window edge, bounded to (0, 1].
      a.deadlineProximity = Math.max(a.deadlineProximity, 1 - delta / deadlineWindowMs);
    }
  }

  const candidates: IdentityCandidate[] = [];
  for (const [loopId, a] of acc) {
    const loop = getOpenLoop(db, loopId);
    if (!loop) continue; // vanished under a concurrent delete
    const score =
      W_LINK * a.linkOverlaps + W_PERSON * a.personScore + W_DEADLINE * a.deadlineProximity;
    if (score <= 0) continue;
    const matchedBy = [...a.linkTags, ...a.personTags];
    if (a.deadlineProximity > 0) matchedBy.push("deadline-proximity");
    candidates.push({ loop, matchedBy, score });
  }

  // Score desc; the loop's recency breaks ties (the "tiny last_update
  // tiebreak"), then id for a total, deterministic order.
  candidates.sort(
    (x, y) =>
      y.score - x.score ||
      y.loop.lastUpdate - x.loop.lastUpdate ||
      (x.loop.id < y.loop.id ? -1 : 1),
  );
  return candidates.slice(0, limit);
}
