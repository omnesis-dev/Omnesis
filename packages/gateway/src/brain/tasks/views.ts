// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Tasks views — queries over open loops, read the way a bullet journal
 * is: the day, the month, the future, what waits on someone else, and the
 * Brain's suggestions.
 *
 * A task's place comes from when the user plans to do it (`scheduledFor`)
 * and, when unscheduled, from its deadline. A task planned for an earlier
 * day that is still open stays on today, marked carried, until the user
 * completes, moves or strikes it. Only the user's own tasks appear in the
 * journal views; Brain loops the user has not accepted appear only under
 * Suggested.
 */

import { assertNever } from "@omnesis/core";
import { getDocumentTitlesAndSources } from "../../db.js";
import { fetchSelfPersonId } from "../../domain/InteractionScoreService.js";
import { deadlineDueDay } from "../deadlines.js";
import { knowledgeOwnerReadPredicate } from "../knowledge/storage-fence.js";
import { displayPersonRefs } from "../person-refs.js";
import { getActiveLoopTitle, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { cognitionSpendDay } from "../storage/spend.js";
import type { OpenLoopRow, OpenLoopLedgerEntry } from "../storage/types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export const TASK_VIEWS = [
  "today",
  "month",
  "future",
  "anytime",
  "waiting",
  "suggested",
  "done",
] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export interface TaskItem {
  row: OpenLoopRow;
  /** The day the task is due by its deadline, when it has one. */
  dueDay: string | null;
  /** Planned for an earlier day and still open. */
  carried: boolean;
  actors: Array<{ id: string; name: string | null; isSelf: boolean }>;
  blockedBy: Array<{ id: string; title: string }>;
}

/** A document a task refers to, as a client renders a link to it. */
export interface TaskDocument {
  id: string;
  title: string;
  /** The owning source; its type picks the icon. */
  sourceId: string;
}

export interface TaskViewResult {
  view: TaskView;
  /** The day the view was read for (`YYYY-MM-DD`). */
  day: string;
  tasks: TaskItem[];
  counts: TaskCounts;
}

/**
 * What the journal holds on one day: open tasks in each view a client tabs,
 * plus the suggestions, pending proposals and carried-over tasks.
 */
export interface TaskCounts {
  today: number;
  month: number;
  future: number;
  anytime: number;
  waiting: number;
  suggested: number;
  proposals: number;
  carried: number;
}

/** The month (`YYYY-MM`) a schedule falls in, or null for `someday`. */
function scheduleMonth(schedule: string): string | null {
  return schedule === "someday" ? null : schedule.slice(0, 7);
}

function isDay(schedule: string): boolean {
  return schedule.length === 10;
}

function loopIds(db: Db, sql: string, ...params: Array<string | number>): string[] {
  return db
    .prepare<Array<string | number>, { id: string }>(sql)
    .all(...params)
    .map((r) => r.id);
}

function loadOwnedOpen(db: Db): OpenLoopRow[] {
  return loopIds(
    db,
    `SELECT id FROM open_loops
      WHERE state IN ('open', 'snoozed') AND (origin != 'brain' OR accepted = 1)
        AND ${knowledgeOwnerReadPredicate(db, "open_loops.id")}
      ORDER BY last_update DESC, id DESC`,
  )
    .map((id) => getOpenLoop(db, id))
    .filter((loop): loop is OpenLoopRow => loop !== null);
}

/**
 * Which journal view an open owned task belongs to on `day`. A deadline that
 * has arrived brings the task to today, whatever its plan.
 */
export function placeTask(
  loop: Pick<OpenLoopRow, "scheduledFor" | "deadline">,
  day: string,
): { view: "today" | "month" | "future" | "anytime"; carried: boolean } {
  const planned = placeByPlan(loop, day);
  if (planned.view === "today") return planned;
  const due = deadlineDueDay(loop.deadline);
  return due !== null && due <= day ? { view: "today", carried: false } : planned;
}

