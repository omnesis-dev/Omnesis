// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: tasks.
 *
 * A task is an open loop read the way a bullet journal is. The user's own
 * tasks (typed, from a note, or an accepted Brain suggestion) change only
 * through the user's commands or through a Brain proposal the user
 * confirms; a Brain loop the user has not accepted is a Suggestion.
 *
 * The suite drives the `/tasks` surface for real — views, commands,
 * receipts, undo — and the Brain's side of the contract through scripted
 * source-maintenance runs: loops it creates arrive as suggestions, its
 * change to a user task is recorded as a proposal (and refused without a
 * reason), it can never delete a user task, and the decay engine never
 * schedules a user task for retirement. A task lists the documents it refers
 * to by title and source, and a deleted document leaves that list.
 */

import "./synth-env.js";
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
const REFUSED_TITLE = "Pay the hall cleaning deposit";

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
                    title: REFUSED_TITLE,
                    confidence: 0.9,
                    importance: 0.6,
                    docs: [ctx.subject],
                  }),
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
      [ACCEPTED_TITLE, REFUSED_TITLE].sort(),
    );
    expect(suggested.counts.suggested).toBe(2);
    for (const t of suggested.tasks) expect(t).toMatchObject({ origin: "brain", accepted: false });
    // Suggestions stay out of the journal.
    for (const name of ["today", "month", "future", "anytime"])
      expect(await titles(name)).not.toContain(ACCEPTED_TITLE);

    const accepting = suggested.tasks.find((t) => t.title === ACCEPTED_TITLE)!;
    const refusing = suggested.tasks.find((t) => t.title === REFUSED_TITLE)!;

    // A suggestion cannot be planned or edited before it is accepted.
    expect((await act(refusing.id, { action: "edit", title: "Mine now" })).status).toBe(409);
    expect((await act(refusing.id, { action: "migrate", to: TODAY })).status).toBe(409);

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

    const refused = await act(refusing.id, { action: "refuse", reason: "Already paid." });
    expect(refused.body.receipt.text).toBe(`Not for you: ${REFUSED_TITLE}`);
    expect(refused.body.task?.state).toBe("dismissed");
    expect((await bench.obs.task(refusing.id)).history[0]).toMatchObject({ kind: "refused" });
    expect((await bench.obs.tasks("suggested")).tasks).toEqual([]);
    // A refused suggestion never reaches the user's done list.
    expect(await titles("done")).not.toContain(REFUSED_TITLE);
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
