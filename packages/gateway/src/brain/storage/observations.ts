// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Observation repository — CRUD over `observations`, `observation_citations`
 * and `observation_related_loops`, plus the retention prune into
 * `observation_outcomes`.
 *
 * Lifecycle rule enforced here: `shipped` and `dropped` are terminal. A
 * closed observation never returns to `live` or `held`; a subject that
 * becomes relevant again is noted as a new observation.
 */

import {
  isKnowledgeOwnerReadable,
  knowledgeOwnerReadPredicate,
} from "../knowledge/storage-fence.js";
import {
  isTerminalObservationState,
  type ObservationClaim,
  type ObservationCloseReason,
  type ObservationRow,
  type ObservationScores,
  type ObservationState,
} from "./types.js";
import { deleteInterestSignalsFor } from "./interest.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

interface ObservationDbRow {
  id: string;
  created_by_run: string;
  summary: string;
  why: string;
  user_authored: number;
  window_start: number | null;
  relevant_until: number | null;
  claims_json: string;
  state: string;
  close_reason: string | null;
  noted_scores_json: string | null;
  scores_json: string | null;
  would_push_at: number | null;
  shipped_at: number | null;
  shipped_conversation_id: string | null;
  shipped_message_id: string | null;
  user_action: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

function parseScores(json: string | null): ObservationScores | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ObservationScores;
  } catch {
    return null;
  }
}

function parseClaims(json: string): ObservationClaim[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ObservationClaim[]) : [];
  } catch {
    return [];
  }
}

function observationCitations(db: Db, id: string): string[] {
  return db
    .prepare<[string], { doc_id: string }>(
      "SELECT doc_id FROM observation_citations WHERE observation_id = ? ORDER BY position ASC",
    )
    .all(id)
    .map((r) => r.doc_id);
}

function observationRelatedLoopIds(db: Db, id: string): string[] {
  return db
    .prepare<[string], { loop_id: string }>(
      "SELECT loop_id FROM observation_related_loops WHERE observation_id = ? ORDER BY loop_id",
    )
    .all(id)
    .map((r) => r.loop_id);
}

function rowToObservation(db: Db, r: ObservationDbRow): ObservationRow {
  return {
    id: r.id,
    createdByRun: r.created_by_run,
    summary: r.summary,
    why: r.why,
    userAuthored: r.user_authored === 1,
    windowStart: r.window_start,
    relevantUntil: r.relevant_until,
    citations: observationCitations(db, r.id),
    relatedLoopIds: observationRelatedLoopIds(db, r.id),
    claims: parseClaims(r.claims_json),
    state: r.state as ObservationState,
    closeReason: r.close_reason as ObservationCloseReason | null,
    notedScores: parseScores(r.noted_scores_json),
    scores: parseScores(r.scores_json),
    wouldPushAt: r.would_push_at,
    shippedAt: r.shipped_at,
    shippedConversationId: r.shipped_conversation_id,
    shippedMessageId: r.shipped_message_id,
    userAction: r.user_action,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  };
}

function replaceCitations(db: Db, id: string, citations: readonly string[]): void {
  db.prepare<[string]>("DELETE FROM observation_citations WHERE observation_id = ?").run(id);
  const insert = db.prepare<[string, number, string]>(
    "INSERT INTO observation_citations (observation_id, position, doc_id) VALUES (?, ?, ?)",
  );
  [...new Set(citations)].forEach((docId, i) => insert.run(id, i, docId));
}

function replaceRelatedLoops(db: Db, id: string, loopIds: readonly string[]): void {
  db.prepare<[string]>("DELETE FROM observation_related_loops WHERE observation_id = ?").run(id);
  const insert = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO observation_related_loops (observation_id, loop_id) VALUES (?, ?)",
  );
  for (const loopId of loopIds) insert.run(id, loopId);
}

export interface CreateObservationInput {
  id: string;
  createdByRun: string;
  summary: string;
  why?: string;
  userAuthored?: boolean;
  windowStart?: number | null;
  relevantUntil?: number | null;
  citations?: string[];
  relatedLoopIds?: string[];
  claims?: ObservationClaim[];
  notedScores?: ObservationScores | null;
  wouldPushAt?: number | null;
}

