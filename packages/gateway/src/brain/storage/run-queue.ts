// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Agent Run Queue — a durable SQLite outbox of typed Cognition Steward
 * runs with a durable, idempotent outbox shape:
 *
 *   pending → (claimed in-memory by the drain) → completed | failed
 *           ↘ pending (soft retry, next_attempt_at pushed out)
 *
 * No "claimed" status on disk — in-flight rows stay `pending` with a
 * bumped `attempts`, so a gateway crash mid-run is naturally re-claimed
 * once `next_attempt_at` is due. Exactly-once holds at the queue-row
 * level; mutation idempotence across a re-claim comes from the agent's
 * reconcile-before-create (run ids are stamped on ledger entries so a
 * re-attempt can adopt its own partial work).
 *
 * Fold-on-update: an enqueue with a `dedupeKey` that matches an existing
 * PENDING row replaces that row's payload instead of inserting (at most
 * one pending run per key). The caller computes the folded payload —
 * e.g. re-diffing an updated document from the snapshot on the pending
 * row — via `getPendingRunByDedupeKey` before enqueueing. A fold is fresh
 * work over new data, so it also resets the row's attempt budget (a fold
 * into a soft-failed row starts clean) while adopting the fold's schedule.
 *
 * Debounce-ceiling: a fold with a `maxDeferMs` (the waker's `data` runs)
 * clamps the pushed-out schedule to `cycle_anchor_at + maxDeferMs`, so a
 * run that keeps folding faster than its debounce still becomes claimable
 * within a bounded time instead of deferring forever (debounce starvation).
 * `cycle_anchor_at` is the mutable per-cycle anchor: set on INSERT, reset
 * when a completed in-flight fold resurrects a fresh cycle, untouched by a
 * fold. Folds without `maxDeferMs` (daily/decay/feedback/time_based) are
 * never clamped — their intentional schedules stand.
 */

import { cognitiveWorkflowVersion } from "../cognition/workflows.js";
import {
  mergedInstructionSeparator,
  PROVENANCE_RECHECK_DEDUPE_PREFIX,
  SCHEDULED_INSTRUCTION_MAX_CHARS,
} from "../run-payloads.js";
import { recordCognitionSpend } from "./spend.js";
import { recordRunAttribution } from "./run-attribution.js";
import type { CognitiveWorkflowId } from "../cognition/workflows.js";
import type Database from "better-sqlite3";
import type {
  ClaimedCognitionRun,
  CognitionRunKind,
  CognitionRunRow,
  CognitionRunStatus,
  CognitionRunUsage,
} from "./types.js";
import type { DerivationStage } from "../../domain/DocumentDerivation.js";

type Db = Database.Database;

/**
 * Pending runs due for a claim right now (next_attempt_at ≤ now). The
 * digest readiness barrier reads this to hold composition until the
 * overnight work has drained — debounced/backed-off rows with a future
 * next_attempt_at deliberately do NOT count as outstanding.
 */
export function countDuePendingCognitionRuns(
  db: Db,
  now: number,
  maxAttempts = DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
): number {
  const row = db
    .prepare<[number, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM cognition_runs
        WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < ?`,
    )
    .get(now, maxAttempts);
  return row?.n ?? 0;
}

/** Whether any run — any status — carries this dedupe key. The digest
 * enqueuer's crash-replay guard: a settled digest row for the day means
 * the day already ran even when the marker write was lost. */
export function hasCognitionRunWithDedupeKey(db: Db, dedupeKey: string): boolean {
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ?")
      .get(dedupeKey)!.n > 0
  );
}

/** Default retry cap before a run is marked terminally `failed`. */
export const DEFAULT_COGNITION_RUN_MAX_ATTEMPTS = 5;

/** Default per-tick claim size. */
const DEFAULT_COGNITION_RUN_CLAIM_LIMIT = 1;

interface CognitionRunDbRow {
  id: string;
  kind: string;
  payload_json: string;
  dedupe_key: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  failure_code: string | null;
  next_attempt_at: number;
  enqueued_at: number;
  cycle_anchor_at: number;
  last_attempt_at: number | null;
  completed_at: number | null;
  usage_json: string | null;
}

function rowToRun(r: CognitionRunDbRow): CognitionRunRow {
  return {
    id: r.id,
    kind: r.kind as CognitionRunKind,
    payload: JSON.parse(r.payload_json) as unknown,
    dedupeKey: r.dedupe_key,
    status: r.status as CognitionRunStatus,
    attempts: r.attempts,
    lastError: r.last_error,
    failureCode: r.failure_code,
    nextAttemptAt: r.next_attempt_at,
    enqueuedAt: r.enqueued_at,
    cycleAnchorAt: r.cycle_anchor_at,
    lastAttemptAt: r.last_attempt_at,
    completedAt: r.completed_at,
    usage: r.usage_json === null ? null : (JSON.parse(r.usage_json) as CognitionRunUsage),
  };
}

export interface EnqueueCognitionRunInput {
  id: string;
  kind: CognitionRunKind;
  payload: unknown;
  /** Earliest claim time (unix ms). Omit for ASAP (claimable at `now`). */
  notBefore?: number;
  /** Fold key: at most one pending row per key. Omit for no folding. */
  dedupeKey?: string;
  /**
   * Max-defer ceiling (ms) for a FOLD into an existing pending row: the
   * folded `next_attempt_at` is clamped to `cycle_anchor_at + maxDeferMs`, so
   * a continuously-folded run stops deferring past a bounded time and becomes
   * claimable. Only the waker's `data` enqueues set it (per doc-type ceiling);
   * daily/decay/feedback/time_based omit it, so their schedules never clamp.
   * Ignored on a fresh INSERT (inserts fire on their own debounce).
   */
  maxDeferMs?: number;
  /**
   * How a loop-scoped `time_based` check resolves a collision with a
   * pending, never-claimed check for the same loop on the same UTC day.
   * `refuse` (the default) writes nothing and reports the existing check;
   * `merge` appends this check's instruction to the existing one, which
   * keeps its own schedule; `add` inserts this check alongside it. Ignored
   * by every other kind of run, and by a check that carries no `loopId`.
   */
  onScheduleConflict?: ScheduleConflictPolicy;
}

export type ScheduleConflictPolicy = "refuse" | "merge" | "add";

/**
 * `inserted` — a new row was created. `folded` — a pending row with the
 * same dedupe key existed; its payload (and schedule) were replaced and its
 * id is returned instead of the input's. `merged` — a loop-scoped
 * `time_based` check joined the pending same-loop, same-day check: that
 * row's instruction now carries both, and its id and schedule are returned.
 * `refused` — the same collision, but nothing was written: either no policy
 * resolved it (`pending_check`) or a merge would push the stored instruction
 * past `SCHEDULED_INSTRUCTION_MAX_CHARS` (`instruction_full`). Every outcome
 * reports `nextAttemptAt` — the time the run the call landed on (or collided
 * with) will actually be claimable, never an echo of the request.
 */
export type EnqueueCognitionRunResult =
  | { outcome: "inserted" | "folded" | "merged"; runId: string; nextAttemptAt: number }
  | {
      outcome: "refused";
      reason: "pending_check" | "instruction_full";
      /** The loop the collision was keyed on. */
      loopId: string;
      /** The pending check the call collided with. */
      runId: string;
      nextAttemptAt: number;
      /** That check's payload as stored; the caller reads the instruction out of it. */
      existingPayload: unknown;
    };

const MS_PER_DAY = 86_400_000;

/** UTC-midnight (unix ms) of the calendar day containing `ms`. */
function utcDayStartMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * The structured open-loop id a `time_based` run carries, if any — the key the
 * scheduled-check collision detection keys on. Only a `time_based` payload's
 * own `loopId` field counts; a decay check's `decayCheckLoopId` is a distinct
 * shape and never collides. Reads the field directly rather than importing
 * the payload schema module, keeping the generic queue decoupled from payload
 * types (the same reason `cancelScheduledRunsForLoop` reaches in via
 * `json_extract`). The queue's whole knowledge of a scheduled check's payload
 * is this field and the `prompt` string {@link mergeScheduledInstruction}
 * appends to.
 */
function timeBasedLoopId(input: EnqueueCognitionRunInput): string | undefined {
  if (input.kind !== "time_based") return undefined;
  const payload = input.payload;
  if (payload !== null && typeof payload === "object" && "loopId" in payload) {
    const loopId = (payload as { loopId?: unknown }).loopId;
    if (typeof loopId === "string" && loopId.length > 0) return loopId;
  }
  return undefined;
}

/** The `prompt` string of a scheduled check's payload, if it carries one. */
function scheduledInstruction(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === "object" && "prompt" in payload) {
    const prompt = (payload as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.length > 0) return prompt;
  }
  return undefined;
}

/**
 * The instruction a pending check carries once a second same-loop, same-day
 * check merges into it: the stored instruction, then the new one on its own
 * paragraph, annotated with the hour the new check asked for — the merged
 * check fires at the EXISTING check's time, so the run that carries it out
 * can see that part of its instruction was written for a different hour.
 * Null when either side has no instruction to merge, or when the result
 * would exceed `SCHEDULED_INSTRUCTION_MAX_CHARS`.
 */
function mergeScheduledInstruction(
  existingPayload: unknown,
  incomingPayload: unknown,
  requestedAt: number,
): string | null {
  const existing = scheduledInstruction(existingPayload);
  const incoming = scheduledInstruction(incomingPayload);
  if (existing === undefined || incoming === undefined) return null;
  const merged = `${existing.trimEnd()}${mergedInstructionSeparator(requestedAt)}${incoming}`;
  return merged.length > SCHEDULED_INSTRUCTION_MAX_CHARS ? null : merged;
}

export function enqueueCognitionRun(
  db: Db,
  input: EnqueueCognitionRunInput,
  now: number,
): EnqueueCognitionRunResult {
  const nextAttemptAt = input.notBefore ?? now;
  if (input.dedupeKey !== undefined) {
    const existing = getPendingRunByDedupeKey(db, input.dedupeKey);
    if (existing) {
      // A fold replaces the pending payload. The waker computes it from a read
      // of the row, so the newest one is the one that describes the document
      // as it now is.
      const foldedPayload = input.payload;
      // A fold is fresh work over new data: reset the attempt budget and clear
      // any soft-failure error, so a fold into a soft-failed row starts clean
      // rather than inheriting attempts already burned against the old payload.
      // The cycle anchor is deliberately LEFT UNTOUCHED — the fold belongs to
      // the same cycle, so the ceiling still counts from the row's INSERT.
      if (input.maxDeferMs !== undefined) {
        // Max-defer ceiling: clamp the pushed-out schedule to
        // `cycle_anchor_at + maxDeferMs` so a run that keeps folding faster
        // than its debounce still becomes claimable within a bounded time
        // (debounce-starvation guard) instead of deferring forever.
        db.prepare<[string, number, number, string]>(
          "UPDATE cognition_runs SET payload_json = ?, next_attempt_at = MIN(?, cycle_anchor_at + ?), attempts = 0, last_error = NULL, failure_code = NULL WHERE id = ?",
        ).run(JSON.stringify(foldedPayload ?? {}), nextAttemptAt, input.maxDeferMs, existing.id);
      } else {
        db.prepare<[string, number, string]>(
          "UPDATE cognition_runs SET payload_json = ?, next_attempt_at = ?, attempts = 0, last_error = NULL, failure_code = NULL WHERE id = ?",
        ).run(JSON.stringify(foldedPayload ?? {}), nextAttemptAt, existing.id);
      }
      return {
        outcome: "folded",
        runId: existing.id,
        nextAttemptAt:
          input.maxDeferMs !== undefined
            ? Math.min(nextAttemptAt, existing.cycleAnchorAt + input.maxDeferMs)
            : nextAttemptAt,
      };
    }
  }
  // Scheduled-check collision: a loop-scoped `time_based` check (a
  // `schedule_agent_run` that carries a structured `loopId`) meets an existing
  // pending same-loop, same-day check. The agent can't see its own
  // already-scheduled runs, so two separate runs would otherwise each schedule
  // a check for the same loop on the same day — but the two instructions are
  // rarely identical (a morning re-verify and a pre-event refresh), so the
  // queue never decides for the caller: by default it writes nothing and
  // reports the existing check (its id, real fire time and payload), and the
  // caller resolves the collision by calling again with `merge` or `add`, or
  // by not calling again at all. `add` skips the collision check entirely:
  // nothing here bounds how many checks a loop stacks on one day beyond the
  // caller's judgement.
  //
  // Narrow by design: only fires when the NEW run is a `time_based` row carrying
  // a structured `loopId` (loop-less checks and decay checks — which key on
  // `decayCheckLoopId`, never `loopId` — never collide), and only against an
  // existing PENDING, never-claimed (`attempts = 0`) check whose
  // `next_attempt_at` falls on the same UTC calendar day. The day is a UTC
  // bucket: two checks on either side of UTC midnight are distinct even when
  // they share the host's local day, and two on the same UTC day collide even
  // when local midnight lies between them. A claimed/in-flight (`attempts >
  // 0`) or terminal run is neither a collision target nor mutated.
  const scheduledLoopId = timeBasedLoopId(input);
  const policy = input.onScheduleConflict ?? "refuse";
  if (scheduledLoopId !== undefined && policy !== "add") {
    const dayStartMs = utcDayStartMs(nextAttemptAt);
    const existing = db
      .prepare<
        [string, number, number],
        { id: string; next_attempt_at: number; payload_json: string }
      >(
        `SELECT id, next_attempt_at, payload_json FROM cognition_runs
           WHERE status = 'pending'
             AND attempts = 0
             AND kind = 'time_based'
             AND json_extract(payload_json, '$.loopId') = ?
             AND next_attempt_at >= ?
             AND next_attempt_at < ?
         ORDER BY next_attempt_at ASC
         LIMIT 1`,
      )
      .get(scheduledLoopId, dayStartMs, dayStartMs + MS_PER_DAY);
    if (existing) {
      const existingPayload = JSON.parse(existing.payload_json) as unknown;
      const refused = (
        reason: "pending_check" | "instruction_full",
      ): EnqueueCognitionRunResult => ({
        outcome: "refused",
        reason,
        loopId: scheduledLoopId,
        runId: existing.id,
        nextAttemptAt: existing.next_attempt_at,
        existingPayload,
      });
      if (policy === "refuse") return refused("pending_check");
      // A merge is an addition to the same check, not fresh work over new
      // data: the existing row keeps its schedule, attempt budget and cycle
      // anchor, and only its instruction grows.
      const merged = mergeScheduledInstruction(existingPayload, input.payload, nextAttemptAt);
      if (merged === null) return refused("instruction_full");
      db.prepare<[string, string]>("UPDATE cognition_runs SET payload_json = ? WHERE id = ?").run(
        JSON.stringify({ ...(existingPayload as object), prompt: merged }),
        existing.id,
      );
      return { outcome: "merged", runId: existing.id, nextAttemptAt: existing.next_attempt_at };
    }
  }
  db.prepare<unknown[]>(
    `INSERT INTO cognition_runs (
       id, kind, payload_json, dedupe_key, status, attempts, next_attempt_at, enqueued_at, cycle_anchor_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    input.id,
    input.kind,
    JSON.stringify(input.payload ?? {}),
    input.dedupeKey ?? null,
    nextAttemptAt,
    now,
    now,
  );
  return { outcome: "inserted", runId: input.id, nextAttemptAt };
}

/** The pending row for a fold key, or null. */
export function getPendingRunByDedupeKey(db: Db, dedupeKey: string): CognitionRunRow | null {
  const row = db
    .prepare<
      [string],
      CognitionRunDbRow
    >("SELECT * FROM cognition_runs WHERE dedupe_key = ? AND status = 'pending'")
    .get(dedupeKey);
  return row ? rowToRun(row) : null;
}

export function getCognitionRun(db: Db, id: string): CognitionRunRow | null {
  const row = db
    .prepare<[string], CognitionRunDbRow>("SELECT * FROM cognition_runs WHERE id = ?")
    .get(id);
  return row ? rowToRun(row) : null;
}

export interface ListCognitionRunsOptions {
  kinds?: readonly CognitionRunKind[];
  statuses?: readonly CognitionRunStatus[];
  /** Structured loop scope carried by scheduled/decay run payloads. */
  loopId?: string;
  limit?: number;
  /** Defaults to enqueue recency; scheduled views sort by the next due time. */
  orderBy?: "enqueuedAt" | "nextAttemptAt";
  order?: "asc" | "desc";
  /** Exclusive keyset in the selected order. */
  afterSort?: { at: number; id: string };
}

/**
 * Runs newest-enqueued first by default — the operator inspection read (the
 * CLI's run list). Read-only; the claim path never goes through here.
 */
export function listCognitionRuns(
  db: Db,
  options: ListCognitionRunsOptions = {},
): CognitionRunRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }
  if (options.statuses && options.statuses.length > 0) {
    conditions.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  if (options.loopId !== undefined) {
    conditions.push(
      `(json_extract(payload_json, '$.loopId') = ?
        OR json_extract(payload_json, '$.decayCheckLoopId') = ?)`,
    );
    params.push(options.loopId, options.loopId);
  }
  const direction = options.order === "asc" ? "ASC" : "DESC";
  const orderColumn = options.orderBy === "nextAttemptAt" ? "next_attempt_at" : "enqueued_at";
  if (options.afterSort) {
    const comparator = direction === "ASC" ? ">" : "<";
    conditions.push(`(${orderColumn}, id) ${comparator} (?, ?)`);
    params.push(options.afterSort.at, options.afterSort.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(options.limit ?? 100);
  const oneKind = options.kinds?.length === 1;
  const oneStatus = options.statuses?.length === 1;
  const pageIndex =
    orderColumn === "next_attempt_at"
      ? oneKind && oneStatus
        ? "idx_cognition_runs_status_kind_scheduled_page"
        : oneStatus
          ? "idx_cognition_runs_due"
          : oneKind
            ? "idx_cognition_runs_kind_scheduled_page"
            : "idx_cognition_runs_scheduled_page"
      : oneKind && oneStatus
        ? "idx_cognition_runs_status_kind_enqueued_page"
        : oneStatus
          ? "idx_cognition_runs_status_enqueued_page"
          : oneKind
            ? "idx_cognition_runs_kind_enqueued_page"
            : "idx_cognition_runs_enqueued_page";
  return db
    .prepare<(string | number)[], CognitionRunDbRow>(
      `SELECT * FROM cognition_runs INDEXED BY ${pageIndex} ${where}
       ORDER BY ${orderColumn} ${direction}, id ${direction}
       LIMIT ?`,
    )
    .all(...params)
    .map(rowToRun);
}

/** Current rows for a small, process-local id set (the admin pulse's running ids). */
export function getCognitionRunsByIds(db: Db, ids: readonly string[]): CognitionRunRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare<string[], CognitionRunDbRow>(
      `SELECT * FROM cognition_runs WHERE id IN (${placeholders}) ORDER BY enqueued_at DESC, id DESC`,
    )
    .all(...ids)
    .map(rowToRun);
}

/** Soonest future pending runs, used by the lightweight admin pulse. */
export function listUpcomingCognitionRuns(
  db: Db,
  now: number,
  limit: number = 10,
): CognitionRunRow[] {
  return db
    .prepare<[number, number], CognitionRunDbRow>(
      `SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_due
        WHERE status = 'pending' AND next_attempt_at > ?
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT ?`,
    )
    .all(now, limit)
    .map(rowToRun);
}

/** One barrier-held `data` run, projected to what the readiness pass decides on. */
export interface BarrierHeldRun {
  readonly id: string;
  readonly docId: string;
  /** The barrier deadline the row is still parked at — the compare-and-set value. */
  readonly barrierUntil: number;
  /** When the run would be claimable on its debounce alone; the release target. */
  readonly debounceUntil: number;
}

/**
 * Pending `data` runs the readiness barrier is currently holding, soonest
 * barrier deadline first.
 *
 * "Held by the barrier" is expressed as `next_attempt_at = barrierUntil` — the
 * row is still parked exactly where the barrier put it. Any other writer that
 * reschedules the run (retry backoff, fold, resurrect, max-defer clamp) moves
 * it off that value and out of this set, which is what stops the release pass
 * from cancelling a wait it did not impose.
 *
 * The predicate lives in SQL rather than in the caller so `limit` bounds
 * CANDIDATES rather than rows scanned: filtering after a plain "not yet due"
 * read would let a population of debounce-deferred runs fill the window every
 * tick and starve the barrier's own rows indefinitely. Only the four scalars
 * the decision needs are selected — a `data` payload can carry a whole
 * pre-update document body, and parsing 200 of those per tick would put
 * megabytes of JSON on the event loop to read two numbers.
 */
export function listBarrierHeldDataRuns(db: Db, now: number, limit: number): BarrierHeldRun[] {
  return db
    .prepare<[number, number], BarrierHeldRun>(
      `SELECT id,
              json_extract(payload_json, '$.docId')         AS docId,
              json_extract(payload_json, '$.barrierUntil')  AS barrierUntil,
              json_extract(payload_json, '$.debounceUntil') AS debounceUntil
         FROM cognition_runs
        WHERE status = 'pending'
          AND kind = 'data'
          AND next_attempt_at > ?
          AND json_extract(payload_json, '$.barrierUntil') IS NOT NULL
          AND json_extract(payload_json, '$.docId') IS NOT NULL
          AND next_attempt_at = json_extract(payload_json, '$.barrierUntil')
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT ?`,
    )
    .all(now, limit)
    .filter((r) => typeof r.debounceUntil === "number");
}

/**
 * Release a barrier-held run to `nextAttemptAt`, but only while its schedule is
 * still exactly `expectedNextAttemptAt` and its datum is ready or absent.
 *
 * The compare-and-set is on the value the caller observed, not merely on the
 * row being later than the target. Between the read (main thread) and this
 * write (writer worker) a fold can land and open a fresh quiet window; without
 * the equality guard the release would cut that new window short and fire a run
 * on a document still being edited. The observed payload scalars are also
 * compared because a fold can preserve the same numeric schedule while
 * replacing the datum or its quiet window. The document predicate belongs to
 * this same UPDATE: delete/recreate or a derivation reset between the
 * main-thread candidate read and writer call must not release an incomplete
 * datum.
 *
 * Note that `status = 'pending'` does NOT mean "not in flight" — this queue
 * keeps in-flight rows pending by design (a claim only bumps `attempts`), so
 * the guard rests on the schedule match, not on the status.
 *
 * Returns whether the row moved, so a caller can report only what it released.
 */
export function pullForwardReadyCognitionRun(
  db: Db,
  id: string,
  docId: string,
  observedDebounceUntil: number,
  nextAttemptAt: number,
  expectedNextAttemptAt: number,
  stages: readonly DerivationStage[],
): boolean {
  const incomplete =
    stages.length === 0 ? "0" : stages.map((s) => `${s.column} IS NULL`).join(" OR ");
  const res = db
    .prepare(
      `UPDATE cognition_runs SET next_attempt_at = ?
        WHERE id = ? AND status = 'pending' AND next_attempt_at = ?
          AND json_extract(payload_json, '$.docId') = ?
          AND json_extract(payload_json, '$.barrierUntil') = ?
          AND json_extract(payload_json, '$.debounceUntil') = ?
          AND NOT EXISTS (
            SELECT 1 FROM documents
             WHERE id = ? AND (${incomplete})
          )`,
    )
    .run(
      nextAttemptAt,
      id,
      expectedNextAttemptAt,
      docId,
      expectedNextAttemptAt,
      observedDebounceUntil,
      docId,
    );
  return res.changes > 0;
}

/** Most recently completed or failed runs, ordered by settlement time. */
export function listRecentSettledCognitionRuns(db: Db, limit: number = 10): CognitionRunRow[] {
  return db
    .prepare<[number], CognitionRunDbRow>(
      `SELECT * FROM cognition_runs
        WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL
        ORDER BY completed_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit)
    .map(rowToRun);
}

/**
 * Atomically claim up to `limit` due pending runs under the attempts
 * cap, bumping `attempts` + `last_attempt_at` in one `UPDATE …
 * RETURNING` so two drain ticks can't claim the same row. The stamp takes
 * the caller's `now`, so a virtual clock stays authoritative.
 */
/**
 * Claim priority by run kind: the latency-sensitive reactive kinds (a user
 * just dismissed a brief → `feedback`; new content arrived → `data`) are
 * claimed and processed ahead of the periodic/generative kinds (`daily`,
 * `time_based`, `synthesis`), so a cadence-boundary burst of generative runs
 * (all enqueued at `next_attempt_at = now`) can't delay a reaction the user is
 * waiting on. Within a rank, oldest-due wins.
 */
// The backlog kinds — `bootstrap` (the one-time retrospective sweep) and
// `verification` (the re-verification sweep's re-grounding batches) — sit at
// the LOWEST rank so a backlog of pending maintenance rows can never be
// claimed while any reactive (feedback/data) OR periodic
// (daily/time_based/synthesis/sweep) run is due — they consume only leftover
// drain capacity ("run when the queue is idle").
// Provenance rechecks are the exception to ranking by kind alone. They ride
// the `feedback` kind because they do the same work — re-grounding a loop or
// brief whose evidence moved — but they are maintenance, not reaction: nothing
// is waiting on one, they are enqueued by a sweep rather than by a person, and
// the re-verification lane can produce them in bulk. Left at the reactive rank
// a large death set holds the tier a dismissed brief needs, for as long as it
// takes to drain. Their dedupe key already says what they are, so the rank
// reads it rather than fracturing a documented kind across six dispatch sites.
export const CLAIM_KIND_RANK_SQL = `CASE
     WHEN kind = 'feedback' AND dedupe_key LIKE '${PROVENANCE_RECHECK_DEDUPE_PREFIX}%' THEN 3
     WHEN kind = 'feedback' THEN 0
     WHEN kind = 'data' THEN 1
     WHEN kind IN ('bootstrap', 'verification') THEN 3
     ELSE 2
   END ASC`;

/** Kept in lockstep with {@link CLAIM_KIND_RANK_SQL} (the post-RETURNING re-sort). */
function claimKindRank(kind: string, dedupeKey: string | null): number {
  if (kind === "feedback") {
    return dedupeKey?.startsWith(PROVENANCE_RECHECK_DEDUPE_PREFIX) ? 3 : 0;
  }
  if (kind === "data") return 1;
  if (kind === "bootstrap" || kind === "verification") return 3;
  return 2;
}

export function claimDueCognitionRuns(
  db: Db,
  opts: { now: number; limit?: number; maxAttempts?: number },
): ClaimedCognitionRun[] {
  const limit = opts.limit ?? DEFAULT_COGNITION_RUN_CLAIM_LIMIT;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_COGNITION_RUN_MAX_ATTEMPTS;
  // `last_attempt_at` IS the claim time: a claim is the only thing that
  // constitutes an attempt on this queue, and this statement is the only
  // writer of the column for queued runs (settles touch status/completed_at,
  // never this). The provenance-recheck sweep's coverage predicate rests on
  // that — it reads `last_attempt_at` as the clock of a run's last claim-time
  // re-derivation (see `listCognitionRunsByDedupePrefix`).
  //
  // `recordSettledCognitionRun` also stamps the column, for runs that executed
  // outside the queue entirely. Those rows carry no dedupe key, so they never
  // appear in the prefix reads the predicate is built on. Any OTHER writer of
  // this column would break it.
  const rows = db
    .prepare<[number, number, number, number], CognitionRunDbRow>(
      `UPDATE cognition_runs
         SET attempts = attempts + 1,
             last_attempt_at = ?
       WHERE rowid IN (
         SELECT rowid FROM cognition_runs
         WHERE status = 'pending'
           AND next_attempt_at <= ?
           AND attempts < ?
         ORDER BY ${CLAIM_KIND_RANK_SQL}, next_attempt_at ASC
         LIMIT ?
       )
       RETURNING *`,
    )
    .all(opts.now, opts.now, maxAttempts, limit);
  // RETURNING yields rows in scan order, not the subquery's ORDER BY —
  // re-sort to the same reactive-first, then oldest-due order so the caller
  // both CLAIMS and PROCESSES latency-sensitive reactive runs ahead of a
  // generative/periodic burst.
  rows.sort(
    (a, b) =>
      claimKindRank(a.kind, a.dedupe_key) - claimKindRank(b.kind, b.dedupe_key) ||
      a.next_attempt_at - b.next_attempt_at,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as CognitionRunKind,
    payload: JSON.parse(r.payload_json) as unknown,
    payloadJson: r.payload_json,
    attempts: r.attempts,
  }));
}

