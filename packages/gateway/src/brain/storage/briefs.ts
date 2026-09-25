// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brief repository — CRUD over `briefs` + `brief_citations` +
 * `brief_related_loops`.
 *
 * State-machine rule enforced at this layer: the terminal states — the four
 * `dismissed_*` verdicts the user gives, plus `retired`, the agent
 * withdrawing its own card — are one-way. `setBriefState` refuses to move a
 * brief OUT of one ("never shown again" is a storage guarantee, not a
 * ranking courtesy). `dismissed_snoozed` is the one sanctioned exit: the
 * feedback run returns it to `unread` with `next_show` set.
 */

import { insertBriefClaimSet, replaceBriefClaimSet, type BriefClaimInput } from "./brief-claims.js";
import { isTerminalBriefState, type BriefKind, type BriefRow, type BriefState } from "./types.js";
import type { BriefFeedSortKey, FeedTier } from "../ranking.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

interface BriefDbRow {
  id: string;
  created_by_run: string;
  kind: string;
  title: string;
  description: string;
  body: string | null;
  confidence: number;
  urgency: number;
  relevant_until: number | null;
  next_show: number | null;
  event_at: number | null;
  user_feedback: string | null;
  state: string;
  read_at: number | null;
  created_at: number;
  updated_at: number;
  thread_conversation_id: string | null;
}

/**
 * Feed ranking needs every scalar field but none of the per-row relationship
 * arrays. Keeping this shape explicit avoids two relationship queries for
 * every showable brief before a page can be selected.
 */
export type ShowableBriefCandidate = Omit<BriefRow, "citations" | "relatedLoopIds">;

function rowToBriefCandidate(r: BriefDbRow): ShowableBriefCandidate {
  return {
    id: r.id,
    createdByRun: r.created_by_run,
    kind: r.kind as BriefKind,
    title: r.title,
    description: r.description,
    body: r.body,
    confidence: r.confidence,
    urgency: r.urgency,
    relevantUntil: r.relevant_until,
    nextShow: r.next_show,
    eventAt: r.event_at,
    userFeedback: r.user_feedback,
    state: r.state as BriefState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    threadConversationId: r.thread_conversation_id,
  };
}

function rowToBrief(db: Db, r: BriefDbRow): BriefRow {
  return {
    ...rowToBriefCandidate(r),
    citations: briefCitations(db, r.id),
    relatedLoopIds: briefRelatedLoopIds(db, r.id),
  };
}

function briefCitations(db: Db, briefId: string): string[] {
  return db
    .prepare<[string], { doc_id: string }>(
      "SELECT doc_id FROM brief_citations WHERE brief_id = ? ORDER BY position ASC",
    )
    .all(briefId)
    .map((r) => r.doc_id);
}

function briefRelatedLoopIds(db: Db, briefId: string): string[] {
  return db
    .prepare<[string], { loop_id: string }>(
      "SELECT loop_id FROM brief_related_loops WHERE brief_id = ? ORDER BY loop_id",
    )
    .all(briefId)
    .map((r) => r.loop_id);
}

function replaceCitations(db: Db, briefId: string, citations: readonly string[]): void {
  db.prepare<[string]>("DELETE FROM brief_citations WHERE brief_id = ?").run(briefId);
  const insert = db.prepare<[string, number, string]>(
    "INSERT INTO brief_citations (brief_id, position, doc_id) VALUES (?, ?, ?)",
  );
  citations.forEach((docId, i) => insert.run(briefId, i, docId));
}

function replaceRelatedLoops(db: Db, briefId: string, loopIds: readonly string[]): void {
  db.prepare<[string]>("DELETE FROM brief_related_loops WHERE brief_id = ?").run(briefId);
  const insert = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO brief_related_loops (brief_id, loop_id) VALUES (?, ?)",
  );
  for (const loopId of loopIds) insert.run(briefId, loopId);
}

