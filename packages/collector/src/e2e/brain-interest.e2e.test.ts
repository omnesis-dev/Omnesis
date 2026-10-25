// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: the interest engine.
 *
 * What the owner does on purpose teaches the Brain what they care about:
 * accepting, creating or ignoring a task, a thumbs on a morning-brief item,
 * and what they say in the Morning brief conversation each become one signed
 * example in the interest ledger. The decision gates then see the examples
 * that resemble what they judge: the gate on a new Brain suggestion
 * (withhold / suggest / adopt), observation salience, and the urgency of new
 * evidence. The scripted decision server answers from what it is shown, so
 * every assertion is about the machine carrying a verdict out, never about
 * the verdict being right.
 *
 * The bench has no embedder, so the lookup matches by word overlap; the
 * fixtures are worded so that like matches like and nothing else does.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  isSalienceRequest,
  preserveCurrentOwner,
  salienceSubject,
  sourceInterpretations,
  waitFor,
  type ConversationContext,
  type TaskDto,
} from "./brain-bench/index.js";
import type { DecisionAnswer } from "@omnesis/core";
import type { DecisionServerRequest } from "./brain-bench/decision-server.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DIGEST_HOUR = 7;
const GRACE_MINUTES = 45;

function localAt(ms: number, hours: number, minutes = 0): number {
  const d = new Date(ms);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

let NOON0 = 0;
const dayAt = (k: number, hours: number, minutes = 0) => localAt(NOON0 + k * DAY, hours, minutes);
const morning = (k: number) => dayAt(k, DIGEST_HOUR, GRACE_MINUTES + 15);
const noon = (k: number) => dayAt(k, 12);
const DAYS = { first: "", second: "" };

// ── suggestions ─────────────────────────────────────────────────────────────

interface Suggested {
  externalId: string;
  title: string;
  task: string;
}

/** Accepted: the owner wants kitchen tasks. */
const KITCHEN: Suggested = {
  externalId: "interest-kitchen-tiles",
  title: "Kitchen tiles quote",
  task: "Choose the kitchen tiles",
};
/** Ignored: the owner does not want newsletter tasks. */
const NEWSLETTER: Suggested = {
  externalId: "interest-gardening-newsletter",
  title: "Weekly gardening newsletter",
  task: "Read the gardening newsletter",
};
/** Judged in shadow: like the accepted kitchen task. */
const KITCHEN_SHADOW: Suggested = {
  externalId: "interest-kitchen-quote",
  title: "Kitchen tiles quote approval",
  task: "Approve the kitchen tiles quote",
};
/** Judged under enforce: like the ignored newsletter task. */
const NEWSLETTER_ENFORCED: Suggested = {
  externalId: "interest-gardening-digest",
  title: "Gardening digest",
  task: "Read the gardening digest",
};
/** Judged under enforce: like the accepted kitchen task. */
const KITCHEN_ENFORCED: Suggested = {
  externalId: "interest-kitchen-grout",
  title: "Kitchen tiles grout",
  task: "Pick the kitchen tiles grout colour",
};
/** Judged while the decision server is down. */
const KITCHEN_OUTAGE: Suggested = {
  externalId: "interest-kitchen-delivery",
  title: "Kitchen tiles delivery",
  task: "Book the kitchen tiles delivery",
};
/** Judged with the ledger switched off. */
const KITCHEN_OFF: Suggested = {
  externalId: "interest-kitchen-sealant",
  title: "Kitchen tiles sealant",
  task: "Buy the kitchen tiles sealant",
};
/** Nothing like it in the ledger: no question is asked. */
const UNRELATED: Suggested = {
  externalId: "interest-passport",
  title: "Passport renewal",
  task: "Renew the passport",
};

function suggestionDoc(s: Suggested, at?: number) {
  return email({
    externalId: s.externalId,
    title: s.title,
    content: `Hello,\n\nA note about ${s.title.toLowerCase()} for you.\n\nStudio Northstar`,
    ...(at !== undefined ? { at } : {}),
  });
}

function suggest(s: Suggested) {
  return {
    docTitle: s.title,
    plan: (ctx: { subject: string | null }) => ({
      calls: [
        call("open_loop_search", { query: s.task }),
        call("open_loop_create", {
          title: s.task,
          confidence: 0.9,
          importance: 0.6,
          docs: [ctx.subject],
        }),
      ],
    }),
  };
}

// ── observations ────────────────────────────────────────────────────────────

interface Noted {
  marker: string;
  externalId: string;
  title: string;
  quote: string;
}

/** Thumbs up. */
const BINS: Noted = {
  marker: "council bins",
  externalId: "interest-council-bins",
  title: "Council bins schedule",
  quote: "The council bins schedule changes next week.",
};
/** Thumbs down, not interested. */
const LOYALTY: Noted = {
  marker: "loyalty points",
  externalId: "interest-loyalty-points",
  title: "Loyalty points statement",
  quote: "Your loyalty points expire at the end of the quarter.",
};
/** Thumbs down, factual error. */
const METER: Noted = {
  marker: "water meter",
  externalId: "interest-water-meter",
  title: "Water meter reading",
  quote: "Please submit your water meter reading within ten days.",
};
/** Noted after the thumbs, with nothing like it in the ledger. */
const PIANO: Noted = {
  marker: "piano tuner",
  externalId: "interest-piano-tuner",
  title: "Piano tuner visit",
  quote: "A piano tuner visits on Friday afternoon.",
};
/** Noted after the thumbs: like the one the owner liked. */
const BINS_AGAIN: Noted = {
  marker: "council bins collection",
  externalId: "interest-council-bins-again",
  title: "Council bins schedule update",
  quote: "The council bins schedule changed again.",
};

function observationDoc(n: Noted, at: number) {
  return email({ externalId: n.externalId, title: n.title, content: n.quote, at });
}

function noteOne(n: Noted, summary = `The ${n.marker} schedule changed.`) {
  return {
    docTitle: n.title,
    plan: (ctx: { subject: string | null }) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: n.quote }],
        }),
      ],
    }),
  };
}