/**
 * The settle-time projection of `payload_json`, as a SQL expression: the
 * payload minus the two fields that must not outlive the run (the
 * no-prior-version-storage rule) — the `data` fold `snapshot` (a pre-update
 * body) and the raw `diff` text. Everything else in a payload is
 * reference-shaped (doc/loop/brief ids, a source + date range, a scheduled
 * prompt), and keeping it lets a settled run still answer "what triggered
 * this?" on the operator surfaces instead of decoding to `unknown`.
 */
const SETTLED_PAYLOAD_SQL = "json_remove(payload_json, '$.snapshot', '$.diff')";

/**
 * Mark a claimed run completed, recording its token usage and reducing the
 * payload to its settled projection (see {@link SETTLED_PAYLOAD_SQL}).
 */
export function completeCognitionRun(
  db: Db,
  id: string,
  opts: { usage: CognitionRunUsage | null; now: number },
): void {
  db.prepare<[number, string | null, string]>(
    `UPDATE cognition_runs
       SET status = 'completed', completed_at = ?, last_error = NULL, failure_code = NULL,
           payload_json = ${SETTLED_PAYLOAD_SQL}, usage_json = ?
     WHERE id = ?`,
  ).run(opts.now, opts.usage === null ? null : JSON.stringify(opts.usage), id);
}

