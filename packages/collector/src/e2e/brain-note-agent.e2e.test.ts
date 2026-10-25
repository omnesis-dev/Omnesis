// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: the note agent.
 *
 * Every quick-capture note is the user speaking. Once it settles (and a
 * voice note's transcript is in), one bounded `background-agent` turn acts
 * on it: a task the note asks for is added (already scheduled when the note
 * says when), a task it reports done is completed, one it puts off is moved,
 * one the user gave up on is struck, and the receipt the user reads appears
 * under the note. The
 * turn touches only the user's own tasks — never the Brain's suggestions.
 *
 * The note agent is not part of the experimental Brain: it runs on any
 * install with a runnable background-agent model, so this suite boots a
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
import { SyntheticE2EHarness } from "./synth-harness.js";
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
const today = () => new Date().toISOString().slice(0, 10);

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

const TASK_NOTE = "Remind me to book the piano tuner next week.";
const DONE_NOTE = "Paid the plumber this morning.";
const SUGGESTION_NOTE = "The fete stall is sorted, someone else reserved it.";
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

const PLUMBER_TITLE = "Pay the plumber";
const INSURANCE_TITLE = "Renew the car insurance";
const BOILER_TITLE = "Service the boiler";
const FENCE_TITLE = "Repaint the fence";
const FENCE_REASON = "Decided not to repaint it.";
const REPORT_TITLE = "Send the quarterly report";
const WINDOW_BOXES_TITLE = "Water the window boxes";
const SUGGESTION_ID = "loop_note_agent_suggestion";

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

describe("the note agent (stable install, background-agent puppet)", () => {
  let bench: BrainBench;
  const capture = async (text: string): Promise<string> => {
    const id = randomUUID();
    const res = await bench.harness.gatewayFetch("/notes", {
      method: "POST",
      body: JSON.stringify({ id, text, capturedAt: new Date().toISOString(), ...CAPTURE_ZONE }),
    });
    expect(res.status).toBe(201);
    return id;
  };
  const tellNotes = (day: string) => bench.obs.tellNotes(day);
  const noteCalls = () => bench.puppetCalls.filter((c) => c.flavour === "note");

  beforeAll(async () => {
    // The puppet resolves "next month" and "Friday" from the capture day, as
    // the note agent's prompt tells the model to.
    const nextMonth = monthAfter(today());
    const friday = fridayAfter(today());
    bench = await BrainBench.start({
      experimental: false,
      syncSources: false,
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
            plan: {
              calls: [
                call("task_list", { view: "suggested" }),
                call("task_update", { id: SUGGESTION_ID, action: "complete" }),
              ],
              finalText: "Saved the note.",
            },
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
    const id = await capture(TASK_NOTE);
    const agent = await receiptFor(tellNotes, id, today());
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
    expect(turn.detail).toBe(today());

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

  test("a note reporting progress completes the user's task", async () => {
    const plumber = await bench.obs.createTask({ title: PLUMBER_TITLE });
    const id = await capture(DONE_NOTE);
    const agent = await receiptFor(tellNotes, id, today());
    expect(agent.receipt?.changes).toEqual([
      expect.objectContaining({ text: `Done: ${PLUMBER_TITLE}`, taskId: plumber.task!.id }),
    ]);
    const detail = await bench.obs.task(plumber.task!.id);
    expect(detail.task).toMatchObject({ state: "done", completionNote: "Paid this morning." });
    expect(detail.history[0]).toMatchObject({ kind: "completed", surface: "note" });
  }, 180_000);

  test("a note putting a task off moves it to next month, out of the open views", async () => {
    const day = today();
    const nextMonth = monthAfter(day);
    const insurance = await bench.obs.createTask({ title: INSURANCE_TITLE });
    const taskId = insurance.task!.id;
    expect(insurance.task).toMatchObject({ scheduledFor: null, state: "open" });
    const before = await bench.obs.taskCounts(day);

    const id = await capture(MIGRATE_NOTE);
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
    const day = today();
    const nextMonth = monthAfter(day);
    const id = await capture(SCHEDULED_CREATE_NOTE);
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
    const day = today();
    const fence = await bench.obs.createTask({ title: FENCE_TITLE });
    const taskId = fence.task!.id;
    const before = await bench.obs.taskCounts(day);

    const id = await capture(STRIKE_NOTE);
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
    const day = today();
    const friday = fridayAfter(day);
    const report = await bench.obs.createTask({ title: REPORT_TITLE, scheduledFor: day });
    const taskId = report.task!.id;
    const before = await bench.obs.taskCounts(day);

    const id = await capture(RESCHEDULE_NOTE);
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
    const day = today();
    const boxes = await bench.obs.createTask({ title: WINDOW_BOXES_TITLE, scheduledFor: day });
    const taskId = boxes.task!.id;
    const before = await bench.obs.taskCounts(day);
    expect(before.day).toBe(day);
    expect(before.counts.today).toBeGreaterThanOrEqual(1);

    const id = await capture(COUNTED_NOTE);
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

  test("the note turn never touches a Brain suggestion", async () => {
    bench.withWriteHandle((db) =>
      createOpenLoop(
        db,
        {
          id: SUGGESTION_ID,
          createdByRun: "seed",
          title: "Reserve the fete stall",
          confidence: 0.8,
          importance: 0.5,
        },
        Date.now(),
      ),
    );
    const id = await capture(SUGGESTION_NOTE);
    const agent = await receiptFor(tellNotes, id, today());
    expect(agent.receipt).toMatchObject({ text: "Saved the note.", changes: [] });
    expect((await bench.obs.task(SUGGESTION_ID)).task).toMatchObject({
      state: "open",
      accepted: false,
    });
    // The suggested view is not on offer, and the suggestion is refused by id.
    const turn = noteCalls().filter((c) => c.prompt.includes(SUGGESTION_NOTE));
    const emitted = turn.map((c) => c.emitted).filter((e) => e.kind === "tool");
    expect(emitted.map((e) => (e as { name: string }).name)).toEqual(["task_list", "task_update"]);
    const lastRequest = turn.at(-1)!;
    expect(lastRequest.emitted.kind).toBe("final");
    const results = JSON.stringify(
      (await bench.harness.gatewayJson<{ entries: ListedNoteDto[] }>("/notes/history")).entries,
    );
    expect(results).toContain("Saved the note.");
  }, 180_000);

  test("a voice note is read in the gateway's transcript, not the phone's", async () => {
    const id = randomUUID();
    const form = new FormData();
    form.set(
      "note",
      JSON.stringify({
        id,
        text: VOICE_DEVICE,
        language: "en-GB",
        surface: "ios-app",
        capturedAt: new Date().toISOString(),
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

    const agent = await receiptFor(tellNotes, id, today());
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
    await receiptFor(tellNotes, control, today());
    // The later note was claimed and read; the held one was passed over.
    const held = (await tellNotes(today())).find((n) => n.id === parked);
    expect(held?.agent?.state).toBe("pending");
    expect(noteCalls().some((c) => c.prompt.includes(PARKED_NOTE))).toBe(false);

    // Once nothing is owed the note is read.
    bench.withWriteHandle((db) => {
      db.prepare("DELETE FROM voice_note_transcriptions WHERE note_id = ?").run(parked);
    });
    const agent = await receiptFor(tellNotes, parked, today());
    expect(agent.receipt?.text).toBe("Added a task to call the optician.");
  }, 240_000);
});

describe("the note agent with no background-agent model", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
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
    const listed = await harness.gatewayJson<{ entries: ListedNoteDto[] }>(`/notes?day=${today()}`);
    const note = listed.entries.find((n) => n.id === id);
    expect(note).toBeDefined();
    expect(note!.agent).toBeUndefined();
    const db = new Database(harness.getDbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_agent_runs").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 180_000);
});