function rankedLines(prompt: string): Array<[string, string]> {
  return [...prompt.matchAll(/^\d+\. \[(obs_[^\]]+)\](.*)$/gm)].map((m) => [m[1]!, m[2]!]);
}

/** The observation id of the brief item whose line names `marker`, from the agent's context. */
function briefItemFor(ctx: ConversationContext, marker: string): string {
  const line = [...ctx.systemPrompt.matchAll(/^\d+\. \[(obs_[^\]]+)\](.*)$/gm)].find((m) =>
    m[2]!.includes(marker),
  );
  return line?.[1] ?? "missing-observation";
}

const REPLY_LESS = "I don't care about loyalty points statements, stop showing them.";
const ORDINARY = "Record that I care about kitchen tiles.";

// ── the decision policy ─────────────────────────────────────────────────────

interface OwnerInterestState {
  positive?: unknown[];
  negative?: unknown[];
  statements?: Array<{ direction?: string }>;
}

/**
 * Salience: ship everything. The suggestion gate: adopt when the ledger shows
 * only positives, withhold when it shows a negative or a `less` statement,
 * suggest otherwise. Everything else at its top level.
 */
function policy(request: DecisionServerRequest): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  if (isSalienceRequest(request)) {
    answers.consequence = { type: "score", score: 4 };
    answers.timing = { type: "score", score: 2 };
    answers.already_known = { type: "score", score: 0 };
    return answers;
  }
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== "score") continue;
    const top = question.criteria.length - 1;
    let score = top;
    if (id === "tier") {
      const interest = (request.state as { owner_interest?: OwnerInterestState }).owner_interest;
      const negatives =
        (interest?.negative?.length ?? 0) > 0 ||
        (interest?.statements ?? []).some((s) => s.direction === "less");
      const positives = (interest?.positive?.length ?? 0) > 0;
      score = negatives ? 0 : positives ? 2 : 1;
    }
    answers[id] = { type: "score", score, confidence: 0.9, probabilities: { [score]: 1 } };
  }
  return answers;
}

