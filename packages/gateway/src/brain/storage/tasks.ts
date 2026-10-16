// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Task commands — every change the user makes to their tasks, from the Tasks
 * view, a conversation or a Tell Omnesis note, applied on the writer in one
 * transaction with a structured ledger event.
 *
 * A task is an open loop. The user's own tasks (from a note, created by the
 * user, or an accepted Brain suggestion) change through these commands,
 * through a Brain proposal the user confirms, or through a Brain change
 * Omnesis applied on its own after verifying its evidence (recorded as
 * `auto_applied`). A Brain suggestion the user ignores leaves the Tasks views
 * but stays an open loop the Brain keeps tracking. Every event records the
 * fields it replaced, so the latest change to a task can be undone.
 */

import { assertNever } from "@omnesis/core";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  deleteOpenLoop,
  getOpenLoop,
  updateOpenLoop,
} from "./open-loops.js";
import {
  isOwnedTask,
  type OpenLoopRow,
  type ProposedTaskChange,
  type TaskAuthoredField,
  type TaskEvent,
  type TaskSchedule,
  type TaskSnapshot,
} from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Where a command came from; stamped on its ledger event. */
export interface TaskCommandOrigin {
  surface: TaskEvent["surface"];
  /** Ledger run id: `user:tasks`, `user:conversation:<id>`, `note:<entryId>`. */
  runId: string;
  conversationId?: string;
}

export type TaskCommand = TaskCommandOrigin &
  (
    | {
        kind: "create";
        id: string;
        title: string;
        description?: string;
        deadline?: unknown | null;
        scheduledFor?: TaskSchedule | null;
        origin: "note" | "user";
        docs?: string[];
      }
    | { kind: "complete"; id: string; note?: string }
    | { kind: "migrate"; id: string; to: TaskSchedule }
    | { kind: "strike"; id: string; reason?: string }
    | {
        kind: "edit";
        id: string;
        fields: {
          title?: string;
          description?: string;
          deadline?: unknown | null;
          scheduledFor?: TaskSchedule | null;
        };
      }
    | { kind: "accept"; id: string; scheduledFor?: TaskSchedule | null }
    | { kind: "ignore"; id: string; reason?: string }
    | { kind: "confirm_proposal"; id: string }
    | { kind: "keep"; id: string }
    | { kind: "reopen"; id: string }
    | { kind: "delete"; id: string }
    | { kind: "undo"; seq: number }
  );

export type TaskCommandResult =
  | {
      ok: true;
      /** The task after the change; null once deleted. */
      loop: OpenLoopRow | null;
      loopId: string;
      /** Ledger entry of the change, the handle undo takes. Null for a delete. */
      eventSeq: number | null;
      /** The change closed the task (done or struck). An ignored suggestion stays open. */
      resolved: boolean;
      /** The change reopened a closed task. */
      reopened: boolean;
      /** One line describing what changed, for receipts. */
      receipt: string;
    }
  | {
      ok: false;
      reason: "not_found" | "not_owned" | "invalid" | "nothing_to_undo" | "not_latest";
      message: string;
    };

const SCHEDULE_RE = /^(\d{4}-\d{2}(-\d{2})?|someday)$/;

/** A day (`YYYY-MM-DD`), a month (`YYYY-MM`) or `someday`. */
export function isTaskSchedule(value: string): boolean {
  return SCHEDULE_RE.test(value);
}

function snapshot(loop: OpenLoopRow): TaskSnapshot {
  return {
    state: loop.state,
    title: loop.title,
    description: loop.description,
    deadline: loop.deadline,
    scheduledFor: loop.scheduledFor,
    accepted: loop.accepted,
    ignored: loop.ignored,
    completionNote: loop.completionNote,
    proposedChange: loop.proposedChange,
  };
}

function fail(
  reason: Extract<TaskCommandResult, { ok: false }>["reason"],
  message: string,
): TaskCommandResult {
  return { ok: false, reason, message };
}

/**
 * A schedule as a receipt reads it: "Fri 16 Oct", "November 2026", "someday".
 * A day in another year than `now` names its year.
 */