function placeByPlan(
  loop: Pick<OpenLoopRow, "scheduledFor" | "deadline">,
  day: string,
): { view: "today" | "month" | "future" | "anytime"; carried: boolean } {
  const month = day.slice(0, 7);
  const schedule = loop.scheduledFor;
  if (schedule !== null) {
    if (schedule === "someday") return { view: "future", carried: false };
    if (isDay(schedule)) {
      if (schedule <= day) return { view: "today", carried: schedule < day };
      return { view: scheduleMonth(schedule) === month ? "month" : "future", carried: false };
    }
    if (schedule < month) return { view: "today", carried: true };
    return { view: schedule === month ? "month" : "future", carried: false };
  }
  const due = deadlineDueDay(loop.deadline);
  if (due === null) return { view: "anytime", carried: false };
  if (due <= day) return { view: "today", carried: false };
  return { view: due.slice(0, 7) === month ? "month" : "future", carried: false };
}

function sortKey(item: TaskItem): string {
  const s = item.row.scheduledFor;
  return s && s !== "someday" ? s : (item.dueDay ?? "9999");
}

/** Earliest planned or due first; within a day, in the order the tasks were added. */
function byPlace(a: TaskItem, b: TaskItem): number {
  return (
    sortKey(a).localeCompare(sortKey(b)) ||
    a.row.createdAt - b.row.createdAt ||
    a.row.id.localeCompare(b.row.id)
  );
}

/** Waiting on someone else: blocked by another task, or owned by people other than the user. */
function isWaiting(item: TaskItem): boolean {
  return (
    item.blockedBy.length > 0 ||
    (item.actors.length > 0 && item.actors.every((actor) => !actor.isSelf))
  );
}

export class TaskQueryService {
  constructor(private readonly db: Db) {}

  view(
    view: TaskView,
    day: string,
    options: { limit?: number; before?: { resolvedAt: number; id: string } } = {},
  ): TaskViewResult {
    const selfId = fetchSelfPersonId(this.db);
    const enrich = (row: OpenLoopRow, carried = false): TaskItem =>
      this.enrich(row, selfId, carried);
    const owned = loadOwnedOpen(this.db);
    const counts = this.countsOf(owned, day, selfId);
    let tasks: TaskItem[];
    switch (view) {
      case "today": {
        const open = owned.flatMap((loop) => {
          const placed = placeTask(loop, day);
          return placed.view === "today" ? [enrich(loop, placed.carried)] : [];
        });
        open.sort((a, b) => Number(b.carried) - Number(a.carried) || byPlace(a, b));
        const resolved = this.resolvedOn(day).map((loop) => enrich(loop));
        tasks = [...open, ...resolved];
        break;
      }
      case "month":
      case "future":
      case "anytime":
        tasks = owned
          .filter((loop) => placeTask(loop, day).view === view)
          .map((loop) => enrich(loop))
          .sort(byPlace);
        break;
      case "waiting":
        tasks = owned.map((loop) => enrich(loop)).filter(isWaiting);
        break;
      case "suggested":
        tasks = loopIds(
          this.db,
          `SELECT id FROM open_loops
            WHERE origin = 'brain' AND accepted = 0 AND state = 'open'
              AND ${knowledgeOwnerReadPredicate(this.db, "open_loops.id")}
            ORDER BY importance DESC, last_update DESC, id DESC LIMIT ?`,
          options.limit ?? 100,
        )
          .map((id) => getOpenLoop(this.db, id))
          .filter((loop): loop is OpenLoopRow => loop !== null)
          .map((loop) => enrich(loop));
        break;
      case "done": {
        const before = options.before;
        tasks = loopIds(
          this.db,
          `SELECT id FROM open_loops
            WHERE state IN ('done', 'dismissed') AND (origin != 'brain' OR accepted = 1)
              AND resolved_at IS NOT NULL
              AND ${knowledgeOwnerReadPredicate(this.db, "open_loops.id")}
              ${before ? "AND (resolved_at < ? OR (resolved_at = ? AND id < ?))" : ""}
            ORDER BY resolved_at DESC, id DESC LIMIT ?`,
          ...(before ? [before.resolvedAt, before.resolvedAt, before.id] : []),
          options.limit ?? 50,
        )
          .map((id) => getOpenLoop(this.db, id))
          .filter((loop): loop is OpenLoopRow => loop !== null)
          .map((loop) => enrich(loop));
        break;
      }
      default:
        return assertNever(view);
    }
    return { view, day, tasks, counts };
  }

