// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: observations.
 *
 * An observation is what a run notes for tomorrow's morning brief. Nothing
 * noted reaches the user directly: the next morning the recheck expires,
 * drops and rescores every open observation, checks the survivors' claims,
 * and ranks what is left into the day's item list.
 *
 * This suite drives that lifecycle end to end on the virtual clock: source
 * maintenance runs note observations through the real `observation_note`
 * tool (citations, verbatim claims, note-time salience scores, the "would
 * have pushed" log), the day's evidence and loops move, and the morning run
 * rechecks them. The decision model is a scripted TypeSafe stand-in whose scores
 * are named per observation; the entailment verifier rejects one claim. The
 * gateway's own policy decides ship / hold / drop from those scores, which
 * is what the assertions read. Retention closes the loop 91 days later.
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
  type ObservationDto,
  type SourceInterpretation,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DIGEST_HOUR = 7;
const GRACE_MINUTES = 45;

function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The noon the scenario starts at, and the instants it moves the clock to. Set once booted. */
let NOON = 0;
/** Past the morning brief's grace deadline the day after NOON: the run fires without waiting. */
let MORNING = 0;
let MORNING_DAY = "";

// ── the scenario ────────────────────────────────────────────────────────────
// Each observation is keyed by a marker its summary carries; the scripted
// decision model scores it by that marker.

interface Scenario {
  marker: string;
  externalId: string;
  title: string;
  quote: string;
  /** Hours after NOON the observation stops mattering; omitted = open-ended. */
  relevantForHours?: number;
}

const S = {
  kiln: {
    marker: "kiln permit",
    externalId: "obs-kiln-permit",
    title: "Kiln permit inspection today",
    quote: "The inspector can only sign the kiln permit before 6pm today.",
    relevantForHours: 6,
  },
  boiler: {
    marker: "boiler service",
    externalId: "obs-boiler-service",
    title: "Boiler service window",
    quote: "The engineer will cancel the boiler service unless you confirm by Thursday.",
    relevantForHours: 72,
  },
  library: {
    marker: "library fine",
    externalId: "obs-library-fine",
    title: "Library account notice",
    quote: "Your library fine of 4.50 doubles if it is unpaid at the end of the month.",
  },
  tram: {
    marker: "tram pass",
    externalId: "obs-tram-pass",
    title: "Tram pass renewal",
    quote: "Your annual tram pass expires on the first of next month.",
  },
  choir: {
    marker: "choir rota",
    externalId: "obs-choir-rota",
    title: "Choir rota for the week",
    quote: "You are on the tea rota after Wednesday's choir rehearsal.",
  },
  garden: {
    marker: "garden waste",
    externalId: "obs-garden-waste",
    title: "Garden waste collection",
    quote: "Garden waste bins are now collected every other Tuesday.",
  },
  parcel: {
    marker: "parcel locker",
    externalId: "obs-parcel-locker",
    title: "Parcel ready at the locker",
    quote: "Your parcel is waiting in locker 12 at the station.",
  },
  insurance: {
    marker: "insurance quote",
    externalId: "obs-insurance-quote",
    title: "Contents insurance quote",
    quote: "This contents insurance quote is valid for thirty days.",
  },
  bike: {
    marker: "bike repair",
    externalId: "obs-bike-repair",
    title: "Bike repair estimate",
    quote: "The bike repair needs a new rear wheel before it can be collected.",
  },
  piano: {
    marker: "piano tuning",
    externalId: "obs-piano-tuning",
    title: "Piano tuning visit",
    quote: "The tuner can visit on Friday morning between nine and eleven.",
  },
  allotment: {
    marker: "allotment fee",
    externalId: "obs-allotment-fee",
    title: "Allotment association fee",
    quote: "The allotment association fee is due with the spring newsletter.",
  },
  pottery: {
    marker: "pottery class",
    externalId: "obs-pottery-class",
    title: "Pottery class waiting list",
    quote: "A place on the Thursday pottery class has opened up.",
  },
} satisfies Record<string, Scenario>;

function docFor(s: Scenario) {
  return email({
    externalId: s.externalId,
    title: s.title,
    content: `Hello,\n\n${s.quote}\n\nKind regards,\nStudio Northstar`,
  });
}

/** The ISO instant an observation stops mattering, relative to the scenario's noon. */
function relevantUntil(s: Scenario): Record<string, string> {
  return s.relevantForHours === undefined
    ? {}
    : { relevantUntil: new Date(NOON + s.relevantForHours * HOUR).toISOString() };
}

/** The common plan: list first (the maintenance fence requires it), then note one observation. */
function noteOne(s: Scenario, extra: Record<string, unknown> = {}): SourceInterpretation {
  return {
    docTitle: s.title,
    // Only the revision that still carries the quote: a later edit is not re-noted.
    contentContains: s.quote,
    plan: (ctx) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${s.marker} needs attention.`,
          why: `Missing the ${s.marker} has a cost.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: s.quote }],
          ...relevantUntil(s),
          ...extra,
        }),
      ],
    }),
  };
}