/**
 * Mark a claimed run failed. Terminal when the drain decides the
 * attempts cap is hit; otherwise a soft retry — back to `pending` with
 * `next_attempt_at` pushed out by the drain's back-off. A terminal
 * failure settles the payload like a completion does (see
 * {@link SETTLED_PAYLOAD_SQL}).
 */
export function failCognitionRun(
  db: Db,
  id: string,
  opts: {
    errorMessage: string;
    failureCode?: string;
    terminal: boolean;
    nextAttemptAt: number;
    now: number;
    /**
     * Give the attempt back, so this failure does not spend the run's retry
     * budget. For a failure that never reached the model on its merits — an
     * exhausted account, a rejected key, an unreachable backend — the attempt
     * bought nothing, and counting it would retire the run against an
     * environment fault the payload cannot fix. Claiming increments `attempts`
     * and the claim query skips rows at the cap, so without the refund a
     * non-terminal row would sit pending and unclaimable forever.
     */
    refundAttempt?: boolean;
  },
): void {
  const truncated =
    opts.errorMessage.length > 500 ? opts.errorMessage.slice(0, 500) : opts.errorMessage;
  if (opts.terminal) {
    db.prepare<[string, string | null, number, string]>(
      `UPDATE cognition_runs
         SET status = 'failed', last_error = ?, failure_code = ?, completed_at = ?,
             payload_json = ${SETTLED_PAYLOAD_SQL}
       WHERE id = ?`,
    ).run(truncated, opts.failureCode ?? null, opts.now, id);
  } else {
    // MAX(0, …) because the refund is driven by the failure's shape, not by a
    // ledger of what this row has already been granted; a row that somehow
    // refunds more often than it claims must still never go negative and
    // re-enter the claim window with a bogus budget.
    const attempts = opts.refundAttempt ? "MAX(0, attempts - 1)" : "attempts";
    db.prepare<[string, string | null, number, string]>(
      `UPDATE cognition_runs
         SET status = 'pending', last_error = ?, failure_code = ?, next_attempt_at = ?,
             attempts = ${attempts}
       WHERE id = ?`,
    ).run(truncated, opts.failureCode ?? null, opts.nextAttemptAt, id);
  }
}

