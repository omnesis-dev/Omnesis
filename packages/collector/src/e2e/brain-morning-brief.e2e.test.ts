// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: the morning brief.
 *
 * The one message a day the Brain writes to the user. The morning run's
 * preflight rechecks the open observations; when there is anything to say
 * (ranked observations, a calendar horizon, a task coming due) the steward
 * composes the message and calls `morning_brief_send`, which appends ONE
 * assistant message to the standing, pinned, undeletable "Morning brief"
 * conversation and ships that morning's ranked observations. A quiet morning
 * sends nothing at all.
 *
 * The suite walks a week on the virtual clock, one morning per test, with
 * replies in the thread: the interactive agent (the conversation puppet) acts
 * on "the first one" through the real task tools, with its model context
 * scoped to the latest brief. It ends on a morning whose cognition budget the
 * night's maintenance already spent: the brief still goes out.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  salienceDecisionPolicy,
  sourceInterpretations,
  waitFor,
  type ConversationContext,
  type ObservationDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DIGEST_HOUR = 7;
const GRACE_MINUTES = 45;

/**
 * A wall-clock time on the local calendar day of `ms`. Set through the
 * calendar, never by adding hours to midnight, so a day the clocks change on
 * keeps its 07:00 at 07:00.
 */
function localAt(ms: number, hours: number, minutes = 0): number {
  const d = new Date(ms);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

// ── the week ────────────────────────────────────────────────────────────────

let NOON0 = 0;
const dayAt = (k: number, hours: number, minutes = 0) => localAt(NOON0 + k * DAY, hours, minutes);
/** Past the grace deadline on day `k` after the start: the morning run fires without waiting. */
const morning = (k: number) => dayAt(k, DIGEST_HOUR, GRACE_MINUTES + 15);
const noon = (k: number) => dayAt(k, 12);

/** Day keys, resolved once the bench exists. */
const DAYS = { empty: "", dueTask: "", ranked: "", retried: "", saturday: "", spent: "" };
/** Day offsets of the scenario's mornings. */
let SATURDAY_K = 0;
let SPENT_K = 0;

// ── stimuli ─────────────────────────────────────────────────────────────────

const DUE_TASK_TITLE = "Return the library books";
const BOILER_TASK_TITLE = "Book the boiler engineer";

interface Noted {
  marker: string;
  externalId: string;
  title: string;
  quote: string;
}

const RANKED: Record<"high" | "omit" | "low", Noted> = {
  high: {
    marker: "council tax",
    externalId: "mb-council-tax",
    title: "Council tax reminder",
    quote: "The second council tax instalment is overdue as of this week.",
  },
  omit: {
    marker: "loyalty points",
    externalId: "mb-loyalty-points",
    title: "Loyalty points statement",
    quote: "Your loyalty points expire at the end of the quarter.",
  },
  low: {
    marker: "book club",
    externalId: "mb-book-club",
    title: "Book club pick",
    quote: "The book club moved this month's meeting to the café by the mill.",
  },
};
const RETRIED: Noted = {
  marker: "water meter",
  externalId: "mb-water-meter",
  title: "Water meter reading",
  quote: "Please submit your water meter reading within ten days.",
};
/** Interpreted overnight, spending the day's budget before the morning run. */
const OVERNIGHT: Noted = {
  marker: "parking permit",
  externalId: "mb-parking-permit",
  title: "Parking permit renewal",
  quote: "Your residents' parking permit lapses at the end of the month.",
};
/** Arrives once the budget is spent, so its interpretation stays parked. */
const PARKED: Noted = {
  marker: "window cleaner",
  externalId: "mb-window-cleaner",
  title: "Window cleaner visit",
  quote: "The window cleaner will call round on Thursday afternoon.",
};
/** Noted before the ranked morning, but it only matters from the retried morning on. */
const LATER: Noted = {
  marker: "gutter clearing",
  externalId: "mb-gutter-clearing",
  title: "Gutter clearing booking",
  quote: "The gutter clearing crew is booked for the morning after next.",
};
const BOILER: Noted = {
  marker: "boiler engineer",
  externalId: "mb-boiler-engineer",
  title: "Boiler engineer availability",
  quote: "The engineer has one free slot left next week for the annual service.",
};

function docFor(n: Noted, at: number) {
  return email({
    externalId: n.externalId,
    title: n.title,
    content: `Hello,\n\n${n.quote}\n\nRegards,\nRiverside Estate`,
    at,
  });
}

function noteOne(n: Noted, windowStart?: () => number) {
  return {
    docTitle: n.title,
    plan: (ctx: { subject: string | null }) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${n.marker} needs a look.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: n.quote }],
          ...(windowStart ? { windowStart: new Date(windowStart()).toISOString() } : {}),
        }),
      ],
    }),
  };
}

