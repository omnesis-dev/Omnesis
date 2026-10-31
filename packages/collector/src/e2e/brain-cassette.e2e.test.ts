// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain cassettes — Lane B of the bench.
 *
 * Where the puppet decides each turn from a behavior table, a cassette
 * replays ONE recorded reasoning verbatim. Its tool calls are live (no
 * recorded result), so the real tool layer executes and the writes land
 * for real — which is what makes a cassette a regression net over
 * everything downstream of the model: prompts feeding tools, gate
 * behavior, cascade wiring, id threading.
 *
 * The mechanism this suite exists to prove is `capture`: a live call's
 * result is REAL, so the loop id the recording saw no longer exists. The
 * cassette lifts the id the gateway actually minted and threads it into
 * the calls that follow.
 *
 * One golden cassette per workflow, all in `loops-test-life/agent-demos`
 * and split by role: a datum run noting an observation, the morning run
 * sending the day's brief, a reply in the Morning brief conversation
 * completing a task (the interactive `agent` role), and the note agent
 * acting on a quick-capture note. A cassette pins one reasoning forever;
 * it does NOT test the current model. Re-record when tool schemas move.
 */

import "./synth-env.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  seedHistory,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

const CASSETTE_DIR = join(
  process.cwd().replace(/\/packages\/collector$/, ""),
  // Cassettes for every role live in `agent-demos` — the directory's
  // `.meta.json` files carry the role, which is how the background-agent
  // cassettes share it with the interactive agent's.
  "evals/universes/loops-test-life/agent-demos",
);

/**
 * The document the golden datum cassette was recorded against. Its external
 * id is what the cassette's `$DOC_…` placeholder resolves through, and its
 * content carries the observation's quote verbatim, so the two must stay in
 * step.
 */
const DEPOSIT = email({
  externalId: "bench-cassette-deposit",
  title: "Harvest fair stand — deposit outstanding",
  content:
    "Hi Alex,\n\nWe are holding your stand at the harvest fair. The stand is held until the deposit is sent.\n\nCedar Grove Supplies",
});

/**
 * The cassettes pin calendar facts (the observation's `relevantUntil`), so
 * the virtual clock runs on a fixed day before it. Local noon, and the next
 * morning past the brief's grace deadline.
 */
const NOON = new Date(2031, 2, 4, 12, 0, 0).getTime();
const NOON_DAY = "2031-03-04";
const MORNING = new Date(2031, 2, 5, 8, 0, 0).getTime();
const MORNING_DAY = "2031-03-05";
const BRIEF_TEXT =
  "**Today**\n- Nothing on the calendar.\n\n**Worth your attention**\n- The harvest fair stand is held only until you send the deposit.";
const REPLY = "The harvest fair deposit is paid.";