/** A quote the library notice does not contain. */
const MISQUOTE = "Your library fine has been waived this month.";

const SOURCES: SourceInterpretation[] = [
  noteOne(S.kiln),
  noteOne(S.boiler),
  // A misquote first: the quote-in-document gate refuses it, then the run
  // notes the observation with the real quote.
  {
    docTitle: S.library.title,
    expectedRefusals: [{ tool: "observation_note", code: "evidence_not_found" }],
    plan: (ctx) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${S.library.marker} was waived.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: MISQUOTE }],
        }),
        call("observation_note", {
          summary: `The ${S.library.marker} doubles at the end of the month.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: S.library.quote }],
        }),
      ],
    }),
  },
  noteOne(S.choir),
  noteOne(S.garden),
  noteOne(S.parcel),
  noteOne(S.insurance),
  noteOne(S.piano),
  noteOne(S.allotment),
  // A draft noted and immediately superseded by its corrected version.
  {
    docTitle: S.tram.title,
    plan: (ctx) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${S.tram.marker} draft reading.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: S.tram.quote }],
        }),
        call("observation_note", {
          summary: `The ${S.tram.marker} expires next month.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: S.tram.quote }],
          supersedes: [ref("observation_note", "id", 0)],
        }),
      ],
    }),
  },
  // An observation tied to a loop the run creates in the same pass.
  {
    docTitle: S.bike.title,
    plan: (ctx) => ({
      calls: [
        call("open_loop_search", { query: "bike repair" }),
        call("open_loop_create", {
          title: "Collect the bike after the repair",
          confidence: 0.9,
          importance: 0.6,
          docs: [ctx.subject],
        }),
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${S.bike.marker} is waiting on a new wheel.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: S.bike.quote }],
          relatedLoopIds: [ref("open_loop_create", "loop.id")],
        }),
      ],
    }),
  },
  // Noted, then withdrawn by the same run.
  {
    docTitle: S.pottery.title,
    plan: (ctx) => ({
      calls: [
        call("observation_list", {}),
        call("observation_note", {
          summary: `The ${S.pottery.marker} has a free place.`,
          citations: [ctx.subject],
          claims: [{ docId: ctx.subject, quote: S.pottery.quote }],
        }),
        call("observation_withdraw", { id: ref("observation_note", "id") }),
      ],
    }),
  },
];

/** The ranked ids the morning prompt lists, in order. */
function rankedIds(prompt: string): string[] {
  return [...prompt.matchAll(/^\d+\. \[(obs_[^\]]+)\]/gm)].map((m) => m[1]!);
}