export function describeSchedule(schedule: TaskSchedule | null, now: number): string {
  if (schedule === null) return "unscheduled";
  if (schedule === "someday") return "someday";
  const [year, month, day] = schedule.split("-").map(Number) as [number, number, number?];
  const date = new Date(Date.UTC(year, month - 1, day ?? 1));
  if (day === undefined)
    return date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const sameYear = year === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** Apply one task command atomically. */
export function applyTaskCommand(db: Db, command: TaskCommand, now: number): TaskCommandResult {
  return db.transaction(() => applyUnlocked(db, command, now))();
}

function applyUnlocked(db: Db, command: TaskCommand, now: number): TaskCommandResult {
  const origin: Pick<TaskEvent, "surface" | "conversationId"> = {
    surface: command.surface,
    ...(command.conversationId ? { conversationId: command.conversationId } : {}),
  };
  const record = (loopId: string, note: string, event: Omit<TaskEvent, "surface">): number =>
    appendOpenLoopLedger(
      db,
      loopId,
      { runId: command.runId, note, event: { ...event, ...origin } },
      now,
    );

  if (command.kind === "create") {
    if (command.scheduledFor && !isTaskSchedule(command.scheduledFor))
      return fail("invalid", "scheduledFor must be YYYY-MM-DD, YYYY-MM or someday");
    createOpenLoop(
      db,
      {
        id: command.id,
        createdByRun: command.runId,
        title: command.title,
        description: command.description ?? "",
        confidence: 1,
        importance: 0.5,
        deadline: command.deadline ?? null,
        docs: command.docs ?? [],
        origin: command.origin,
        scheduledFor: command.scheduledFor ?? null,
      },
      now,
    );
    const seq = record(command.id, "Created", {
      kind: "created",
      fields: [
        "title",
        ...(command.description?.trim() ? (["description"] as const) : []),
        ...(command.deadline != null ? (["deadline"] as const) : []),
      ],
    });
    return done(db, command.id, seq, false, false, `Added: ${command.title}`);
  }

  if (command.kind === "undo") return undo(db, command, now, record);

  const loop = getOpenLoop(db, command.id);
  if (!loop) return fail("not_found", `task ${command.id} does not exist`);
  const before = snapshot(loop);
  const owned = isOwnedTask(loop);

  switch (command.kind) {
    case "complete": {
      if (loop.state === "done") return fail("invalid", "the task is already done");
      updateOpenLoop(
        db,
        loop.id,
        {
          state: "done",
          accepted: true,
          completionNote: command.note?.trim() ? command.note.trim() : null,
          proposedChange: null,
        },
        now,
      );
      // A suggestion completed straight away was done before the user saw it.
      const label = owned ? "Done" : "Already done";
      const seq = record(loop.id, command.note ? `${label}: ${command.note}` : label, {
        kind: "completed",
        before,
        ...(command.note ? { note: command.note } : {}),
      });
      return done(db, loop.id, seq, true, false, `Done: ${loop.title}`);
    }
    case "migrate": {
      if (!isTaskSchedule(command.to))
        return fail("invalid", "to must be YYYY-MM-DD, YYYY-MM or someday");
      if (!owned) return fail("not_owned", "accept the suggestion before scheduling it");
      if (loop.state !== "open") return fail("invalid", "only an open task can be moved");
      updateOpenLoop(db, loop.id, { scheduledFor: command.to }, now);
      const seq = record(loop.id, `Moved to ${describeSchedule(command.to, now)}`, {
        kind: "migrated",
        from: loop.scheduledFor,
        to: command.to,
        before,
      });
      return done(
        db,
        loop.id,
        seq,
        false,
        false,
        `Moved to ${describeSchedule(command.to, now)}: ${loop.title}`,
      );
    }
    case "strike": {
      if (loop.state === "dismissed") return fail("invalid", "the task is already struck");
      updateOpenLoop(db, loop.id, { state: "dismissed", proposedChange: null }, now);
      const seq = record(loop.id, command.reason ? `Struck: ${command.reason}` : "Struck", {
        kind: "struck",
        before,
        ...(command.reason ? { note: command.reason } : {}),
      });
      return done(db, loop.id, seq, true, false, `Struck: ${loop.title}`);
    }
    case "ignore": {
      // Only the Tasks views stop offering it: the loop stays open, with its
      // ledger, observations and checks, for the Brain to keep maintaining.
      if (owned) return fail("invalid", "only a suggestion can be ignored; strike a task instead");
      if (loop.ignored) return fail("invalid", "the suggestion is already ignored");
      if (loop.state !== "open") return fail("invalid", "only an open suggestion can be ignored");
      updateOpenLoop(db, loop.id, { ignored: true }, now);
      const seq = record(loop.id, command.reason ? `Ignored: ${command.reason}` : "Ignored", {
        kind: "ignored",
        before,
        ...(command.reason ? { note: command.reason } : {}),
      });
      return done(db, loop.id, seq, false, false, `Ignored: ${loop.title}`);
    }
    case "edit": {
      if (!owned) return fail("not_owned", "accept the suggestion before editing it");
      const fields = command.fields;
      if (fields.scheduledFor && !isTaskSchedule(fields.scheduledFor))
        return fail("invalid", "scheduledFor must be YYYY-MM-DD, YYYY-MM or someday");
      if (Object.keys(fields).length === 0) return fail("invalid", "nothing to change");
      updateOpenLoop(
        db,
        loop.id,
        {
          ...(fields.title !== undefined ? { title: fields.title } : {}),
          ...(fields.description !== undefined ? { description: fields.description } : {}),
          ...(fields.deadline !== undefined ? { deadline: fields.deadline } : {}),
          ...(fields.scheduledFor !== undefined ? { scheduledFor: fields.scheduledFor } : {}),
        },
        now,
      );
      const seq = record(loop.id, "Edited", {
        kind: "edited",
        before,
        fields: AUTHORED_EDIT_FIELDS.filter((field) => fields[field] !== undefined),
      });
      return done(db, loop.id, seq, false, false, `Edited: ${fields.title ?? loop.title}`);
    }
    case "accept": {
      if (owned && loop.origin !== "brain") return fail("invalid", "this is already your task");
      if (loop.accepted) return fail("invalid", "already accepted");
      if (command.scheduledFor && !isTaskSchedule(command.scheduledFor))
        return fail("invalid", "scheduledFor must be YYYY-MM-DD, YYYY-MM or someday");
      updateOpenLoop(
        db,
        loop.id,
        {
          accepted: true,
          ignored: false,
          ...(command.scheduledFor !== undefined ? { scheduledFor: command.scheduledFor } : {}),
        },
        now,
      );
      const seq = record(loop.id, "Accepted", { kind: "accepted", before });
      return done(db, loop.id, seq, false, false, `Added to your tasks: ${loop.title}`);
    }
    case "confirm_proposal": {
      const proposal = loop.proposedChange;
      if (!proposal) return fail("invalid", "there is no proposed change to confirm");
      const resolved = proposal.kind === "complete" || proposal.kind === "strike";
      updateOpenLoop(db, loop.id, proposalUpdate(proposal), now);
      const seq = record(loop.id, `Confirmed: ${proposal.reason}`, {
        kind: "proposal_confirmed",
        before,
        note: proposal.reason,
      });
      return done(db, loop.id, seq, resolved, false, `Confirmed: ${loop.title}`);
    }
    case "keep": {
      if (!loop.proposedChange) return fail("invalid", "there is no proposed change to refuse");
      updateOpenLoop(db, loop.id, { proposedChange: null }, now);
      const seq = record(loop.id, "Kept as is", { kind: "proposal_kept", before });
      return done(db, loop.id, seq, false, false, `Kept as is: ${loop.title}`);
    }
    case "reopen": {
      if (loop.state === "open") return fail("invalid", "the task is already open");
      updateOpenLoop(db, loop.id, { state: "open", completionNote: null }, now);
      const seq = record(loop.id, "Reopened", { kind: "reopened", before });
      return done(db, loop.id, seq, false, true, `Reopened: ${loop.title}`);
    }
    case "delete": {
      deleteOpenLoop(db, loop.id, { retire: true, now });
      return {
        ok: true,
        loop: null,
        loopId: loop.id,
        eventSeq: null,
        resolved: true,
        reopened: false,
        receipt: `Deleted: ${loop.title}`,
      };
    }
    default:
      return assertNever(command);
  }
}

const AUTHORED_EDIT_FIELDS = ["title", "description", "deadline"] as const;

function proposalUpdate(proposal: ProposedTaskChange): Parameters<typeof updateOpenLoop>[2] {
  switch (proposal.kind) {
    case "complete":
      return { state: "done", proposedChange: null };
    case "strike":
      return { state: "dismissed", proposedChange: null };
    case "edit":
      return {
        proposedChange: null,
        ...(proposal.fields?.title !== undefined ? { title: proposal.fields.title } : {}),
        ...(proposal.fields?.description !== undefined
          ? { description: proposal.fields.description }
          : {}),
        ...(proposal.fields?.deadline !== undefined ? { deadline: proposal.fields.deadline } : {}),
        ...(proposal.fields?.scheduledFor !== undefined
          ? { scheduledFor: proposal.fields.scheduledFor }
          : {}),
      };
    default:
      return assertNever(proposal.kind);
  }
}

function undo(
  db: Db,
  command: Extract<TaskCommand, { kind: "undo" }>,
  now: number,
  record: (loopId: string, note: string, event: Omit<TaskEvent, "surface">) => number,
): TaskCommandResult {
  const entry = db
    .prepare<
      [number],
      { loop_id: string; event_json: string | null }
    >("SELECT loop_id, event_json FROM open_loop_ledger WHERE seq = ?")
    .get(command.seq);
  if (!entry?.event_json) return fail("nothing_to_undo", "that change cannot be undone");
  const event = JSON.parse(entry.event_json) as TaskEvent;
  if (event.kind === "undone") return fail("nothing_to_undo", "an undo cannot be undone");
  const later = db
    .prepare<
      [string, number],
      { one: number }
    >("SELECT 1 AS one FROM open_loop_ledger WHERE loop_id = ? AND seq > ? AND event_json IS NOT NULL LIMIT 1")
    .get(entry.loop_id, command.seq);
  if (later) return fail("not_latest", "a later change to this task has to be undone first");
  const loop = getOpenLoop(db, entry.loop_id);
  if (!loop) return fail("not_found", "the task no longer exists");
  if (event.kind === "created") {
    deleteOpenLoop(db, loop.id, { retire: false, now });
    return {
      ok: true,
      loop: null,
      loopId: loop.id,
      eventSeq: null,
      resolved: true,
      reopened: false,
      receipt: `Removed: ${loop.title}`,
    };
  }
  const before = event.before;
  if (!before) return fail("nothing_to_undo", "that change cannot be undone");
  const wasClosed = loop.state === "done" || loop.state === "dismissed";
  const restoresOpen = before.state === "open" || before.state === "snoozed";
  updateOpenLoop(
    db,
    loop.id,
    {
      state: before.state,
      title: before.title,
      description: before.description,
      deadline: before.deadline,
      scheduledFor: before.scheduledFor,
      accepted: before.accepted,
      ignored: before.ignored ?? loop.ignored,
      completionNote: before.completionNote,
      // A proposal the Brain made after this change stands; otherwise the
      // proposal the change consumed comes back with it.
      proposedChange: loop.proposedChange ?? before.proposedChange,
    },
    now,
  );
  const seq = record(loop.id, "Undone", { kind: "undone", undoOf: command.seq });
  return done(db, loop.id, seq, false, wasClosed && restoresOpen, `Undone: ${loop.title}`);
}

function done(
  db: Db,
  loopId: string,
  eventSeq: number,
  resolved: boolean,
  reopened: boolean,
  receipt: string,
): TaskCommandResult {
  return {
    ok: true,
    loop: getOpenLoop(db, loopId),
    loopId,
    eventSeq,
    resolved,
    reopened,
    receipt,
  };
}

/**
 * Record a Brain proposal on one of the user's own tasks. The task keeps its
 * values; a newer proposal replaces an older one. Returns false when the loop
 * is gone or is not the user's.
 */
export function proposeTaskChange(
  db: Db,
  loopId: string,
  proposal: ProposedTaskChange,
  now: number,
): boolean {
  return db.transaction(() => {
    const loop = getOpenLoop(db, loopId);
    if (!loop || !isOwnedTask(loop)) return false;
    db.prepare<[string, string]>("UPDATE open_loops SET proposed_change_json = ? WHERE id = ?").run(
      JSON.stringify(proposal),
      loopId,
    );
    appendOpenLoopLedger(
      db,
      loopId,
      { runId: proposal.runId, note: `Proposed ${proposal.kind}: ${proposal.reason}` },
      now,
    );
    return true;
  })();
}

/**
 * The fields of a task the user wrote themselves, read from its events. The
 * title, description and deadline the user gave a task they created, every
 * field they edited, the state of a task they reopened, and whatever Omnesis
 * changed on its own that the user then undid. A Brain change to one of
 * these is always a proposal: the user's own word wins.
 *
 * Events recorded before the fields were tracked count as setting every
 * field. `entries` may be in any order.
 */
export function userAuthoredTaskFields(
  entries: readonly { seq: number; event: TaskEvent | null }[],
): Set<TaskAuthoredField> {
  const authored = new Set<TaskAuthoredField>();
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry.event]));
  const all: TaskAuthoredField[] = ["title", "description", "deadline"];
  for (const { event } of entries) {
    if (!event) continue;
    switch (event.kind) {
      case "created":
      case "edited":
        for (const field of event.fields ?? all) authored.add(field);
        break;
      case "reopened":
        authored.add("state");
        break;
      case "undone": {
        const reverted = event.undoOf !== undefined ? bySeq.get(event.undoOf) : undefined;
        if (reverted?.kind === "auto_applied" && reverted.change) {
          if (reverted.change.kind === "complete") authored.add("state");
          for (const field of reverted.change.fields ?? []) authored.add(field);
        }
        break;
      }
      default:
        break;
    }
  }
  return authored;
}