describe("Brain cassettes (background-agent and agent replay)", () => {
  let bench: BrainBench;
  let docId = "";
  let runId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      cassetteDir: CASSETTE_DIR,
      agent: "replay",
      clock: "virtual",
      syncSources: false,
      brain: {
        derivationBarrier: "0s",
        digest: { enabled: true, hour: 7, graceMinutes: 45, push: false },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
    });
    await bench.clock.set(NOON);
    // The day's (empty) morning run settles before the scenario begins.
    await bench.markers.waitFor("digest_last_run_day", (v) => v === NOON_DAY, 60_000);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the background-agent replay lane is wired and the engine is active", async () => {
    const status = await bench.obs.status();
    // A cassette directory declaring a `background-agent` scenario satisfies
    // the model-assigned half of the gate exactly as a real backend does.
    expect(status.brain.modelAssigned).toBe(true);
    expect(status.brain.active).toBe(true);
  }, 60_000);

  test("a cassette recovers a persisted legacy datum run and its writes land", async () => {
    // New source arrivals use maintenance. A pre-upgrade queued datum still
    // executes through the real driver and retains cassette capture semantics.
    docId = seedHistory(bench, {
      id: DEPOSIT.externalId,
      sourceId: bench.harness.getSourceIds()[0]!,
      title: DEPOSIT.title,
      content: DEPOSIT.content,
      at: NOON,
    });
    runId = bench.seedRun({
      id: "cassette-recovered-datum",
      kind: "data",
      payload: { docId, event: "created", datumAt: NOON },
      enqueuedAt: NOON,
    });
    await waitFor(
      "persisted cassette run completes",
      async () =>
        (await bench.obs.settledRuns("data")).some((run) => run.id === runId) ? true : null,
      60_000,
    );

    const runs = await bench.obs.settledRuns("data");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");

    const loops = await bench.obs.loops();
    expect(loops.items).toHaveLength(1);
    expect(loops.items[0]!.title).toContain("harvest fair stand");
    // The `$DOC_…` placeholder resolved against the live document row.
    expect(loops.items[0]!.docs).toEqual([docId]);

    const observations = await bench.obs.observations();
    expect(observations.items).toHaveLength(1);
    expect(observations.items[0]).toMatchObject({
      state: "live",
      createdByRun: runId,
      citations: [docId],
      claims: [
        {
          docId,
          quote: "The stand is held until the deposit is sent.",
          verification: "unverified",
        },
      ],
      relevantUntil: "2031-03-20T17:00:00.000Z",
    });
  }, 120_000);

  test("capture threads the gateway-minted loop id into the calls that follow", async () => {
    const loop = (await bench.obs.loops()).items[0]!;

    // The ledger append and the observation both addressed the loop the
    // gateway minted during THIS replay — no `$CAP_` placeholder survived,
    // and no recorded id leaked through.
    const detail = await bench.obs.loop(loop.id);
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger[0]!.note).toContain("Stand held pending the deposit");
    expect(detail.observations.map((o) => o.relatedLoopIds)).toEqual([[loop.id]]);
  }, 60_000);

  test("the replayed run recorded a transcript with its real tool results", async () => {
    const refs = await bench.obs.transcripts({ runId });
    expect(refs.items.length).toBeGreaterThan(0);
    const { transcript } = await bench.obs.transcript(refs.items.at(-1)!.fileName);

    const toolResults = transcript.events.filter((e) => e.type === "agent.tool.result");
    expect(toolResults.length).toBeGreaterThanOrEqual(7);
    const calls = await bench.obs.executedTools(runId);
    expect(calls.map((call) => call.tool)).toEqual([
      "fetch_many",
      "open_loop_search",
      "open_loop_create",
      "open_loop_fetch",
      "open_loop_ledger_append",
      "observation_list",
      "observation_note",
    ]);
    // Every live call succeeded: the document read is a batch, the rest are
    // the steward's structured results.
    expect(calls.map((call) => call.result?.kind)).toEqual([
      "document.batch",
      ...Array<string>(6).fill("structured"),
    ]);
    // A live call's result is the real tool's, so the created loop's id is
    // in the transcript — the recording could not have supplied it.
    const loopId = (await bench.obs.loops()).items[0]!.id;
    expect(JSON.stringify(toolResults)).toContain(loopId);
  }, 60_000);

  test("the morning cassette sends the brief and ships the observation", async () => {
    await bench.clock.set(MORNING);
    await bench.markers.waitFor("digest_last_run_day", (v) => v === MORNING_DAY, 60_000);
    // Wait on the morning run alone: the loop the datum cassette created also
    // queues knowledge maintenance, which this lane has no cassette for and
    // which therefore never settles.
    const run = await waitFor(
      "the morning run to settle",
      async () =>
        (await bench.obs.runs({ kind: "daily" })).items.find(
          (r) => r.dedupeKey === `daily:digest:${MORNING_DAY}` && r.status !== "pending",
        ) ?? null,
      120_000,
    );
    expect(run.status).toBe("completed");

    const brief = await bench.obs.morningBrief(MORNING_DAY);
    const observation = (await bench.obs.observations()).items[0]!;
    expect(brief.sent).toMatchObject({ day: MORNING_DAY, itemCount: 1 });
    expect(brief.items.map((i) => i.observationId)).toEqual([observation.id]);
    expect(observation).toMatchObject({
      state: "shipped",
      shippedMessageId: brief.sent!.messageId,
    });

    const conversation = await bench.obs.conversation(brief.sent!.conversationId);
    expect(conversation.origin?.kind).toBe("daily_brief");
    expect(conversation.messages.map((m) => m.parts.map((p) => p.text).join(""))).toEqual([
      BRIEF_TEXT,
    ]);
    expect((await bench.obs.executedTools(run.id)).map((s) => [s.tool, s.result?.kind])).toEqual([
      ["morning_brief_send", "structured"],
    ]);
  }, 180_000);

  test("the reply cassette completes the task the user names, from the brief thread", async () => {
    const conversationId = (await bench.obs.morningBrief(MORNING_DAY)).sent!.conversationId;
    const session = await bench.harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeFromId: conversationId }),
    });
    await bench.harness.gatewayJson(`/agent/sessions/${session.sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: REPLY }),
    });
    await waitFor(
      "the replayed reply to persist",
      async () => {
        const record = await bench.obs.conversation(conversationId);
        const last = record.messages.at(-1);
        return last?.role === "assistant" &&
          last.parts.some((p) => p.text?.includes("harvest fair deposit is marked paid"))
          ? true
          : null;
      },
      60_000,
    );

    const loop = (await bench.obs.loops()).items[0]!;
    const task = await bench.obs.task(loop.id);
    expect(task.task).toMatchObject({ state: "done", completionNote: "Paid by bank transfer." });
    expect(task.history[0]).toMatchObject({
      kind: "completed",
      surface: "conversation",
      conversationId,
    });
  }, 120_000);

  test("no placeholder survives into any persisted row", async () => {
    const loopId = (await bench.obs.loops()).items[0]!.id;
    const persisted = JSON.stringify({
      loops: (await bench.obs.loops()).items,
      observations: (await bench.obs.observations()).items,
      ledger: (await bench.obs.ledger(loopId)).items,
      task: await bench.obs.task(loopId),
      brief: await bench.obs.morningBrief(MORNING_DAY),
    });
    expect(persisted).not.toMatch(/\$(?:DOC|PERSON|CAP|SESSION|MSG)[_A-Za-z]*/);
    expect(persisted).not.toContain("__CAPTURE_MISS_");
  }, 60_000);
});

describe("Brain cassettes (the note agent on a stable install)", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: false,
      cassetteDir: CASSETTE_DIR,
      syncSources: false,
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the note cassette adds the task the note asks for, and its receipt lands", async () => {
    const documentId = seedHistory(bench, {
      id: "bench-cassette-insurance",
      sourceId: bench.harness.getSourceIds()[0]!,
      title: "Bicycle insurance renewal details",
      content:
        "The bicycle insurance policy can be renewed using the policy reference in this document.",
      at: Date.now(),
    });
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const res = await bench.harness.gatewayFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        id,
        text: "Remind me to renew the bike insurance before it lapses.",
        capturedAt,
        capturedTimeZoneId: "UTC",
        capturedUtcOffsetSeconds: 0,
      }),
    });
    expect(res.status).toBe(201);
    const agent = await waitFor(
      "the note cassette's receipt",
      async () => {
        const note = (await bench.obs.tellNotes(capturedAt.slice(0, 10))).find((n) => n.id === id);
        return note?.agent?.state === "done" ? note.agent : null;
      },
      90_000,
    );
    expect(agent.receipt).toMatchObject({
      text: "Added a task to renew the bike insurance.",
      changes: [{ text: "Added: Renew the bike insurance", taskId: expect.any(String) }],
    });
    const task = await bench.obs.task(agent.receipt!.changes[0]!.taskId!);
    expect(task.task).toMatchObject({ origin: "note", scheduledFor: "someday", state: "open" });
    expect(task.task.documents).toEqual([
      expect.objectContaining({ id: documentId, title: "Bicycle insurance renewal details" }),
    ]);
    expect(task.history[0]).toMatchObject({ kind: "created", surface: "note" });
  }, 180_000);
});
