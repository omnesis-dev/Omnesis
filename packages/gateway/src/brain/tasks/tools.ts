// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Task tools — how an agent changes the user's tasks on the user's say-so.
 *
 * Every conversation gets them, and so does the turn that reads a Tell
 * Omnesis note. What the user says is testimony: a change applies at once,
 * through the same task commands as the Tasks view, and returns a one-line
 * receipt with the handle that undoes it.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { summaryExcerpt, type ToolHandle } from "@omnesis/agent";
import { cognitionSpendDay } from "../storage/spend.js";
import { getObservation } from "../storage/observations.js";
import { getOpenLoop } from "../storage/open-loops.js";
import {
  isTaskSchedule,
  type TaskCommand,
  type TaskCommandOrigin,
  type TaskCommandResult,
} from "../storage/tasks.js";
import { isOwnedTask } from "../storage/types.js";
import { TASK_VIEWS, TaskQueryService, type TaskItem, type TaskDocument } from "./views.js";
import type { ToolResult } from "@omnesis/core";
import type { TaskService } from "./service.js";
import type { InterestEngine } from "../interest/engine.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

export interface TaskToolDeps {
  db: Database.Database;
  /** Applies task commands, with the cascades that follow a change. */
  tasks: Pick<TaskService, "apply">;
  writeGate: Pick<WriteGate, "transitionObservation" | "setObservationUserAction">;
  origin: TaskCommandOrigin;
  clock?: () => number;
  idGen?: () => string;
  /** Offer `observation_suppress` (the Morning brief is running). */
  observations?: boolean;
  /**
   * Offer `interest_record`: what the user says here about their interests
   * is feedback on the brief. Only the Morning brief conversation passes it.
   */
  interest?: Pick<InterestEngine, "record">;
}

const schedule = z
  .string()
  .refine(isTaskSchedule, "must be YYYY-MM-DD, YYYY-MM or someday")
  .describe("When the user plans to do it: a day YYYY-MM-DD, a month YYYY-MM, or someday.");
const docs = z
  .array(z.string().min(1))
  .max(100)
  .describe(
    "Relevant document ids found with the read tools. On edit, replaces the linked documents: preserve existing links unless the user asks to remove them; [] clears them.",
  );