/** The ranked items the morning prompt lists: `[id, line]`, in order. */
function rankedLines(prompt: string): Array<[string, string]> {
  return [...prompt.matchAll(/^\d+\. \[(obs_[^\]]+)\](.*)$/gm)].map((m) => [m[1]!, m[2]!]);
}

/** The context the agent's system prompt carries for a reply in the brief thread. */
function briefItems(
  ctx: ConversationContext,
): Array<{ observationId: string; loopId: string | null }> {
  return [...ctx.systemPrompt.matchAll(/^\d+\. \[(obs_[^\]]+)\](.*)$/gm)].map((m) => ({
    observationId: m[1]!,
    loopId: /tasks: (\S+) "/.exec(m[2]!)?.[1] ?? null,
  }));
}

const REPLY_DONE = "The first one is done, I booked it this morning.";
const REPLY_SUPPRESS = "Stop telling me about the boiler, and add a task to buy a boiler filter.";
const ORDINARY = "Put buying stamps on my list for this Saturday.";

describe("brain bench: the morning brief", () => {
  let bench: BrainBench;
  let briefConversationId = "";

  const digestRun = async (day: string) => {
    const runs = await bench.obs.runs({ kind: "daily" });
    const run = runs.items.find((r) => r.dedupeKey === `daily:digest:${day}`);
    if (!run) throw new Error(`no morning run for ${day}`);
    return run;
  };
  const crossMorning = async (k: number, day: string) => {
    await bench.clock.set(morning(k));
    await bench.markers.waitFor("digest_last_run_day", (v) => v === day, 60_000);
    await bench.drainUntilQuiet({ includeUpcoming: false });
  };
  const byMarker = async (marker: string): Promise<ObservationDto> => {
    const matches = await bench.obs.observationsMatching(marker);
    if (matches.length !== 1)
      throw new Error(`expected one observation for "${marker}", got ${matches.length}`);
    return matches[0]!;
  };
  const assistantTexts = async () =>
    (await bench.obs.conversation(briefConversationId)).messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.parts.map((p) => p.text ?? "").join(""));

  /** Send one reply and wait for the turn's closing text to persist. */
  const reply = async (conversationId: string, text: string, closing: string) => {
    const session = await bench.harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
      method: "POST",
      body: JSON.stringify(conversationId ? { resumeFromId: conversationId } : {}),
    });
    await bench.harness.gatewayJson(`/agent/sessions/${session.sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    await waitFor(
      `the reply "${text}" to complete`,
      async () => {
        const res = await bench.harness.gatewayFetch(`/agent/conversations/${session.sessionId}`);
        if (!res.ok) return null;
        const record = (await res.json()) as {
          messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
        };
        const last = record.messages.at(-1);
        return last?.role === "assistant" && last.parts.some((p) => p.text === closing)
          ? true
          : null;
      },
      60_000,
    );
    return session.sessionId;
  };

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      syncSources: false,
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        digest: { enabled: true, hour: DIGEST_HOUR, graceMinutes: GRACE_MINUTES, push: false },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
      decision: {
        policy: salienceDecisionPolicy([
          [RANKED.high.marker, { consequence: 4, timing: 2, alreadyKnown: 0 }],
          [RANKED.omit.marker, { consequence: 3, timing: 1, alreadyKnown: 0 }],
          [RANKED.low.marker, { consequence: 2, timing: 1, alreadyKnown: 0 }],
          [LATER.marker, { consequence: 4, timing: 3, alreadyKnown: 0 }],
        ]),
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            noteOne(RANKED.high),
            noteOne(RANKED.omit),
            noteOne(RANKED.low),
            noteOne(RETRIED),
            noteOne(LATER, () => dayAt(4, 9)),
            noteOne(OVERNIGHT),
            noteOne(PARKED),
            {
              docTitle: BOILER.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: BOILER_TASK_TITLE }),
                  call("observation_list", {}),
                  call("observation_note", {
                    summary: `The ${BOILER.marker} has one slot left next week.`,
                    citations: [ctx.subject],
                    claims: [{ docId: ctx.subject, quote: BOILER.quote }],
                    relatedLoopIds: [ref("open_loop_search", "loops.0.id")],
                  }),
                ],
              }),
            },
          ],
        }),
        behaviors: [
          {
            flavour: "daily.digest",
            plan: (ctx) => {
              const day = ctx.subject!;
              // The skipped send: the first attempt composes nothing.
              if (day === DAYS.retried && ctx.attempt === 1)
                return { calls: [], finalText: "Nothing worth sending." };
              const lines = rankedLines(ctx.prompt);
              const omitted = lines
                .filter(([, line]) => line.includes(RANKED.omit.marker))
                .map(([id]) => id);
              const text = [
                `Today (${day}):`,
                ctx.prompt.includes(DUE_TASK_TITLE)
                  ? `- ${DUE_TASK_TITLE} is due.`
                  : "- Nothing due.",
                ...(lines.length ? ["", "Worth your attention:"] : []),
                ...lines
                  .filter(([id]) => !omitted.includes(id))
                  .map(([id, line], i) => `${i + 1}. ${line.trim()} (${id})`),
              ].join("\n");
              return {
                calls: [
                  call("morning_brief_send", {
                    text,
                    ...(omitted.length ? { omittedObservationIds: omitted } : {}),
                  }),
                  // A second send the same morning is refused.
                  ...(day === DAYS.ranked
                    ? [call("morning_brief_send", { text: "A second brief the same day." })]
                    : []),
                ],
                finalText: "Sent the morning brief.",
              };
            },
          },
        ],
      },
      agent: {
        behaviors: [
          {
            messageContains: REPLY_DONE,
            plan: (ctx) => ({
              calls: [
                call("task_update", {
                  id: briefItems(ctx)[0]?.loopId ?? "missing-loop",
                  action: "complete",
                  note: "Booked this morning.",
                }),
              ],
              finalText: `Done: ${BOILER_TASK_TITLE}.`,
            }),
          },
          {
            messageContains: REPLY_SUPPRESS,
            plan: (ctx) => ({
              calls: [
                call("observation_suppress", {
                  id: briefItems(ctx)[0]?.observationId ?? "missing-observation",
                  reason: "The user does not want boiler reminders.",
                }),
                call("task_list", { query: "boiler filter" }),
                call("task_create", { title: "Buy a boiler filter" }),
              ],
              finalText: "Won't mention the boiler again, and added the filter.",
            }),
          },
          {
            messageContains: ORDINARY,
            plan: () => ({
              calls: [
                call("task_list", { query: "stamps" }),
                call("task_create", { title: "Buy stamps", scheduledFor: DAYS.saturday }),
              ],
              finalText: "Added: Buy stamps.",
            }),
          },
        ],
      },
    });
    const bootNow = (await bench.clock.now()).now;
    NOON0 = localAt(localAt(bootNow, 0) + 36 * HOUR, 12);
    DAYS.empty = bench.clock.localDay(morning(1));
    DAYS.dueTask = bench.clock.localDay(morning(2));
    DAYS.ranked = bench.clock.localDay(morning(3));
    DAYS.retried = bench.clock.localDay(morning(4));
    SATURDAY_K = 5;
    while (new Date(morning(SATURDAY_K)).getDay() !== 6) SATURDAY_K += 1;
    DAYS.saturday = bench.clock.localDay(morning(SATURDAY_K));
    SPENT_K = SATURDAY_K + 1;
    DAYS.spent = bench.clock.localDay(morning(SPENT_K));
    await bench.clock.set(NOON0);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a morning with nothing to say sends no message and the run completes", async () => {
    await crossMorning(1, DAYS.empty);
    const run = await digestRun(DAYS.empty);
    expect(run.status).toBe("completed");
    // Settled in preflight: no model was bought.
    expect((await bench.obs.run(run.id)).transcripts).toEqual([]);
    expect((await bench.obs.morningBrief(DAYS.empty)).sent).toBeNull();
    const conversations = await bench.obs.conversations();
    expect(conversations.conversations.filter((c) => c.origin?.kind === "daily_brief")).toEqual([]);
  }, 180_000);

  test("a task coming due is enough for a brief: one message in the pinned Morning brief conversation", async () => {
    await bench.clock.set(noon(1));
    const created = await bench.obs.createTask({
      title: DUE_TASK_TITLE,
      deadline: { type: "by", date: DAYS.dueTask },
    });
    expect(created.task).toMatchObject({ origin: "user", state: "open" });

    await crossMorning(2, DAYS.dueTask);
    const run = await digestRun(DAYS.dueTask);
    expect(run.status).toBe("completed");
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain(`Morning brief for ${DAYS.dueTask}.`);
    expect(prompt).toContain(DUE_TASK_TITLE);
    expect(prompt).toContain("Ranked observations: (none today");

    const brief = await bench.obs.morningBrief(DAYS.dueTask);
    expect(brief.sent).toMatchObject({ day: DAYS.dueTask, runId: run.id, itemCount: 0 });
    expect(brief.items).toEqual([]);
    briefConversationId = brief.sent!.conversationId;

    const listed = (await bench.obs.conversations()).conversations.filter(
      (c) => c.origin?.kind === "daily_brief",
    );
    expect(listed.map((c) => c.id)).toEqual([briefConversationId]);
    expect(listed[0]).toMatchObject({ title: "Morning brief", pinned: true });

    const conversation = await bench.obs.conversation(briefConversationId);
    expect(conversation.origin).toMatchObject({
      kind: "daily_brief",
      runId: run.id,
      briefs: [{ day: DAYS.dueTask, messageIndex: 0, messageId: brief.sent!.messageId }],
    });
    expect(await assistantTexts()).toEqual([expect.stringContaining(`${DUE_TASK_TITLE} is due.`)]);

    // The brief thread is permanent: it cannot be deleted.
    const deleted = await bench.harness.gatewayFetch(
      `/agent/conversations/${briefConversationId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(409);
    expect((await bench.obs.conversations()).conversations.map((c) => c.id)).toContain(
      briefConversationId,
    );

    // Done with it, so the following mornings carry only their own inputs.
    const done = await bench.obs.taskAction(created.task!.id, { action: "complete" });
    expect(done.status).toBe(200);
  }, 240_000);

  test("ranked observations ship in order, an omitted one is suppressed, and a second send is refused", async () => {
    await bench.clock.set(noon(2));
    await bench.pushAndSettle([...Object.values(RANKED), LATER].map((n) => docFor(n, noon(2))));
    for (const n of [...Object.values(RANKED), LATER])
      expect((await byMarker(n.marker)).state).toBe("live");

    await crossMorning(3, DAYS.ranked);
    const run = await digestRun(DAYS.ranked);
    expect(run.status).toBe("completed");

    const brief = await bench.obs.morningBrief(DAYS.ranked);
    expect(brief.items.map((i) => [i.rank, i.observation?.summary])).toEqual([
      [1, expect.stringContaining(RANKED.high.marker)],
      [2, expect.stringContaining(RANKED.omit.marker)],
      [3, expect.stringContaining(RANKED.low.marker)],
    ]);
    expect(brief.sent).toMatchObject({ day: DAYS.ranked, conversationId: briefConversationId });
    // Its window opens on a later morning: not in this brief, and still live for that one.
    expect(await byMarker(LATER.marker)).toMatchObject({ state: "live", shippedMessageId: null });

    const high = await byMarker(RANKED.high.marker);
    const low = await byMarker(RANKED.low.marker);
    for (const shipped of [high, low])
      expect(shipped).toMatchObject({
        state: "shipped",
        shippedConversationId: briefConversationId,
        shippedMessageId: brief.sent!.messageId,
      });
    expect(await byMarker(RANKED.omit.marker)).toMatchObject({
      state: "dropped",
      closeReason: "suppressed",
      shippedMessageId: null,
    });

    const sends = (await bench.obs.executedTools(run.id)).filter(
      (s) => s.tool === "morning_brief_send",
    );
    expect(sends.map((s) => s.result?.kind)).toEqual(["structured", "error"]);
    expect(sends[0]!.result).toMatchObject({
      resultType: "morning_brief.sent",
      data: { conversationId: briefConversationId, shippedObservations: 2 },
    });
    expect(sends[1]!.result).toMatchObject({ code: "already_sent" });

    // One message per morning, appended to the same conversation.
    const texts = await assistantTexts();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain(RANKED.high.marker);
    expect(texts[1]).not.toContain(RANKED.omit.marker);
    expect(
      (await bench.obs.conversation(briefConversationId)).origin?.briefs?.map((b) => b.day),
    ).toEqual([DAYS.dueTask, DAYS.ranked]);
  }, 300_000);

  test("a morning run that does not send fails validation and the retry sends", async () => {
    await bench.clock.set(noon(3));
    await bench.pushAndSettle([docFor(RETRIED, noon(3))]);

    await crossMorning(4, DAYS.retried);
    const run = await digestRun(DAYS.retried);
    const row = bench.runRow(run.id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toContain("The morning brief was not sent");
    expect((await bench.obs.morningBrief(DAYS.retried)).sent).toBeNull();

    // The retry is due after its backoff, still the same morning.
    await bench.clock.set(Number(row.next_attempt_at));
    await waitFor(
      "the morning retry to settle",
      async () => ((await bench.obs.run(run.id)).run.status === "completed" ? true : null),
      90_000,
    );
    expect((await bench.obs.morningBrief(DAYS.retried)).sent?.runId).toBe(run.id);
    expect(await byMarker(RETRIED.marker)).toMatchObject({ state: "shipped" });
    // The morning its window opens, the deferred observation ships.
    const later = await byMarker(LATER.marker);
    expect(later).toMatchObject({ state: "shipped" });
    expect(
      (await bench.obs.morningBrief(DAYS.retried)).items.map((i) => i.observationId),
    ).toContain(later.id);
    expect(await assistantTexts()).toHaveLength(3);
  }, 300_000);

  test("a Saturday morning is a morning like any other", async () => {
    // The eve's own morning run settles first, so the observation noted
    // below waits for Saturday's.
    const eve = bench.clock.localDay(noon(SATURDAY_K - 1));
    await bench.clock.set(noon(SATURDAY_K - 1));
    await bench.markers.waitFor("digest_last_run_day", (v) => v === eve, 60_000);
    await bench.drainUntilQuiet({ includeUpcoming: false });
    const task = await bench.obs.createTask({ title: BOILER_TASK_TITLE, scheduledFor: "someday" });
    expect(task.task?.id).toBeTruthy();
    await bench.pushAndSettle([docFor(BOILER, noon(SATURDAY_K - 1))]);
    const boiler = await byMarker(BOILER.marker);
    expect(boiler.relatedLoopIds).toEqual([task.task!.id]);

    await crossMorning(SATURDAY_K, DAYS.saturday);
    expect(new Date(`${DAYS.saturday}T12:00:00`).getDay()).toBe(6);
    const brief = await bench.obs.morningBrief(DAYS.saturday);
    expect(brief.sent?.day).toBe(DAYS.saturday);
    expect(brief.items.map((i) => i.observationId)).toEqual([boiler.id]);
    expect(await assistantTexts()).toHaveLength(4);
  }, 300_000);

  test("each brief in the thread serves what it was based on: shipped items, sources and tasks", async () => {
    const conversation = await bench.obs.conversation(briefConversationId);
    const refs = conversation.origin?.briefs ?? [];
    expect(refs.map((ref) => ref.day)).toEqual([
      DAYS.dueTask,
      DAYS.ranked,
      DAYS.retried,
      DAYS.saturday,
    ]);
    // Each reference records when its brief was appended.
    for (const ref of refs) expect(ref.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    // The ranked morning: the omitted item is absent and takes no number.
    const ranked = await bench.obs.briefDetail(briefConversationId, DAYS.ranked);
    const sent = (await bench.obs.morningBrief(DAYS.ranked)).sent!;
    expect(ranked).toMatchObject({
      day: DAYS.ranked,
      messageId: sent.messageId,
      sentAt: sent.sentAt,
    });
    const [high, low] = await Promise.all([
      byMarker(RANKED.high.marker),
      byMarker(RANKED.low.marker),
    ]);
    const highDoc = await bench.docId(RANKED.high.externalId);
    expect(ranked.items).toEqual([
      {
        rank: 1,
        observationId: high.id,
        summary: high.summary,
        sources: [
          {
            id: highDoc,
            title: RANKED.high.title,
            sourceType: expect.any(String),
            createdAt: new Date(noon(2)).toISOString(),
          },
        ],
        tasks: [],
      },
      expect.objectContaining({ rank: 2, observationId: low.id }),
    ]);
    const omitted = await byMarker(RANKED.omit.marker);
    expect(ranked.items.map((i) => i.observationId)).not.toContain(omitted.id);

    // The weekend brief's item carries its related task, as it stands now.
    const saturday = await bench.obs.briefDetail(briefConversationId, DAYS.saturday);
    const boiler = await byMarker(BOILER.marker);
    expect(saturday.items).toEqual([
      expect.objectContaining({
        rank: 1,
        observationId: boiler.id,
        tasks: [{ id: boiler.relatedLoopIds[0], title: BOILER_TASK_TITLE, state: "open" }],
      }),
    ]);

    // A brief with no ranked items is based on nothing.
    expect((await bench.obs.briefDetail(briefConversationId, DAYS.dueTask)).items).toEqual([]);

    // A day with no brief in the thread, and a malformed day, are refused.
    const path = (day: string) => `/agent/conversations/${briefConversationId}/briefs/${day}`;
    expect(await bench.obs.statusOf(path(DAYS.empty))).toBe(404);
    expect(await bench.obs.statusOf(path("not-a-day"))).toBe(400);
  }, 120_000);

  test("a reply in the thread resolves 'the first one' from the latest brief and completes its task", async () => {
    await reply(briefConversationId, REPLY_DONE, `Done: ${BOILER_TASK_TITLE}.`);

    // The model saw the latest brief onward, with the day's items in its system prompt.
    const call0 = bench.conversationCalls.find((c) => c.context.message.includes(REPLY_DONE))!;
    expect(call0.context.systemPrompt).toContain("Morning brief conversation");
    expect(call0.context.systemPrompt).toContain(`brief you sent on ${DAYS.saturday}`);
    const history = call0.context.history.filter((m) => m.role !== "system");
    expect(history[0]!.content).toBe(`(This morning's brief, ${DAYS.saturday}.)`);
    expect(JSON.stringify(history)).not.toContain(RANKED.high.marker);
    expect(briefItems(call0.context)).toEqual([
      { observationId: (await byMarker(BOILER.marker)).id, loopId: expect.any(String) },
    ]);

    const loopId = briefItems(call0.context)[0]!.loopId!;
    const detail = await bench.obs.task(loopId);
    expect(detail.task).toMatchObject({ state: "done", completionNote: "Booked this morning." });
    expect(detail.history[0]).toMatchObject({
      kind: "completed",
      surface: "conversation",
      conversationId: briefConversationId,
    });
  }, 180_000);

  test("a reply can suppress an item and add a task, and the receipts land in the thread", async () => {
    await reply(
      briefConversationId,
      REPLY_SUPPRESS,
      "Won't mention the boiler again, and added the filter.",
    );
    const boiler = await byMarker(BOILER.marker);
    // Already shipped, so it stays shipped; what the user did is recorded.
    expect(boiler).toMatchObject({ state: "shipped", userAction: "suppressed" });

    const today = await bench.obs.tasks("anytime");
    const filter = today.tasks.find((t) => t.title === "Buy a boiler filter");
    expect(filter).toMatchObject({ origin: "user", state: "open" });
    const history = (await bench.obs.task(filter!.id)).history;
    expect(history[0]).toMatchObject({
      kind: "created",
      surface: "conversation",
      conversationId: briefConversationId,
    });

    const conversation = await bench.obs.conversation(briefConversationId);
    const results = conversation.messages.flatMap((m) =>
      m.parts.filter((p) => p.kind === "tool_result" || p.result !== undefined),
    );
    expect(JSON.stringify(results)).toContain("Won't mention again");
    expect(JSON.stringify(results)).toContain("Added: Buy a boiler filter");
  }, 180_000);

  test("an ordinary conversation has the task tools too", async () => {
    const id = await reply("", ORDINARY, "Added: Buy stamps.");
    expect(id).not.toBe(briefConversationId);
    const month = await bench.obs.tasks("today", { date: DAYS.saturday });
    const stamps = month.tasks.find((t) => t.title === "Buy stamps");
    expect(stamps).toMatchObject({ origin: "user", scheduledFor: DAYS.saturday });
    expect((await bench.obs.task(stamps!.id)).history[0]).toMatchObject({
      surface: "conversation",
      conversationId: id,
    });
    // An ordinary conversation is deletable. The reply is readable as soon as
    // it is saved, a moment before its turn finishes settling (read state,
    // spend); until then the gateway answers "still processing", which is a
    // wait, not a refusal.
    const deleted = await waitFor(
      "the reply's turn to release the conversation",
      async () => {
        const response = await bench.harness.gatewayFetch(`/agent/conversations/${id}`, {
          method: "DELETE",
        });
        if (response.status === 409 && (await response.clone().text()).includes("still processing"))
          return null;
        return response;
      },
      30_000,
    );
    expect(deleted.status).toBe(200);
  }, 180_000);

  test("a morning whose budget is already spent still sends the brief, and nothing else runs", async () => {
    // Overnight maintenance spends the day's budget before the brief is due.
    await bench.clock.set(dayAt(SPENT_K, 1));
    await bench.pushAndSettle([docFor(OVERNIGHT, dayAt(SPENT_K, 1))]);
    expect((await byMarker(OVERNIGHT.marker)).state).toBe("live");
    const budgetNow = () =>
      bench.harness.gatewayJson<{
        day: string;
        usedRuns: number;
        exhausted: { dimension: string; reason: string } | null;
      }>("/admin/brain/budget");
    const overnight = await budgetNow();
    expect(overnight.day).toBe(DAYS.spent);
    expect(overnight.usedRuns).toBeGreaterThan(0);
    await bench.patchConfig({ brain: { budget: { dailyRuns: overnight.usedRuns } } });
    const spent = await budgetNow();
    expect(spent.exhausted).toMatchObject({ dimension: "runs" });
    expect(spent.exhausted!.reason).toContain("the morning brief still runs");

    const parked = docFor(PARKED, dayAt(SPENT_K, 1));
    await bench.push(parked);
    const parkedId = await bench.docId(PARKED.externalId);

    // Inside the grace window: the parked queue cannot settle, and the
    // readiness barrier does not wait for it.
    await bench.clock.set(dayAt(SPENT_K, DIGEST_HOUR, 1));
    await bench.markers.waitFor("digest_last_run_day", (v) => v === DAYS.spent, 60_000);
    const run = await digestRun(DAYS.spent);
    await waitFor(
      "the morning run to settle on a spent budget",
      async () => ((await bench.obs.run(run.id)).run.status === "completed" ? true : null),
      90_000,
    );

    const brief = await bench.obs.morningBrief(DAYS.spent);
    expect(brief.sent).toMatchObject({
      day: DAYS.spent,
      runId: run.id,
      conversationId: briefConversationId,
    });
    expect(brief.items.map((i) => i.observation?.summary)).toEqual([
      expect.stringContaining(OVERNIGHT.marker),
    ]);
    expect((await assistantTexts()).at(-1)).toContain(OVERNIGHT.marker);

    // The brief's own spend counts toward the day, and cognition stays paused.
    const after = await budgetNow();
    expect(after.usedRuns).toBeGreaterThan(overnight.usedRuns);
    expect(after.exhausted).toMatchObject({ dimension: "runs" });
    // Everything else stayed parked: the late document was never interpreted.
    expect(await bench.obs.runsForSource(parkedId)).toEqual([]);
    expect(await bench.obs.observationsMatching(PARKED.marker)).toEqual([]);
  }, 300_000);
});
