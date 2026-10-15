// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `/tasks*` — the Tasks view's HTTP surface: the journal views, one task with
 * its history, and the user's task commands (create, complete, move, strike,
 * edit, accept or ignore a suggestion, confirm or keep a proposed change,
 * reopen, delete, undo).
 *
 * Tasks are available on every install: a user can keep their own tasks with
 * no model assigned. Suggestions and proposals only appear when the Brain
 * runs.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertNever } from "@omnesis/core";
import { scope } from "../../http/scope.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../http/errors.js";
import { validateJson } from "../../http/validate.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { isTaskSchedule, type TaskCommand, type TaskCommandResult } from "../storage/tasks.js";
import { TASK_VIEWS, type TaskDocument, type TaskItem, type TaskView } from "./views.js";
import { TaskService, type TaskEffects } from "./service.js";
import type { OpenLoopLedgerEntry } from "../storage/types.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/wiring.js";
import type { RouteApp } from "../../http/routes/types.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * One task as the clients read it. `documents` are the documents it refers
 * to, in the task's order, from one lookup per response (see
 * {@link TaskService.documents}); a reference whose document is gone or
 * hidden is left out.
 */
export function taskDto(item: TaskItem, documents: ReadonlyMap<string, TaskDocument>) {
  const loop = item.row;
  return {
    id: loop.id,
    title: loop.title,
    description: loop.description,
    state: loop.state,
    origin: loop.origin,
    accepted: loop.accepted,
    ignored: loop.ignored,
    scheduledFor: loop.scheduledFor,
    deadline: loop.deadline,
    dueDay: item.dueDay,
    carried: item.carried,
    completionNote: loop.completionNote,
    proposedChange: loop.proposedChange
      ? {
          kind: loop.proposedChange.kind,
          fields: loop.proposedChange.fields ?? null,
          reason: loop.proposedChange.reason,
          evidence: loop.proposedChange.evidence,
          proposedAt: iso(loop.proposedChange.proposedAt),
        }
      : null,
    actors: item.actors,
    blockedBy: item.blockedBy,
    documents: loop.docs.flatMap((id) => {
      const document = documents.get(id);
      return document ? [document] : [];
    }),
    createdAt: iso(loop.createdAt),
    lastUpdate: iso(loop.lastUpdate),
    resolvedAt: iso(loop.resolvedAt),
  };
}

export function taskEventDto(entry: OpenLoopLedgerEntry) {
  return {
    seq: entry.seq,
    at: iso(entry.at),
    note: entry.note,
    kind: entry.event?.kind ?? "note",
    surface: entry.event?.surface ?? (entry.runId.startsWith("user:") ? "tasks" : "brain"),
    conversationId: entry.event?.conversationId ?? null,
    from: entry.event?.from ?? null,
    to: entry.event?.to ?? null,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const schedule = z
  .string()
  .refine(isTaskSchedule, "must be YYYY-MM-DD, YYYY-MM or someday")
  .nullable();
const deadline = z
  .object({
    type: z.enum(["any_time", "by", "approximate", "on_day"]),
    date: z.string().regex(DAY_RE).optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .nullable();

const createBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    scheduledFor: schedule.optional(),
    deadline: deadline.optional(),
  })
  .strict();

const actionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), note: z.string().max(500).optional() }).strict(),
  z
    .object({
      action: z.literal("migrate"),
      to: z.string().refine(isTaskSchedule, "must be YYYY-MM-DD, YYYY-MM or someday"),
    })
    .strict(),
  z.object({ action: z.literal("strike"), reason: z.string().max(500).optional() }).strict(),
  z
    .object({
      action: z.literal("edit"),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      scheduledFor: schedule.optional(),
      deadline: deadline.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("accept"),
      scheduledFor: schedule.optional(),
      // What the user adds about the task, saved as a Tell Omnesis note the
      // note agent applies to it; `noteId` makes a retry a replay.
      note: z
        .string()
        .max(8000)
        .refine((s) => s.trim().length > 0, "must not be blank")
        .optional(),
      noteId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ action: z.literal("ignore"), reason: z.string().max(500).optional() }).strict(),
  // The name older app builds send for ignoring a suggestion.
  z.object({ action: z.literal("refuse"), reason: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("confirm") }).strict(),
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("reopen") }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
]);

const undoBody = z.object({ seq: z.number().int().positive() }).strict();

export interface MountTaskRoutesOpts {
  db: Database.Database;
  writeGate: WriteGate;
  clock?: (() => number) | undefined;
  idGen?: () => string;
  /** The cascades that follow a task change; see {@link TaskEffects}. */
  effects?: TaskEffects | undefined;
  /** Tell Omnesis capture, for a suggestion accepted with a note. */
  notes?: () => Pick<OmnesisNotesRuntime, "capture">;
}

/** A Done-view cursor: `<resolvedAt ms>:<task id>`. */
function parseDoneCursor(raw: string | undefined): { resolvedAt: number; id: string } | null {
  if (raw === undefined) return null;
  const match = /^(\d+):(.+)$/.exec(raw);
  if (!match) throw new BadRequestError("before must be a cursor returned as nextBefore");
  return { resolvedAt: Number(match[1]), id: match[2]! };
}

const ORIGIN = { surface: "tasks", runId: "user:tasks" } as const;