/**
 * What a Brain change applied on its own needs to know about a task: which
 * fields the user wrote, and its newest event, which the change is judged
 * against.
 */
export function readTaskAuthorship(
  db: Db,
  loopId: string,
): { authored: Set<TaskAuthoredField>; latestEventSeq: number | null } {
  const rows = db
    .prepare<[string], { seq: number; event_json: string }>(
      `SELECT seq, event_json FROM open_loop_ledger
        WHERE loop_id = ? AND event_json IS NOT NULL ORDER BY seq`,
    )
    .all(loopId);
  const entries = rows.map((row) => ({
    seq: row.seq,
    event: JSON.parse(row.event_json) as TaskEvent,
  }));
  return {
    authored: userAuthoredTaskFields(entries),
    latestEventSeq: entries.at(-1)?.seq ?? null,
  };
}

/** A Brain change Omnesis applies on its own to one of the user's own tasks. */
export interface AutoAppliedTaskChange {
  kind: "complete" | "edit";
  /** For `edit`: the new values. */
  fields?: { title?: string; description?: string; deadline?: unknown };
  /** Why, in one sentence, citing what changed. */
  reason: string;
  /** Documents behind the change. */
  evidence: string[];
  runId: string;
  /** The task's newest event when the change was judged; null when it had none. */
  basedOnSeq: number | null;
}