  /** The journal's counts on `day`, without reading any one view. */
  counts(day: string): TaskCounts {
    return this.countsOf(loadOwnedOpen(this.db), day, fetchSelfPersonId(this.db));
  }

  private countsOf(owned: OpenLoopRow[], day: string, selfId: string | null): TaskCounts {
    const counts: TaskCounts = {
      today: 0,
      month: 0,
      future: 0,
      anytime: 0,
      waiting: 0,
      suggested: this.suggestedCount(),
      proposals: 0,
      carried: 0,
    };
    for (const loop of owned) {
      const placed = placeTask(loop, day);
      counts[placed.view] += 1;
      if (placed.carried) counts.carried += 1;
      if (loop.proposedChange !== null) counts.proposals += 1;
      if (isWaiting(this.enrich(loop, selfId, false))) counts.waiting += 1;
    }
    return counts;
  }

  get(id: string): TaskItem | null {
    const row = getOpenLoop(this.db, id);
    return row ? this.enrich(row, fetchSelfPersonId(this.db), false) : null;
  }

  /**
   * The documents `items` refer to, read in one lookup for all of them. A
   * document the corpus no longer holds, or one the privacy fence hides, is
   * absent: a task keeps its own record of the ids, and its reader sees only
   * what is still there to open.
   */
  documents(items: readonly TaskItem[]): Map<string, TaskDocument> {
    const ids = [...new Set(items.flatMap((item) => item.row.docs))];
    return new Map(
      [...getDocumentTitlesAndSources(this.db, ids)].map(([id, doc]) => [
        id,
        { id, title: doc.title, sourceId: doc.sourceId },
      ]),
    );
  }

  history(id: string, limit = 100): OpenLoopLedgerEntry[] {
    return listOpenLoopLedger(this.db, id, { order: "desc", limit });
  }

  /** The newest change to a task that can be undone, if any. */
  latestUndoable(id: string): number | null {
    const latest = this.db
      .prepare<[string], { seq: number; event_json: string }>(
        `SELECT seq, event_json FROM open_loop_ledger
          WHERE loop_id = ? AND event_json IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(id);
    if (!latest) return null;
    return (JSON.parse(latest.event_json) as { kind: string }).kind === "undone"
      ? null
      : latest.seq;
  }

  suggestedCount(): number {
    return (
      this.db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM open_loops
            WHERE origin = 'brain' AND accepted = 0 AND state = 'open'
              AND ${knowledgeOwnerReadPredicate(this.db, "open_loops.id")}`,
        )
        .get()?.n ?? 0
    );
  }

  private resolvedOn(day: string): OpenLoopRow[] {
    // A date-time without an offset parses as local time: the gateway's day.
    const start = new Date(`${day}T00:00:00`).getTime();
    const end = start + 36 * 3_600_000;
    return loopIds(
      this.db,
      `SELECT id FROM open_loops
        WHERE state IN ('done', 'dismissed') AND (origin != 'brain' OR accepted = 1)
          AND resolved_at >= ? AND resolved_at < ?
          AND ${knowledgeOwnerReadPredicate(this.db, "open_loops.id")}
        ORDER BY resolved_at DESC`,
      start,
      end,
    )
      .map((id) => getOpenLoop(this.db, id))
      .filter(
        (loop): loop is OpenLoopRow =>
          loop !== null && loop.resolvedAt !== null && cognitionSpendDay(loop.resolvedAt) === day,
      );
  }

  private enrich(row: OpenLoopRow, selfId: string | null, carried: boolean): TaskItem {
    const blockedBy: TaskItem["blockedBy"] = [];
    for (const id of row.blockedBy) {
      const title = getActiveLoopTitle(this.db, id);
      if (title !== null) blockedBy.push({ id, title });
    }
    return {
      row,
      dueDay: deadlineDueDay(row.deadline),
      carried,
      actors: displayPersonRefs(this.db, row.actors).map((ref) => ({
        ...ref,
        isSelf: selfId !== null && ref.id === selfId,
      })),
      blockedBy,
    };
  }
}