export function mountTaskRoutes(app: RouteApp, opts: MountTaskRoutesOpts): void {
  const tasks = new TaskService(
    opts.db,
    opts.writeGate,
    opts.clock ?? Date.now,
    opts.effects,
    opts.notes,
  );
  const idGen = opts.idGen ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));

  // Every read reflects the journal as it is now; a cached answer would show a
  // task in the state it was in before its last change.
  for (const path of ["/tasks", "/tasks/*"])
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });

  const respond = (result: TaskCommandResult) => {
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundError(result.message);
      if (result.reason === "invalid") throw new BadRequestError(result.message);
      throw new ConflictError(result.message);
    }
    const item = result.loop ? tasks.get(result.loop.id) : null;
    return {
      task: item ? taskDto(item, tasks.documents([item])) : null,
      receipt: { text: result.receipt, undoSeq: result.eventSeq },
    };
  };

  app.get("/tasks", scope.admin(), (c) => {
    const view = (c.req.query("view") ?? "today") as TaskView;
    if (!TASK_VIEWS.includes(view))
      throw new BadRequestError(`view must be one of ${TASK_VIEWS.join(", ")}`);
    const day = c.req.query("date") ?? cognitionSpendDay(tasks.now());
    if (!DAY_RE.test(day)) throw new BadRequestError("date must be YYYY-MM-DD");
    const before = parseDoneCursor(c.req.query("before"));
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const result = tasks.view(view, day, { limit, ...(before ? { before } : {}) });
    const last = result.tasks.at(-1)?.row;
    const documents = tasks.documents(result.tasks);
    return c.json({
      view: result.view,
      day: result.day,
      tasks: result.tasks.map((item) => taskDto(item, documents)),
      counts: result.counts,
      // Done pages back through history: pass this as `before` for the next page.
      ...(view === "done" && result.tasks.length === limit && last?.resolvedAt
        ? { nextBefore: `${last.resolvedAt}:${last.id}` }
        : {}),
    });
  });

  // The journal's counts alone, for a badge that must not load a whole view.
  app.get("/tasks/counts", scope.admin(), (c) => {
    const day = c.req.query("date") ?? cognitionSpendDay(tasks.now());
    if (!DAY_RE.test(day)) throw new BadRequestError("date must be YYYY-MM-DD");
    return c.json({ day, counts: tasks.counts(day) });
  });

  app.get("/tasks/:id", scope.admin(), (c) => {
    const item = tasks.get(c.req.param("id"));
    if (!item) throw new NotFoundError("Task not found");
    const history = tasks.history(item.row.id);
    return c.json({
      task: taskDto(item, tasks.documents([item])),
      history: history.events.map(taskEventDto),
      undoSeq: history.undoSeq,
    });
  });

  app.post("/tasks", scope.admin(), validateJson(createBody), async (c) => {
    const body = c.req.valid("json") as z.infer<typeof createBody>;
    const result = await tasks.apply({
      ...ORIGIN,
      kind: "create",
      id: `loop_${idGen()}`,
      origin: "user",
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
      ...(body.deadline !== undefined ? { deadline: body.deadline } : {}),
    });
    return c.json(respond(result), 201);
  });

  app.post("/tasks/undo", scope.admin(), validateJson(undoBody), async (c) => {
    const body = c.req.valid("json") as z.infer<typeof undoBody>;
    return c.json(respond(await tasks.apply({ ...ORIGIN, kind: "undo", seq: body.seq })));
  });

  app.post("/tasks/:id/actions", scope.admin(), validateJson(actionBody), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json") as z.infer<typeof actionBody>;
    if (body.action === "accept" && body.note !== undefined) {
      const result = await tasks.acceptWithNote({
        ...ORIGIN,
        id,
        note: body.note,
        noteId: body.noteId ?? randomUUID(),
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
      });
      return c.json({
        ...respond(result),
        ...(result.ok && result.noteId ? { noteId: result.noteId } : {}),
      });
    }
    return c.json(respond(await tasks.apply(taskCommandFor(id, body))));
  });
}

function taskCommandFor(id: string, body: z.infer<typeof actionBody>): TaskCommand {
  switch (body.action) {
    case "complete":
      return { ...ORIGIN, kind: "complete", id, ...(body.note ? { note: body.note } : {}) };
    case "migrate":
      return { ...ORIGIN, kind: "migrate", id, to: body.to };
    case "strike":
      return { ...ORIGIN, kind: "strike", id, ...(body.reason ? { reason: body.reason } : {}) };
    case "edit": {
      const { action: _action, ...fields } = body;
      return { ...ORIGIN, kind: "edit", id, fields };
    }
    case "accept":
      return {
        ...ORIGIN,
        kind: "accept",
        id,
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
      };
    case "ignore":
    case "refuse":
      return { ...ORIGIN, kind: "ignore", id, ...(body.reason ? { reason: body.reason } : {}) };
    case "confirm":
      return { ...ORIGIN, kind: "confirm_proposal", id };
    case "keep":
      return { ...ORIGIN, kind: "keep", id };
    case "reopen":
      return { ...ORIGIN, kind: "reopen", id };
    case "delete":
      return { ...ORIGIN, kind: "delete", id };
    default:
      return assertNever(body);
  }
}