/**
 * One drain-side settle of a claimed run: mark the row completed or
 * failed AND fold the attempt's token usage into the day's spend totals,
 * in a single writer transaction (no crash window between the row state
 * and the accounting).
 *
 * Spend semantics: `usage` is what THIS attempt consumed and is recorded
 * whatever the outcome — a failed attempt's tokens were still spent. The
 * spend row's `runs` counter only counts completions, so retries don't
 * inflate the per-day run count.
 */
export interface FinalizeCognitionRunInput {
  runId: string;
  now: number;
  /** Local-day spend bucket for `now` (`cognitionSpendDay(now)`). */
  day: string;
  /**
   * Spend attribution: the cognitive workflow the run performed, derived from
   * its claimed kind + payload (`cognitiveWorkflowIdForRun`). Not the queue
   * kind — several kinds multiplex procedures with different cost profiles.
   */
  mechanism: CognitiveWorkflowId;
  /**
   * Spend attribution: the model id of the backend that executed the
   * attempt, as resolved per run by the run driver; null when no backend
   * resolved (recorded as `''`).
   */
  modelId: string | null;
  /** Tokens consumed by this attempt; null when the backend reported none. */
  usage: CognitionRunUsage | null;
  /**
   * Raw `payload_json` as claimed (`ClaimedCognitionRun.payloadJson`).
   * On a COMPLETED outcome, if the row's payload BYTES differ at settle time a
   * fold landed while the run was in flight — the row carries a datum this
   * attempt never saw. Rather than freezing the payload on completion (which
   * would swallow that fold), the row is resurrected as a fresh cycle (see
   * {@link debounceMs}). A byte-identical fold is NOT resurrected — the attempt
   * already processed that exact payload, so re-running would be a no-op. This
   * A soft failure re-reads the folded payload on its next claim. A terminal
   * failure normally settles, but a different payload folded in-flight is
   * fresh work and is resurrected with a fresh attempt budget. Omit to settle
   * unconditionally.
   */
  claimedPayloadJson?: string;
  /**
   * Quiet window (ms) to re-open when an in-flight fold resurrects the row.
   * The resurrected `next_attempt_at` becomes `now + debounceMs` (NOT `now`) —
   * the primary spend-safety mechanism: a sustained-hot thread then fires at
   * most once per ceiling (each fire opens a fresh window) instead of once per
   * message. Omit (or 0) to re-fire ASAP (kinds with no debounce concept).
   */
  debounceMs?: number;
  outcome:
    | { kind: "completed" }
    | {
        kind: "failed";
        errorMessage: string;
        failureCode?: string;
        terminal: boolean;
        nextAttemptAt: number;
        /** See `failCognitionRun` — the attempt bought nothing, so give it back. */
        refundAttempt?: boolean;
      };
}