export interface CreateBriefInput {
  id: string;
  createdByRun: string;
  kind: BriefKind;
  title: string;
  description?: string;
  body?: string | null;
  citations?: string[];
  confidence: number;
  urgency: number;
  relevantUntil?: number | null;
  relatedLoopIds?: string[];
  nextShow?: number | null;
  eventAt?: number | null;
  /**
   * Atomic asserted-claim set persisted with the brief, already vetted at
   * the tool boundary (quote-in-document + entailment gate). Lands in the
   * same transaction as the brief row.
   */
  claims?: BriefClaimInput[];
}

export function createBrief(db: Db, input: CreateBriefInput, now: number): BriefRow {
  const txn = db.transaction(() => {
    db.prepare<unknown[]>(
      `INSERT INTO briefs (
         id, created_by_run, kind, title, description, body, confidence, urgency,
         relevant_until, next_show, event_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
    ).run(
      input.id,
      input.createdByRun,
      input.kind,
      input.title,
      input.description ?? "",
      input.body ?? null,
      input.confidence,
      input.urgency,
      input.relevantUntil ?? null,
      input.nextShow ?? null,
      input.eventAt ?? null,
      now,
      now,
    );
    replaceCitations(db, input.id, input.citations ?? []);
    replaceRelatedLoops(db, input.id, input.relatedLoopIds ?? []);
    if (input.claims !== undefined) insertBriefClaimSet(db, input.id, input.claims, now);
  });
  txn();
  const created = getBrief(db, input.id);
  if (!created) throw new Error(`brief ${input.id} vanished mid-create`);
  return created;
}

export function getBrief(db: Db, id: string): BriefRow | null {
  const row = db.prepare<[string], BriefDbRow>("SELECT * FROM briefs WHERE id = ?").get(id);
  return row ? rowToBrief(db, row) : null;
}

export interface ListBriefsOptions {
  states?: readonly BriefState[];
  limit?: number;
  beforeCreated?: { createdAt: number; id: string };
}

const ACTIVE_BRIEF_PAGE_STATES: readonly BriefState[] = ["unread", "read"];
const DISMISSED_BRIEF_PAGE_STATES: readonly BriefState[] = [
  "dismissed_already_handled",
  "dismissed_acknowledged",
  "dismissed_not_relevant",
  "dismissed_wrong",
];

function hasExactlyStates<T extends string>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && expected.every((state) => actual.includes(state));
}

/** Briefs ordered newest-created first. */
export function listBriefs(db: Db, options: ListBriefsOptions = {}): BriefRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let pageIndex = "idx_briefs_created_page";
  if (options.states && options.states.length > 0) {
    if (hasExactlyStates(options.states, ACTIVE_BRIEF_PAGE_STATES)) {
      // Literal predicates match the corresponding partial order index.
      conditions.push("state IN ('unread', 'read')");
      pageIndex = "idx_briefs_active_created_page";
    } else if (hasExactlyStates(options.states, DISMISSED_BRIEF_PAGE_STATES)) {
      conditions.push(
        `state IN (
          'dismissed_already_handled',
          'dismissed_acknowledged',
          'dismissed_not_relevant',
          'dismissed_wrong'
        )`,
      );
      pageIndex = "idx_briefs_dismissed_created_page";
    } else if (options.states.length === 1) {
      conditions.push("state = ?");
      params.push(options.states[0]);
      pageIndex = "idx_briefs_state_created_page";
    } else {
      conditions.push(`state IN (${options.states.map(() => "?").join(", ")})`);
      params.push(...options.states);
    }
  }
  if (options.beforeCreated) {
    conditions.push("(created_at, id) < (?, ?)");
    params.push(options.beforeCreated.createdAt, options.beforeCreated.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(options.limit ?? 100);
  const rows = db
    .prepare<(string | number)[], BriefDbRow>(
      `SELECT * FROM briefs INDEXED BY ${pageIndex} ${where}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => rowToBrief(db, r));
}

/** Newest brief a given run created — the digest push looks its card up. */
export function newestBriefForRun(db: Db, runId: string): BriefRow | null {
  const row = db
    .prepare<
      [string],
      BriefDbRow
    >("SELECT * FROM briefs WHERE created_by_run = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(runId);
  return row ? rowToBrief(db, row) : null;
}

/**
 * All briefs attached to one loop (any state, newest-created first) —
 * the operator loop-detail read. The engine paths use the deletion
 * invariant helpers instead; nothing here mutates.
 */
export function listBriefsForLoop(
  db: Db,
  loopId: string,
  options: { limit?: number; beforeCreated?: { createdAt: number; id: string } } = {},
): BriefRow[] {
  const cursor = options.beforeCreated
    ? "AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))"
    : "";
  const params: Array<string | number> = [loopId];
  if (options.beforeCreated) {
    params.push(
      options.beforeCreated.createdAt,
      options.beforeCreated.createdAt,
      options.beforeCreated.id,
    );
  }
  const limit = options.limit === undefined ? "" : "LIMIT ?";
  if (options.limit !== undefined) params.push(options.limit);
  return db
    .prepare<(string | number)[], BriefDbRow>(
      `SELECT b.* FROM briefs b
       JOIN brief_related_loops rl ON rl.brief_id = b.id
       WHERE rl.loop_id = ?
       ${cursor}
       ORDER BY b.created_at DESC, b.id DESC
       ${limit}`,
    )
    .all(...params)
    .map((r) => rowToBrief(db, r));
}

/**
 * The feed's selection: exactly the briefs the ranking engine may show —
 * state `unread`/`read`, `next_show` null-or-past, and `relevant_until`
 * unexpired (a brief past its relevance bound stays in the system but
 * never renders). Ordering is the ranking engine's job, not this query's.
 */
export function listShowableBriefs(db: Db, now: number): BriefRow[] {
  const rows = db
    .prepare<[number, number], BriefDbRow>(
      `SELECT * FROM briefs
       WHERE state IN ('unread', 'read')
         AND (next_show IS NULL OR next_show <= ?)
         AND (relevant_until IS NULL OR relevant_until > ?)`,
    )
    .all(now, now);
  return rows.map((r) => rowToBrief(db, r));
}

/**
 * Feed-only form of {@link listShowableBriefs}: scalar candidates without
 * relationship hydration. The feed bulk-loads only the deadline signals it
 * needs to rank the full set, then resolves citations for the selected page.
 */
export function listShowableBriefCandidates(db: Db, now: number): ShowableBriefCandidate[] {
  const rows = db
    .prepare<[number, number], BriefDbRow>(
      `SELECT * FROM briefs
       WHERE state IN ('unread', 'read')
         AND (next_show IS NULL OR next_show <= ?)
         AND (relevant_until IS NULL OR relevant_until > ?)`,
    )
    .all(now, now);
  return rows.map(rowToBriefCandidate);
}

interface BriefFeedPageDbRow extends BriefDbRow {
  sort_read_group: 0 | 1;
  sort_tier: FeedTier;
  sort_proximity: number;
}

export interface BriefFeedPageCandidate {
  brief: ShowableBriefCandidate;
  sortKey: BriefFeedSortKey;
}

/**
 * Monotonic high-water mark for read-state pagination. Legacy read rows have a
 * NULL marker and are treated as read in every snapshot. New mark-read writes
 * always allocate a marker above this value, even when two writes share a
 * millisecond.
 */
export function briefReadSnapshot(db: Db): number {
  return (
    db.prepare<[], { value: number | null }>("SELECT MAX(read_at) AS value FROM briefs").get()
      ?.value ?? 0
  );
}

/**
 * One bounded keyset page in the complete semantic feed order.
 *
 * Ranking happens inside SQLite and LIMIT is applied before any relationship
 * hydration reaches JavaScript. The query mirrors ranking.ts exactly:
 * read-group, time/due/loop/info tier, event time, deadline proximity, then
 * urgency/confidence/relevance/creation/id. `snapshotReadAt` freezes the common
 * unread→read mutation for the lifetime of a cursor walk.
 */
export function listBriefFeedPage(
  db: Db,
  snapshotNow: number,
  snapshotReadAt: number,
  options: { after?: BriefFeedSortKey; limit: number },
): BriefFeedPageCandidate[] {
  const after = options.after;
  const afterEvent = after && after.tier <= 1 ? (after.eventAt ?? 0) : 0;
  const rows = db
    .prepare<Record<string, string | number>, BriefFeedPageDbRow>(
      `WITH raw_deadlines AS (
         SELECT brl.brief_id,
                CASE
                  WHEN json_type(ol.deadline_json) = 'text'
                    THEN json_extract(ol.deadline_json, '$')
                  WHEN json_type(ol.deadline_json, '$.date') = 'text'
                    THEN json_extract(ol.deadline_json, '$.date')
                  ELSE NULL
                END AS raw_due
           FROM brief_related_loops brl
           JOIN open_loops ol ON ol.id = brl.loop_id
          WHERE ol.state = 'open' AND ol.deadline_json IS NOT NULL
       ),
       deadline_days AS (
         SELECT brief_id,
                CASE
                  WHEN length(raw_due) = 10 AND raw_due GLOB '????-??-??' THEN raw_due
                  ELSE date(raw_due, 'localtime')
                END AS due_day
           FROM raw_deadlines
          WHERE raw_due IS NOT NULL
       ),
       nearest_deadlines AS (
         SELECT brief_id, MIN(due_day) AS nearest_due_day
           FROM deadline_days
          WHERE due_day IS NOT NULL
          GROUP BY brief_id
       ),
       base AS (
         SELECT b.*,
                CASE
                  WHEN b.state = 'read'
                   AND (b.read_at IS NULL OR b.read_at <= @snapshotReadAt)
                    THEN 1 ELSE 0
                END AS sort_read_group,
                nd.nearest_due_day,
                date(@snapshotNow / 1000.0, 'unixepoch', 'localtime') AS snapshot_day
           FROM briefs b
           LEFT JOIN nearest_deadlines nd ON nd.brief_id = b.id
          WHERE b.state IN ('unread', 'read')
            AND (b.next_show IS NULL OR b.next_show <= @snapshotNow)
            AND (b.relevant_until IS NULL OR b.relevant_until > @snapshotNow)
       ),
       ranked AS (
         SELECT base.*,
                CASE
                  WHEN event_at IS NOT NULL
                   AND event_at >= @snapshotNow
                   AND event_at <= @snapshotNow + 3600000 THEN 0
                  WHEN event_at IS NOT NULL
                   AND date(event_at / 1000.0, 'unixepoch', 'localtime') = snapshot_day THEN 1
                  WHEN kind = 'loop'
                   AND nearest_due_day IS NOT NULL
                   AND nearest_due_day <= snapshot_day THEN 2
                  WHEN kind = 'loop' THEN 3
                  ELSE 4
                END AS sort_tier,
                CASE
                  WHEN kind <> 'loop' OR nearest_due_day IS NULL THEN 0.0
                  WHEN nearest_due_day <= snapshot_day THEN 1.0
                  WHEN julianday(nearest_due_day) - julianday(snapshot_day) >= 7 THEN 0.0
                  ELSE 1.0 -
                    (julianday(nearest_due_day) - julianday(snapshot_day)) / 7.0
                END AS sort_proximity
           FROM base
       ),
       keyed AS (
         SELECT ranked.*,
                CASE WHEN sort_tier <= 1 THEN event_at ELSE 0 END AS sort_event,
                -sort_proximity AS sort_neg_proximity,
                -urgency AS sort_neg_urgency,
                -confidence AS sort_neg_confidence,
                CASE WHEN relevant_until IS NULL THEN 1 ELSE 0 END AS sort_relevant_null,
                COALESCE(relevant_until, 0) AS sort_relevant,
                -created_at AS sort_neg_created
           FROM ranked
       )
       SELECT *
         FROM keyed
        WHERE @hasAfter = 0
           OR (
             sort_read_group, sort_tier, sort_event, sort_neg_proximity,
             sort_neg_urgency, sort_neg_confidence, sort_relevant_null,
             sort_relevant, sort_neg_created, id
           ) > (
             @afterReadGroup, @afterTier, @afterEvent, @afterNegProximity,
             @afterNegUrgency, @afterNegConfidence, @afterRelevantNull,
             @afterRelevant, @afterNegCreated, @afterId
           )
        ORDER BY sort_read_group ASC, sort_tier ASC, sort_event ASC,
                 sort_neg_proximity ASC, sort_neg_urgency ASC,
                 sort_neg_confidence ASC, sort_relevant_null ASC,
                 sort_relevant ASC, sort_neg_created ASC, id ASC
        LIMIT @limit`,
    )
    .all({
      snapshotNow,
      snapshotReadAt,
      hasAfter: after ? 1 : 0,
      afterReadGroup: after?.readGroup ?? 0,
      afterTier: after?.tier ?? 0,
      afterEvent,
      afterNegProximity: -(after?.proximity ?? 0),
      afterNegUrgency: -(after?.urgency ?? 0),
      afterNegConfidence: -(after?.confidence ?? 0),
      afterRelevantNull: after?.relevantUntil === null ? 1 : 0,
      afterRelevant: after?.relevantUntil ?? 0,
      afterNegCreated: -(after?.createdAt ?? 0),
      afterId: after?.id ?? "",
      limit: Math.max(1, Math.floor(options.limit)),
    });
  return rows.map((row) => ({
    brief: rowToBriefCandidate(row),
    sortKey: {
      readGroup: row.sort_read_group,
      tier: row.sort_tier,
      eventAt: row.event_at,
      proximity: row.sort_proximity,
      urgency: row.urgency,
      confidence: row.confidence,
      relevantUntil: row.relevant_until,
      createdAt: row.created_at,
      id: row.id,
    },
  }));
}

/**
 * Count of showable UNREAD briefs — the feed's showable subset
 * (`next_show` null-or-past, `relevant_until` unexpired) narrowed to
 * state `unread`. The iOS Briefs drawer badge's cheap read: it never
 * loads the briefs themselves, so the badge renders without fetching the
 * whole feed. `read` briefs are already-seen and never counted; a snoozed
 * or not-yet-due brief is not showable, so neither is counted.
 */
export function countShowableUnreadBriefs(db: Db, now: number): number {
  const row = db
    .prepare<[number, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM briefs
       WHERE state = 'unread'
         AND (next_show IS NULL OR next_show <= ?)
         AND (relevant_until IS NULL OR relevant_until > ?)`,
    )
    .get(now, now);
  return row?.n ?? 0;
}

/**
 * Durable snooze resurface: return every `dismissed_snoozed` brief whose
 * user-picked `next_show` has arrived to `unread`, so the ranking engine
 * shows it again. Driven by the rhythm tick, independent of the async
 * feedback run — a snooze the user gave a concrete time to can never be
 * stranded by a terminally-failed feedback run. A snoozed brief with a null
 * `next_show` (the "agent decides" case) is left for the feedback run.
 * Returns the number of briefs resurfaced.
 */
export function resurfaceDueSnoozedBriefs(db: Db, now: number): number {
  return db
    .prepare<[number, number]>(
      `UPDATE briefs SET state = 'unread', updated_at = ?
       WHERE state = 'dismissed_snoozed' AND next_show IS NOT NULL AND next_show <= ?`,
    )
    .run(now, now).changes;
}

/** Content/metadata fields a run may mutate. Absent = unchanged. */
export interface UpdateBriefInput {
  title?: string;
  description?: string;
  body?: string | null;
  citations?: string[];
  confidence?: number;
  urgency?: number;
  relevantUntil?: number | null;
  relatedLoopIds?: string[];
  nextShow?: number | null;
  eventAt?: number | null;
  userFeedback?: string | null;
  /**
   * When present, atomically REPLACES the brief's live claim set: the
   * standing rows are soft-invalidated (kept for audit) and this set
   * inserted, all inside the update's transaction. Absent = untouched.
   */
  claims?: BriefClaimInput[];
}

/** Returns the updated row, or null when the brief doesn't exist. */
export function updateBrief(
  db: Db,
  id: string,
  input: UpdateBriefInput,
  now: number,
): BriefRow | null {
  const existing = db.prepare<[string], BriefDbRow>("SELECT * FROM briefs WHERE id = ?").get(id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now];
  // The snooze round-trip's engine half: `dismissed_snoozed` is the one
  // sanctioned exit from a dismissal, and writing `next_show` on a
  // snoozed brief IS the exit — the feedback run decides when the brief
  // re-surfaces, and this write returns it to `unread` so the ranking
  // engine (which only shows unread/read with `next_show` null-or-past)
  // takes over the timing. Terminal `dismissed_*` states never pass
  // through here because the flip is conditioned on `dismissed_snoozed`.
  if (existing.state === "dismissed_snoozed" && input.nextShow !== undefined) {
    sets.push("state = ?");
    params.push("unread" satisfies BriefState);
  }
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (input.title !== undefined) push("title", input.title);
  if (input.description !== undefined) push("description", input.description);
  if (input.body !== undefined) push("body", input.body);
  if (input.confidence !== undefined) push("confidence", input.confidence);
  if (input.urgency !== undefined) push("urgency", input.urgency);
  if (input.relevantUntil !== undefined) push("relevant_until", input.relevantUntil);
  if (input.nextShow !== undefined) push("next_show", input.nextShow);
  if (input.eventAt !== undefined) push("event_at", input.eventAt);
  if (input.userFeedback !== undefined) push("user_feedback", input.userFeedback);

  params.push(id);
  const txn = db.transaction(() => {
    db.prepare<(string | number | null)[]>(`UPDATE briefs SET ${sets.join(", ")} WHERE id = ?`).run(
      ...params,
    );
    if (input.citations !== undefined) replaceCitations(db, id, input.citations);
    if (input.relatedLoopIds !== undefined) replaceRelatedLoops(db, id, input.relatedLoopIds);
    if (input.claims !== undefined) replaceBriefClaimSet(db, id, input.claims, now);
  });
  txn();
  return getBrief(db, id);
}

/**
 * State transition with the terminal guard: a brief in a terminal
 * `dismissed_*` state never leaves it. Returns false when the brief
 * doesn't exist or the transition was refused.
 */
/**
 * Stamp the brief's follow-up thread, exactly once. Returns false when the
 * brief is missing or already has a thread — the caller re-reads the row
 * and reuses the existing conversation, so two concurrent opens converge
 * on one thread instead of minting two.
 */
export function setBriefThreadConversation(
  db: Db,
  id: string,
  conversationId: string,
  now: number,
): boolean {
  const res = db
    .prepare<[string, number, string]>(
      `UPDATE briefs SET thread_conversation_id = ?, updated_at = ?
        WHERE id = ? AND thread_conversation_id IS NULL`,
    )
    .run(conversationId, now, id);
  return res.changes > 0;
}

/**
 * Replace a brief's thread pointer when its stamped conversation no longer
 * exists (the user deleted the thread from a conversations list). Compare-
 * and-swap on the dead id, so a concurrent re-open converges on exactly one
 * replacement instead of two.
 */
export function restampBriefThreadConversation(
  db: Db,
  id: string,
  deadConversationId: string,
  conversationId: string,
  now: number,
): boolean {
  const res = db
    .prepare<[string, number, string, string]>(
      `UPDATE briefs SET thread_conversation_id = ?, updated_at = ?
        WHERE id = ? AND thread_conversation_id = ?`,
    )
    .run(conversationId, now, id, deadConversationId);
  return res.changes > 0;
}

export function setBriefState(db: Db, id: string, state: BriefState, now: number): boolean {
  const existing = db
    .prepare<[string], { state: string }>("SELECT state FROM briefs WHERE id = ?")
    .get(id);
  if (!existing) return false;
  const current = existing.state as BriefState;
  if (isTerminalBriefState(current) && state !== current) return false;
  if (state === "read" && current !== "read") {
    db.prepare<[string, number, number, number, string]>(
      `UPDATE briefs
          SET state = ?,
              read_at = MAX(?, COALESCE((SELECT MAX(read_at) + 1 FROM briefs), ?)),
              updated_at = ?
        WHERE id = ?`,
    ).run(state, now, now, now, id);
  } else {
    db.prepare<[string, number, string]>(
      "UPDATE briefs SET state = ?, updated_at = ? WHERE id = ?",
    ).run(state, now, id);
  }
  return true;
}

export type MarkBriefReadResult =
  | { outcome: "marked" }
  | { outcome: "already_read" }
  | { outcome: "not_found" }
  /** The brief is in a `dismissed_*` state — the feed never shows those. */
  | { outcome: "not_markable"; state: BriefState };

/**
 * Mark a brief seen (`unread` → `read`) — the feed's per-brief signal
 * when the user actually views a card, which is what makes `read`
 * briefs sort last on return visits. Idempotent on `read`; refuses on
 * any `dismissed_*` state (the feed never shows those, so a mark-read
 * there is a client bug worth surfacing loudly).
 */
export function markBriefRead(db: Db, id: string, now: number): MarkBriefReadResult {
  const existing = db
    .prepare<[string], { state: string }>("SELECT state FROM briefs WHERE id = ?")
    .get(id);
  if (!existing) return { outcome: "not_found" };
  const state = existing.state as BriefState;
  if (state === "read") return { outcome: "already_read" };
  if (state !== "unread") return { outcome: "not_markable", state };
  db.prepare<[number, number, number, string]>(
    `UPDATE briefs
        SET state = 'read',
            read_at = MAX(?, COALESCE((SELECT MAX(read_at) + 1 FROM briefs), ?)),
            updated_at = ?
      WHERE id = ?`,
  ).run(now, now, now, id);
  return { outcome: "marked" };
}

/**
 * Active briefs attached to any of `loopIds`, with the overlapping loop
 * ids per brief. Active = will (re)appear on the feed: unread/read with
 * unexpired relevance, plus dismissed_snoozed — a snoozed card is only
 * parked and resurfaces at next_show, so a sibling created while it
 * sleeps would wake up beside it. The brief_create one-card-per-loop
 * guard reads this to refuse a sibling card for an obligation that
 * already has one.
 */
export function findActiveBriefsForLoops(
  db: Db,
  loopIds: string[],
  now: number,
): Array<{ id: string; title: string; state: string; loopIds: string[] }> {
  if (loopIds.length === 0) return [];
  const placeholders = loopIds.map(() => "?").join(",");
  const rows = db
    .prepare<[...string[], number], { id: string; title: string; state: string; loop_id: string }>(
      `SELECT b.id, b.title, b.state, brl.loop_id
       FROM briefs b JOIN brief_related_loops brl ON brl.brief_id = b.id
       WHERE brl.loop_id IN (${placeholders})
         AND b.state IN ('unread', 'read', 'dismissed_snoozed')
         AND (b.relevant_until IS NULL OR b.relevant_until > ?)
       ORDER BY b.created_at`,
    )
    .all(...loopIds, now);
  const byBrief = new Map<
    string,
    { id: string; title: string; state: string; loopIds: string[] }
  >();
  for (const r of rows) {
    const entry = byBrief.get(r.id) ?? { id: r.id, title: r.title, state: r.state, loopIds: [] };
    entry.loopIds.push(r.loop_id);
    byBrief.set(r.id, entry);
  }
  return [...byBrief.values()];
}

/**
 * Retract every non-terminal brief attached to `loopId` — the loop-resolve
 * cascade. When a loop transitions to a resolved state (`done`/`dismissed`)
 * each of its linked briefs still in a non-terminal state (`unread`,
 * `read`, `dismissed_snoozed`) is moved to `dismissed_already_handled` (a
 * terminal handled state) so a resolved loop never leaves a lingering brief
 * that still reads as actionable on the feed. Terminal briefs are one-way
 * and left untouched, which makes the pass idempotent — a second call over
 * an already-resolved loop finds only terminal briefs and transitions
 * nothing. Returns the ids it actually retracted.
 *
 * Unlike {@link deleteBriefsAttachedToLoops} (the delete-path invariant,
 * which removes the non-terminal briefs outright), the loop survives here
 * with its briefs kept — moved to terminal-handled — preserving the audit
 * trail of what was surfaced for the now-resolved loop.
 */
export function retractBriefsForResolvedLoop(db: Db, loopId: string, now: number): string[] {
  const attached = db
    .prepare<[string], { brief_id: string; state: string }>(
      `SELECT DISTINCT b.id AS brief_id, b.state AS state
       FROM briefs b JOIN brief_related_loops brl ON brl.brief_id = b.id
       WHERE brl.loop_id = ?`,
    )
    .all(loopId);
  const retracted: string[] = [];
  for (const row of attached) {
    if (isTerminalBriefState(row.state as BriefState)) continue;
    if (setBriefState(db, row.brief_id, "dismissed_already_handled", now)) {
      retracted.push(row.brief_id);
    }
  }
  return retracted;
}

/**
 * Withdraw a brief from the feed, keeping its row. `retired` is terminal, so
 * the card drops out of every active-brief query by the same `state`
 * predicate the dismissals use, while the record of what was surfaced — and
 * its claims, citations and loop edges — survives for later runs to read.
 *
 * Returns false only when the brief does not exist. A brief already in a
 * terminal state is left exactly as it is and reported as retired: it is
 * already off the feed, and overwriting a user's dismissal with the agent's
 * housekeeping would destroy the feedback signal that dismissal carries.
 */
export function retireBrief(db: Db, id: string, now: number): boolean {
  const row = db
    .prepare<[string], { state: string }>("SELECT state FROM briefs WHERE id = ?")
    .get(id);
  if (!row) return false;
  if (isTerminalBriefState(row.state as BriefState)) return true;
  return setBriefState(db, id, "retired", now);
}

/**
 * Delete every brief attached (via `brief_related_loops`) to any of
 * `loopIds`. With `includeTerminal: false` (the deletion invariant),
 * terminal-dismissed briefs survive and only their edges to the deleted
 * loops are removed. Returns the deleted brief ids.
 */
export function deleteBriefsAttachedToLoops(
  db: Db,
  loopIds: readonly string[],
  options: { includeTerminal: boolean },
): string[] {
  if (loopIds.length === 0) return [];
  const placeholders = loopIds.map(() => "?").join(", ");
  const attached = db
    .prepare<string[], { brief_id: string; state: string }>(
      `SELECT DISTINCT b.id AS brief_id, b.state AS state
       FROM briefs b JOIN brief_related_loops brl ON brl.brief_id = b.id
       WHERE brl.loop_id IN (${placeholders})`,
    )
    .all(...loopIds);

  const deleted: string[] = [];
  for (const row of attached) {
    const terminal = isTerminalBriefState(row.state as BriefState);
    if (terminal && !options.includeTerminal) continue;
    db.prepare<[string]>("DELETE FROM briefs WHERE id = ?").run(row.brief_id);
    deleted.push(row.brief_id);
  }
  // Drop the surviving briefs' edges to the deleted loops so nothing dangles.
  db.prepare<string[]>(`DELETE FROM brief_related_loops WHERE loop_id IN (${placeholders})`).run(
    ...loopIds,
  );
  return deleted;
}