export function createObservation(
  db: Db,
  input: CreateObservationInput,
  now: number,
): ObservationRow {
  db.transaction(() => {
    db.prepare<unknown[]>(
      `INSERT INTO observations (
         id, created_by_run, summary, why, user_authored, window_start, relevant_until,
         claims_json, state, noted_scores_json, would_push_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.createdByRun,
      input.summary,
      input.why ?? "",
      input.userAuthored ? 1 : 0,
      input.windowStart ?? null,
      input.relevantUntil ?? null,
      JSON.stringify(input.claims ?? []),
      input.notedScores ? JSON.stringify(input.notedScores) : null,
      input.wouldPushAt ?? null,
      now,
      now,
    );
    replaceCitations(db, input.id, input.citations ?? []);
    replaceRelatedLoops(db, input.id, input.relatedLoopIds ?? []);
  })();
  const created = getObservation(db, input.id);
  if (!created) throw new Error(`observation ${input.id} vanished mid-create`);
  return created;
}

export function getObservation(db: Db, id: string): ObservationRow | null {
  if (!isKnowledgeOwnerReadable(db, id)) return null;
  const row = db
    .prepare<[string], ObservationDbRow>("SELECT * FROM observations WHERE id = ?")
    .get(id);
  return row ? rowToObservation(db, row) : null;
}

export interface ListObservationsOptions {
  states?: readonly ObservationState[];
  limit?: number;
  beforeCreated?: { createdAt: number; id: string };
  createdByRun?: string;
}

/** Observations newest-created first. */
export function listObservations(db: Db, options: ListObservationsOptions = {}): ObservationRow[] {
  const conditions: string[] = [knowledgeOwnerReadPredicate(db, "observations.id")];
  const params: (string | number)[] = [];
  if (options.states && options.states.length > 0) {
    conditions.push(`state IN (${options.states.map(() => "?").join(", ")})`);
    params.push(...options.states);
  }
  if (options.createdByRun) {
    conditions.push("created_by_run = ?");
    params.push(options.createdByRun);
  }
  if (options.beforeCreated) {
    conditions.push("(created_at, id) < (?, ?)");
    params.push(options.beforeCreated.createdAt, options.beforeCreated.id);
  }
  params.push(options.limit ?? 100);
  return db
    .prepare<(string | number)[], ObservationDbRow>(
      `SELECT * FROM observations WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params)
    .map((r) => rowToObservation(db, r));
}

/** Every observation still eligible for a morning brief, oldest first. */
export function listOpenObservations(db: Db, limit = 500): ObservationRow[] {
  return db
    .prepare<[number], ObservationDbRow>(
      `SELECT * FROM observations
        WHERE state IN ('live','held') AND ${knowledgeOwnerReadPredicate(db, "observations.id")}
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit)
    .map((r) => rowToObservation(db, r));
}

/** Open observations attached to any of `loopIds`. */
export function findOpenObservationsForLoops(db: Db, loopIds: readonly string[]): ObservationRow[] {
  if (loopIds.length === 0) return [];
  const placeholders = loopIds.map(() => "?").join(",");
  return db
    .prepare<string[], ObservationDbRow>(
      `SELECT DISTINCT o.* FROM observations o
         JOIN observation_related_loops rl ON rl.observation_id = o.id
        WHERE rl.loop_id IN (${placeholders}) AND o.state IN ('live','held')
          AND ${knowledgeOwnerReadPredicate(db, "o.id")}
        ORDER BY o.created_at DESC, o.id DESC`,
    )
    .all(...loopIds)
    .map((r) => rowToObservation(db, r));
}

/** All observations attached to one loop, newest first (operator loop detail). */
export function listObservationsForLoop(
  db: Db,
  loopId: string,
  options: { limit?: number; beforeCreated?: { createdAt: number; id: string } } = {},
): ObservationRow[] {
  const params: Array<string | number> = [loopId];
  let cursor = "";
  if (options.beforeCreated) {
    cursor = "AND (o.created_at, o.id) < (?, ?)";
    params.push(options.beforeCreated.createdAt, options.beforeCreated.id);
  }
  params.push(options.limit ?? 50);
  return db
    .prepare<Array<string | number>, ObservationDbRow>(
      `SELECT o.* FROM observations o
         JOIN observation_related_loops rl ON rl.observation_id = o.id
        WHERE rl.loop_id = ? AND ${knowledgeOwnerReadPredicate(db, "o.id")} ${cursor}
        ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    )
    .all(...params)
    .map((r) => rowToObservation(db, r));
}

/** Rescore an open observation without changing its state. */
export function recordObservationScores(
  db: Db,
  id: string,
  scores: ObservationScores,
  now: number,
): boolean {
  return (
    db
      .prepare<[string, number, string]>(
        `UPDATE observations SET scores_json = ?, updated_at = ?
          WHERE id = ? AND state IN ('live','held')`,
      )
      .run(JSON.stringify(scores), now, id).changes > 0
  );
}

/** Record entailment verdicts for an open observation's claims. */
export function recordObservationClaims(
  db: Db,
  id: string,
  claims: readonly ObservationClaim[],
  now: number,
): boolean {
  return (
    db
      .prepare<[string, number, string]>(
        `UPDATE observations SET claims_json = ?, updated_at = ?
          WHERE id = ? AND state IN ('live','held')`,
      )
      .run(JSON.stringify(claims), now, id).changes > 0
  );
}

export interface ObservationTransition {
  state: Exclude<ObservationState, "live">;
  reason?: ObservationCloseReason | null;
  scores?: ObservationScores | null;
  shipped?: { conversationId: string; messageId: string };
  userAction?: string | null;
}

/**
 * Move an open observation to `held`, `shipped` or `dropped`. Refused (false)
 * when the observation is missing or already terminal; terminal states never
 * change again.
 */
export function transitionObservation(
  db: Db,
  id: string,
  transition: ObservationTransition,
  now: number,
): boolean {
  const current = db
    .prepare<[string], { state: string }>("SELECT state FROM observations WHERE id = ?")
    .get(id);
  if (!current || isTerminalObservationState(current.state as ObservationState)) return false;
  const terminal = isTerminalObservationState(transition.state);
  const sets = ["state = ?", "close_reason = ?", "updated_at = ?"];
  const args: Array<string | number | null> = [transition.state, transition.reason ?? null, now];
  if (transition.scores !== undefined) {
    sets.push("scores_json = ?");
    args.push(transition.scores ? JSON.stringify(transition.scores) : null);
  }
  if (transition.shipped) {
    sets.push("shipped_at = ?", "shipped_conversation_id = ?", "shipped_message_id = ?");
    args.push(now, transition.shipped.conversationId, transition.shipped.messageId);
  }
  if (transition.userAction !== undefined) {
    sets.push("user_action = ?");
    args.push(transition.userAction);
  }
  if (terminal) {
    sets.push("closed_at = ?");
    args.push(now);
  }
  args.push(id);
  return (
    db
      .prepare<
        Array<string | number | null>
      >(`UPDATE observations SET ${sets.join(", ")} WHERE id = ? AND state IN ('live','held')`)
      .run(...args).changes > 0
  );
}

/** Record what the user did about an observation, terminal or not; null clears it. */
export function setObservationUserAction(
  db: Db,
  id: string,
  userAction: string | null,
  now: number,
): boolean {
  return (
    db
      .prepare<
        [string | null, number, string]
      >("UPDATE observations SET user_action = ?, updated_at = ? WHERE id = ?")
      .run(userAction, now, id).changes > 0
  );
}

/**
 * Drop the open observations of a loop that resolved, unless another of their
 * related loops is still active. Returns the dropped ids.
 */
export function dropObservationsForResolvedLoop(db: Db, loopId: string, now: number): string[] {
  const dropped: string[] = [];
  db.transaction(() => {
    for (const observation of findOpenObservationsForLoops(db, [loopId])) {
      const otherActive = db
        .prepare<[string, string], { one: number }>(
          `SELECT 1 AS one FROM observation_related_loops rl
             JOIN open_loops l ON l.id = rl.loop_id
            WHERE rl.observation_id = ? AND rl.loop_id != ? AND l.state IN ('open','snoozed')
            LIMIT 1`,
        )
        .get(observation.id, loopId);
      if (otherActive) continue;
      if (
        transitionObservation(db, observation.id, { state: "dropped", reason: "superseded" }, now)
      )
        dropped.push(observation.id);
    }
  })();
  return dropped;
}

/**
 * Delete open observations attached to `loopIds`; with `includeClosed`, every
 * attached observation. Returns the deleted ids.
 */
export function deleteObservationsAttachedToLoops(
  db: Db,
  loopIds: readonly string[],
  opts: { includeClosed: boolean },
): string[] {
  if (loopIds.length === 0) return [];
  const placeholders = loopIds.map(() => "?").join(",");
  const ids = db
    .prepare<string[], { id: string }>(
      `SELECT DISTINCT o.id FROM observations o
         JOIN observation_related_loops rl ON rl.observation_id = o.id
        WHERE rl.loop_id IN (${placeholders})
          ${opts.includeClosed ? "" : "AND o.state IN ('live','held')"}`,
    )
    .all(...loopIds)
    .map((r) => r.id);
  const del = db.prepare<[string]>("DELETE FROM observations WHERE id = ?");
  for (const id of ids) {
    deleteInterestSignalsFor(db, { observationId: id });
    del.run(id);
  }
  return ids;
}

/** Delete every observation citing one of `docIds`. Returns the deleted ids. */
export function deleteObservationsCitingDocs(db: Db, docIds: readonly string[]): string[] {
  if (docIds.length === 0) return [];
  const placeholders = docIds.map(() => "?").join(",");
  const ids = db
    .prepare<string[], { observation_id: string }>(
      `SELECT DISTINCT observation_id FROM observation_citations WHERE doc_id IN (${placeholders})`,
    )
    .all(...docIds)
    .map((r) => r.observation_id);
  const del = db.prepare<[string]>("DELETE FROM observations WHERE id = ?");
  for (const id of ids) {
    deleteInterestSignalsFor(db, { observationId: id });
    del.run(id);
  }
  return ids;
}

/** Drop open observations whose relevance window has ended. Returns their ids. */
export function expireObservations(db: Db, now: number): string[] {
  const ids = db
    .prepare<[number], { id: string }>(
      `SELECT id FROM observations
        WHERE state IN ('live','held') AND relevant_until IS NOT NULL AND relevant_until <= ?`,
    )
    .all(now)
    .map((r) => r.id);
  for (const id of ids) transitionObservation(db, id, { state: "dropped", reason: "expired" }, now);
  return ids;
}

export interface PruneObservationsResult {
  pruned: number;
  ids: string[];
}

/**
 * Reduce closed observations older than `olderThan` to an outcome record and
 * delete the observation row (its knowledge node follows through the owner
 * triggers). Bounded per call.
 */
export function pruneClosedObservations(
  db: Db,
  olderThan: number,
  now: number,
  limit = 200,
): PruneObservationsResult {
  const rows = db
    .prepare<[number, number], ObservationDbRow>(
      `SELECT * FROM observations
        WHERE closed_at IS NOT NULL AND closed_at <= ?
        ORDER BY closed_at ASC, id ASC LIMIT ?`,
    )
    .all(olderThan, limit);
  const insert = db.prepare<unknown[]>(
    `INSERT OR REPLACE INTO observation_outcomes (
       id, topic, source_kinds_json, state, close_reason, noted_scores_json, scores_json,
       would_push_at, user_action, created_at, closed_at, pruned_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sourceKinds = db.prepare<[string], { kind: string }>(
    `SELECT DISTINCT d.provider_id || '/' || d.source_id AS kind
       FROM observation_citations c JOIN documents d ON d.id = c.doc_id
      WHERE c.observation_id = ? ORDER BY kind`,
  );
  const del = db.prepare<[string]>("DELETE FROM observations WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      insert.run(
        r.id,
        topicOf(r.summary),
        JSON.stringify(sourceKinds.all(r.id).map((k) => k.kind)),
        r.state,
        r.close_reason,
        r.noted_scores_json,
        r.scores_json,
        r.would_push_at,
        r.user_action,
        r.created_at,
        r.closed_at,
        now,
      );
      del.run(r.id);
    }
  })();
  return { pruned: rows.length, ids: rows.map((r) => r.id) };
}

/** A short topic for the outcome record: the first words of the summary. */
function topicOf(summary: string): string {
  const words = summary.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length > 80 ? `${words.slice(0, 79)}…` : words;
}

export interface ObservationOutcomeRow {
  id: string;
  topic: string;
  sourceKinds: string[];
  state: ObservationState;
  closeReason: ObservationCloseReason | null;
  notedScores: ObservationScores | null;
  scores: ObservationScores | null;
  wouldPushAt: number | null;
  userAction: string | null;
  createdAt: number;
  closedAt: number | null;
  prunedAt: number;
}

export function listObservationOutcomes(db: Db, limit = 200): ObservationOutcomeRow[] {
  return db
    .prepare<
      [number],
      {
        id: string;
        topic: string;
        source_kinds_json: string;
        state: string;
        close_reason: string | null;
        noted_scores_json: string | null;
        scores_json: string | null;
        would_push_at: number | null;
        user_action: string | null;
        created_at: number;
        closed_at: number | null;
        pruned_at: number;
      }
    >("SELECT * FROM observation_outcomes ORDER BY pruned_at DESC, id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      id: r.id,
      topic: r.topic,
      sourceKinds: JSON.parse(r.source_kinds_json) as string[],
      state: r.state as ObservationState,
      closeReason: r.close_reason as ObservationCloseReason | null,
      notedScores: parseScores(r.noted_scores_json),
      scores: parseScores(r.scores_json),
      wouldPushAt: r.would_push_at,
      userAction: r.user_action,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      prunedAt: r.pruned_at,
    }));
}

export interface WouldPushEntry {
  id: string;
  summary: string;
  notedScores: ObservationScores | null;
  createdAt: number;
  wouldPushAt: number;
  state: ObservationState;
  shippedAt: number | null;
  relevantUntil: number | null;
}

/**
 * The "would have pushed" log: live and pruned observations whose noted
 * scores would have earned a same-day push, newest first.
 */
export function listWouldPushLog(db: Db, limit = 200): WouldPushEntry[] {
  return db
    .prepare<
      [number],
      {
        id: string;
        summary: string;
        noted_scores_json: string | null;
        created_at: number;
        would_push_at: number;
        state: string;
        shipped_at: number | null;
        relevant_until: number | null;
      }
    >(
      `SELECT id, summary, noted_scores_json, created_at, would_push_at, state, shipped_at, relevant_until
         FROM observations WHERE would_push_at IS NOT NULL
         AND ${knowledgeOwnerReadPredicate(db, "observations.id")}
       UNION ALL
       SELECT id, topic, noted_scores_json, created_at, would_push_at, state, NULL, NULL
         FROM observation_outcomes WHERE would_push_at IS NOT NULL
       ORDER BY would_push_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      id: r.id,
      summary: r.summary,
      notedScores: parseScores(r.noted_scores_json),
      createdAt: r.created_at,
      wouldPushAt: r.would_push_at,
      state: r.state as ObservationState,
      shippedAt: r.shipped_at,
      relevantUntil: r.relevant_until,
    }));
}

/** True when any observation table exists and holds a row (cascade fast-path). */
export function hasAnyObservations(db: Db): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observations'").get() !==
      undefined && db.prepare("SELECT 1 FROM observations LIMIT 1").get() !== undefined
  );
}