describe("brain bench: observations", () => {
  let bench: BrainBench;
  const byMarker = async (marker: string): Promise<ObservationDto> => {
    const matches = await bench.obs.observationsMatching(marker);
    if (matches.length !== 1)
      throw new Error(`expected one observation for "${marker}", got ${matches.length}`);
    return matches[0]!;
  };

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      syncSources: false,
      // The morning brief is appended through the agent service, which exists
      // only with an interactive agent role assigned.
      agent: { behaviors: [] },
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        digest: { enabled: true, hour: DIGEST_HOUR, graceMinutes: GRACE_MINUTES, push: false },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
      decision: {
        policy: salienceDecisionPolicy([
          [S.kiln.marker, { consequence: 4, timing: 3, alreadyKnown: 0 }],
          [S.boiler.marker, { consequence: 4, timing: 3, alreadyKnown: 0 }],
          [S.library.marker, { consequence: 3, timing: 1, alreadyKnown: 0 }],
          [S.tram.marker, { consequence: 2, timing: 1, alreadyKnown: 0 }],
          [S.choir.marker, { consequence: 1, timing: 2, alreadyKnown: 0 }],
          [S.garden.marker, { consequence: 1, timing: 0, alreadyKnown: 0 }],
          [S.parcel.marker, { consequence: 3, timing: 2, alreadyKnown: 0.9 }],
          [S.insurance.marker, { consequence: 3, timing: 1, alreadyKnown: 0 }],
          [S.bike.marker, { consequence: 3, timing: 1, alreadyKnown: 0 }],
          [S.piano.marker, { consequence: 2, timing: 2, alreadyKnown: 0 }],
          [S.allotment.marker, { consequence: 2, timing: 1, alreadyKnown: 0 }],
        ]),
      },
      entailment: ({ prompt }) => (prompt.includes(S.insurance.marker) ? "neutral" : "entailment"),
      behaviors: {
        dynamic: sourceInterpretations({ sources: SOURCES, maintainNode: preserveCurrentOwner }),
        behaviors: [
          {
            flavour: "daily.digest",
            plan: (ctx) => ({
              calls: [
                call("morning_brief_send", {
                  text: [
                    `Today, ${ctx.subject}: nothing on the calendar.`,
                    "",
                    "Worth your attention:",
                    ...rankedIds(ctx.prompt).map((id, i) => `${i + 1}. Item ${id}.`),
                  ].join("\n"),
                }),
              ],
              finalText: "Sent the morning brief.",
            }),
          },
        ],
      },
    });
    // Start at the next local noon, clear of anything the boot admitted.
    const bootNow = (await bench.clock.now()).now;
    NOON = localMidnight(localMidnight(bootNow) + 36 * HOUR) + 12 * HOUR;
    MORNING = localMidnight(NOON + DAY) + DIGEST_HOUR * HOUR + (GRACE_MINUTES + 15) * 60_000;
    MORNING_DAY = bench.clock.localDay(MORNING);
    await bench.clock.set(NOON);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a source run notes observations with citations, claims and note-time scores", async () => {
    const docs = [
      S.kiln,
      S.boiler,
      S.library,
      S.tram,
      S.choir,
      S.garden,
      S.parcel,
      S.insurance,
      S.bike,
      S.piano,
      S.allotment,
      S.pottery,
    ].map((s) => ({ ...docFor(s), at: NOON - HOUR }));
    // One source at a time: every plan lists observations before noting, and a
    // concurrent run's note would void that receipt (a revision conflict the
    // run retries only once the virtual clock passes its backoff).
    for (const doc of docs) await bench.pushAndSettle([doc]);

    const boiler = await byMarker(S.boiler.marker);
    const docId = await bench.docId(S.boiler.externalId);
    expect(boiler.state).toBe("live");
    expect(boiler.citations).toEqual([docId]);
    expect(boiler.claims).toEqual([{ docId, quote: S.boiler.quote, verification: "unverified" }]);
    expect(boiler.relevantUntil).toBe(new Date(NOON + 72 * HOUR).toISOString());
    // Scored at the moment it was noted, by the decision model.
    expect(boiler.notedScores).toMatchObject({ consequence: 4, timing: 3, alreadyKnown: 0 });
    expect(boiler.userAuthored).toBe(false);

    // The run that noted it is a real source-maintenance run.
    const runs = await bench.obs.runsForSource(docId);
    expect(runs.map((r) => r.id)).toContain(boiler.createdByRun);
    const steps = await bench.obs.executedTools(boiler.createdByRun);
    const noted = steps.find((s) => s.tool === "observation_note");
    expect(noted?.result).toMatchObject({
      kind: "structured",
      resultType: "observation.noted",
      data: { id: boiler.id, scores: { consequence: 4, timing: 3 } },
    });

    // The detail route resolves citations and carries the note-lane decision.
    const detail = await bench.obs.observation(boiler.id);
    expect(detail.observation.citations.map((c) => c.id)).toEqual([docId]);
    expect(
      detail.decisions.some((d) => d.lane === "note" && d.purpose === "observation-salience"),
    ).toBe(true);

    const pulse = await bench.obs.pulse();
    expect(pulse.counts.openObservations).toBe(11);
  }, 240_000);

  test("a quote that is not in the cited document is refused and leaves no row", async () => {
    const library = await byMarker(S.library.marker);
    expect(library.summary).toContain("doubles");
    // A batch run can interpret several sources; keep this source's notes.
    const notes = (await bench.obs.executedTools(library.createdByRun)).filter(
      (s) =>
        s.tool === "observation_note" &&
        (s.args.citations as string[] | undefined)?.includes(library.citations[0]!),
    );
    expect(notes.map((s) => s.result?.kind)).toEqual(["error", "structured"]);
    expect(notes[0]!.result).toMatchObject({ code: "evidence_not_found" });
  }, 60_000);

  test("a top-consequence, top-timing observation due before the next brief is logged as a would-be push", async () => {
    const kiln = await byMarker(S.kiln.marker);
    expect(kiln.wouldPushAt).not.toBeNull();
    const log = await bench.obs.wouldPush();
    expect(log.items.map((i) => i.id)).toEqual([kiln.id]);
    expect(log.items[0]!.notedScores).toMatchObject({ consequence: 4, timing: 3 });

    // Same scores, but it matters past tomorrow's brief: no push would fire.
    const boiler = await byMarker(S.boiler.marker);
    expect(boiler.wouldPushAt).toBeNull();
  }, 60_000);

  test("superseding and withdrawing drop the replaced observation", async () => {
    const tram = await bench.obs.observationsMatching(S.tram.marker);
    expect(tram).toHaveLength(2);
    const draft = tram.find((o) => o.summary.includes("draft"))!;
    const current = tram.find((o) => !o.summary.includes("draft"))!;
    expect(draft).toMatchObject({ state: "dropped", closeReason: "superseded" });
    expect(current.state).toBe("live");

    const pottery = await byMarker(S.pottery.marker);
    expect(pottery).toMatchObject({ state: "dropped", closeReason: "withdrawn" });
  }, 60_000);

  test("the evening moves the world: a loop resolves, a cited document changes, another is deleted", async () => {
    // The bike observation's loop is done before the brief.
    const bike = await byMarker(S.bike.marker);
    expect(bike.relatedLoopIds).toHaveLength(1);
    const done = await bench.obs.taskAction(bike.relatedLoopIds[0]!, { action: "complete" });
    expect(done.status).toBe(200);

    // The piano tuner's message is rewritten: the quoted availability is gone.
    await bench.clock.set(NOON + 4 * HOUR);
    await bench.update(
      { ...docFor(S.piano), at: NOON + 4 * HOUR },
      "Hello,\n\nThe tuner is fully booked for the next month.\n\nKind regards,\nStudio Northstar",
    );
    // The allotment notice is deleted by its source.
    const allotmentDoc = await bench.docId(S.allotment.externalId);
    await bench.deleteDoc(allotmentDoc);
    await bench.drainUntilQuiet();

    // A deleted cited document never takes its observation with it: the
    // observation loses its citation and is queued for review.
    const allotment = await bench.obs.observationsMatching(S.allotment.marker);
    expect(allotment).toHaveLength(1);
    expect(allotment[0]).toMatchObject({ citations: [] });
    expect(
      bench.sql
        .prepare("SELECT 1 FROM knowledge_work WHERE subject_kind = 'node' AND subject_id = ?")
        .get(allotment[0]!.id),
    ).toBeDefined();
  }, 240_000);

  test("the morning recheck ships, holds and drops by the salience policy and ranks what ships", async () => {
    await bench.clock.set(MORNING);
    await bench.markers.waitFor("digest_last_run_day", (v) => v === MORNING_DAY, 60_000);
    await bench.drainUntilQuiet({ timeoutMs: 150_000 });

    const brief = await bench.obs.morningBrief(MORNING_DAY);
    expect(brief.sent?.day).toBe(MORNING_DAY);
    const ranked = brief.items.map((i) => i.observation?.summary ?? "");
    // Consequence first, then timing; the timely low-consequence one last.
    expect(
      ranked.map((summary) => Object.values(S).find((s) => summary.includes(s.marker))?.marker),
    ).toEqual([S.boiler.marker, S.library.marker, S.tram.marker, S.choir.marker]);
    for (const item of brief.items) {
      expect(item.observation).toMatchObject({
        state: "shipped",
        shippedMessageId: brief.sent!.messageId,
        shippedConversationId: brief.sent!.conversationId,
      });
      // The verifier passed every shipped claim.
      expect(item.observation!.claims.every((c) => c.verification === "entailed")).toBe(true);
    }

    expect(await byMarker(S.kiln.marker)).toMatchObject({
      state: "dropped",
      closeReason: "expired",
    });
    expect(await byMarker(S.garden.marker)).toMatchObject({
      state: "held",
      closeReason: "below_bar",
    });
    expect(await byMarker(S.parcel.marker)).toMatchObject({
      state: "dropped",
      closeReason: "already_known",
    });
    expect(await byMarker(S.insurance.marker)).toMatchObject({
      state: "dropped",
      closeReason: "unsupported",
    });
    expect(await byMarker(S.bike.marker)).toMatchObject({
      state: "dropped",
      closeReason: "superseded",
    });
    expect(await byMarker(S.piano.marker)).toMatchObject({
      state: "dropped",
      closeReason: "stale",
    });

    // The morning lane rescored every open observation as of this morning.
    const morningIso = new Date(MORNING).toISOString();
    const recheck = bench.decision.calls.filter(
      (c) => (c.request.state as { now?: unknown; observation?: unknown }).now === morningIso,
    );
    expect(recheck.length).toBeGreaterThanOrEqual(7);
    const boiler = await bench.obs.observation((await byMarker(S.boiler.marker)).id);
    expect(boiler.decisions.map((d) => d.lane).sort()).toEqual(["note", "recheck"]);
  }, 240_000);

  test("the morning prompt carried exactly the ranked ids, in rank order", async () => {
    const runs = await bench.obs.runs({ kind: "daily" });
    const run = runs.items.find((r) => r.dedupeKey === `daily:digest:${MORNING_DAY}`)!;
    const prompt = await bench.obs.promptFor(run.id);
    const brief = await bench.obs.morningBrief(MORNING_DAY);
    expect(rankedIds(prompt)).toEqual(brief.items.map((i) => i.observationId));
  }, 60_000);

  test("retention reduces closed observations to outcome records after 90 days", async () => {
    const closed = (await bench.obs.observations()).items.filter(
      (o) => o.state === "shipped" || o.state === "dropped",
    );
    expect(closed.length).toBeGreaterThan(0);
    await bench.clock.set(MORNING + 91 * DAY);
    await waitFor(
      "closed observations pruned",
      async () =>
        (await bench.obs.observations()).items.some(
          (o) => o.state === "shipped" || o.state === "dropped",
        )
          ? null
          : true,
      90_000,
    );
    await bench.drainUntilQuiet();
    const outcomes = await bench.obs.observationOutcomes();
    expect(outcomes.items.map((o) => o.id).sort()).toEqual(closed.map((o) => o.id).sort());
    const boiler = outcomes.items.find((o) => o.topic.includes(S.boiler.marker))!;
    expect(boiler).toMatchObject({
      state: "shipped",
      sourceKinds: ["synthetic:test@example.com/synthetic:test@example.com"],
    });
    // The held observation is still open, and the would-push log outlives the row.
    expect((await bench.obs.observations()).items.map((o) => o.summary)).toEqual([
      expect.stringContaining(S.garden.marker),
    ]);
    expect((await bench.obs.wouldPush()).items).toHaveLength(1);
  }, 240_000);
});