/**
 * Return an in-flight-folded, just-COMPLETED row to `pending` as a logically
 * fresh cycle: reset the cycle anchor to `now`, clear the attempt budget/error,
 * and re-enter the debounce window (`next_attempt_at = now + debounceMs`) rather
 * than firing immediately. Re-entering the window is the primary spend-safety
 * mechanism — a sustained-hot thread fires at most once per max-defer ceiling
 * (each fire opens a fresh window) instead of once per message.
 *
 * Completed runs and terminally failed runs with a different in-flight payload
 * resurrect. The terminal attempt exhausted its budget for the payload it
 * claimed, not for fresh work that arrived afterward. A byte-identical payload
 * still settles, so poison work cannot resurrect itself.
 */
function resurrectFoldedRun(db: Db, id: string, opts: { now: number; debounceMs: number }): void {
  db.prepare<[number, number, string]>(
    `UPDATE cognition_runs
       SET status = 'pending', attempts = 0, last_error = NULL, failure_code = NULL,
           next_attempt_at = ?, cycle_anchor_at = ?
     WHERE id = ?`,
  ).run(opts.now + opts.debounceMs, opts.now, id);
}

export function finalizeCognitionRun(db: Db, input: FinalizeCognitionRunInput): void {
  db.transaction(() => {
    const debounceMs = input.debounceMs ?? 0;
    const recordSpend = (opts?: { countRun: boolean }): void => {
      if (!input.usage) return;
      recordCognitionSpend(db, input.day, input.mechanism, input.modelId ?? "", input.usage, opts);
    };
    // What produced this run's output, kept after the run row itself is
    // pruned. Written for every settle, including a failed attempt: a run that
    // wrote artifacts before failing still needs to be attributable. Inside
    // the settle transaction so an artifact and its provenance land together.
    recordRunAttribution(db, {
      runId: input.runId,
      workflowId: input.mechanism,
      workflowVersion: cognitiveWorkflowVersion(input.mechanism),
      modelId: input.modelId ?? "",
      settledAt: input.now,
    });
    // In-flight rows remain pending and can receive a folded payload while an
    // attempt runs. Byte inequality means the attempt never saw all current
    // work; byte equality is already-processed work and must not re-run.
    const foldedInFlight =
      input.claimedPayloadJson !== undefined &&
      db
        .prepare<
          [string],
          { payload_json: string }
        >("SELECT payload_json FROM cognition_runs WHERE id = ?")
        .get(input.runId)?.payload_json !== input.claimedPayloadJson;
    if (input.outcome.kind === "completed") {
      if (foldedInFlight) resurrectFoldedRun(db, input.runId, { now: input.now, debounceMs });
      else completeCognitionRun(db, input.runId, { usage: input.usage, now: input.now });
      recordSpend();
    } else {
      if (input.outcome.terminal && foldedInFlight) {
        resurrectFoldedRun(db, input.runId, { now: input.now, debounceMs });
      } else {
        failCognitionRun(db, input.runId, {
          errorMessage: input.outcome.errorMessage,
          ...(input.outcome.failureCode !== undefined
            ? { failureCode: input.outcome.failureCode }
            : {}),
          terminal: input.outcome.terminal,
          nextAttemptAt: input.outcome.nextAttemptAt,
          ...(input.outcome.refundAttempt !== undefined
            ? { refundAttempt: input.outcome.refundAttempt }
            : {}),
          now: input.now,
        });
      }
      recordSpend({ countRun: false });
    }
  })();
}