const deadline = z
  .object({
    type: z.enum(["any_time", "by", "approximate", "on_day"]),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .describe("A real due date the task must meet, separate from when the user plans to do it.");

function invalid(message: string): ToolResult {
  return { kind: "error", code: "invalid_args", message };
}

function compact(item: TaskItem, documents: ReadonlyMap<string, TaskDocument>) {
  const loop = item.row;
  return {
    id: loop.id,
    title: loop.title,
    ...(loop.description ? { description: loop.description } : {}),
    ...(loop.deadline ? { deadline: loop.deadline } : {}),
    state: loop.state,
    yours: isOwnedTask(loop),
    documents: loop.docs.flatMap((id) => {
      const document = documents.get(id);
      return document ? [document] : [];
    }),
    ...(loop.scheduledFor ? { scheduledFor: loop.scheduledFor } : {}),
    ...(item.dueDay ? { due: item.dueDay } : {}),
    ...(item.carried ? { carried: true } : {}),
    ...(loop.completionNote ? { completionNote: loop.completionNote } : {}),
    ...(loop.proposedChange
      ? {
          proposedChange: {
            kind: loop.proposedChange.kind,
            reason: loop.proposedChange.reason,
            ...(loop.proposedChange.fields ? { fields: loop.proposedChange.fields } : {}),
          },
        }
      : {}),
  };
}

function receipt(result: TaskCommandResult): ToolResult {
  if (!result.ok) return { kind: "error", code: result.reason, message: result.message };
  return {
    kind: "structured",
    resultType: "task.changed",
    data: {
      receipt: result.receipt,
      ...(result.eventSeq !== null ? { undoSeq: result.eventSeq } : {}),
      task: result.loop
        ? {
            id: result.loop.id,
            title: result.loop.title,
            state: result.loop.state,
            scheduledFor: result.loop.scheduledFor,
            deadline: result.loop.deadline,
          }
        : null,
    },
  };
}

export function buildTaskTools(deps: TaskToolDeps): ToolHandle[] {
  const clock = deps.clock ?? Date.now;
  const idGen = deps.idGen ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
  const tasks = new TaskQueryService(deps.db);
  const apply = async (command: TaskCommand) => receipt(await deps.tasks.apply(command));

  const listSchema = z
    .object({
      view: z
        .enum(TASK_VIEWS)
        .optional()
        .describe(
          "today (planned for today, carried over, or due), month, future (later or someday), anytime (unscheduled), waiting (on someone else), done, suggested (the Brain's suggestions the user has not accepted). Default today.",
        ),
      query: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Case-insensitive literal substring of title or description, not semantic search. Searches today, month, future, anytime and suggested together; view is ignored when query is present. Omit query to inspect waiting or done.",
        ),
    })
    .strict();
  const taskList: ToolHandle = {
    name: "task_list",
    description:
      "List the user's tasks, or find one by a short case-insensitive literal substring. query searches today, month, future, anytime and suggested together; view is ignored when query is present. Omit query to inspect a specific view, such as waiting or done. Read before changing a task so you use its id.",
    schema: listSchema,
    summarize: (args) => {
      const a = (args ?? {}) as { query?: unknown; view?: unknown };
      return typeof a.query === "string" ? a.query : typeof a.view === "string" ? a.view : "";
    },
    async invoke(raw): Promise<ToolResult> {
      const parsed = listSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      const day = cognitionSpendDay(clock());
      let items: TaskItem[];
      if (parsed.data.query) {
        const needle = parsed.data.query.toLowerCase();
        items = (["today", "month", "future", "anytime", "suggested"] as const)
          .flatMap((view) => tasks.view(view as (typeof TASK_VIEWS)[number], day).tasks)
          .filter(
            (item, index, all) => all.findIndex((other) => other.row.id === item.row.id) === index,
          )
          .filter((item) =>
            `${item.row.title} ${item.row.description}`.toLowerCase().includes(needle),
          );
      } else {
        items = tasks.view((parsed.data.view ?? "today") as (typeof TASK_VIEWS)[number], day).tasks;
      }
      const visible = items.slice(0, 60);
      const documents = tasks.documents(visible);
      return {
        kind: "structured",
        resultType: "task.list",
        data: {
          today: day,
          tasks: visible.map((item) => compact(item, documents)),
          truncated: items.length > 60,
        },
      };
    },
  };

  const createSchema = z
    .object({
      title: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("The task, as the user would write it in their journal."),
      description: z.string().max(2000).optional(),
      scheduledFor: schedule.optional(),
      deadline: deadline.optional(),
      docs: docs.optional(),
    })
    .strict();
  const taskCreate: ToolHandle = {
    name: "task_create",
    description:
      "Add a task to the user's tasks because they asked for it. Check task_list first so you never add a task that already exists. Search for relevant documents and link their ids with docs when useful.",
    schema: createSchema,
    mutates: true,
    summarize: (args) => {
      const title = (args as { title?: unknown } | null)?.title;
      return typeof title === "string" ? title : "";
    },
    async invoke(raw): Promise<ToolResult> {
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      return apply({
        ...deps.origin,
        kind: "create",
        id: `loop_${idGen()}`,
        origin: deps.origin.surface === "note" ? "note" : "user",
        title: parsed.data.title,
        ...(parsed.data.docs !== undefined ? { docs: parsed.data.docs } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.scheduledFor !== undefined
          ? { scheduledFor: parsed.data.scheduledFor }
          : {}),
        ...(parsed.data.deadline !== undefined ? { deadline: parsed.data.deadline } : {}),
      });
    },
  };

  const actions = [
    "complete",
    "migrate",
    "strike",
    "edit",
    "accept",
    "ignore",
    "confirm",
    "keep",
    "reopen",
    "delete",
  ] as const;
  const actionFields: Record<(typeof actions)[number], readonly string[]> = {
    complete: ["note"],
    migrate: ["to"],
    strike: ["reason"],
    edit: ["title", "description", "scheduledFor", "deadline", "docs"],
    accept: ["scheduledFor"],
    ignore: ["reason"],
    confirm: [],
    keep: [],
    reopen: [],
    delete: [],
  };
  const updateSchema = z
    .object({
      id: z.string().min(1),
      action: z
        .enum(actions)
        .describe(
          "complete (done; optional note on how), migrate (move to `to`), strike (not worth doing; optional reason), edit (change title, description, scheduledFor, deadline or linked docs), " +
            "accept / ignore (a Brain suggestion; ignore only takes it out of the user's tasks, the Brain keeps tracking it), " +
            "confirm / keep (accept or refuse the Brain's proposed change), reopen, delete (permanently removes the task and its history; cannot be undone; only for a task that should never have existed).",
        ),
      note: z.string().max(500).optional(),
      reason: z.string().max(500).optional(),
      to: schedule.optional(),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      scheduledFor: schedule.nullable().optional(),
      deadline: deadline.nullable().optional(),
      docs: docs.optional(),
    })
    .strict();
  const taskUpdate: ToolHandle = {
    name: "task_update",
    description:
      "Change one of the user's tasks because they said so. Use only the fields defined for the selected action; deadline and docs belong to edit. Use strike for an undoable cancellation. Delete is permanent: never recreate a deleted task as an undo; explain that deletion cannot be undone. The change applies at once; tell the user what changed in one short line, which they can undo.",
    schema: updateSchema,
    mutates: true,
    summarize: (args) => {
      const a = (args ?? {}) as { id?: unknown; title?: unknown };
      if (typeof a.title === "string" && a.title) return a.title;
      return typeof a.id === "string" ? (getOpenLoop(deps.db, a.id)?.title ?? "") : "";
    },
    async invoke(raw): Promise<ToolResult> {
      const parsed = updateSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      const { id, action, note, reason, to } = parsed.data;
      const unused = Object.keys(parsed.data).filter(
        (key) => key !== "id" && key !== "action" && !actionFields[action].includes(key),
      );
      if (unused.length > 0)
        return invalid(
          `${action} does not accept ${unused.join(", ")}. Use edit for title, description, scheduledFor, deadline or docs; issue separate actions for other changes. Nothing was changed.`,
        );
      const base = { ...deps.origin, id };
      switch (action) {
        case "complete":
          return apply({ ...base, kind: "complete", ...(note ? { note } : {}) });
        case "migrate":
          if (!to) return invalid("migrate needs `to`");
          return apply({ ...base, kind: "migrate", to });
        case "strike":
          return apply({ ...base, kind: "strike", ...(reason ? { reason } : {}) });
        case "edit":
          return apply({
            ...base,
            kind: "edit",
            fields: {
              ...(parsed.data.docs !== undefined ? { docs: parsed.data.docs } : {}),
              ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
              ...(parsed.data.description !== undefined
                ? { description: parsed.data.description }
                : {}),
              ...(parsed.data.scheduledFor !== undefined
                ? { scheduledFor: parsed.data.scheduledFor }
                : {}),
              ...(parsed.data.deadline !== undefined ? { deadline: parsed.data.deadline } : {}),
            },
          });
        case "accept":
          return apply({
            ...base,
            kind: "accept",
            ...(parsed.data.scheduledFor !== undefined
              ? { scheduledFor: parsed.data.scheduledFor }
              : {}),
          });
        case "ignore":
          return apply({ ...base, kind: "ignore", ...(reason ? { reason } : {}) });
        case "confirm":
          return apply({ ...base, kind: "confirm_proposal" });
        case "keep":
          return apply({ ...base, kind: "keep" });
        case "reopen":
          return apply({ ...base, kind: "reopen" });
        case "delete":
          return apply({ ...base, kind: "delete" });
        default:
          return invalid(`unknown action ${action}`);
      }
    },
  };

  const undoSchema = z.object({ undoSeq: z.number().int().positive() }).strict();
  const taskUndo: ToolHandle = {
    name: "task_undo",
    description:
      "Undo a task change you made in this conversation, by the undoSeq its receipt returned.",
    schema: undoSchema,
    mutates: true,
    summarize: () => "",
    async invoke(raw): Promise<ToolResult> {
      const parsed = undoSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      // Only a change this conversation (or this note) made can be undone
      // here; anything else is the user's to undo in the Tasks view.
      const entry = deps.db
        .prepare<[number], { run_id: string }>("SELECT run_id FROM open_loop_ledger WHERE seq = ?")
        .get(parsed.data.undoSeq);
      if (!entry || entry.run_id !== deps.origin.runId)
        return {
          kind: "error",
          code: "not_yours",
          message: "You can only undo a change you made in this conversation.",
        };
      return apply({ ...deps.origin, kind: "undo", seq: parsed.data.undoSeq });
    },
  };

  const tools = [taskList, taskCreate, taskUpdate, taskUndo];
  if (deps.observations) tools.push(buildObservationSuppress(deps, clock));
  if (deps.interest) tools.push(buildInterestRecord(deps.interest, deps.origin));
  return tools;
}

function buildObservationSuppress(deps: TaskToolDeps, clock: () => number): ToolHandle {
  const suppressSchema = z
    .object({
      id: z.string().min(1).describe("Observation id, as listed in the morning brief context."),
      reason: z.string().min(1).max(300).describe("What the user said, in a sentence."),
    })
    .strict();
  const observationSuppress: ToolHandle = {
    name: "observation_suppress",
    description:
      "The user does not want to hear about a morning brief item: stop it from appearing again. To keep similar items out of future briefs, also record the preference on the user's self memory.",
    schema: suppressSchema,
    mutates: true,
    summarize: (args) => {
      const id = (args as { id?: unknown } | null)?.id;
      return typeof id === "string"
        ? summaryExcerpt(getObservation(deps.db, id)?.summary ?? "")
        : "";
    },
    async invoke(raw): Promise<ToolResult> {
      const parsed = suppressSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      const observation = getObservation(deps.db, parsed.data.id);
      if (!observation)
        return { kind: "error", code: "not_found", message: `no observation ${parsed.data.id}` };
      const now = clock();
      // One write either way: an observation still waiting is dropped with the
      // user's action on it; one already shown keeps its state and gains it.
      if (observation.state === "live" || observation.state === "held")
        await deps.writeGate.transitionObservation(
          observation.id,
          { state: "dropped", reason: "suppressed", userAction: "suppressed" },
          now,
        );
      else await deps.writeGate.setObservationUserAction(observation.id, "suppressed", now);
      return {
        kind: "structured",
        resultType: "observation.suppressed",
        data: { id: observation.id, receipt: `Won't mention again: ${observation.summary}` },
      };
    },
  };
  return observationSuppress;
}

function buildInterestRecord(
  interest: Pick<InterestEngine, "record">,
  origin: TaskCommandOrigin,
): ToolHandle {
  const recordSchema = z
    .object({
      direction: z
        .enum(["more", "less"])
        .describe(
          "less: the user does not care about this kind of thing; more: they want more of it.",
        ),
      about: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe("The kind of thing, in the user's own terms."),
      quote: z.string().trim().min(1).max(500).optional().describe("The user's words."),
      observationId: z
        .string()
        .min(1)
        .optional()
        .describe("The brief item the user was talking about, when it was one."),
    })
    .strict();
  return {
    name: "interest_record",
    description:
      "Record what the user said they care about, or do not, so future briefs and task suggestions follow it. `about` names the kind of thing in the user's own terms; `quote` is their words. Use `less` when they say they are not interested in a kind of item, `more` when they ask for more of something. Only for what the user says in this conversation about their interests; not for facts about the world.",
    schema: recordSchema,
    mutates: true,
    summarize: (args) => {
      const about = (args as { about?: unknown } | null)?.about;
      return typeof about === "string" ? about : "";
    },
    async invoke(raw): Promise<ToolResult> {
      const parsed = recordSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid arguments");
      const { direction, about, quote, observationId } = parsed.data;
      const signal = await interest.record({
        polarity: direction === "more" ? 1 : -1,
        kind: "statement",
        source: "statement",
        subjectText: about,
        note: quote ?? null,
        ...(origin.conversationId !== undefined ? { conversationId: origin.conversationId } : {}),
        ...(observationId !== undefined ? { observationId } : {}),
      });
      if (!signal)
        return {
          kind: "structured",
          resultType: "interest.recorded",
          data: {
            recorded: false,
            direction,
            about,
            message: "The interest ledger is off on this gateway; nothing was recorded.",
          },
        };
      return {
        kind: "structured",
        resultType: "interest.recorded",
        data: { id: signal.id, direction, about },
      };
    },
  };
}
