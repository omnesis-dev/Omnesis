// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: tasks.
 *
 * A task is an open loop read the way a bullet journal is. The user's own
 * tasks (typed, from a note, or an accepted Brain suggestion) change only
 * through the user's commands or through a Brain proposal the user
 * confirms; a Brain loop the user has not accepted is a Suggestion. The user
 * accepts a suggestion (for a planned time, or with a note the note agent
 * applies to it), marks it already done, or ignores it — which only takes it
 * out of Tasks: the Brain keeps the loop open and keeps maintaining it.
 *
 * The suite drives the `/tasks` surface for real — views, commands,
 * receipts, undo — and the Brain's side of the contract through scripted
 * source-maintenance runs: loops it creates arrive as suggestions, its
 * change to a user task is recorded as a proposal (and refused without a
 * reason) unless the scripted entailment verifier confirms the evidence it
 * states — then it is applied as an undoable `auto_applied` event, except
 * striking and anything the user wrote, which stay proposals — it can never
 * delete a user task, and the decay engine never schedules a user task for
 * retirement. A task lists the documents it refers to by title and source,
 * and a deleted document leaves that list.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { describeSchedule } from "../../../gateway/src/brain/storage/tasks.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  sourceInterpretations,
  waitFor,
  type TaskDto,
  type TaskReceiptDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;

function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

let NOON = 0;
let TODAY = "";
let YESTERDAY = "";
let NEXT_MONTH = "";

const SUGGESTIONS = email({
  externalId: "tasks-hall-booking",
  title: "Village hall booking form",
  content:
    "Hello,\n\nPlease return the signed hall booking form and pay the cleaning deposit.\n\nRiverside Estate",
});
const ACCEPTED_TITLE = "Return the signed hall booking form";
const IGNORED_TITLE = "Pay the hall cleaning deposit";

const DEPOSIT_REMINDER = email({
  externalId: "tasks-hall-deposit-reminder",
  title: "Hall cleaning deposit reminder",
  content:
    "Hello,\n\nA reminder that the cleaning deposit is due before the booking.\n\nRiverside Estate",
});
const DEPOSIT_DESCRIPTION = "The cleaning deposit is due before the booking.";

const CHOIR = email({
  externalId: "tasks-choir-season",
  title: "Choir season letter",
  content:
    "Hello,\n\nPlease renew your choir membership, collect your music folder, and sign up for the spring concert rota.\n\nStudio Northstar",
});
const NOTE_TITLE = "Renew the choir membership";
const DONE_TITLE = "Collect the choir music folder";
const LATER_TITLE = "Sign up for the spring concert rota";
const TASK_NOTE = "I pay by standing order from now on";
const TASK_NOTE_DESCRIPTION = "Paid by standing order.";

const RECEIPT = email({
  externalId: "tasks-window-cleaner-receipt",
  title: "Window cleaner receipt",
  content: "Hello,\n\nThanks for paying the window cleaner invoice in full today.\n\nStellar Sound",
});
const USER_TASK_TITLE = "Pay the window cleaner";

const RENAME = email({
  externalId: "tasks-hall-form-renamed",
  title: "Hall booking form update",
  content:
    "Hello,\n\nThe hall booking form is now called the venue hire agreement.\n\nRiverside Estate",
});

const PERMIT = email({
  externalId: "tasks-parking-permit-renewed",
  title: "Parking permit renewed",
  content:
    "Hello,\n\nYour residents' parking permit has been renewed until next spring.\n\nRiverside Estate",
});
const PERMIT_TASK = "Renew the parking permit";
const PERMIT_QUOTE = "Your residents' parking permit has been renewed until next spring.";
const PERMIT_REASON = "The council confirmed the permit was renewed.";

const DRY_CLEANING = email({
  externalId: "tasks-dry-cleaning-ready",
  title: "Dry cleaning ready",
  content:
    "Hello,\n\nYour coat is ready at the counter and has been collected by your neighbour.\n\nThe dry cleaners",
});
const DRY_CLEANING_TASK = "Collect the dry cleaning";
/** The scripted verifier finds this fact unsupported. */
const UNSUPPORTED_FACT = "The dry cleaning was collected by the user.";