/**
 * Insert a run that executed OUTSIDE the queue, already settled.
 *
 * The watch compiler runs synchronously inside the authoring request, so its
 * run cannot pass through enqueue → claim → finalize without either racing
 * the drainer or changing the compile path's latency semantics. This records
 * the finished run directly: one terminal row (`completed`/`failed`, never
 * `pending`, so the drainer can never claim it) plus the same settle
 * bookkeeping `finalizeCognitionRun` performs — durable run attribution and
 * the day's spend totals — in one transaction. `attempts` is 1 by
 * construction: an inline run either happened or left no row.
 *
 * Recording the same run id twice is a no-op in full. The row insert declines
 * on conflict, and the attribution upsert and the spend accumulator are gated
 * behind that outcome — spend is a running total, so folding a duplicate call
 * into it would bill one compilation's tokens twice against the day.
 */
export interface RecordSettledCognitionRunInput {
  runId: string;
  kind: CognitionRunKind;
  /** Reference-shaped payload for the trigger view; stored settled as-is. */
  payload: unknown;
  /** When the run began (unix ms) — becomes `enqueued_at`/`last_attempt_at`. */
  startedAt: number;
  /** When the run settled (unix ms) — becomes `completed_at`. */
  now: number;
  /** Local-day spend bucket for `now` (`cognitionSpendDay(now)`). */
  day: string;
  /** Spend attribution: the cognitive workflow the run performed. */
  mechanism: CognitiveWorkflowId;
  /** Model id of the backend that executed the run; null when none resolved. */
  modelId: string | null;
  /** Tokens consumed; null when no model turn ran or none were reported. */
  usage: CognitionRunUsage | null;
  outcome: { kind: "completed" } | { kind: "failed"; errorMessage: string; failureCode?: string };
}

