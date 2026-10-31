// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: the note agent.
 *
 * Every quick-capture note is the user speaking. Once it settles (and a
 * voice note's transcript is in), one bounded `agent` turn acts
 * on it: a task the note asks for is added (already scheduled when the note
 * says when), a task it reports done is completed, one it puts off is moved,
 * one the user gave up on is struck, and the receipt the user reads appears
 * under the note. Explicit requests can also accept or ignore the Brain's
 * suggestions; unrelated suggestions stay unchanged.
 *
 * The note agent is not part of the experimental Brain: it runs on any
 * install with a runnable Agent model, so this suite boots a
 * STABLE gateway. The model is the bench puppet, matched on the note text
 * (the turn has no cognition envelope; `readRunContext` reads its note
 * block). A second, model-less gateway proves the agent stays idle.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { describeSchedule } from "../../../gateway/src/brain/storage/tasks.js";
import { createOpenLoop } from "../../../gateway/src/brain/storage/open-loops.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  ref,
  waitFor,
  type ListedNoteDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

const CAPTURE_ZONE = { capturedTimeZoneId: "UTC", capturedUtcOffsetSeconds: 0 } as const;
/** The UTC day of `at`: the capture day the gateway reads from a note captured then. */
const isoDay = (at: Date) => at.toISOString().slice(0, 10);

/** The month after `day`'s, as `YYYY-MM`: what "next month" means on that capture day. */
function monthAfter(day: string): string {
  const [year, month] = day.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The first Friday after `day`: what "Friday" means on that capture day. */
function fridayAfter(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() !== 5);
  return date.toISOString().slice(0, 10);
}

/** The UTC day after a note's capture day. */
function dayAfter(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return isoDay(date);
}

const TASK_NOTE = "Remind me to book the piano tuner next week.";
const DONE_NOTE = "Paid the plumber this morning.";
const SUGGESTION_NOTE =
  "Accept the planetarium workshop suggestion for tomorrow, and ignore the seed library membership suggestion because I handled it elsewhere.";
const PARKED_NOTE = "Call the optician about the new lenses.";
const CONTROL_NOTE = "Buy birthday candles for Saturday.";
const VOICE_DEVICE = "book a table at the harbour restaurant for fry day";
const VOICE_SPOKEN = "Book a table at the harbour restaurant for Friday.";
const MIGRATE_NOTE =
  "I have to renew the car insurance, but not this week — move it to next month.";
const SCHEDULED_CREATE_NOTE = "I have to service the boiler, but not this week — do it next month.";
const STRIKE_NOTE = "I've decided I won't repaint the fence.";
const RESCHEDULE_NOTE = "Push the quarterly report to Friday.";
const COUNTED_NOTE = "Watered the window boxes.";
const SWITCHED_OFF_NOTE = "Remind me to collect the dry cleaning.";
const GREENHOUSE_NOTE =
  "Add a task to plan the community greenhouse, and attach the supplies guide.";
const GREENHOUSE_QUOTE_NOTE =
  "Attach the delivery quote to my task to plan the community greenhouse too.";
const GREENHOUSE_TITLE = "Plan the community greenhouse";
const GUIDE_TITLE = "Community greenhouse supplies guide";
const QUOTE_TITLE = "Community greenhouse delivery quote";
const DOCUMENT_SOURCE = "synthetic:test@example.com";

const PLUMBER_TITLE = "Pay the plumber";
const INSURANCE_TITLE = "Renew the car insurance";
const BOILER_TITLE = "Service the boiler";
const FENCE_TITLE = "Repaint the fence";
const FENCE_REASON = "Decided not to repaint it.";
const REPORT_TITLE = "Send the quarterly report";
const WINDOW_BOXES_TITLE = "Water the window boxes";
const ACCEPT_SUGGESTION_ID = "loop_note_agent_accept_suggestion";
const IGNORE_SUGGESTION_ID = "loop_note_agent_ignore_suggestion";
const UNTOUCHED_SUGGESTION_ID = "loop_note_agent_untouched_suggestion";
const ACCEPT_SUGGESTION_TITLE = "Reserve the planetarium workshop";
const IGNORE_SUGGESTION_TITLE = "Renew the seed library membership";

/** Wait out the turn: a note's receipt appears once its agent row is done. */
async function receiptFor(
  read: (day: string) => Promise<ListedNoteDto[]>,
  id: string,
  day: string,
): Promise<NonNullable<ListedNoteDto["agent"]>> {
  return waitFor(
    `the note agent's receipt for ${id}`,
    async () => {
      const note = (await read(day)).find((n) => n.id === id);
      return note?.agent?.state === "done" ? note.agent : null;
    },
    90_000,
  );
}

describe("the note agent (stable install, Agent puppet, no Brain model)", () => {
  let bench: BrainBench;
  // A note's capture day comes from its `capturedAt`, so a run that crosses
  // midnight UTC compares against the day each note was captured on.
  const captureDays = new Map<string, string>();
  const capture = async (text: string, at = new Date()): Promise<string> => {
    const id = randomUUID();
    const res = await bench.harness.gatewayFetch("/notes", {
      method: "POST",
      body: JSON.stringify({ id, text, capturedAt: at.toISOString(), ...CAPTURE_ZONE }),
    });
    expect(res.status).toBe(201);
    captureDays.set(id, isoDay(at));
    return id;
  };
  const dayOf = (id: string) => captureDays.get(id)!;
  const tellNotes = (day: string) => bench.obs.tellNotes(day);
  const noteCalls = () => bench.puppetCalls.filter((c) => c.flavour === "note");

  // The puppet resolves "next month" and "Friday" from the capture day, as the
  // note agent's prompt tells the model to, once when the bench starts; the
  // tests expect exactly those days, however long the suite runs.
  let nextMonth: string;
  let friday: string;
  beforeAll(async () => {
    nextMonth = monthAfter(isoDay(new Date()));
    friday = fridayAfter(isoDay(new Date()));
    bench = await BrainBench.start({
      experimental: false,
      agent: "puppet",
      brainAgent: false,
      syncSources: false,
      embedder: true,
      extraInference: { assignments: { transcriber: "replay" } },
      behaviors: {
        behaviors: [
          {
            flavour: "note",
            promptContains: TASK_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "piano tuner" }),
                call("task_create", { title: "Book the piano tuner" }),
              ],
              finalText: "Added a task to book the piano tuner.",
            },
          },
          {
            flavour: "note",
            promptContains: GREENHOUSE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "community greenhouse" }),
                call("search_many", {
                  queries: [{ query: GUIDE_TITLE, filters: { sourceIds: [DOCUMENT_SOURCE] } }],
                }),
                call("fetch_many", {
                  documents: [{ documentId: ref("search_many", "items.0.results.0.documentId") }],
                }),
                call("task_create", {
                  title: GREENHOUSE_TITLE,
                  docs: [ref("fetch_many", "items.0.document.id")],
                }),
              ],
              finalText: "Added the greenhouse task with its supplies guide.",
            },
          },
          {
            flavour: "note",
            promptContains: GREENHOUSE_QUOTE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "community greenhouse" }),
                call("search_many", {
                  queries: [{ query: QUOTE_TITLE, filters: { sourceIds: [DOCUMENT_SOURCE] } }],
                }),
                call("fetch_many", {
                  documents: [{ documentId: ref("search_many", "items.0.results.0.documentId") }],
                }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "edit",
                  docs: [
                    ref("task_list", "tasks.0.documents.0.id"),
                    ref("fetch_many", "items.0.document.id"),
                  ],
                }),
              ],
              finalText: "Attached the delivery quote and kept the supplies guide.",
            },
          },
          {
            flavour: "note",
            promptContains: DONE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "plumber" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "complete",
                  note: "Paid this morning.",
                }),
              ],
              finalText: "Marked paying the plumber as done.",
            },
          },
          {
            flavour: "note",
            promptContains: SUGGESTION_NOTE,
            plan: (context) => ({
              calls: [
                call("task_list", { view: "suggested" }),
                call("task_list", { query: "planetarium workshop" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id", 1),
                  action: "accept",
                  scheduledFor: dayAfter(context.detail!),
                }),
                call("task_list", { query: "seed library membership" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id", 2),
                  action: "ignore",
                  reason: "Handled elsewhere.",
                }),
              ],
              finalText:
                "Added the planetarium workshop for tomorrow and ignored the seed library suggestion.",
            }),
          },
          {
            flavour: "note",
            promptContains: "harbour restaurant",
            plan: {
              calls: [call("task_create", { title: "Book a table at the harbour restaurant" })],
              finalText: "Added a task to book the table.",
            },
          },
          {
            flavour: "note",
            promptContains: PARKED_NOTE,
            plan: {
              calls: [call("task_create", { title: "Call the optician" })],
              finalText: "Added a task to call the optician.",
            },
          },
          {
            flavour: "note",
            promptContains: MIGRATE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "car insurance" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "migrate",
                  to: nextMonth,
                }),
              ],
              finalText: "Moved renewing the car insurance to next month.",
            },
          },
          {
            flavour: "note",
            promptContains: SCHEDULED_CREATE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "boiler" }),
                call("task_create", { title: BOILER_TITLE, scheduledFor: nextMonth }),
              ],
              finalText: "Added servicing the boiler for next month.",
            },
          },
          {
            flavour: "note",
            promptContains: STRIKE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "fence" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "strike",
                  reason: FENCE_REASON,
                }),
              ],
              finalText: "Struck repainting the fence.",
            },
          },
          {
            flavour: "note",
            promptContains: RESCHEDULE_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "quarterly report" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "edit",
                  scheduledFor: friday,
                }),
              ],
              finalText: "Moved the quarterly report to Friday.",
            },
          },
          {
            flavour: "note",
            promptContains: COUNTED_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "window boxes" }),
                call("task_update", { id: ref("task_list", "tasks.0.id"), action: "complete" }),
              ],
              finalText: "Marked watering the window boxes as done.",
            },
          },
          {
            flavour: "note",
            promptContains: CONTROL_NOTE,
            plan: {
              calls: [call("task_create", { title: "Buy birthday candles" })],
              finalText: "Added a task to buy candles.",
            },
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the gateway is stable, and tasks report an active note agent", async () => {
    const status = await bench.obs.status();
    expect(status.experimental).toBe(false);
    expect(status.tasks).toEqual({ available: true, noteAgent: true });
  }, 60_000);

  test("a note asking for a task adds it, with the receipt under the note", async () => {
    const status = await bench.harness.gatewayJson<{
      experimental: boolean;
      brain: { active: boolean; modelAssigned: boolean };
      noteAgent: { active: boolean };
    }>("/status");
    expect(status.experimental).toBe(false);
    expect(status.brain).toMatchObject({ active: false, modelAssigned: false });
    expect(status.noteAgent.active).toBe(true);
    const id = await capture(TASK_NOTE);
    const agent = await receiptFor(tellNotes, id, dayOf(id));
    expect(agent.receipt).toMatchObject({
      text: "Added a task to book the piano tuner.",
      changes: [{ text: "Added: Book the piano tuner", taskId: expect.any(String) }],
    });
    const taskId = agent.receipt!.changes[0]!.taskId!;
    const detail = await bench.obs.task(taskId);
    expect(detail.task).toMatchObject({
      title: "Book the piano tuner",
      origin: "note",
      state: "open",
    });
    expect(detail.history[0]).toMatchObject({ kind: "created", surface: "note" });

    // The turn was handed the note itself, with its capture day.
    const turn = noteCalls().find((c) => c.prompt.includes(TASK_NOTE))!;
    expect(turn.kind).toBe("note");
    expect(turn.subject).toBe(TASK_NOTE);
    expect(turn.detail).toBe(dayOf(id));

    // The history feed carries the same receipt.
    const history = await bench.harness.gatewayJson<{ entries: ListedNoteDto[] }>("/notes/history");
    expect(history.entries.find((n) => n.id === id)?.agent?.receipt?.text).toBe(
      "Added a task to book the piano tuner.",
    );

    // Each change is undoable through the receipt's handle.
    const undo = await bench.obs.undoTask(agent.receipt!.changes[0]!.undoSeq!);
    expect(undo.status).toBe(200);
    expect((await bench.harness.gatewayFetch(`/tasks/${taskId}`)).status).toBe(404);
  }, 180_000);

  test("notes search and attach documents to new and existing tasks without the Brain", async () => {
    await bench.pushAll([
      {
        externalId: "note-greenhouse-supplies",
        title: GUIDE_TITLE,
        content: "The community greenhouse supplies guide lists seed trays and a watering can.",
      },
      {
        externalId: "note-greenhouse-delivery",
        title: QUOTE_TITLE,
        content: "The community greenhouse delivery quote covers transport of seed trays.",
      },
    ]);
    const guideId = await bench.docId("note-greenhouse-supplies");
    const quoteId = await bench.docId("note-greenhouse-delivery");
    await waitFor(
      "the greenhouse documents to be searchable",
      async () => {
        await bench.harness.gatewayJson("/admin/index/reindex-missing", { method: "POST" });
        await bench.harness.refreshSearchSnapshot();
        const response = await bench.harness.gatewayJson<{
          results: Array<{ documentId: string }>;
        }>("/search", {
          method: "POST",
          body: JSON.stringify({
            text: "community greenhouse",
            filters: { sourceIds: [DOCUMENT_SOURCE] },
          }),
        });
        const ids = response.results.map((document) => document.documentId);
        return ids.includes(guideId) && ids.includes(quoteId) ? true : null;
      },
      60_000,
    );

    const created = await capture(GREENHOUSE_NOTE);
    const creationReceipt = await receiptFor(tellNotes, created, dayOf(created));
    expect(creationReceipt.receipt?.changes).toHaveLength(1);
    const taskId = creationReceipt.receipt!.changes[0]!.taskId!;
    const guide = { id: guideId, title: GUIDE_TITLE, sourceId: DOCUMENT_SOURCE };
    expect((await bench.obs.task(taskId)).task).toMatchObject({
      title: GREENHOUSE_TITLE,
      origin: "note",
      documents: [guide],
    });

    const updated = await capture(GREENHOUSE_QUOTE_NOTE);
    const updateReceipt = await receiptFor(tellNotes, updated, dayOf(updated));
    expect(updateReceipt.receipt?.changes).toEqual([
      expect.objectContaining({ taskId, undoSeq: expect.any(Number) }),
    ]);
    const detail = await bench.obs.task(taskId);
    expect(detail.task.documents).toHaveLength(2);
    expect(detail.task.documents).toEqual(
      expect.arrayContaining([
        guide,
        { id: quoteId, title: QUOTE_TITLE, sourceId: DOCUMENT_SOURCE },
      ]),
    );
    expect(detail.history[0]).toMatchObject({ kind: "edited", surface: "note" });

    const undo = await bench.obs.undoTask(updateReceipt.receipt!.changes[0]!.undoSeq!);
    expect(undo.status).toBe(200);
    expect((await bench.obs.task(taskId)).task.documents).toEqual([guide]);
    expect((await bench.obs.status()).experimental).toBe(false);
  }, 240_000);

  test("a note reporting progress completes the user's task", async () => {
    const plumber = await bench.obs.createTask({ title: PLUMBER_TITLE });
    const id = await capture(DONE_NOTE);
    const agent = await receiptFor(tellNotes, id, dayOf(id));
    expect(agent.receipt?.changes).toEqual([
      expect.objectContaining({ text: `Done: ${PLUMBER_TITLE}`, taskId: plumber.task!.id }),
    ]);
    const detail = await bench.obs.task(plumber.task!.id);
    expect(detail.task).toMatchObject({ state: "done", completionNote: "Paid this morning." });
    expect(detail.history[0]).toMatchObject({ kind: "completed", surface: "note" });
  }, 180_000);

  test("a note putting a task off moves it to next month, out of the open views", async () => {
    const at = new Date();
    const day = isoDay(at);
    const insurance = await bench.obs.createTask({ title: INSURANCE_TITLE });
    const taskId = insurance.task!.id;
    expect(insurance.task).toMatchObject({ scheduledFor: null, state: "open" });
    const before = await bench.obs.taskCounts(day);

    const id = await capture(MIGRATE_NOTE, at);
    const agent = await receiptFor(tellNotes, id, day);
    expect(agent.receipt).toMatchObject({
      text: "Moved renewing the car insurance to next month.",
      changes: [
        { text: `Moved to ${describeSchedule(nextMonth, Date.now())}: ${INSURANCE_TITLE}`, taskId },
      ],
    });

    const detail = await bench.obs.task(taskId);
    expect(detail.task).toMatchObject({ state: "open", scheduledFor: nextMonth });
    expect(detail.history[0]).toMatchObject({
      kind: "migrated",
      surface: "note",
      from: null,
      to: nextMonth,
    });
    // A month after the current one is the Future, never the Month or Anytime.
    const ids = async (view: string) =>
      (await bench.obs.tasks(view, { date: day })).tasks.map((t) => t.id);
    expect(await ids("future")).toContain(taskId);
    expect(await ids("month")).not.toContain(taskId);
    expect(await ids("anytime")).not.toContain(taskId);
    expect(await ids("today")).not.toContain(taskId);
    const after = await bench.obs.taskCounts(day);
    expect(after.counts.anytime).toBe(before.counts.anytime - 1);
    expect(after.counts.future).toBe(before.counts.future + 1);

    // On the first day of next month the task is planned for this month.
    const firstOfNextMonth = `${nextMonth}-01`;
    expect(
      (await bench.obs.tasks("month", { date: firstOfNextMonth })).tasks.map((t) => t.id),
    ).toContain(taskId);
  }, 180_000);

  test("a note putting off a task that does not exist adds it already scheduled", async () => {
    const at = new Date();
    const day = isoDay(at);
    const id = await capture(SCHEDULED_CREATE_NOTE, at);
    const agent = await receiptFor(tellNotes, id, day);
    expect(agent.receipt).toMatchObject({
      text: "Added servicing the boiler for next month.",
      changes: [{ text: `Added: ${BOILER_TITLE}`, taskId: expect.any(String) }],
    });
    const taskId = agent.receipt!.changes[0]!.taskId!;
    expect((await bench.obs.task(taskId)).task).toMatchObject({
      title: BOILER_TITLE,
      origin: "note",
      state: "open",
      scheduledFor: nextMonth,
    });
    const future = (await bench.obs.tasks("future", { date: day })).tasks;
    expect(future.filter((t) => t.title === BOILER_TITLE).map((t) => t.id)).toEqual([taskId]);
    expect(
      (await bench.obs.tasks("anytime", { date: day })).tasks.some((t) => t.title === BOILER_TITLE),
    ).toBe(false);
  }, 180_000);

  test("a note giving a task up strikes it, with the reason, into the done history", async () => {
    const at = new Date();
    const day = isoDay(at);
    const fence = await bench.obs.createTask({ title: FENCE_TITLE });
    const taskId = fence.task!.id;
    const before = await bench.obs.taskCounts(day);

    const id = await capture(STRIKE_NOTE, at);
    const agent = await receiptFor(tellNotes, id, day);
    expect(agent.receipt).toMatchObject({
      text: "Struck repainting the fence.",
      changes: [{ text: `Struck: ${FENCE_TITLE}`, taskId, undoSeq: expect.any(Number) }],
    });

    const detail = await bench.obs.task(taskId);
    expect(detail.task).toMatchObject({ state: "dismissed", completionNote: null });
    expect(detail.task.resolvedAt).not.toBeNull();
    expect(detail.history[0]).toMatchObject({
      kind: "struck",
      surface: "note",
      note: `Struck: ${FENCE_REASON}`,
    });
    // Struck is resolved: it lists under Done (and on today's page as
    // resolved today), and no longer in any open view or count.
    expect((await bench.obs.tasks("done")).tasks.map((t) => t.id)).toContain(taskId);
    expect(
      (await bench.obs.tasks("today", { date: day })).tasks.find((t) => t.id === taskId)?.state,
    ).toBe("dismissed");
    expect((await bench.obs.tasks("anytime", { date: day })).tasks.map((t) => t.id)).not.toContain(
      taskId,
    );
    const after = await bench.obs.taskCounts(day);
    expect(after.counts.anytime).toBe(before.counts.anytime - 1);
    expect(after.counts.today).toBe(before.counts.today);
  }, 180_000);

  test("a note pushing a task to a weekday reschedules it to that day", async () => {
    const at = new Date();
    const day = isoDay(at);
    const report = await bench.obs.createTask({ title: REPORT_TITLE, scheduledFor: day });
    const taskId = report.task!.id;
    const before = await bench.obs.taskCounts(day);

    const id = await capture(RESCHEDULE_NOTE, at);
    const agent = await receiptFor(tellNotes, id, day);
    expect(agent.receipt).toMatchObject({
      text: "Moved the quarterly report to Friday.",
      changes: [{ text: `Edited: ${REPORT_TITLE}`, taskId }],
    });
    const detail = await bench.obs.task(taskId);
    expect(detail.task).toMatchObject({ state: "open", scheduledFor: friday });
    expect(detail.history[0]).toMatchObject({ kind: "edited", surface: "note" });

    // A later day this month is the Month; one in a later month the Future.
    const expected = friday.slice(0, 7) === day.slice(0, 7) ? "month" : "future";
    expect((await bench.obs.tasks(expected, { date: day })).tasks.map((t) => t.id)).toContain(
      taskId,
    );
    expect((await bench.obs.tasks("today", { date: day })).tasks.map((t) => t.id)).not.toContain(
      taskId,
    );
    const after = await bench.obs.taskCounts(day);
    expect(after.counts.today).toBe(before.counts.today - 1);
    expect(after.counts[expected]).toBe(before.counts[expected] + 1);
    // Read on that Friday, it is on that day's page.
    expect((await bench.obs.tasks("today", { date: friday })).tasks.map((t) => t.id)).toContain(
      taskId,
    );
  }, 180_000);

  test("a note completing today's task lowers today's open count", async () => {
    const at = new Date();
    const day = isoDay(at);
    const boxes = await bench.obs.createTask({ title: WINDOW_BOXES_TITLE, scheduledFor: day });
    const taskId = boxes.task!.id;
    const before = await bench.obs.taskCounts(day);
    expect(before.day).toBe(day);
    expect(before.counts.today).toBeGreaterThanOrEqual(1);

    const id = await capture(COUNTED_NOTE, at);
    const agent = await receiptFor(tellNotes, id, day);
    expect(agent.receipt?.changes).toEqual([
      expect.objectContaining({ text: `Done: ${WINDOW_BOXES_TITLE}`, taskId }),
    ]);

    const after = await bench.obs.taskCounts(day);
    expect(after.counts.today).toBe(before.counts.today - 1);
    // The view's own counts agree, and the task stays on today's page as done.
    const view = await bench.obs.tasks("today", { date: day });
    expect(view.counts).toEqual(after.counts);
    expect(view.tasks.find((t) => t.id === taskId)?.state).toBe("done");
  }, 180_000);

  test("a note accepts and ignores named suggestions with receipts and undo", async () => {
    bench.withWriteHandle((db) => {
      for (const [id, title] of [
        [ACCEPT_SUGGESTION_ID, ACCEPT_SUGGESTION_TITLE],
        [IGNORE_SUGGESTION_ID, IGNORE_SUGGESTION_TITLE],
        [UNTOUCHED_SUGGESTION_ID, "Check the pottery kiln booking"],
      ] as const)
        createOpenLoop(
          db,
          { id, title, createdByRun: "seed", confidence: 0.8, importance: 0.5 },
          Date.now(),
        );
    });
    const untouched = await bench.obs.task(UNTOUCHED_SUGGESTION_ID);
    const id = await capture(SUGGESTION_NOTE);
    const agent = await receiptFor(tellNotes, id, dayOf(id));
    expect(agent.receipt).toMatchObject({
      text: "Added the planetarium workshop for tomorrow and ignored the seed library suggestion.",
      changes: [
        {
          text: `Added to your tasks: ${ACCEPT_SUGGESTION_TITLE}`,
          taskId: ACCEPT_SUGGESTION_ID,
          undoSeq: expect.any(Number),
        },
        {
          text: `Ignored: ${IGNORE_SUGGESTION_TITLE}`,
          taskId: IGNORE_SUGGESTION_ID,
          undoSeq: expect.any(Number),
        },
      ],
    });
    const accepted = await bench.obs.task(ACCEPT_SUGGESTION_ID);
    expect(accepted.task).toMatchObject({ state: "open", accepted: true, ignored: false });
    expect(accepted.task.scheduledFor).toBe(dayAfter(dayOf(id)));
    expect(accepted.history[0]).toMatchObject({ kind: "accepted", surface: "note" });
    const ignored = await bench.obs.task(IGNORE_SUGGESTION_ID);
    expect(ignored.task).toMatchObject({ state: "open", accepted: false, ignored: true });
    expect(ignored.history[0]).toMatchObject({ kind: "ignored", surface: "note" });
    expect(await bench.obs.task(UNTOUCHED_SUGGESTION_ID)).toEqual(untouched);

    for (const change of agent.receipt!.changes)
      expect((await bench.obs.undoTask(change.undoSeq!)).status).toBe(200);
    expect((await bench.obs.task(ACCEPT_SUGGESTION_ID)).task).toMatchObject({
      state: "open",
      accepted: false,
      ignored: false,
      scheduledFor: null,
    });
    expect((await bench.obs.task(IGNORE_SUGGESTION_ID)).task).toMatchObject({
      state: "open",
      accepted: false,
      ignored: false,
    });
    expect(await bench.obs.task(UNTOUCHED_SUGGESTION_ID)).toEqual(untouched);
  }, 180_000);

  test("a voice note is read in the gateway's transcript, not the phone's", async () => {
    const id = randomUUID();
    const voiceAt = new Date();
    const form = new FormData();
    form.set(
      "note",
      JSON.stringify({
        id,
        text: VOICE_DEVICE,
        language: "en-GB",
        surface: "ios-app",
        capturedAt: voiceAt.toISOString(),
        ...CAPTURE_ZONE,
      }),
    );
    form.set(
      "audio",
      new Blob([new TextEncoder().encode(VOICE_SPOKEN)], { type: "audio/mp4" }),
      "n.m4a",
    );
    const encoded = new Response(form);
    const res = await bench.harness.gatewayFetch("/notes/voice", {
      method: "POST",
      headers: { "Content-Type": encoded.headers.get("content-type")! },
      body: await encoded.arrayBuffer(),
    });
    expect(res.status).toBe(202);

    const agent = await receiptFor(tellNotes, id, isoDay(voiceAt));
    expect(agent.receipt?.changes.map((c) => c.text)).toEqual([
      "Added: Book a table at the harbour restaurant",
    ]);
    const turns = noteCalls().filter((c) => c.prompt.includes("harbour restaurant"));
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.subject).toBe(VOICE_SPOKEN);
      expect(turn.prompt).not.toContain(VOICE_DEVICE);
    }
  }, 180_000);

  test("a note waiting on its transcript is held while later notes are read", async () => {
    const parked = await capture(PARKED_NOTE);
    // Its transcript is still owed: a retry hours out.
    bench.withWriteHandle((db) => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO voice_note_transcriptions
           (note_id, audio, mime_type, language, saved_text, placeholder, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 'audio/mp4', 'en', ?, 0, 1, ?, ?)`,
      ).run(
        parked,
        Buffer.from(PARKED_NOTE, "utf8"),
        PARKED_NOTE,
        new Date(now + 6 * 60 * 60_000).toISOString(),
        new Date(now).toISOString(),
      );
    });
    const control = await capture(CONTROL_NOTE);
    await receiptFor(tellNotes, control, dayOf(control));
    // The later note was claimed and read; the held one was passed over.
    const held = (await tellNotes(dayOf(parked))).find((n) => n.id === parked);
    expect(held?.agent?.state).toBe("pending");
    expect(noteCalls().some((c) => c.prompt.includes(PARKED_NOTE))).toBe(false);

    // Once nothing is owed the note is read.
    bench.withWriteHandle((db) => {
      db.prepare("DELETE FROM voice_note_transcriptions WHERE note_id = ?").run(parked);
    });
    const agent = await receiptFor(tellNotes, parked, dayOf(parked));
    expect(agent.receipt?.text).toBe("Added a task to call the optician.");
  }, 240_000);

  test("a note told while the note agent is off is never read, even when switched straight back on", async () => {
    const setNoteAgent = (on: boolean) =>
      bench.harness.gatewayJson("/admin/config", {
        method: "PATCH",
        body: JSON.stringify({ agent: { noteAgent: on } }),
      });
    await setNoteAgent(false);
    const unread = await capture(SWITCHED_OFF_NOTE);
    await setNoteAgent(true);
    // A note told once it is back on is read; the earlier one stays settled.
    const control = await capture(CONTROL_NOTE);
    await receiptFor(tellNotes, control, dayOf(control));
    expect((await tellNotes(dayOf(unread))).find((n) => n.id === unread)?.agent?.state).toBe(
      "skipped",
    );
    expect(noteCalls().some((c) => c.prompt.includes(SWITCHED_OFF_NOTE))).toBe(false);
  }, 180_000);
});

describe("a Brain assignment does not substitute for an Agent model", () => {
  let harness: SyntheticE2EHarness;
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({ experimental: false, syncSources: false });
    harness = bench.harness;
  }, 240_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("notes are saved and nothing reads them", async () => {
    const status = await harness.gatewayJson<{ tasks: { available: boolean; noteAgent: boolean } }>(
      "/status",
    );
    expect(status.tasks).toEqual({ available: true, noteAgent: false });

    const id = randomUUID();
    const capturedAt = Date.now();
    const res = await harness.gatewayFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        id,
        text: "Remind me to defrost the freezer.",
        capturedAt: new Date(capturedAt).toISOString(),
        ...CAPTURE_ZONE,
      }),
    });
    expect(res.status).toBe(201);

    // Proof the drain had its chance: its job ticked after the note settled.
    // The jobs snapshot refreshes on its own tick, so the job may not be
    // listed on the first read.
    let listedJobs: string[] = [];
    await waitFor(
      () =>
        `the note agent's drain to tick after the note settled (jobs: ${listedJobs.join(", ")})`,
      async () => {
        const snap = await harness.gatewayJson<{
          jobs: Array<{ id: string; observation: { lastTickAt?: number } }>;
        }>("/admin/background-jobs");
        listedJobs = snap.jobs.map((j) => j.id);
        const job = snap.jobs.find((j) => j.id === "noteAgent.drain");
        return (job?.observation.lastTickAt ?? 0) > capturedAt + 12_000 ? true : null;
      },
      90_000,
    );
    const listed = await harness.gatewayJson<{ entries: ListedNoteDto[] }>(
      `/notes?day=${isoDay(new Date(capturedAt))}`,
    );
    const note = listed.entries.find((n) => n.id === id);
    expect(note).toBeDefined();
    expect(note!.agent).toBeUndefined();
    expect(bench.puppetCalls.filter((call) => call.flavour === "note")).toEqual([]);
    const db = new Database(harness.getDbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_agent_runs").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 180_000);
});