const GYM = email({
  externalId: "tasks-gym-closing",
  title: "Gym closing notice",
  content: "Hello,\n\nThe community gym closes for good at the end of this month.\n\nThe gym team",
});
const GYM_TASK = "Book a gym induction";
const GYM_QUOTE = "The community gym closes for good at the end of this month.";

const BOILER = email({
  externalId: "tasks-boiler-service-renamed",
  title: "Boiler service booking",
  content:
    "Hello,\n\nYour boiler service is now booked as the annual gas safety check.\n\nRiverside Estate",
});
const BOILER_TASK = "Book the boiler service";
const BOILER_EDITED_TITLE = "Book the boiler service before winter";
const BOILER_QUOTE = "Your boiler service is now booked as the annual gas safety check.";

const DECAY_DOC = email({
  externalId: "tasks-decay-flyer",
  title: "Summer fete stall flyer",
  content:
    "Hello,\n\nStalls at the summer fete can be reserved any time before July.\n\nRiverside Estate",
});
const DECAY_LOOP_TITLE = "Reserve a stall at the summer fete";

const LOAN_CARD = email({
  externalId: "tasks-tool-library-card",
  title: "Tool library loan card",
  content: "Hello,\n\nYour loan card for the hedge trimmer is attached.\n\nRiverside Estate",
});
const LOAN_REMINDER = email({
  externalId: "tasks-tool-library-reminder",
  title: "Tool library return reminder",
  content: "Hello,\n\nPlease return the hedge trimmer by Friday.\n\nRiverside Estate",
});
const LOAN_TITLE = "Return the hedge trimmer to the tool library";
/** The loan card's document id, known once it is ingested and cited by the reminder's run. */
let loanCardId = "";
const DECAY_USER_TITLE = "Sort the garage shelves";