export function recordSettledCognitionRun(db: Db, input: RecordSettledCognitionRunInput): void {
  db.transaction(() => {
    const failed = input.outcome.kind === "failed";
    const errorMessage =
      input.outcome.kind === "failed" ? input.outcome.errorMessage.slice(0, 500) : null;
    const failureCode =
      input.outcome.kind === "failed" ? (input.outcome.failureCode ?? null) : null;
    const inserted = db
      .prepare<unknown[]>(
        `INSERT INTO cognition_runs (
         id, kind, payload_json, dedupe_key, status, attempts, last_error, failure_code,
         next_attempt_at, enqueued_at, cycle_anchor_at, last_attempt_at,
         completed_at, usage_json
       ) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.runId,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        failed ? "failed" : "completed",
        errorMessage,
        failureCode,
        input.startedAt,
        input.startedAt,
        input.startedAt,
        input.startedAt,
        input.now,
        input.usage === null ? null : JSON.stringify(input.usage),
      );
    // This run is already on the ledger: its attribution and its tokens were
    // recorded with it, and re-applying either would overwrite the first
    // settle's provenance and double-count the day's spend.
    if (inserted.changes === 0) return;
    recordRunAttribution(db, {
      runId: input.runId,
      workflowId: input.mechanism,
      workflowVersion: cognitiveWorkflowVersion(input.mechanism),
      modelId: input.modelId ?? "",
      settledAt: input.now,
    });
    // Mirror finalizeCognitionRun's spend semantics: tokens are recorded
    // whatever the outcome (a refused compilation's tokens were still spent);
    // the day's `runs` counter only counts completions.
    if (input.usage) {
      recordCognitionSpend(
        db,
        input.day,
        input.mechanism,
        input.modelId ?? "",
        input.usage,
        failed ? { countRun: false } : undefined,
      );
    }
  })();
}

/**
 * Drop pending rows by dedupe key — used by the decay sweep to retract
 * scheduled status-checks whose loop is no longer eligible (closed,
 * deleted, privacy-cascaded). A row already claimed and in flight is
 * still `pending`, so this can race a running check; the decay prompt is
 * built from live loop state at claim time and degrades to a no-op when
 * the loop is gone. Returns the number of rows dropped.
 */
export function cancelPendingCognitionRunsByDedupeKeys(
  db: Db,
  dedupeKeys: readonly string[],
): number {
  if (dedupeKeys.length === 0) return 0;
  const placeholders = dedupeKeys.map(() => "?").join(", ");
  return db
    .prepare<string[]>(
      `DELETE FROM cognition_runs
       WHERE status = 'pending' AND dedupe_key IN (${placeholders})`,
    )
    .run(...dedupeKeys).changes;
}

/**
 * Cancel the never-claimed scheduled runs linked to a loop that just
 * resolved or was deleted — the cascade that keeps an agent-scheduled
 * `schedule_agent_run` check from firing against an already-handled loop
 * and burning a model call to rediscover "nothing to do".
 *
 * A run is considered linked to the loop by EITHER of two matches:
 *   1. the payload's structured `loopId` — the clean link the engine
 *      auto-attaches (and the agent may pass) for a loop-scoped check; or
 *   2. the loop id appearing anywhere in the payload's `prompt` — the
 *      robust fallback. The agent reliably writes the loop id into every
 *      check's prompt (e.g. "Check on loop_XXXX…"), so this catches checks
 *      whose structured `loopId` is missing — pre-link runs scheduled
 *      before the field existed, and any run where the structured link
 *      wasn't attached. Loop ids are UUID-suffixed, so a full-id substring
 *      match is specific enough to avoid false positives; and a false
 *      positive is low-harm anyway (a check that merely mentions a
 *      now-resolved loop would no-op when it fired). `instr` returns NULL
 *      for a payload with no `prompt`, so promptless rows (decay checks,
 *      which key on `decayCheckLoopId`) never match this clause.
 *
 * Only `pending` rows with `attempts = 0` are dropped: a claimed/in-flight
 * run stays `pending` on disk but with a bumped `attempts`, so the
 * `attempts = 0` guard leaves an executing check untouched (its prompt is
 * built from live loop state at claim time and already degrades to a
 * no-op when the loop is gone). Completed/failed rows are excluded by the
 * status guard. Idempotent — a no-match resolve returns 0. Returns the
 * number of rows dropped.
 */
export function cancelScheduledRunsForLoop(db: Db, loopId: string): number {
  return db
    .prepare<[string, string]>(
      `DELETE FROM cognition_runs
       WHERE status = 'pending'
         AND attempts = 0
         AND kind = 'time_based'
         AND (
           json_extract(payload_json, '$.loopId') = ?
           OR instr(json_extract(payload_json, '$.prompt'), ?) > 0
         )`,
    )
    .run(loopId, loopId).changes;
}

/**
 * Dedupe keys of all pending runs whose key starts with `prefix` — the
 * decay sweep's reconciliation read ("which loops have a check
 * scheduled").
 */
export function listPendingCognitionDedupeKeys(db: Db, prefix: string): string[] {
  return db
    .prepare<[string], { dedupe_key: string }>(
      `SELECT dedupe_key FROM cognition_runs
       WHERE status = 'pending' AND dedupe_key IS NOT NULL AND dedupe_key LIKE ? || '%'`,
    )
    .all(prefix)
    .map((r) => r.dedupe_key);
}

/**
 * Pending runs whose dedupe key starts with `prefix`, with their attempt
 * counts — the re-verification sweep's coverage read. The attempts column
 * lets the caller tell claimable rows (still owed an execution) apart from
 * attempts-exhausted crash residue: a process death mid-claim leaves a row
 * `pending` at the cap, where the drainer's `attempts < maxAttempts` claim
 * predicate can never pick it up again.
 */
export function listPendingCognitionRunsByDedupePrefix(
  db: Db,
  prefix: string,
): Array<{ dedupeKey: string; attempts: number }> {
  return db
    .prepare<[string], { dedupe_key: string; attempts: number }>(
      `SELECT dedupe_key, attempts FROM cognition_runs
       WHERE status = 'pending' AND dedupe_key IS NOT NULL AND dedupe_key LIKE ? || '%'`,
    )
    .all(prefix)
    .map((r) => ({ dedupeKey: r.dedupe_key, attempts: r.attempts }));
}

/** One run's coverage-relevant state — see {@link listCognitionRunsByDedupePrefix}. */
export interface CognitionRunDedupeRow {
  dedupeKey: string;
  status: CognitionRunStatus;
  attempts: number;
  /**
   * Wall clock of the run's last CLAIM; null when it was never claimed. A
   * claim is the only attempt this queue makes, and {@link claimDueCognitionRuns}
   * is the column's only writer — so this is when the run last read the world.
   */
  lastAttemptAt: number | null;
}

/**
 * Every run — any status — whose dedupe key starts with `prefix`, with the
 * state the provenance-recheck sweep decides on: `status` + `attempts` split
 * claimable pending rows (still owed an execution) from attempts-exhausted
 * crash residue, and `lastAttemptAt` is the COVERAGE CLOCK — a recheck's
 * prompt re-derives its dead-prior set when the run is claimed, so any death
 * at or before its last claim was already re-examined and needs no new run.
 * Terminal rows are included precisely because they carry that coverage: a
 * completed recheck's claim already saw every prior death older than it, so
 * the sweep must not re-enqueue those.
 */
export function listCognitionRunsByDedupePrefix(db: Db, prefix: string): CognitionRunDedupeRow[] {
  return db
    .prepare<
      [string],
      { dedupe_key: string; status: string; attempts: number; last_attempt_at: number | null }
    >(
      `SELECT dedupe_key, status, attempts, last_attempt_at FROM cognition_runs
       WHERE dedupe_key IS NOT NULL AND dedupe_key LIKE ? || '%'`,
    )
    .all(prefix)
    .map((r) => ({
      dedupeKey: r.dedupe_key,
      status: r.status as CognitionRunStatus,
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at,
    }));
}

/** Pending rows still under the attempts cap — the drainer's backlog gauge. */
export function countPendingCognitionRuns(db: Db, maxAttempts: number): number {
  const row = db
    .prepare<
      [number],
      { n: number }
    >("SELECT COUNT(*) AS n FROM cognition_runs WHERE status = 'pending' AND attempts < ?")
    .get(maxAttempts);
  return row?.n ?? 0;
}

/**
 * Runs that are due now and outrank the backlog kinds.
 *
 * The drainer claims strictly by rank, so while this is non-zero the
 * retrospective lane receives no drain capacity at all — its runs are due,
 * claimable, and simply never reached. That is the intended design: the
 * backfill must never delay a reaction. But a lane reporting itself as running
 * while completing nothing for hours is the kind of quiet stall these surfaces
 * exist to make visible, so the number is published rather than left to be
 * inferred from a flat counter.
 *
 * Shares {@link CLAIM_KIND_RANK_SQL} rather than restating the ranking. The
 * rank has an exception in it — a provenance recheck rides the `feedback` kind
 * but claims as maintenance — and a second copy would lose it.
 */
export function countDueAboveBacklogRank(db: Db, now: number): number {
  return db
    .prepare<[number, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM cognition_runs
        WHERE status = 'pending'
          AND next_attempt_at <= ?
          AND attempts < ?
          AND (${CLAIM_KIND_RANK_SQL.replace(" ASC", "")}) < 3`,
    )
    .get(now, DEFAULT_COGNITION_RUN_MAX_ATTEMPTS)!.n;
}