interface SignalDto {
  id: string;
  polarity: 1 | -1;
  kind: string;
  source: string;
  text: string;
  note: string | null;
  loopId: string | null;
  observationId: string | null;
  conversationId: string | null;
  embedded: boolean;
  createdAt: string;
  supersededAt: string | null;
}

interface InterestDto {
  enabled: boolean;
  backlog: number;
  counts: {
    live: number;
    superseded: number;
    positive: number;
    negative: number;
    statements: number;
  };
  signals: SignalDto[];
  decisions: Array<{ purpose: string; verdict: string; enforced: boolean; score: number | null }>;
}

describe("brain bench: the interest engine", () => {
  let bench: BrainBench;
  let briefConversationId = "";
  const loops: Record<string, string> = {};
  const observations: Record<string, string> = {};

  const interest = async (): Promise<InterestDto> =>
    bench.harness.gatewayJson<InterestDto>("/admin/brain/interest?limit=200");
  const live = async (): Promise<SignalDto[]> =>
    (await interest()).signals.filter((s) => s.supersededAt === null);
  const view = async (name: string): Promise<TaskDto[]> => (await bench.obs.tasks(name)).tasks;
  const suggestionFor = async (s: Suggested): Promise<TaskDto> => {
    const docId = await bench.docId(s.externalId);
    await bench.obs.interpretationForSource(docId);
    const found = (await bench.obs.loops({ limit: 100 })).items.find((l) => l.title === s.task);
    if (!found) throw new Error(`no loop titled "${s.task}"`);
    const task = await bench.obs.task(found.id);
    return task.task;
  };
  const proposeDecisionsFor = async (s: Suggested) => {
    const docId = await bench.docId(s.externalId);
    const run = await bench.obs.interpretationForSource(docId);
    return (await bench.obs.run(run.id)).decisions.filter((d) => d.purpose === "task-propose");
  };
  const tierCallsFor = (task: string) =>
    bench.decision.calls.filter(
      (c) =>
        "tier" in c.request.questions &&
        (c.request.state as { task?: { title?: string } }).task?.title === task,
    );
  const latestSeq = async (taskId: string): Promise<number> => {
    const task = await bench.obs.task(taskId);
    const seq = task.history[0]?.seq;
    if (seq === undefined) throw new Error(`no history for ${taskId}`);
    return seq;
  };
  const react = (observationId: string, body: unknown) =>
    bench.harness.gatewayFetch(
      `/agent/conversations/${briefConversationId}/briefs/${DAYS.first}/items/${observationId}/reaction`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  const crossMorning = async (k: number, day: string) => {
    await bench.clock.set(morning(k));
    await bench.markers.waitFor("digest_last_run_day", (v) => v === day, 60_000);
    await bench.drainUntilQuiet({ includeUpcoming: false });
  };
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
      decision: { policy, inputTokens: 40 },
      entailment: () => "entailment",
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        digest: { enabled: true, hour: DIGEST_HOUR, graceMinutes: GRACE_MINUTES, push: false },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            suggest(KITCHEN),
            suggest(NEWSLETTER),
            suggest(KITCHEN_SHADOW),
            suggest(NEWSLETTER_ENFORCED),
            suggest(KITCHEN_ENFORCED),
            suggest(KITCHEN_OUTAGE),
            suggest(KITCHEN_OFF),
            suggest(UNRELATED),
            noteOne(BINS),
            noteOne(LOYALTY),
            noteOne(METER),
            noteOne(BINS_AGAIN),
            noteOne(PIANO, "A piano tuner visits on Friday."),
          ],
        }),
        behaviors: [
          {
            flavour: "daily.digest",
            plan: (ctx) => {
              const lines = rankedLines(ctx.prompt);
              const text = [
                `Today (${ctx.subject}):`,
                ...(lines.length ? ["", "Worth your attention:"] : ["- Nothing today."]),
                ...lines.map(([id, line], i) => `${i + 1}. ${line.trim()} (${id})`),
              ].join("\n");
              return {
                calls: [call("morning_brief_send", { text })],
                finalText: "Sent the morning brief.",
              };
            },
          },
        ],
      },
      agent: {
        behaviors: [
          {
            messageContains: REPLY_LESS,
            plan: (ctx) => ({
              calls: [
                call("interest_record", {
                  direction: "less",
                  about: "loyalty points statements",
                  quote: REPLY_LESS,
                  observationId: briefItemFor(ctx, LOYALTY.marker),
                }),
              ],
              finalText: "Noted: no more loyalty points statements.",
            }),
          },
          {
            messageContains: ORDINARY,
            plan: () => ({
              calls: [call("interest_record", { direction: "more", about: "kitchen tiles" })],
              finalText: "Tried to record that.",
            }),
          },
        ],
      },
    });
    const bootNow = (await bench.clock.now()).now;
    NOON0 = localAt(localAt(bootNow, 0) + 36 * HOUR, 12);
    DAYS.first = bench.clock.localDay(morning(1));
    DAYS.second = bench.clock.localDay(morning(2));
    await bench.clock.set(NOON0);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the ledger starts empty and the admin surface says so", async () => {
    const state = await interest();
    expect(state).toMatchObject({ enabled: true, backlog: 0, signals: [], decisions: [] });
    expect(state.counts).toMatchObject({ live: 0, superseded: 0 });
    const probe = await bench.harness.gatewayJson<{ result: unknown }>(
      `/admin/brain/interest/lookup?text=${encodeURIComponent("kitchen tiles")}`,
    );
    expect(probe.result).toBeNull();
  });

  test("accepting, creating and ignoring tasks write signed examples, and undo takes one back", async () => {
    await bench.pushAndSettle([suggestionDoc(KITCHEN), suggestionDoc(NEWSLETTER)]);
    const kitchen = await suggestionFor(KITCHEN);
    const newsletter = await suggestionFor(NEWSLETTER);
    loops.kitchen = kitchen.id;
    loops.newsletter = newsletter.id;
    expect(kitchen).toMatchObject({ origin: "brain", accepted: false, ignored: false });
    // Nothing in the ledger resembles either suggestion: no question was asked.
    expect(await proposeDecisionsFor(KITCHEN)).toEqual([]);
    expect(tierCallsFor(KITCHEN.task)).toEqual([]);
    expect(await live()).toEqual([]);

    expect((await bench.obs.taskAction(kitchen.id, { action: "accept" })).status).toBe(200);
    expect(
      (await bench.obs.taskAction(newsletter.id, { action: "ignore", reason: "Not my thing" }))
        .status,
    ).toBe(200);
    const created = await bench.obs.createTask({ title: "Order the kitchen worktop samples" });
    loops.worktop = created.task!.id;

    const signals = await live();
    expect(signals).toHaveLength(3);
    expect(signals.find((s) => s.loopId === kitchen.id)).toMatchObject({
      polarity: 1,
      kind: "task",
      source: "task_accepted",
      text: KITCHEN.task,
      note: null,
      embedded: false,
    });
    expect(signals.find((s) => s.loopId === newsletter.id)).toMatchObject({
      polarity: -1,
      source: "task_ignored",
      text: NEWSLETTER.task,
      note: "Not my thing",
    });
    expect(signals.find((s) => s.loopId === created.task!.id)).toMatchObject({
      polarity: 1,
      source: "task_created",
      text: "Order the kitchen worktop samples",
    });
    const counts = (await interest()).counts;
    expect(counts).toMatchObject({ live: 3, superseded: 0, positive: 2, negative: 1 });

    // Undoing the ignore takes its example back; ignoring again writes a new one.
    const seq = await latestSeq(newsletter.id);
    expect((await bench.obs.undoTask(seq)).status).toBe(200);
    expect((await live()).map((s) => s.source).sort()).toEqual(["task_accepted", "task_created"]);
    expect((await interest()).counts.superseded).toBe(1);
    expect((await bench.obs.taskAction(newsletter.id, { action: "ignore" })).status).toBe(200);
    expect((await live()).filter((s) => s.loopId === newsletter.id)).toHaveLength(1);

    // The probe finds like for like and nothing else.
    const probe = await bench.harness.gatewayJson<{
      result: { positive: Array<{ text: string }>; negative: Array<{ text: string }> } | null;
    }>(
      `/admin/brain/interest/lookup?text=${encodeURIComponent("Approve the kitchen tiles quote")}`,
    );
    expect(probe.result?.positive.map((p) => p.text)).toContain(KITCHEN.task);
    expect(probe.result?.negative ?? []).toEqual([]);
  }, 240_000);

  test("a new suggestion is judged against the ledger: shadow records, enforce withholds and adopts, undo of an adoption is the loudest no", async () => {
    // Shadow (the default): the verdict is recorded, the suggestion is offered as before.
    await bench.pushAndSettle([suggestionDoc(KITCHEN_SHADOW)]);
    const shadow = await suggestionFor(KITCHEN_SHADOW);
    expect(shadow).toMatchObject({ accepted: false, ignored: false });
    const [shadowCall] = tierCallsFor(KITCHEN_SHADOW.task);
    expect(shadowCall).toBeDefined();
    const shadowState = shadowCall!.request.state as {
      task: { title: string };
      owner_interest: { positive: Array<{ text: string; source: string }>; negative: unknown[] };
    };
    expect(shadowState.owner_interest.positive.map((p) => p.text)).toContain(KITCHEN.task);
    expect(shadowState.owner_interest.positive.map((p) => p.text)).not.toContain(NEWSLETTER.task);
    expect(shadowState.owner_interest.negative).toEqual([]);
    expect(await proposeDecisionsFor(KITCHEN_SHADOW)).toEqual([
      expect.objectContaining({
        purpose: "task-propose",
        lane: "tier",
        verdict: "pass",
        score: 2,
        enforced: false,
        recordId: shadow.id,
      }),
    ]);
    expect((await view("suggested")).map((t) => t.id)).toContain(shadow.id);

    // Enforce: like the ignored newsletter, withheld — tracked, out of the views, undoable.
    await bench.patchConfig({ brain: { tasks: { proposeGate: "enforce" } } });
    await bench.pushAndSettle([suggestionDoc(NEWSLETTER_ENFORCED)]);
    const withheld = await suggestionFor(NEWSLETTER_ENFORCED);
    expect(withheld).toMatchObject({ origin: "brain", accepted: false, ignored: true });
    expect((await view("suggested")).map((t) => t.id)).not.toContain(withheld.id);
    const withheldTask = await bench.obs.task(withheld.id);
    expect(withheldTask.history[0]).toMatchObject({ kind: "withheld", surface: "brain" });
    expect(await proposeDecisionsFor(NEWSLETTER_ENFORCED)).toEqual([
      expect.objectContaining({ verdict: "skip", score: 0, enforced: true }),
    ]);
    // Withholding writes no example of its own: only the owner's reactions count.
    expect((await live()).filter((s) => s.loopId === withheld.id)).toEqual([]);
    expect((await bench.obs.undoTask(withheldTask.history[0]!.seq)).status).toBe(200);
    expect((await view("suggested")).map((t) => t.id)).toContain(withheld.id);

    // Enforce: like the accepted kitchen task, adopted — the owner's task at once.
    await bench.pushAndSettle([suggestionDoc(KITCHEN_ENFORCED)]);
    const adopted = await suggestionFor(KITCHEN_ENFORCED);
    expect(adopted).toMatchObject({ origin: "brain", accepted: true, ignored: false });
    expect((await view("anytime")).map((t) => t.id)).toContain(adopted.id);
    const adoptedTask = await bench.obs.task(adopted.id);
    expect(adoptedTask.history[0]).toMatchObject({ kind: "auto_accepted", surface: "brain" });
    expect(await proposeDecisionsFor(KITCHEN_ENFORCED)).toEqual([
      expect.objectContaining({ verdict: "pass", score: 2, enforced: true }),
    ]);
    // Undoing the adoption offers it as a suggestion again and is a strong "no".
    expect((await bench.obs.undoTask(adoptedTask.history[0]!.seq)).status).toBe(200);
    expect((await bench.obs.task(adopted.id)).task).toMatchObject({
      accepted: false,
      ignored: false,
    });
    expect((await live()).find((s) => s.loopId === adopted.id)).toMatchObject({
      polarity: -1,
      source: "task_adopt_undone",
      text: KITCHEN_ENFORCED.task,
    });

    // Nothing like it in the ledger: no question, a plain suggestion, no row.
    await bench.pushAndSettle([suggestionDoc(UNRELATED)]);
    expect(await suggestionFor(UNRELATED)).toMatchObject({ accepted: false, ignored: false });
    expect(tierCallsFor(UNRELATED.task)).toEqual([]);
    expect(await proposeDecisionsFor(UNRELATED)).toEqual([]);

    // An outage fails open: a suggestion, recorded as unavailable.
    bench.decision.refuseWith(529);
    try {
      await bench.pushAndSettle([suggestionDoc(KITCHEN_OUTAGE)]);
    } finally {
      bench.decision.refuseWith(null);
    }
    expect(await suggestionFor(KITCHEN_OUTAGE)).toMatchObject({ accepted: false, ignored: false });
    expect(await proposeDecisionsFor(KITCHEN_OUTAGE)).toEqual([
      expect.objectContaining({ verdict: "unavailable", score: null }),
    ]);

    // The ledger switched off: nothing is shown, nothing is asked, nothing is recorded.
    await bench.patchConfig({ brain: { interest: { enabled: false } } });
    await bench.pushAndSettle([suggestionDoc(KITCHEN_OFF)]);
    const off = await suggestionFor(KITCHEN_OFF);
    expect(off).toMatchObject({ accepted: false, ignored: false });
    expect(tierCallsFor(KITCHEN_OFF.task)).toEqual([]);
    const before = (await live()).length;
    expect((await bench.obs.taskAction(off.id, { action: "accept" })).status).toBe(200);
    expect((await live()).length).toBe(before);
    expect((await interest()).enabled).toBe(false);
    await bench.patchConfig({
      brain: { interest: { enabled: true }, tasks: { proposeGate: "shadow" } },
    });
    expect((await interest()).enabled).toBe(true);
  }, 480_000);

  test("thumbs on a brief item become examples; a factual error becomes a note instead", async () => {
    await bench.clock.set(noon(0));
    await bench.pushAndSettle([BINS, LOYALTY, METER].map((n) => observationDoc(n, noon(0))));
    await crossMorning(1, DAYS.first);
    const brief = await bench.obs.morningBrief(DAYS.first);
    expect(brief.sent).not.toBeNull();
    briefConversationId = brief.sent!.conversationId;
    const detail = await bench.obs.briefDetail(briefConversationId, DAYS.first);
    expect(detail.items).toHaveLength(3);
    for (const n of [BINS, LOYALTY, METER]) {
      const item = detail.items.find((i) => i.summary.includes(n.marker));
      if (!item) throw new Error(`no brief item for ${n.marker}`);
      observations[n.marker] = item.observationId;
    }
    const bins = observations[BINS.marker]!;
    const loyalty = observations[LOYALTY.marker]!;
    const meter = observations[METER.marker]!;

    // Thumbs up: one positive example with the item's text.
    const up = await react(bins, { reaction: "up" });
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ observationId: bins, reaction: "up" });
    expect((await live()).find((s) => s.observationId === bins)).toMatchObject({
      polarity: 1,
      kind: "observation",
      source: "brief_thumbs_up",
      text: expect.stringContaining(BINS.marker),
    });
    expect((await bench.obs.observation(bins)).observation.userAction).toBe("thumbs_up");

    // Thumbs down, not interested, with words: one negative example carrying them.
    const down = await react(loyalty, { reaction: "not_interested", note: "I never read these." });
    expect(down.status).toBe(200);
    expect((await live()).find((s) => s.observationId === loyalty)).toMatchObject({
      polarity: -1,
      source: "brief_not_interested",
      note: "I never read these.",
    });
    // A changed mind on one item replaces its example rather than adding one.
    expect((await react(loyalty, { reaction: "up" })).status).toBe(200);
    // The virtual clock is frozen inside a phase, so the two rows share a
    // timestamp and their order is not meaningful; compare them as a set.
    const loyaltySignals = (await interest()).signals.filter((s) => s.observationId === loyalty);
    expect(
      loyaltySignals
        .map((s) => [s.source, s.supersededAt === null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["brief_not_interested", false],
      ["brief_thumbs_up", true],
    ]);
    expect(
      (await react(loyalty, { reaction: "not_interested", note: "I never read these." })).status,
    ).toBe(200);

    // Thumbs down, factual error, with a correction: no example, a quick-capture note.
    const notesBefore = (await bench.obs.tellNotes(DAYS.first)).length;
    const wrong = await react(meter, {
      reaction: "factual_error",
      note: "The reading was submitted last week.",
    });
    expect(wrong.status).toBe(200);
    const wrongBody = (await wrong.json()) as { noteId?: string };
    expect(wrongBody.noteId).toBeDefined();
    expect((await live()).find((s) => s.observationId === meter)).toBeUndefined();
    expect((await bench.obs.observation(meter)).observation.userAction).toBe("disputed");
    const notes = await bench.obs.tellNotes(DAYS.first);
    expect(notes).toHaveLength(notesBefore + 1);
    expect(notes.map((n) => n.text).join("\n")).toContain("The reading was submitted last week.");
    expect(notes.map((n) => n.text).join("\n")).toContain(METER.marker);
    // The same correction again saves nothing twice, and the note is a brief note.
    const again = await react(meter, {
      reaction: "factual_error",
      note: "The reading was submitted last week.",
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { noteId?: string }).noteId).toBe(wrongBody.noteId);
    expect(await bench.obs.tellNotes(DAYS.first)).toHaveLength(notesBefore + 1);
    const surface = bench.sql
      .prepare<
        [string],
        { surface: string | null }
      >("SELECT surface FROM note_entries WHERE id = ?")
      .get(wrongBody.noteId!);
    expect(surface?.surface).toBe("brief");
    // A client cannot name the note: the body takes no note id.
    expect(
      (await react(meter, { reaction: "factual_error", note: "x", noteId: wrongBody.noteId }))
        .status,
    ).toBe(400);

    // The brief detail carries every reaction for the clients.
    const after = await bench.obs.briefDetail(briefConversationId, DAYS.first);
    const reactions = Object.fromEntries(
      after.items.map((i) => [
        i.observationId,
        (i as { reaction?: { kind: string } }).reaction?.kind,
      ]),
    );
    expect(reactions).toEqual({
      [bins]: "up",
      [loyalty]: "not_interested",
      [meter]: "factual_error",
    });

    // Clearing a thumbs takes its example back.
    const cleared = await react(bins, { reaction: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ observationId: bins, reaction: null });
    expect((await live()).find((s) => s.observationId === bins)).toBeUndefined();
    expect((await bench.obs.observation(bins)).observation.userAction).toBeNull();
    expect((await react(bins, { reaction: "up" })).status).toBe(200);

    // Not an item of that brief, or not a brief at all: refused.
    expect((await react("obs_nobody", { reaction: "up" })).status).toBe(404);
    expect((await react(bins, { reaction: "sideways" })).status).toBe(400);
    const otherDay = await bench.harness.gatewayFetch(
      `/agent/conversations/${briefConversationId}/briefs/2020-01-01/items/${bins}/reaction`,
      { method: "PUT", body: JSON.stringify({ reaction: "up" }) },
    );
    expect(otherDay.status).toBe(404);
  }, 300_000);

  test("what the owner says in the Morning brief conversation is recorded there, and only there", async () => {
    await reply(briefConversationId, REPLY_LESS, "Noted: no more loyalty points statements.");
    const statement = (await live()).find((s) => s.kind === "statement");
    expect(statement).toMatchObject({
      polarity: -1,
      source: "statement",
      text: "loyalty points statements",
      note: REPLY_LESS,
      conversationId: briefConversationId,
      observationId: observations[LOYALTY.marker],
    });

    // In an ordinary conversation the tool does not exist, so nothing lands.
    const before = (await live()).filter((s) => s.kind === "statement").length;
    await reply("", ORDINARY, "Tried to record that.");
    expect((await live()).filter((s) => s.kind === "statement")).toHaveLength(before);
  }, 180_000);

  test("the next morning's salience and the urgency of new evidence see the owner's reactions", async () => {
    await bench.clock.set(noon(1));
    const callsBefore = bench.decision.calls.length;
    const [docId] = await bench.pushAndSettle([
      observationDoc(BINS_AGAIN, noon(1)),
      observationDoc(PIANO, noon(1)),
    ]);

    // Intake: the urgency question about the document carried the liked observation.
    const urgency = bench.decision.calls.filter(
      (c) =>
        "urgency" in c.request.questions &&
        (c.request.state as { documentId?: string }).documentId === docId,
    );
    expect(urgency.length).toBeGreaterThan(0);
    const urgencyState = urgency[0]!.request.state as {
      owner_interest?: { positive: Array<{ text: string; source: string }> };
    };
    expect(urgencyState.owner_interest?.positive.map((p) => p.source)).toContain("brief_thumbs_up");
    const rubric = bench.sql
      .prepare<
        [],
        { rubric_version: string }
      >("SELECT rubric_version FROM knowledge_decisions WHERE purpose='urgency' ORDER BY created_at DESC LIMIT 1")
      .get();
    expect(rubric?.rubric_version).toBe("knowledge-decisions-v3");

    // Noting time: the salience question about the new observation carried it too.
    const noted = bench.decision.calls.filter(
      (c) =>
        isSalienceRequest(c.request) &&
        (salienceSubject(c.request) ?? "").includes(BINS_AGAIN.marker),
    );
    expect(noted.length).toBeGreaterThan(0);
    const salienceState = noted[0]!.request.state as {
      owner_interest?: {
        positive: Array<{ text: string; source: string }>;
        statements: Array<{ direction: string; text: string }>;
      };
    };
    expect(salienceState.owner_interest?.positive.map((p) => p.source)).toContain(
      "brief_thumbs_up",
    );

    // The morning recheck asks again with it, and the decision row names the new rubric.
    await crossMorning(2, DAYS.second);
    const rechecks = bench.decision.calls.filter(
      (c) =>
        isSalienceRequest(c.request) &&
        (salienceSubject(c.request) ?? "").includes(BINS_AGAIN.marker),
    );
    expect(rechecks.length).toBeGreaterThan(noted.length);
    const observation = (await bench.obs.observationsMatching(BINS_AGAIN.marker))[0];
    expect(observation).toBeDefined();
    const salienceRows = (await bench.obs.observation(observation!.id)).decisions.filter(
      (d) => d.purpose === "observation-salience",
    );
    expect(salienceRows.length).toBeGreaterThan(0);
    expect(salienceRows.every((d) => d.rubricVersion === "observation-salience-v2")).toBe(true);
    // An observation with nothing like it in the ledger is asked about without the block.
    const unlike = bench.decision.calls
      .slice(callsBefore)
      .filter(
        (c) =>
          isSalienceRequest(c.request) && (salienceSubject(c.request) ?? "").includes(PIANO.marker),
      );
    // Noting time and the recheck alike: nothing in the ledger resembles it.
    expect(unlike.length).toBeGreaterThanOrEqual(2);
    for (const c of unlike)
      expect((c.request.state as { owner_interest?: unknown }).owner_interest).toBeUndefined();

    // Everything the gates were shown is on the admin surface, newest first.
    const state = await interest();
    expect(state.counts.statements).toBe(1);
    expect(state.decisions.map((d) => d.purpose)).toContain("task-propose");
    expect(state.backlog).toBe(state.counts.live);
  }, 300_000);
});