describe("brain bench: tasks", () => {
  let bench: BrainBench;

  const create = async (body: Record<string, unknown>): Promise<TaskReceiptDto> =>
    bench.obs.createTask(body);
  const act = async (id: string, body: Record<string, unknown>) => {
    const res = await bench.obs.taskAction(id, body);
    return { status: res.status, body: (await res.json()) as TaskReceiptDto & { error?: string } };
  };
  const view = async (name: string): Promise<TaskDto[]> => (await bench.obs.tasks(name)).tasks;
  const titles = async (name: string) => (await view(name)).map((t) => t.title);

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      syncSources: false,
      entailment: ({ claim }) => (claim.includes(UNSUPPORTED_FACT) ? "neutral" : "entailment"),
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        recencyWindow: "30d",
        decay: { backoffBase: "1h", backoffCap: "8h", datedFloor: "30m" },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            {
              docTitle: SUGGESTIONS.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "hall booking" }),
                  call("open_loop_create", {
                    title: ACCEPTED_TITLE,
                    confidence: 0.9,
                    importance: 0.7,
                    docs: [ctx.subject],
                  }),
                  call("open_loop_create", {
                    title: IGNORED_TITLE,
                    confidence: 0.9,
                    importance: 0.6,
                    docs: [ctx.subject],
                  }),
                ],
              }),
            },
            {
              docTitle: DEPOSIT_REMINDER.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "cleaning deposit" }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    description: DEPOSIT_DESCRIPTION,
                    docs: [ctx.subject],
                  }),
                ],
              }),
            },
            {
              docTitle: CHOIR.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "choir" }),
                  ...[NOTE_TITLE, DONE_TITLE, LATER_TITLE].map((title) =>
                    call("open_loop_create", {
                      title,
                      confidence: 0.9,
                      importance: 0.5,
                      docs: [ctx.subject],
                    }),
                  ),
                ],
              }),
            },
            {
              docTitle: RECEIPT.title,
              expectedRefusals: [
                { tool: "open_loop_update", code: "reason_required" },
                { tool: "open_loop_delete", code: "user_task" },
              ],
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: USER_TASK_TITLE }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    state: "done",
                    docs: [ctx.subject],
                  }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    state: "done",
                    docs: [ctx.subject],
                    reason: "The receipt says the invoice was paid in full today.",
                  }),
                  call("open_loop_delete", { id: ref("open_loop_search", "loops.0.id") }),
                ],
              }),
            },
            {
              docTitle: RENAME.title,
              plan: () => ({
                calls: [
                  call("open_loop_search", { query: ACCEPTED_TITLE }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    title: "Return the signed venue hire agreement",
                    reason: "The form was renamed to the venue hire agreement.",
                  }),
                ],
              }),
            },
            {
              docTitle: PERMIT.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "parking permit" }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    state: "done",
                    docs: [ctx.subject],
                    reason: PERMIT_REASON,
                    evidence: {
                      fact: "The residents' parking permit has been renewed.",
                      basis: "explicit",
                      quotes: [{ docId: ctx.subject, quote: PERMIT_QUOTE }],
                    },
                  }),
                ],
              }),
            },
            {
              docTitle: DRY_CLEANING.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "dry cleaning" }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    state: "done",
                    docs: [ctx.subject],
                    reason: "The shop says the coat has been collected.",
                    evidence: {
                      fact: UNSUPPORTED_FACT,
                      basis: "explicit",
                      quotes: [
                        {
                          docId: ctx.subject,
                          quote: "Your coat is ready at the counter and has been collected",
                        },
                      ],
                    },
                  }),
                ],
              }),
            },
            {
              docTitle: GYM.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "gym induction" }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    state: "dismissed",
                    docs: [ctx.subject],
                    reason: "The gym closes at the end of the month.",
                    evidence: {
                      fact: "The gym closes for good at the end of this month.",
                      basis: "explicit",
                      quotes: [{ docId: ctx.subject, quote: GYM_QUOTE }],
                    },
                  }),
                ],
              }),
            },
            {
              docTitle: BOILER.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "boiler service" }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    title: "Book the annual gas safety check",
                    docs: [ctx.subject],
                    reason: "The booking is now called the annual gas safety check.",
                    evidence: {
                      fact: "The boiler service is now booked as the annual gas safety check.",
                      basis: "explicit",
                      quotes: [{ docId: ctx.subject, quote: BOILER_QUOTE }],
                    },
                  }),
                ],
              }),
            },
            {
              docTitle: LOAN_REMINDER.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "hedge trimmer" }),
                  call("open_loop_create", {
                    title: LOAN_TITLE,
                    confidence: 0.9,
                    importance: 0.6,
                    docs: [ctx.subject, loanCardId],
                  }),
                ],
              }),
            },
            {
              docTitle: DECAY_DOC.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "summer fete stall" }),
                  call("open_loop_create", {
                    title: DECAY_LOOP_TITLE,
                    confidence: 0.8,
                    importance: 0.4,
                    docs: [ctx.subject],
                  }),
                ],
              }),
            },
          ],
        }),
        behaviors: [
          {
            // The note written while accepting a suggestion names that task.
            flavour: "note",
            promptContains: TASK_NOTE,
            plan: {
              calls: [
                call("task_list", { query: "choir membership" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "edit",
                  description: TASK_NOTE_DESCRIPTION,
                }),
              ],
              finalText: "Noted the standing order on the choir membership task.",
            },
          },
          {
            flavour: "time_based.decay",
            plan: (ctx) => ({
              calls: [call("open_loop_update", { id: ctx.subject, state: "dismissed" })],
              finalText: "Nothing came of it; retired.",
            }),
          },
        ],
      },
    });
    const bootNow = (await bench.clock.now()).now;
    NOON = localMidnight(localMidnight(bootNow) + 36 * HOUR) + 12 * HOUR;
    TODAY = bench.clock.localDay(NOON);
    YESTERDAY = bench.clock.localDay(NOON - DAY);
    const next = new Date(NOON);
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    NEXT_MONTH = bench.clock.localDay(next.getTime()).slice(0, 7);
    await bench.clock.set(NOON);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("tasks are available, and a note agent is reported when a background model runs", async () => {
    const status = await bench.obs.status();
    expect(status.tasks).toEqual({ available: true, noteAgent: true });
  }, 60_000);

  test("a task the user adds moves through the journal views with a receipt for every change", async () => {
    const added = await create({ title: "Renew the passport", scheduledFor: TODAY });
    expect(added.receipt.text).toBe("Added: Renew the passport");
    // A task the user adds is theirs from the start: it never waits for acceptance.
    expect(added.task).toMatchObject({
      origin: "user",
      accepted: true,
      state: "open",
      scheduledFor: TODAY,
      carried: false,
    });
    const id = added.task!.id;
    expect(await titles("today")).toContain("Renew the passport");
    expect(await titles("anytime")).not.toContain("Renew the passport");

    const moved = await act(id, { action: "migrate", to: NEXT_MONTH });
    expect(moved.status).toBe(200);
    expect(moved.body.receipt.text).toBe(
      `Moved to ${describeSchedule(NEXT_MONTH, Date.now())}: Renew the passport`,
    );
    expect(await titles("today")).not.toContain("Renew the passport");
    expect(await titles("future")).toContain("Renew the passport");

    const edited = await act(id, { action: "edit", title: "Renew both passports" });
    expect(edited.body.task?.title).toBe("Renew both passports");

    const done = await act(id, { action: "complete", note: "Posted the forms." });
    expect(done.body.task).toMatchObject({ state: "done", completionNote: "Posted the forms." });
    expect(await titles("done")).toContain("Renew both passports");
    // A task done today is listed under today, resolved.
    expect((await view("today")).find((t) => t.id === id)?.state).toBe("done");

    // Undo restores exactly what the completion replaced.
    const undone = await bench.obs.undoTask(done.body.receipt.undoSeq!);
    expect(undone.status).toBe(200);
    const restored = (await undone.json()) as TaskReceiptDto;
    expect(restored.task).toMatchObject({
      state: "open",
      title: "Renew both passports",
      scheduledFor: NEXT_MONTH,
      completionNote: null,
    });
    // Only the latest change can be undone.
    const stale = await bench.obs.undoTask(edited.body.receipt.undoSeq!);
    expect(stale.status).toBe(409);
    // An undo cannot itself be undone.
    expect((await bench.obs.undoTask(restored.receipt.undoSeq!)).status).toBe(409);

    const struck = await act(id, { action: "strike", reason: "Not travelling this year." });
    expect(struck.body.receipt.text).toBe("Struck: Renew both passports");
    const reopened = await act(id, { action: "reopen" });
    expect(reopened.body.task?.state).toBe("open");

    const detail = await bench.obs.task(id);
    expect(detail.history.map((e) => e.kind)).toEqual([
      "reopened",
      "struck",
      "undone",
      "completed",
      "edited",
      "migrated",
      "created",
    ]);
    expect(detail.history.every((e) => e.surface === "tasks")).toBe(true);
    expect(detail.history.find((e) => e.kind === "migrated")).toMatchObject({
      from: TODAY,
      to: NEXT_MONTH,
    });
    expect(detail.undoSeq).toBe(detail.history[0]!.seq);

    const deleted = await act(id, { action: "delete" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.task).toBeNull();
    expect((await bench.harness.gatewayFetch(`/tasks/${id}`)).status).toBe(404);
  }, 120_000);

  test("the journal places tasks by plan, deadline and carry-over", async () => {
    const carried = await create({ title: "Water the seedlings", scheduledFor: YESTERDAY });
    const someday = await create({ title: "Learn to juggle", scheduledFor: "someday" });
    const anytime = await create({ title: "Find the spare key" });
    const due = await create({
      title: "Send the tax form",
      deadline: { type: "by", date: TODAY },
    });

    const today = await bench.obs.tasks("today");
    expect(today.tasks.find((t) => t.id === carried.task!.id)).toMatchObject({ carried: true });
    expect(today.tasks.find((t) => t.id === due.task!.id)).toMatchObject({ dueDay: TODAY });
    expect(today.counts.carried).toBe(1);
    // Carried-over tasks lead the day.
    expect(today.tasks[0]!.id).toBe(carried.task!.id);
    expect(await titles("future")).toContain("Learn to juggle");
    expect(await titles("anytime")).toEqual(["Find the spare key"]);

    // Undoing a creation removes the task.
    const removed = await bench.obs.undoTask(anytime.receipt.undoSeq!);
    expect(removed.status).toBe(200);
    expect(await titles("anytime")).toEqual([]);

    expect((await act(someday.task!.id, { action: "migrate", to: "next week" })).status).toBe(400);
    const invalid = await bench.harness.gatewayFetch("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Plan the picnic", scheduledFor: "tomorrow" }),
    });
    expect(invalid.status).toBe(400);
  }, 120_000);

  test("a Brain loop is a suggestion until the user accepts it", async () => {
    await bench.pushAndSettle([{ ...SUGGESTIONS, at: NOON }]);
    const suggested = await bench.obs.tasks("suggested");
    expect(suggested.tasks.map((t) => t.title).sort()).toEqual(
      [ACCEPTED_TITLE, IGNORED_TITLE].sort(),
    );
    expect(suggested.counts.suggested).toBe(2);
    for (const t of suggested.tasks) expect(t).toMatchObject({ origin: "brain", accepted: false });
    // Suggestions stay out of the journal.
    for (const name of ["today", "month", "future", "anytime"])
      expect(await titles(name)).not.toContain(ACCEPTED_TITLE);

    const accepting = suggested.tasks.find((t) => t.title === ACCEPTED_TITLE)!;
    const ignoring = suggested.tasks.find((t) => t.title === IGNORED_TITLE)!;

    // A suggestion cannot be planned or edited before it is accepted.
    expect((await act(ignoring.id, { action: "edit", title: "Mine now" })).status).toBe(409);
    expect((await act(ignoring.id, { action: "migrate", to: TODAY })).status).toBe(409);

    // A suggestion names the document it came from by title and source.
    const suggestionDoc = await bench.docId(SUGGESTIONS.externalId);
    expect(accepting.documents).toEqual([
      { id: suggestionDoc, title: SUGGESTIONS.title, sourceId: expect.any(String) },
    ]);
    expect(accepting.documents[0]!.sourceId).not.toBe("");

    const accepted = await act(accepting.id, { action: "accept", scheduledFor: TODAY });
    expect(accepted.body.receipt.text).toBe(`Added to your tasks: ${ACCEPTED_TITLE}`);
    expect(accepted.body.task?.documents.map((d) => d.title)).toEqual([SUGGESTIONS.title]);
    expect(accepted.body.task).toMatchObject({ accepted: true, scheduledFor: TODAY });
    expect(await titles("today")).toContain(ACCEPTED_TITLE);
    expect((await act(accepting.id, { action: "accept" })).status).toBe(400);

    // Ignoring takes the suggestion out of Tasks; its loop stays open.
    const ignored = await act(ignoring.id, { action: "ignore", reason: "Already arranged." });
    expect(ignored.body.receipt.text).toBe(`Ignored: ${IGNORED_TITLE}`);
    expect(ignored.body.task).toMatchObject({ state: "open", accepted: false, ignored: true });
    expect((await bench.obs.task(ignoring.id)).history[0]).toMatchObject({ kind: "ignored" });
    const afterIgnore = await bench.obs.tasks("suggested");
    expect(afterIgnore.tasks).toEqual([]);
    expect(afterIgnore.counts.suggested).toBe(0);
    expect(await titles("done")).not.toContain(IGNORED_TITLE);

    // Undo offers it again; ignoring it again takes it back out.
    const undone = await bench.obs.undoTask(ignored.body.receipt.undoSeq!);
    expect(undone.status).toBe(200);
    expect(await titles("suggested")).toEqual([IGNORED_TITLE]);
    expect((await act(ignoring.id, { action: "ignore" })).body.task?.ignored).toBe(true);

    // Brain runs keep maintaining the ignored loop without offering it again.
    await bench.pushAndSettle([{ ...DEPOSIT_REMINDER, at: NOON }]);
    expect((await bench.obs.task(ignoring.id)).task).toMatchObject({
      state: "open",
      ignored: true,
      description: DEPOSIT_DESCRIPTION,
    });
    expect((await bench.obs.tasks("suggested")).tasks).toEqual([]);
  }, 240_000);

  test("a suggestion is accepted with a note, accepted for later, or marked already done", async () => {
    await bench.pushAndSettle([{ ...CHOIR, at: NOON }]);
    const suggested = (await view("suggested")).filter((t) =>
      [NOTE_TITLE, DONE_TITLE, LATER_TITLE].includes(t.title),
    );
    expect(suggested.map((t) => t.title).sort()).toEqual(
      [NOTE_TITLE, DONE_TITLE, LATER_TITLE].sort(),
    );
    const byTitle = (title: string) => suggested.find((t) => t.title === title)!;

    // Accepted with a note: the note is saved as a quick-capture note about that task,
    // and the note agent applies it to the task.
    const noteId = randomUUID();
    const withNote = await act(byTitle(NOTE_TITLE).id, {
      action: "accept",
      note: TASK_NOTE,
      noteId,
    });
    expect(withNote.status).toBe(200);
    expect(withNote.body.task).toMatchObject({ accepted: true, state: "open" });
    expect((withNote.body as { noteId?: string }).noteId).toBe(noteId);
    const saved = (await bench.obs.tellNotes(TODAY)).find((n) => n.id === noteId);
    expect(saved).toMatchObject({
      taskId: byTitle(NOTE_TITLE).id,
      text: `This is a note about the task “${NOTE_TITLE}”: ${TASK_NOTE}`,
    });
    // The note waits out its settle time on the gateway's clock.
    await bench.clock.set(NOON + 60_000);
    const receipt = await waitFor(
      `the note agent's receipt for ${noteId}`,
      async () => {
        const note = (await bench.obs.tellNotes(TODAY)).find((n) => n.id === noteId);
        return note?.agent?.state === "done" ? note.agent.receipt : null;
      },
      90_000,
    );
    expect(receipt?.changes.map((c) => c.taskId)).toEqual([byTitle(NOTE_TITLE).id]);
    expect((await bench.obs.task(byTitle(NOTE_TITLE).id)).task.description).toBe(
      TASK_NOTE_DESCRIPTION,
    );

    // Marked already done: closed in one step, in the done list, undoable.
    const done = await act(byTitle(DONE_TITLE).id, { action: "complete" });
    expect(done.body.task).toMatchObject({ state: "done", accepted: true });
    expect((await bench.obs.task(byTitle(DONE_TITLE).id)).history[0]).toMatchObject({
      kind: "completed",
      note: "Already done",
    });
    expect(await titles("done")).toContain(DONE_TITLE);
    expect((await bench.obs.undoTask(done.body.receipt.undoSeq!)).status).toBe(200);
    expect((await bench.obs.task(byTitle(DONE_TITLE).id)).task).toMatchObject({
      state: "open",
      accepted: false,
    });
    expect(await titles("suggested")).toContain(DONE_TITLE);

    // Accepted for a later month: planned there, undoable back to a suggestion.
    const later = await act(byTitle(LATER_TITLE).id, {
      action: "accept",
      scheduledFor: NEXT_MONTH,
    });
    expect(later.body.task).toMatchObject({ accepted: true, scheduledFor: NEXT_MONTH });
    expect([...(await titles("month")), ...(await titles("future"))]).toContain(LATER_TITLE);
    expect(await titles("today")).not.toContain(LATER_TITLE);
    expect((await bench.obs.undoTask(later.body.receipt.undoSeq!)).status).toBe(200);
    expect(await titles("suggested")).toContain(LATER_TITLE);
  }, 240_000);

  test("a run's change to a user task is a proposal the user confirms", async () => {
    const task = await create({ title: USER_TASK_TITLE, scheduledFor: TODAY });
    await bench.pushAndSettle([{ ...RECEIPT, at: NOON }]);

    const detail = await bench.obs.task(task.task!.id);
    // The task kept its values: nothing a run decides applies on its own.
    expect(detail.task.state).toBe("open");
    expect(detail.task.proposedChange).toMatchObject({
      kind: "complete",
      reason: "The receipt says the invoice was paid in full today.",
      evidence: [await bench.docId(RECEIPT.externalId)],
    });
    expect((await bench.obs.tasks("today")).counts.proposals).toBe(1);

    // Without a reason the change was refused, and the delete was refused outright.
    const docId = await bench.docId(RECEIPT.externalId);
    const [run] = await bench.obs.runsForSource(docId);
    const steps = await bench.obs.executedTools(run!.id);
    expect(
      steps
        .filter((s) => s.tool === "open_loop_update")
        .map((s) => s.result?.code ?? s.result?.kind),
    ).toEqual(["reason_required", "structured"]);
    expect(steps.find((s) => s.tool === "open_loop_delete")?.result).toMatchObject({
      kind: "error",
      code: "user_task",
    });

    const confirmed = await act(task.task!.id, { action: "confirm" });
    expect(confirmed.body.receipt.text).toBe(`Confirmed: ${USER_TASK_TITLE}`);
    expect(confirmed.body.task).toMatchObject({ state: "done", proposedChange: null });
    expect((await bench.obs.task(task.task!.id)).history[0]).toMatchObject({
      kind: "proposal_confirmed",
    });
  }, 240_000);

  test("a verified completion applies on its own, shows in history, and undo restores it", async () => {
    const task = await create({ title: PERMIT_TASK, scheduledFor: TODAY });
    await bench.pushAndSettle([{ ...PERMIT, at: NOON }]);
    const permitDoc = await bench.docId(PERMIT.externalId);

    // The verifier was asked whether the quote establishes the fact behind the change.
    expect(
      bench.entailmentCalls.some(
        (c) => c.claim?.includes("So this is done: Renew the parking permit") === true,
      ),
    ).toBe(true);

    const detail = await bench.obs.task(task.task!.id);
    expect(detail.task).toMatchObject({ state: "done", proposedChange: null });
    expect(detail.history[0]).toMatchObject({
      kind: "auto_applied",
      surface: "brain",
      change: "complete",
      note: PERMIT_REASON,
      evidence: [permitDoc],
    });
    expect(detail.undoSeq).toBe(detail.history[0]!.seq);
    expect((await bench.obs.tasks("today")).counts.proposals).toBe(0);

    const undone = await bench.obs.undoTask(detail.undoSeq!);
    expect(undone.status).toBe(200);
    const after = await bench.obs.task(task.task!.id);
    expect(after.task).toMatchObject({ state: "open", proposedChange: null });
    expect(after.history.map((e) => e.kind).slice(0, 2)).toEqual(["undone", "auto_applied"]);
  }, 240_000);

  test("an unverified completion and a strike stay proposals", async () => {
    const cleaning = await create({ title: DRY_CLEANING_TASK, scheduledFor: TODAY });
    const gym = await create({ title: GYM_TASK, scheduledFor: TODAY });
    await bench.pushAndSettle([
      { ...DRY_CLEANING, at: NOON },
      { ...GYM, at: NOON },
    ]);

    const unverified = await bench.obs.task(cleaning.task!.id);
    expect(unverified.task).toMatchObject({
      state: "open",
      proposedChange: { kind: "complete" },
    });
    expect(unverified.history.some((e) => e.kind === "auto_applied")).toBe(false);
    expect(bench.entailmentCalls.some((c) => c.claim?.includes(UNSUPPORTED_FACT) === true)).toBe(
      true,
    );

    // Striking is the user's call, whatever the evidence: the verifier is not asked.
    const struck = await bench.obs.task(gym.task!.id);
    expect(struck.task).toMatchObject({ state: "open", proposedChange: { kind: "strike" } });
    expect(bench.entailmentCalls.some((c) => c.claim?.includes("gym") === true)).toBe(false);
  }, 240_000);

  test("a title the user edited is never changed on its own", async () => {
    const task = await create({ title: BOILER_TASK });
    expect((await act(task.task!.id, { action: "edit", title: BOILER_EDITED_TITLE })).status).toBe(
      200,
    );
    await bench.pushAndSettle([{ ...BOILER, at: NOON }]);
    const detail = await bench.obs.task(task.task!.id);
    expect(detail.task).toMatchObject({
      title: BOILER_EDITED_TITLE,
      proposedChange: { kind: "edit", fields: { title: "Book the annual gas safety check" } },
    });
    expect(detail.history.some((e) => e.kind === "auto_applied")).toBe(false);
  }, 240_000);

  test("a proposal on an accepted suggestion can be refused, keeping the task as it is", async () => {
    await bench.pushAndSettle([{ ...RENAME, at: NOON }]);
    const accepted = (await view("today")).find((t) => t.title === ACCEPTED_TITLE)!;
    expect(accepted.proposedChange).toMatchObject({
      kind: "edit",
      fields: { title: "Return the signed venue hire agreement" },
    });
    const kept = await act(accepted.id, { action: "keep" });
    expect(kept.body.receipt.text).toBe(`Kept as is: ${ACCEPTED_TITLE}`);
    expect(kept.body.task).toMatchObject({ title: ACCEPTED_TITLE, proposedChange: null });
    expect((await act(accepted.id, { action: "keep" })).status).toBe(400);
  }, 240_000);

  test("decay schedules checks for Brain suggestions and never for the user's own tasks", async () => {
    const own = await create({ title: DECAY_USER_TITLE });
    await bench.pushAndSettle([{ ...DECAY_DOC, at: NOON }]);
    const loop = (await bench.obs.tasks("suggested")).tasks.find(
      (t) => t.title === DECAY_LOOP_TITLE,
    )!;

    // The sweep that scheduled the suggestion's check saw the user's task too.
    await waitFor(
      () => `a decay check for ${loop.id} (have: ${bench.pendingDedupeKeys().join(", ")})`,
      () => (bench.pendingDedupeKeys().includes(`decay:loop:${loop.id}`) ? true : null),
      30_000,
    );
    expect(bench.pendingDedupeKeys()).not.toContain(`decay:loop:${own.task!.id}`);

    // Months pass: the suggestion is retired, the user's task is untouched.
    await bench.clock.set(NOON + 3 * HOUR);
    await bench.drainUntilQuiet({ includeUpcoming: false });
    await bench.clock.set(NOON + 60 * DAY);
    await bench.drainUntilQuiet({ includeUpcoming: false });
    expect((await bench.obs.task(loop.id)).task.state).toBe("dismissed");
    const decayRuns = await bench.obs.settledRuns("time_based");
    expect(decayRuns.some((r) => r.dedupeKey === `decay:loop:${loop.id}`)).toBe(true);
    expect(decayRuns.some((r) => r.dedupeKey === `decay:loop:${own.task!.id}`)).toBe(false);
    expect(bench.pendingDedupeKeys()).not.toContain(`decay:loop:${own.task!.id}`);
    expect((await bench.obs.task(own.task!.id)).task.state).toBe("open");
    // An accepted suggestion is the user's task too: no decay pass retired it.
    expect((await view("today")).find((t) => t.title === ACCEPTED_TITLE)?.state).toBe("open");
  }, 300_000);

  test("a task lists its documents, and deleting one of them purges the task", async () => {
    const now = (await bench.clock.now()).now;
    await bench.pushAndSettle([{ ...LOAN_CARD, at: now }]);
    loanCardId = await bench.docId(LOAN_CARD.externalId);
    await bench.pushAndSettle([{ ...LOAN_REMINDER, at: now }]);
    const reminderId = await bench.docId(LOAN_REMINDER.externalId);

    const suggestion = (await bench.obs.tasks("suggested")).tasks.find(
      (t) => t.title === LOAN_TITLE,
    )!;
    const accepted = await act(suggestion.id, { action: "accept" });
    const listed = accepted.body.task!.documents;
    expect(listed.map((d) => d.id).sort()).toEqual([loanCardId, reminderId].sort());
    expect(Object.fromEntries(listed.map((d) => [d.id, d.title]))).toEqual({
      [loanCardId]: LOAN_CARD.title,
      [reminderId]: LOAN_REMINDER.title,
    });
    // Every document names its source, which picks the icon a client shows.
    const sources = new Set(listed.map((d) => d.sourceId));
    expect(sources.size).toBe(1);
    expect([...sources][0]).not.toBe("");

    // Deleting a document removes what was derived from it, the task included.
    await bench.deleteDoc(loanCardId);
    await bench.drainUntilQuiet({ includeUpcoming: false });
    await expect(bench.obs.task(suggestion.id)).rejects.toMatchObject({ status: 404 });
    expect((await view("anytime")).some((t) => t.id === suggestion.id)).toBe(false);
  }, 300_000);
});