export type AutoApplyTaskResult =
  | { applied: true; seq: number; resolved: boolean }
  | { applied: false; reason: "not_found" | "not_owned" | "stale" | "invalid" };

/**
 * Apply a Brain change to one of the user's own tasks and record it
 * as an `auto_applied` event the user can undo. The change was judged
 * against the task as it stood at `basedOnSeq`: when the task has changed
 * since (the user edited, reopened or undid something meanwhile), nothing is
 * applied and the caller proposes the change instead.
 */
export function autoApplyTaskChange(
  db: Db,
  loopId: string,
  change: AutoAppliedTaskChange,
  now: number,
): AutoApplyTaskResult {
  return db.transaction((): AutoApplyTaskResult => {
    const loop = getOpenLoop(db, loopId);
    if (!loop) return { applied: false, reason: "not_found" };
    if (!isOwnedTask(loop)) return { applied: false, reason: "not_owned" };
    if (readTaskAuthorship(db, loopId).latestEventSeq !== change.basedOnSeq)
      return { applied: false, reason: "stale" };
    const before = snapshot(loop);
    const fields = change.fields ?? {};
    const changed: TaskAuthoredField[] = [];
    if (change.kind === "complete") {
      if (loop.state === "done" || loop.state === "dismissed")
        return { applied: false, reason: "invalid" };
      updateOpenLoop(db, loop.id, { state: "done", proposedChange: null }, now);
    } else {
      if (fields.title !== undefined) changed.push("title");
      if (fields.description !== undefined) changed.push("description");
      if (fields.deadline !== undefined) changed.push("deadline");
      if (changed.length === 0) return { applied: false, reason: "invalid" };
      updateOpenLoop(
        db,
        loop.id,
        {
          ...(fields.title !== undefined ? { title: fields.title } : {}),
          ...(fields.description !== undefined ? { description: fields.description } : {}),
          ...(fields.deadline !== undefined ? { deadline: fields.deadline } : {}),
        },
        now,
      );
    }
    const seq = appendOpenLoopLedger(
      db,
      loop.id,
      {
        runId: change.runId,
        note: `${autoAppliedLabel(change.kind)}: ${change.reason}`,
        event: {
          kind: "auto_applied",
          surface: "brain",
          before,
          note: change.reason,
          change: { kind: change.kind, ...(changed.length > 0 ? { fields: changed } : {}) },
          evidence: change.evidence,
        },
      },
      now,
    );
    return { applied: true, seq, resolved: change.kind === "complete" };
  })();
}

/** How a task's history names a change Omnesis applied on its own. */
export function autoAppliedLabel(kind: AutoAppliedTaskChange["kind"]): string {
  return kind === "complete" ? "Marked done by Omnesis" : "Updated by Omnesis";
}
