// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area G: the rhythm engine.
 *
 * The rhythm lanes are the parts of the Cognition Steward nothing but the
 * clock drives: the per-source daily batches, the morning digest, the
 * retrospective bootstrap, the generative synthesis/collision producers, and
 * the scheduled sweeps. Each is a due-gated pass that reads a marker out of
 * `cognition_engine_state`, enqueues under a day-scoped dedupe key, and writes
 * its marker LAST so a crash replays and folds.
 *
 * Every test here runs the gateway on the briefs VIRTUAL clock and crosses the
 * boundaries deliberately rather than waiting them out. Wall-clock time of day
 * is never load-bearing: each suite pins the clock to a local instant it
 * computes, and every stimulus document carries an explicit source timestamp,
 * so a run at 23:58 asserts the same thing as a run at noon.
 *
 * Suites are split by CONFIG, not by topic — a bench boots one gateway, and
 * the lanes below need genuinely different `brain` blocks (the digest lane
 * would otherwise fire inside the daily suite's `daily`-kind assertions, and
 * the bootstrap lane, which ships ON, would enqueue historical runs under
 * every other suite's feet).
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  ref,
  sleep,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Local midnight of the day `ms` falls in — the same arithmetic the kit's
 * `bench.clock.localMidnight` does, restated here because the suites' boundary
 * constants are evaluated while the module and the `describe` bodies load,
 * before any bench exists to ask. Callers that want another day pass a
 * NOON-anchored instant plus whole days, which lands on the intended local day
 * either side of a DST shift.
 */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The shared anchor for suites that pin their clock before observing rhythm
 * work. The synthesis suite instead follows the gateway's boot day because
 * it observes the first noticing run before moving the clock.
 */
const D0_NOON = localMidnight(Date.now()) + 12 * HOUR;

const SRC_A = "synthetic:alpha@example.com";
const SRC_B = "synthetic:beta@example.com";

// ── proving a rhythm pass ran ───────────────────────────────────────────────

/**
 * A key of engine state the rhythm loop stamps unconditionally, borrowed as a
 * heartbeat.
 *
 * The provenance-recheck lane is off in every suite here, and its DISABLED
 * tick re-anchors this watermark to the cognition clock's `now` — that is how
 * prior deaths landing while the knob is off are kept out of a later backfill.
 * Nothing reads or writes it while the lane is off, so it is free to borrow,
 * and it carries the instant the tick saw rather than a wall-clock timestamp.
 */
const RHYTHM_HEARTBEAT_KEY = "provenance_recheck_watermark";

/**
 * Block until the rhythm loop has run passes at the gateway's CURRENT
 * cognition instant.
 *
 * A test asserting that a lane enqueued NOTHING needs evidence the lane was
 * actually asked: elapsed wall time proves neither that the rhythm loop is
 * alive, nor that the clock POST landed, nor that any due-gate was consulted.
 * Arming the heartbeat one millisecond behind `now` and waiting for a tick to
 * lift it back to `now` proves all three at once. Twice over, because the
 * lanes are independent periodic tasks sharing one cadence: the first round
 * proves the loop is turning, the second that a whole turn of it went by at
 * this instant.
 */
async function awaitRhythmPasses(bench: BrainBench, rounds = 2): Promise<void> {
  const { now } = await bench.clock.now();
  for (let round = 0; round < rounds; round += 1) {
    bench.withWriteHandle((db) => {
      db.prepare(
        `INSERT INTO cognition_engine_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(RHYTHM_HEARTBEAT_KEY, String(now - 1));
    });
    await bench.markers.waitFor(RHYTHM_HEARTBEAT_KEY, (v) => v === String(now), 60_000);
  }
}

interface RunRow {
  id: string;
  kind: string;
  status: string;
  dedupe_key: string | null;
}

function runRows(bench: BrainBench, kind: string): RunRow[] {
  return bench.sql
    .prepare<
      [string],
      RunRow
    >("SELECT id, kind, status, dedupe_key FROM cognition_runs WHERE kind = ? ORDER BY enqueued_at ASC, id ASC")
    .all(kind);
}

/**
 * The LOOPS half of a delta-prime block — the lines between the per-source
 * header and the recent-decisions section. The two halves are scoped
 * differently (loops by source, decisions across the whole agent), so an
 * assertion about "this source's loops" has to read this section rather than
 * search the whole prompt.
 */
function primeLoops(prompt: string, sourceId: string): string[] {
  const label = `Tracked loops touching source "${sourceId}" (most important first):`;
  const start = prompt.indexOf(label);
  if (start < 0) return [];
  const rest = prompt.slice(start + label.length);
  const end = rest.indexOf("Recent decisions in this window:");
  return rest
    .slice(0, end < 0 ? undefined : end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// G1 — the daily boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("rhythm: the daily boundary", () => {
  let bench: BrainBench;
  /** The gateway id of the document the tracked loop is built from. */
  let alphaDocId = "";
  let loopId = "";
  const DAILY_HOUR = 5;
  /** The boundary the suite drives across: tomorrow at `DAILY_HOUR`. */
  const BOUNDARY = localMidnight(D0_NOON + DAY) + DAILY_HOUR * HOUR;
  const CROSS_AT = BOUNDARY + 30 * 60_000;
  /** The day key that boundary belongs to; resolved once the bench exists. */
  let CROSSED_DAY = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        dailyRunHour: DAILY_HOUR,
        // Every other rhythm lane off: this suite asserts on the `daily` kind,
        // and the digest rides that same kind.
        digest: { enabled: false },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
        sweepsEnabled: false,
        synthesis: { enabled: false },
        collision: { enabled: false },
      },
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: "Studio Northstar rehearsal hold",
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "rehearsal hold" }),
                call("open_loop_create", {
                  title: "Confirm the rehearsal hold with Studio Northstar",
                  description: "Tracked from the booking request.",
                  confidence: 0.9,
                  importance: 0.85,
                  docs: [ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: "Studio holds the slot until it is confirmed.",
                }),
              ],
              finalText: "Tracked the rehearsal hold.",
            }),
          },
          // The daily batches themselves do nothing — this suite asserts on the
          // ENQUEUE side (one run per source, its key, and its prompt).
          { flavour: "daily.source", plan: { calls: [], finalText: "Nothing in the batch." } },
        ],
      },
    });

    CROSSED_DAY = bench.clock.localDay(BOUNDARY);
    await bench.clock.set(D0_NOON);

    // Every stimulus carries an EXPLICIT source timestamp (`at`): the daily
    // enqueuer selects on `source_created_at` against a boundary window this
    // suite chose on the cognition clock, which wall-clock dating would miss.
    await bench.push({
      externalId: "rhythm-alpha-hold",
      title: "Studio Northstar rehearsal hold",
      content:
        "Hi Alex,\n\nWe are holding Thursday evening for your rehearsal at Studio Northstar. Confirm by reply and we will lock the room.\n\nStudio Northstar",
      documentType: "email",
      sourceId: SRC_A,
      providerId: SRC_A,
      at: D0_NOON,
    });
    // Sample-typed documents are the ones the real-time waker defers to the
    // daily batch, so these are what make each source qualify for one.
    await bench.push({
      externalId: "rhythm-alpha-txn",
      title: "Card payment to Cedar Grove Supplies",
      content: "Card payment of 18.40 to Cedar Grove Supplies.",
      documentType: "transaction",
      sourceId: SRC_A,
      providerId: SRC_A,
      at: D0_NOON + HOUR,
    });
    await bench.push({
      externalId: "rhythm-beta-txn",
      title: "Card payment to Riverside Estate",
      content: "Card payment of 240.00 to Riverside Estate.",
      documentType: "transaction",
      sourceId: SRC_B,
      providerId: SRC_B,
      at: D0_NOON + HOUR,
    });

    await bench.drainUntilQuiet();
    alphaDocId = await bench.docId("rhythm-alpha-hold");
    const loops = await bench.obs.loops();
    loopId = loops.items[0]?.id ?? "";
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the boundary's own day fired at boot, and the transaction docs woke nothing", async () => {
    // The pass that ran at boot claimed the day the suite starts on, so the
    // crossing below is a genuinely NEW boundary rather than the first one.
    expect(bench.markers.get("daily_last_run_day")).toBe(bench.clock.localDay(D0_NOON));
    // Its window was the day BEFORE the stimulus, so nothing was batched yet.
    expect(runRows(bench, "daily")).toHaveLength(0);
    // And the sample-typed documents are deferred, not woken on directly.
    const data = await bench.obs.settledRuns("data");
    expect(data.map((r) => r.dedupeKey)).toEqual([`data:doc:${alphaDocId}`]);
    expect(loopId).not.toBe("");
  }, 120_000);

  test("crossing the boundary enqueues exactly one daily batch per source", async () => {
    await bench.clock.set(CROSS_AT);
    await bench.markers.waitFor("daily_last_run_day", (v) => v === CROSSED_DAY, 60_000);
    await bench.drainUntilQuiet();

    const runs = await bench.obs.settledRuns("daily");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect([...runs.map((r) => r.dedupeKey)].sort()).toEqual([
      `daily:source:${SRC_A}:${CROSSED_DAY}`,
      `daily:source:${SRC_B}:${CROSSED_DAY}`,
    ]);

    // The payload window is boundary-to-boundary, not tick-to-tick.
    const payloads = runRows(bench, "daily").map(
      (r) => bench.runPayload(r.id) as { sourceId: string; dateFrom: string; dateTo: string },
    );
    for (const p of payloads) {
      expect(p.dateFrom).toBe(new Date(BOUNDARY - DAY).toISOString());
      expect(p.dateTo).toBe(new Date(BOUNDARY).toISOString());
    }
  }, 240_000);

  test("each batch prompt is the per-source flavour, delta-primed with that source's own loops", async () => {
    const runs = await bench.obs.settledRuns("daily");
    const bySource = new Map<string, string>();
    for (const run of runs) {
      const prompt = await bench.obs.promptFor(run.id);
      const source = /Daily batch review for source "([^"]+)"/.exec(prompt)?.[1] ?? "";
      bySource.set(source, prompt);
    }
    expect([...bySource.keys()].sort()).toEqual([SRC_A, SRC_B].sort());

    // The source carrying a tracked loop gets it named in the delta prime …
    const alpha = bySource.get(SRC_A)!;
    expect(alpha).toContain(`Tracked loops touching source "${SRC_A}" (most important first):`);
    expect(alpha).toContain(`[${loopId}]`);
    expect(alpha).toContain("Confirm the rehearsal hold with Studio Northstar");
    // … and the agent's own ledger note rides the line, never source content.
    expect(alpha).toContain("Studio holds the slot until it is confirmed.");
    expect(alpha).not.toContain("Confirm by reply and we will lock the room");

    // The source with no loops gets the same block, empty — never a crash.
    // Only the LOOPS section is source-scoped; the recent-decisions section
    // below it is the agent's whole recent activity, so the assertion has to
    // read the section rather than the whole prompt.
    const beta = bySource.get(SRC_B)!;
    expect(beta).toContain(`Tracked loops touching source "${SRC_B}" (most important first):`);
    expect(primeLoops(beta, SRC_B)).toEqual(["- (none)"]);
    expect(primeLoops(alpha, SRC_A).filter((l) => l.includes(`[${loopId}]`))).toHaveLength(1);
  }, 120_000);

  test("advancing again inside the same day enqueues nothing new", async () => {
    const before = runRows(bench, "daily").map((r) => r.id);
    await bench.clock.set(CROSS_AT + 8 * HOUR);
    // The day's marker cannot move here — that is the very thing under test —
    // so the heartbeat carries the proof instead: the loop ran passes at this
    // instant and the due gate is what chose to enqueue nothing.
    await awaitRhythmPasses(bench);
    await bench.drainUntilQuiet();

    expect(runRows(bench, "daily").map((r) => r.id)).toEqual(before);
    expect(bench.markers.get("daily_last_run_day")).toBe(CROSSED_DAY);
  }, 120_000);

  test("a restart does not re-fire the day the marker already claimed", async () => {
    const before = runRows(bench, "daily").map((r) => r.id);

    // A fresh process starts its virtual clock at the wall clock; the kit's
    // restart puts the suite's timeline back and reopens the SQL handle onto
    // the database the NEW process owns.
    await bench.restartGateway();
    await awaitRhythmPasses(bench);
    await bench.drainUntilQuiet();

    expect(runRows(bench, "daily").map((r) => r.id)).toEqual(before);
    expect(bench.markers.get("daily_last_run_day")).toBe(CROSSED_DAY);
  }, 240_000);

  test("a crash between the enqueue and the marker write replays and folds", async () => {
    // The state such a crash leaves: the day's rows enqueued and still PENDING
    // (never claimed), and no marker to say the pass ran. Parked out of the
    // drainer's reach so the replay is observed rather than raced.
    const before = runRows(bench, "daily")
      .map((r) => r.id)
      .sort();
    expect(before).toHaveLength(2);
    const parkedUntil = CROSS_AT + 24 * HOUR;
    bench.withWriteHandle((db) => {
      db.prepare(
        "UPDATE cognition_runs SET status = 'pending', attempts = 0, completed_at = NULL, next_attempt_at = ? WHERE kind = 'daily'",
      ).run(parkedUntil);
    });
    bench.markers.clear("daily_last_run_day");

    await bench.markers.waitFor("daily_last_run_day", (v) => v === CROSSED_DAY, 60_000);

    // The replay folded into the pending rows: same rows, same ids, no
    // second batch for a day that was already enqueued.
    const after = runRows(bench, "daily");
    expect(after.map((r) => r.id).sort()).toEqual(before);
    expect([...after.map((r) => r.dedupe_key)].sort()).toEqual([
      `daily:source:${SRC_A}:${CROSSED_DAY}`,
      `daily:source:${SRC_B}:${CROSSED_DAY}`,
    ]);
    await bench.drainUntilQuiet();
  }, 240_000);

  test("downtime fires once, for the most recent boundary only", async () => {
    // A gateway that was off for three days comes back to exactly ONE
    // boundary at or before now — never one batch per missed day.
    const before = new Set(runRows(bench, "daily").map((r) => r.id));
    await bench.push({
      externalId: "rhythm-alpha-txn-late",
      title: "Card payment to Studio Northstar",
      content: "Card payment of 62.00 to Studio Northstar.",
      documentType: "transaction",
      sourceId: SRC_A,
      providerId: SRC_A,
      at: localMidnight(D0_NOON + 3 * DAY) + 12 * HOUR,
    });
    await bench.docId("rhythm-alpha-txn-late");

    const boundary = localMidnight(D0_NOON + 4 * DAY) + DAILY_HOUR * HOUR;
    const day = bench.clock.localDay(boundary);
    await bench.clock.set(boundary + 30 * 60_000);
    await bench.markers.waitFor("daily_last_run_day", (v) => v === day, 60_000);
    await bench.drainUntilQuiet();

    // One batch — for the newest boundary's window, which is where the late
    // transaction sits. The two skipped days are simply never batched.
    const fresh = runRows(bench, "daily").filter((r) => !before.has(r.id));
    expect(fresh.map((r) => r.dedupe_key)).toEqual([`daily:source:${SRC_A}:${day}`]);
    const skipped = [
      bench.clock.localDay(localMidnight(D0_NOON + 2 * DAY) + DAILY_HOUR * HOUR),
      bench.clock.localDay(localMidnight(D0_NOON + 3 * DAY) + DAILY_HOUR * HOUR),
    ];
    for (const missed of skipped) {
      expect(runRows(bench, "daily").filter((r) => r.dedupe_key?.endsWith(`:${missed}`))).toEqual(
        [],
      );
    }
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// G2 — the morning digest
// ═══════════════════════════════════════════════════════════════════════════

describe("rhythm: the morning digest", () => {
  let bench: BrainBench;
  const DAILY_HOUR = 5;
  const DIGEST_HOUR = 7;
  const GRACE_MINUTES = 45;
  /** The digest hour on D+1, and ten minutes past it — inside the grace window. */
  const DIGEST_BOUNDARY = localMidnight(D0_NOON + DAY) + DIGEST_HOUR * HOUR;
  const DIGEST_AT = DIGEST_BOUNDARY + 10 * 60_000;
  /** The day key that boundary belongs to; resolved once the bench exists. */
  let DIGEST_DAY = "";
  const DIGEST_MARKER = "Riverside rehearsal week";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        dailyRunHour: DAILY_HOUR,
        digest: { enabled: true, hour: DIGEST_HOUR, graceMinutes: GRACE_MINUTES },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
        sweepsEnabled: false,
        synthesis: { enabled: false },
        collision: { enabled: false },
      },
      behaviors: {
        behaviors: [
          {
            flavour: "daily.digest",
            // The digest's subject is the local day it composes for, so the
            // card carries it — one suite boots several digests and each
            // must be attributable to its own day.
            plan: (ctx) => ({
              calls: [
                call("brief_list"),
                call("brief_create", {
                  kind: "info",
                  title: `Morning brief — ${DIGEST_MARKER} ${ctx.subject}`,
                  description: "One rehearsal to confirm; nothing else needs you today.",
                  body: "Nothing else needs you today.",
                  confidence: 0.7,
                  urgency: 0.4,
                }),
                // Authority probe. The morning-digest workflow is granted the
                // brief artifact and nothing else, so this verb is not in its
                // toolset at all — the call cannot land.
                call("open_loop_create", {
                  title: `Digest overreach — ${DIGEST_MARKER}`,
                  description: "A loop the digest has no authority to mint.",
                  confidence: 0.8,
                  importance: 0.8,
                }),
              ],
              finalText: "Composed the morning brief.",
            }),
          },
        ],
      },
    });
    DIGEST_DAY = bench.clock.localDay(DIGEST_BOUNDARY);
    await bench.clock.set(D0_NOON);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("crossing the digest hour composes exactly one digest for the day", async () => {
    const before = new Set(runRows(bench, "daily").map((r) => r.id));

    await bench.clock.set(DIGEST_AT);
    await bench.markers.waitFor("digest_last_run_day", (v) => v === DIGEST_DAY, 60_000);
    await bench.drainUntilQuiet();

    const fresh = runRows(bench, "daily").filter((r) => !before.has(r.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.dedupe_key).toBe(`daily:digest:${DIGEST_DAY}`);
    expect(fresh[0]!.status).toBe("completed");
    expect(bench.runPayload(fresh[0]!.id)).toEqual({ digest: true, date: DIGEST_DAY });

    // The readiness barrier released rather than being bypassed: the grace
    // deadline is 45 minutes past the hour and the clock stands at +10.
    expect(DIGEST_AT).toBeLessThan(DIGEST_BOUNDARY + GRACE_MINUTES * 60_000);
    // Its first condition — today's dailies already enqueued — was true when
    // the digest fired, and the marker that proves it is still there.
    expect(bench.markers.get("daily_last_run_day")! >= DIGEST_DAY).toBe(true);
  }, 240_000);

  test("the digest prompt is the composition flavour and its card is the day's one brief", async () => {
    const run = runRows(bench, "daily").find((r) => r.dedupe_key === `daily:digest:${DIGEST_DAY}`)!;
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain(`Morning digest for ${DIGEST_DAY}.`);
    expect(prompt).toContain('Compose EXACTLY ONE brief of kind "info"');
    // The digest is delta-primed with what is landing, not with a source batch.
    expect(prompt).toContain("Loops due soon or recently touched (most important first):");
    expect(prompt).not.toContain("Daily batch review for source");

    const briefs = await bench.obs.briefs();
    const cards = briefs.items.filter((b) => b.title.includes(`${DIGEST_MARKER} ${DIGEST_DAY}`));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("info");
    expect(cards[0]!.createdByRun).toBe(run.id);
  }, 120_000);

  test("the digest's authority is brief-only — its loop write never lands", async () => {
    const loops = await bench.obs.loops();
    expect(loops.items).toHaveLength(0);
    const pulse = await bench.obs.pulse();
    expect(pulse.counts.totalLoops).toBe(0);

    // Not vacuous: the puppet really did attempt the call, and the tool layer
    // answered that no such tool exists for this workflow.
    const run = runRows(bench, "daily").find((r) => r.dedupe_key === `daily:digest:${DIGEST_DAY}`)!;
    const refs = await bench.obs.transcripts({ runId: run.id });
    const { transcript } = await bench.obs.transcript(refs.items.at(-1)!.fileName);
    const wire = JSON.stringify(transcript.events);
    expect(wire).toContain("open_loop_create");
    expect(wire).toContain("unknown_tool");
  }, 120_000);

  test("advancing inside the same day composes no second digest", async () => {
    const before = runRows(bench, "daily").map((r) => r.id);
    await bench.clock.set(DIGEST_AT + 10 * HOUR);
    // Still the same local day for both the digest and the daily boundary, so
    // neither lane's marker can move; the heartbeat is what proves the rhythm
    // loop ran passes here and the day-scoped gate is what held.
    await awaitRhythmPasses(bench);
    await bench.drainUntilQuiet();

    expect(runRows(bench, "daily").map((r) => r.id)).toEqual(before);
    const briefs = await bench.obs.briefs();
    expect(
      briefs.items.filter((b) => b.title.includes(`${DIGEST_MARKER} ${DIGEST_DAY}`)),
    ).toHaveLength(1);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// G3 — the retrospective bootstrap
// ═══════════════════════════════════════════════════════════════════════════

describe("rhythm: bootstrap coverage", () => {
  let bench: BrainBench;
  const SRC_HISTORY = "synthetic:history@example.com";
  const MAX_PER_DAY = 2;
  /**
   * D+1 noon: comfortably past the ten-minute boot hold whatever hour the
   * suite booted at, and far enough from midnight that a later advance inside
   * the test stays on the same local day (the pace cap is per day).
   */
  const PAST_HOLD_AT = localMidnight(D0_NOON + DAY) + 12 * HOUR;
  /** The local day that instant falls on; resolved once the bench exists. */
  let PAST_HOLD_DAY = "";
  const SEEDS = [
    {
      externalId: "rhythm-history-1",
      title: "Rehearsal room lease renewal",
      content:
        "Your rehearsal room lease at Riverside Estate renews on 14 March 2029. Give notice in writing if you do not intend to continue.",
    },
    {
      externalId: "rhythm-history-2",
      title: "Equipment warranty registration",
      content:
        "The warranty on your Stellar Sound desk runs until 2 September 2030. Keep this message for the claim reference.",
    },
    {
      externalId: "rhythm-history-3",
      title: "Insurance policy schedule",
      content:
        "The public liability policy for Studio Northstar is scheduled to expire on 30 June 2029 unless renewed.",
    },
    {
      externalId: "rhythm-history-4",
      title: "Membership term confirmation",
      content:
        "Your Cedar Grove Supplies trade membership is valid through to 11 November 2029 at the current rate.",
    },
  ];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: MAX_PER_DAY,
          maxRunsPerDay: MAX_PER_DAY,
          maxRuns: 50,
          batchSize: 10,
        },
        digest: { enabled: false },
        mergeAdjudication: { enabled: false },
        sweepsEnabled: false,
        synthesis: { enabled: false },
        collision: { enabled: false },
      },
      behaviors: {
        // Bootstrap runs fetch their document, then do nothing: this suite is
        // about which documents the lane BUYS and what the counters say, not
        // about what the steward writes when it reads one.
        behaviors: [{ flavour: "bootstrap", plan: { calls: [], finalText: "Nothing to seed." } }],
      },
    });

    await bench.obs.startBootstrap();
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v !== undefined);

    PAST_HOLD_DAY = bench.clock.localDay(PAST_HOLD_AT);

    // Just outside the waker's 7-day recency window, so these are the lane's
    // most recent candidates and `recent-first` takes them before the
    // universe's (months-old) ambient corpus.
    const seededAt = Date.now() - 8 * DAY;
    for (const seed of SEEDS) {
      await bench.push({
        ...seed,
        documentType: "email",
        sourceId: SRC_HISTORY,
        providerId: SRC_HISTORY,
        at: seededAt,
      });
    }
    for (const seed of SEEDS) {
      const docId = await bench.docId(seed.externalId);
      await waitFor(
        `extracted dates for ${seed.externalId}`,
        () =>
          (bench.sql
            .prepare<
              [string],
              { n: number }
            >("SELECT COUNT(*) AS n FROM document_extracted_dates WHERE document_id = ?")
            .get(docId)?.n ?? 0) > 0
            ? true
            : null,
        90_000,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the lane holds through the boot window", async () => {
    // A pass inside the boot window defers, stamping the hold rather than
    // probing the corpus — so nothing is bought in the minutes after a start.
    expect(bench.markers.get("bootstrap_hold_since")).toBeDefined();
    expect(bench.markers.get("bootstrap_hold_since")).not.toBe("0");
    expect(runRows(bench, "bootstrap")).toHaveLength(0);
  }, 120_000);

  test("past the boot window the lane enqueues up to its per-day cap, keyed per document", async () => {
    await bench.clock.set(PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    await waitFor(
      "bootstrap runs to be enqueued",
      () => (runRows(bench, "bootstrap").length > 0 ? true : null),
      60_000,
    );
    await bench.drainUntilQuiet();

    const runs = runRows(bench, "bootstrap");
    // The backlog target and the per-day cap both bind at 2, so one pass
    // takes exactly that many however large the batch size is.
    expect(runs).toHaveLength(MAX_PER_DAY);
    const takenDocId = (run: RunRow): string =>
      (bench.runPayload(run.id) as { docId: string }).docId;
    for (const run of runs) {
      expect(run.dedupe_key).toBe(`bootstrap:doc:${takenDocId(run)}`);
    }

    // Every selected document belongs to the seeded history: `recent-first`
    // took the newest candidates, which are the ones this suite planted.
    const seedIds = new Set(await Promise.all(SEEDS.map((s) => bench.docId(s.externalId))));
    for (const run of runs) {
      expect(seedIds.has(takenDocId(run))).toBe(true);
    }

    // Selection marks at ENQUEUE, so a later pass can never re-select them.
    const marked = bench.sql
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM documents WHERE bootstrap_processed_at IS NOT NULL")
      .get()!.n;
    expect(marked).toBeGreaterThanOrEqual(MAX_PER_DAY);
  }, 240_000);

  test("the day's allowance is spent — a further pass inside it buys nothing", async () => {
    expect(bench.markers.get(`bootstrap_enqueued:${PAST_HOLD_DAY}`)).toBe(String(MAX_PER_DAY));
    expect(bench.markers.get("bootstrap_total_enqueued")).toBe(String(MAX_PER_DAY));

    const before = runRows(bench, "bootstrap").map((r) => r.id);
    // Later the same local day: the pace cap is per DAY, so crossing into the
    // next one would legitimately buy more.
    await bench.clock.set(PAST_HOLD_AT + 6 * HOUR);
    // The lane records its state on the way past the lifetime backstop, one
    // step AHEAD of the pace cap it is about to hit. Clearing that marker and
    // waiting for the lane to write it back is therefore proof that a pass
    // really reached the cap — the day's allowance held rather than the lane
    // having gone quiet on us.
    bench.markers.clear("bootstrap_state");
    await bench.markers.waitFor("bootstrap_state", (v) => v === "running", 60_000);
    await bench.drainUntilQuiet();
    expect(runRows(bench, "bootstrap").map((r) => r.id)).toEqual(before);
    expect(bench.markers.get(`bootstrap_enqueued:${PAST_HOLD_DAY}`)).toBe(String(MAX_PER_DAY));
    expect(bench.markers.get("bootstrap_total_enqueued")).toBe(String(MAX_PER_DAY));
  }, 240_000);

  test("a new local day restores the allowance and the lane takes fresh documents", async () => {
    const before = new Set(runRows(bench, "bootstrap").map((r) => r.id));
    const takenBefore = new Set(
      runRows(bench, "bootstrap").map((r) => (bench.runPayload(r.id) as { docId: string }).docId),
    );
    const nextDay = localMidnight(PAST_HOLD_AT + DAY) + 12 * HOUR;

    await bench.clock.set(nextDay);
    await bench.markers.waitFor(
      `bootstrap_enqueued:${bench.clock.localDay(nextDay)}`,
      (v) => v === String(MAX_PER_DAY),
      60_000,
    );
    await bench.drainUntilQuiet();

    const fresh = runRows(bench, "bootstrap").filter((r) => !before.has(r.id));
    expect(fresh).toHaveLength(MAX_PER_DAY);
    // Mark-at-enqueue means the new day's batch cannot re-select what the
    // first one already bought — the lane advances rather than looping.
    for (const run of fresh) {
      const docId = (bench.runPayload(run.id) as { docId: string }).docId;
      expect(takenBefore.has(docId)).toBe(false);
    }
    expect(bench.markers.get("bootstrap_total_enqueued")).toBe(String(2 * MAX_PER_DAY));
  }, 240_000);

  test("coverage reconciles with the runs that actually settled", async () => {
    const coverage = await bench.obs.coverage();
    const rows = coverage.items.filter((i) => i.workflowId === "source-bootstrap");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sourceId).toBe(SRC_HISTORY);

    const runs = runRows(bench, "bootstrap");
    const settled = runs.filter((r) => r.status !== "pending");
    expect(runs).toHaveLength(2 * MAX_PER_DAY);
    expect(settled).toHaveLength(runs.length);

    // `eligible` is bumped when the lane selects a document; `processed` /
    // `skipped` when its run settles. With every selected run settled the two
    // sides must agree, and the derived status must say so.
    expect(row.eligible).toBe(runs.length);
    expect(row.processed + row.skipped).toBe(settled.length);
    expect(row.status).toBe("settled");
    expect(coverage.bootstrapProcessedDocs).toBeGreaterThanOrEqual(runs.length);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// G4 — the generative producers: synthesis noticing + collision
// ═══════════════════════════════════════════════════════════════════════════

describe("rhythm: synthesis noticing and the collision sweep", () => {
  let bench: BrainBench;
  const NOTICING_MARKER = "Noticing pass card";
  /** The day the suite's clock starts on; resolved once the bench exists. */
  let D0_DAY = "";
  let bootDayNoon = 0;
  let collisionDocId = "";
  let loopIds: string[] = [];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        synthesis: { enabled: true, cadenceHours: 6, maxPerDay: 1 },
        collision: { enabled: true, cadenceHours: 6, maxPerSweep: 3 },
        bootstrap: { enabled: false },
        digest: { enabled: false },
        mergeAdjudication: { enabled: false },
        sweepsEnabled: false,
      },
      behaviors: {
        behaviors: [
          {
            flavour: "synthesis.noticing",
            plan: (ctx) => ({
              calls: [
                call("brief_list"),
                call("brief_create", {
                  kind: "info",
                  title: `${NOTICING_MARKER} for ${ctx.subject}`,
                  description: "A pattern worth knowing, with no clock on it.",
                  confidence: 0.6,
                  urgency: 0.3,
                }),
              ],
              finalText: "Noticed one thing.",
            }),
          },
          // The collision judge deliberately writes nothing: a candidate the
          // judge covered with a brief would be filtered out of later sweeps,
          // which would hide the enqueue behaviour this suite asserts on.
          {
            flavour: "synthesis.collision.loops",
            plan: { calls: [], finalText: "No real relationship." },
          },
          {
            flavour: "data.created",
            docTitle: "Riverside Estate site visit and invoice",
            plan: (ctx) => ({
              calls: [
                call("open_loop_create", {
                  title: "Book the Riverside Estate site visit",
                  description: "The visit still needs a date.",
                  confidence: 0.9,
                  importance: 0.8,
                  docs: [ctx.subject],
                }),
                call("open_loop_create", {
                  title: "Pay the Riverside Estate deposit invoice",
                  description: "The invoice on the same message is unpaid.",
                  confidence: 0.9,
                  importance: 0.7,
                  docs: [ctx.subject],
                }),
              ],
              finalText: "Two distinct obligations from one message.",
            }),
          },
        ],
      },
    });
    // Boot can cross local midnight after the module's shared anchor was
    // captured. The first noticing run belongs to the gateway's frozen day.
    const { now } = await bench.clock.now();
    D0_DAY = bench.clock.localDay(now);
    bootDayNoon = localMidnight(now) + 12 * HOUR;
    await waitFor(
      `boot-time noticing run for ${D0_DAY} to complete`,
      () => {
        const run = runRows(bench, "synthesis").find(
          (row) => row.dedupe_key === `synthesis:noticing:${D0_DAY}`,
        );
        return run?.status === "completed" ? run : null;
      },
      60_000,
    );
    await bench.clock.set(bootDayNoon);
    await bench.drainUntilQuiet();

    await bench.push({
      externalId: "rhythm-collision-doc",
      title: "Riverside Estate site visit and invoice",
      content:
        "Hi Alex,\n\nTwo things in one note: we still need a date for the site visit, and the deposit invoice attached is outstanding.\n\nRiverside Estate",
      documentType: "email",
      sourceId: SRC_A,
      providerId: SRC_A,
      at: bootDayNoon,
    });
    await bench.drainUntilQuiet();
    collisionDocId = await bench.docId("rhythm-collision-doc");
    loopIds = (await bench.obs.loops()).items.map((l) => l.id).sort();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the noticing pass fires on its cadence and its card lands", async () => {
    const runs = runRows(bench, "synthesis").filter(
      (r) => r.dedupe_key === `synthesis:noticing:${D0_DAY}`,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(bench.runPayload(runs[0]!.id)).toEqual({ focus: "noticing", date: D0_DAY });

    const prompt = await bench.obs.promptFor(runs[0]!.id);
    expect(prompt).toContain(`Synthesis pass ("Noticing") for ${D0_DAY}.`);
    expect(prompt).toContain("ORIGINATE at most ONE piece of awareness");
    expect(prompt).toContain("All tracked loops (most important first):");

    const briefs = await bench.obs.briefs();
    const cards = briefs.items.filter((b) => b.title.startsWith(NOTICING_MARKER));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.createdByRun).toBe(runs[0]!.id);
  }, 240_000);

  test("the per-day cap holds a second noticing pass inside the same day", async () => {
    const noticing = (): string[] =>
      runRows(bench, "synthesis")
        .filter((r) => r.dedupe_key?.startsWith("synthesis:noticing:"))
        .map((r) => r.dedupe_key!);
    const before = noticing();
    // Well past the 6h cadence, still inside the local day. The collision arm
    // rides its own cadence and may fire here, so this asserts on the noticing
    // producer alone — the cap it is subject to is per LOCAL DAY, not per pass.
    await bench.clock.set(bootDayNoon + 8 * HOUR);
    // Neither generative marker is guaranteed to move here — both lanes are
    // cadence-gated off an instant stamped before the clock was pinned — so
    // the heartbeat carries the proof: the rhythm loop ran passes AT this
    // instant, the noticing producer was asked, and its per-day cap answered.
    await awaitRhythmPasses(bench);
    await bench.drainUntilQuiet();
    expect(noticing()).toEqual(before);
  }, 240_000);

  test("crossing into a new day fires the collision sweep on the shared-document key", async () => {
    expect(loopIds).toHaveLength(2);
    const nextNoon = localMidnight(bootDayNoon + DAY) + 12 * HOUR;
    const nextDay = bench.clock.localDay(nextNoon);

    await bench.clock.set(nextNoon);
    await waitFor(
      "the collision sweep to seed a judge run",
      () =>
        runRows(bench, "synthesis").some((r) => r.dedupe_key?.startsWith("synthesis:collision:"))
          ? true
          : null,
      60_000,
    );
    await bench.drainUntilQuiet();

    const collisions = runRows(bench, "synthesis").filter((r) =>
      r.dedupe_key?.startsWith("synthesis:collision:"),
    );
    expect(collisions).toHaveLength(1);
    // The key is the SORTED member set, so the same pair re-detected through a
    // different signal folds onto this one run.
    expect(collisions[0]!.dedupe_key).toBe(`synthesis:collision:${loopIds.join(",")}`);
    const payload = bench.runPayload(collisions[0]!.id) as {
      focus: string;
      loopIds: string[];
      matchedBy: string[];
    };
    expect(payload.focus).toBe("collision");
    expect([...payload.loopIds].sort()).toEqual(loopIds);
    expect(payload.matchedBy).toContain(`doc:${collisionDocId}`);

    const prompt = await bench.obs.promptFor(collisions[0]!.id);
    expect(prompt).toContain("Cross-loop collision check.");
    expect(prompt).toContain(`doc:${collisionDocId}`);

    // The new day also lets the noticing pass through again — one per day.
    const noticing = runRows(bench, "synthesis").filter((r) =>
      r.dedupe_key?.startsWith("synthesis:noticing:"),
    );
    expect([...noticing.map((r) => r.dedupe_key)].sort()).toEqual([
      `synthesis:noticing:${D0_DAY}`,
      `synthesis:noticing:${nextDay}`,
    ]);
  }, 240_000);

  test("a settled verdict is not re-bought while its loops stand untouched", async () => {
    const before = runRows(bench, "synthesis").map((r) => r.id);
    const at = localMidnight(bootDayNoon + 2 * DAY) + 12 * HOUR;
    await bench.clock.set(at);
    // A day the noticing producer is due for again: its marker reaching this
    // instant is the positive control, so the collision producer standing
    // still below is a decision it took rather than a rhythm that never ran.
    await bench.markers.waitFor("synthesis_last_run_at", (v) => v === String(at), 60_000);
    await bench.drainUntilQuiet();

    const collisions = runRows(bench, "synthesis").filter((r) =>
      r.dedupe_key?.startsWith("synthesis:collision:"),
    );
    expect(collisions).toHaveLength(1);
    // The next day's noticing pass is the only new synthesis work — and there
    // IS one, so `every` below is a judgement on real rows.
    const fresh = runRows(bench, "synthesis").filter((r) => !before.includes(r.id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.dedupe_key?.startsWith("synthesis:noticing:"))).toBe(true);
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// G5 — the scheduled sweeps
// ═══════════════════════════════════════════════════════════════════════════

interface SweepDto {
  id: string;
  enabled: boolean;
  origin: string;
  steeringPrompt: string;
  stats: {
    runs: number;
    briefsCreated: number;
    loopsCreated: number;
    loopsTouched: number;
    annotationsCreated: number;
  };
}

describe("rhythm: scheduled sweeps", () => {
  let bench: BrainBench;
  const SWEEP_ID = "bench-rhythm-audit";
  const ANCHOR = "10:00";
  const ANCHOR_MS = 10 * HOUR;
  const STEERING_ONE =
    "Review the rehearsal bookings the user is carrying and surface only the ones whose date is still unsettled.";
  const STEERING_TWO =
    "Review the studio invoices the user is carrying and surface only the ones still unpaid after their due date.";
  const QUOTE = "The rehearsal date for the autumn showcase is still unsettled.";
  const SWEEP_MARKER = "Rehearsal audit";
  /** Set once the stimulus document has landed; the plan closes over it. */
  let sweepDocId = "";

  const sweepList = async (): Promise<SweepDto[]> =>
    (await bench.harness.gatewayJson<{ items: SweepDto[] }>("/admin/brain/sweeps")).items;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        sweepsEnabled: true,
        bootstrap: { enabled: false },
        digest: { enabled: false },
        mergeAdjudication: { enabled: false },
        synthesis: { enabled: false },
        collision: { enabled: false },
      },
      behaviors: {
        behaviors: [
          {
            flavour: "sweep",
            subject: SWEEP_ID,
            plan: () => ({
              calls: [
                call("open_loop_search", { query: "rehearsal date" }),
                call("open_loop_create", {
                  title: `${SWEEP_MARKER} — settle the rehearsal date`,
                  description: "Raised by the scheduled audit.",
                  confidence: 0.85,
                  importance: 0.7,
                  docs: [sweepDocId],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: "Opened by the rehearsal audit sweep.",
                }),
                call("annotate_durable", {
                  docId: sweepDocId,
                  claimType: "rehearsal_date_status",
                  claimText: "The autumn showcase rehearsal date is not yet fixed.",
                  evidenceDocId: sweepDocId,
                  evidenceQuote: QUOTE,
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
                call("brief_create", {
                  kind: "loop",
                  title: `${SWEEP_MARKER} — rehearsal date outstanding`,
                  description: "The autumn showcase still has no rehearsal date.",
                  citations: [sweepDocId],
                  relatedLoopIds: [ref("open_loop_create", "loop.id")],
                  confidence: 0.85,
                  urgency: 0.5,
                }),
              ],
              finalText: "Audited the rehearsal bookings.",
            }),
          },
        ],
      },
    });
    // Silence every shipped sweep BEFORE the clock is pinned, so the suite's
    // assertions are about ONE theme. A shipped sweep only seeds its phase on
    // first sight, but moving the clock forward across its anchor would make
    // it due — and they would then all queue up behind each other, serialized
    // in the drainer, under this suite's assertions.
    for (const sweep of await sweepList()) {
      await bench.harness.gatewayJson(`/admin/brain/sweeps/${sweep.id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      });
    }

    await bench.clock.set(D0_NOON);

    await bench.push({
      externalId: "rhythm-sweep-doc",
      title: "Autumn showcase rehearsal planning",
      content: `Hi Alex,\n\n${QUOTE} Let us know which evening suits and we will hold the room.\n\nStudio Northstar`,
      documentType: "email",
      sourceId: SRC_A,
      providerId: SRC_A,
      at: D0_NOON,
    });
    await bench.drainUntilQuiet();
    sweepDocId = await bench.docId("rhythm-sweep-doc");

    await bench.harness.gatewayJson(`/admin/brain/sweeps/${SWEEP_ID}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Rehearsal audit",
        cadenceHours: 24,
        at: ANCHOR,
        enabled: true,
        steeringPrompt: STEERING_ONE,
      }),
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a sweep that has never run seeds its phase instead of firing", async () => {
    await bench.markers.waitFor(
      `sweep_last_boundary_at:${SWEEP_ID}`,
      (v) => v !== undefined,
      60_000,
    );
    await sleep(2_000);
    // Seeding is what stops a fresh install enqueueing every theme in one
    // serialized batch; the first occurrence lands on the next anchor.
    expect(runRows(bench, "sweep")).toHaveLength(0);
    const seeded = Number(bench.markers.get(`sweep_last_boundary_at:${SWEEP_ID}`));
    expect(seeded).toBe(bench.clock.localMidnight(D0_NOON) + ANCHOR_MS);
  }, 120_000);

  test("crossing the anchor fires the sweep once for the day, prompt-steered", async () => {
    const boundary = localMidnight(D0_NOON + DAY) + ANCHOR_MS;
    const day = bench.clock.localDay(boundary);
    await bench.clock.set(boundary + 30 * 60_000);
    await waitFor(
      "the sweep to be enqueued",
      () => (runRows(bench, "sweep").length > 0 ? true : null),
      60_000,
    );
    await bench.drainUntilQuiet();

    const runs = runRows(bench, "sweep");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dedupe_key).toBe(`sweep:${SWEEP_ID}:${day}`);
    expect(runs[0]!.status).toBe("completed");
    // The marker records the BOUNDARY, not the tick that noticed it — that is
    // what keeps the cadence from drifting a tick per period.
    expect(Number(bench.markers.get(`sweep_last_boundary_at:${SWEEP_ID}`))).toBe(boundary);

    const prompt = await bench.obs.promptFor(runs[0]!.id);
    expect(prompt).toContain(`Scheduled sweep "${SWEEP_ID}" for ${day}.`);
    // The steering rides inside a per-run fence, framed as subject matter
    // rather than instruction.
    const fence = /<<<sweep-steering-[0-9a-f]{16}>>>/.exec(prompt)?.[0];
    expect(fence).toBeDefined();
    expect(prompt).toContain(`${fence}\n${STEERING_ONE}\n${fence}`);
    expect(prompt).toContain("End of steering.");
  }, 240_000);

  test("the sweep tally reconciles with what the scripted plan actually did", async () => {
    const run = runRows(bench, "sweep")[0]!;
    const tally = bench.sql
      .prepare<
        [string],
        {
          runs: number;
          failed_runs: number;
          briefs_created: number;
          loops_created: number;
          loops_touched: number;
          annotations_created: number;
        }
      >(
        "SELECT runs, failed_runs, briefs_created, loops_created, loops_touched, annotations_created FROM cognition_sweep_tally WHERE sweep_id = ?",
      )
      .get(SWEEP_ID)!;

    expect(tally.runs).toBe(1);
    expect(tally.failed_runs).toBe(0);

    // Counted back from `created_by_run`, so the tally and the artifact stores
    // cannot disagree — assert against the stores, not against the plan.
    const briefs = (await bench.obs.briefs()).items.filter((b) => b.createdByRun === run.id);
    const loops = (await bench.obs.loops()).items.filter((l) => l.createdByRun === run.id);
    const annotations = (await bench.obs.docAnnotations(sweepDocId)).annotations;
    expect(briefs).toHaveLength(1);
    expect(loops).toHaveLength(1);
    expect(annotations).toHaveLength(1);

    expect(tally.briefs_created).toBe(briefs.length);
    expect(tally.loops_created).toBe(loops.length);
    expect(tally.loops_touched).toBe(1);
    expect(tally.annotations_created).toBe(annotations.length);

    // And the operator surface reports the same numbers.
    const dto = (await sweepList()).find((s) => s.id === SWEEP_ID)!;
    expect(dto.stats).toMatchObject({
      runs: 1,
      briefsCreated: tally.briefs_created,
      loopsCreated: tally.loops_created,
      loopsTouched: tally.loops_touched,
      annotationsCreated: tally.annotations_created,
    });
  }, 120_000);

  test("steering is snapshotted at enqueue — a later edit cannot reach a fired occurrence", async () => {
    const firstRun = runRows(bench, "sweep")[0]!;
    const steeringOf = (runId: string): string =>
      (bench.runPayload(runId) as { steeringPrompt: string }).steeringPrompt;
    expect(steeringOf(firstRun.id)).toBe(STEERING_ONE);

    await bench.harness.gatewayJson(`/admin/brain/sweeps/${SWEEP_ID}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Rehearsal audit",
        cadenceHours: 24,
        at: ANCHOR,
        enabled: true,
        steeringPrompt: STEERING_TWO,
      }),
    });
    expect((await sweepList()).find((s) => s.id === SWEEP_ID)!.steeringPrompt).toBe(STEERING_TWO);

    // The occurrence that already fired carries its own copy of the prose —
    // the payload is a snapshot, not a pointer at the file.
    expect(steeringOf(firstRun.id)).toBe(STEERING_ONE);
    const prompt = await bench.obs.promptFor(firstRun.id);
    expect(prompt).toContain(STEERING_ONE);
    expect(prompt).not.toContain(STEERING_TWO);

    // The edit lands on the NEXT occurrence, which is the whole point of
    // snapshotting rather than freezing.
    const boundary = localMidnight(D0_NOON + 2 * DAY) + ANCHOR_MS;
    const day = bench.clock.localDay(boundary);
    await bench.clock.set(boundary + 30 * 60_000);
    await waitFor(
      "the next occurrence to be enqueued",
      () => (runRows(bench, "sweep").length > 1 ? true : null),
      60_000,
    );
    await bench.drainUntilQuiet();

    const second = runRows(bench, "sweep").find((r) => r.id !== firstRun.id)!;
    expect(second.dedupe_key).toBe(`sweep:${SWEEP_ID}:${day}`);
    expect(steeringOf(second.id)).toBe(STEERING_TWO);
    expect(steeringOf(firstRun.id)).toBe(STEERING_ONE);
  }, 240_000);

  test("downtime fires one occurrence, not one per missed anchor", async () => {
    const before = new Set(runRows(bench, "sweep").map((r) => r.id));
    // Three anchors go by unobserved. The marker holds the BOUNDARY the sweep
    // last fired for, and only one boundary sits at or before now, so the
    // catch-up is a single occurrence — not a serialized burst of three.
    const boundary = localMidnight(D0_NOON + 5 * DAY) + ANCHOR_MS;
    await bench.clock.set(boundary + 30 * 60_000);
    await waitFor(
      "the catch-up occurrence to be enqueued",
      () => (runRows(bench, "sweep").some((r) => !before.has(r.id)) ? true : null),
      60_000,
    );
    await sleep(3_000);
    await bench.drainUntilQuiet();

    const fresh = runRows(bench, "sweep").filter((r) => !before.has(r.id));
    expect(fresh.map((r) => r.dedupe_key)).toEqual([
      `sweep:${SWEEP_ID}:${bench.clock.localDay(boundary)}`,
    ]);
    for (const offset of [3, 4]) {
      const missed = bench.clock.localDay(localMidnight(D0_NOON + offset * DAY) + ANCHOR_MS);
      expect(runRows(bench, "sweep").filter((r) => r.dedupe_key?.endsWith(`:${missed}`))).toEqual(
        [],
      );
    }
    expect(Number(bench.markers.get(`sweep_last_boundary_at:${SWEEP_ID}`))).toBe(boundary);
  }, 240_000);
});

/**
 * The extracted-dates gate and the year-less convention, end to end.
 *
 * The backlog lane admits a document to the brain only when the extracted-
 * dates pass already found a still-future date in it. People write their own
 * planning documents without years ("August 16", "16 au 23 août"), so the
 * pass resolves a year-less month/day against the document's anchor — the
 * next occurrence on or after it — instead of dropping it; a
 * document written the human way therefore reaches the lane like any other.
 *
 * The control document (same shape, explicit year) proves the lane itself
 * works, so a failure on the year-less twin isolates the year rule rather
 * than the pipeline.
 */
describe("rhythm: the extracted-dates gate and year-less documents", () => {
  let bench: BrainBench;
  const SRC = "synthetic:planning@example.com";
  const GATE_PAST_HOLD_AT = localMidnight(D0_NOON + DAY) + 12 * HOUR;
  let controlDocId = "";
  let yearlessDocId = "";

  // A date months out but clamped INSIDE the current calendar year, phrased
  // without a year the way a person plans. The clamp is what keeps both
  // sensible resolutions (the anchor's year, or the next occurrence) in the
  // future whatever day of the year this runs: past early October, now+90d
  // crosses into January, where an anchor's-year policy would resolve it
  // months into the past and the gate's still-future condition could never
  // open.
  const futureAt = new Date(
    Math.min(Date.now() + 90 * DAY, Date.UTC(new Date().getUTCFullYear(), 11, 20)),
  );
  const MONTH_NAME = futureAt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const DAY_OF_MONTH = futureAt.getUTCDate();

  const CONTROL = {
    externalId: "gate-control-yearful",
    title: "Residency block confirmed (control)",
    content: `The Studio Northstar residency block is confirmed for ${MONTH_NAME} ${DAY_OF_MONTH}, ${futureAt.getUTCFullYear()}. Final schedule to follow.`,
  };
  const YEARLESS = {
    externalId: "gate-yearless-plan",
    title: "Residency block planning notes",
    content: `The Studio Northstar residency block is planned for ${MONTH_NAME} ${DAY_OF_MONTH}. Final schedule to follow.`,
  };

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 10,
          maxRunsPerDay: 10,
          maxRuns: 50,
          batchSize: 10,
        },
        digest: { enabled: false },
        mergeAdjudication: { enabled: false },
        sweepsEnabled: false,
        synthesis: { enabled: false },
        collision: { enabled: false },
      },
      behaviors: {
        behaviors: [
          { flavour: "bootstrap", plan: { calls: [], finalText: "Read; nothing to do." } },
        ],
      },
    });
    await bench.obs.startBootstrap();
    // Wait for the consent-triggered pass at the bench's boot instant before
    // moving virtual time. Merely issuing Start first is not enough: its
    // periodic kick is asynchronous, so a fast clock move can still put that
    // pass beyond the ten-minute boot grace before it stamps the hold.
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v !== undefined);
    await bench.clock.set(D0_NOON);

    // Outside the waker's recency window: these are backlog documents, and
    // the backlog lane is the only door left for them.
    const seededAt = Date.now() - 8 * DAY;
    await bench.push({
      ...CONTROL,
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: seededAt,
    });
    await bench.push({
      ...YEARLESS,
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: seededAt,
    });

    // The pass stamps `dates_extracted_at` on every document it VISITS,
    // stored rows or not — so waiting on the stamp for BOTH documents is what
    // makes "zero rows" mean "visited and dropped" rather than "not yet
    // reached". (The control's stored row alone would not prove the twin was
    // ever looked at.)
    controlDocId = await bench.docId(CONTROL.externalId);
    yearlessDocId = await bench.docId(YEARLESS.externalId);
    for (const id of [controlDocId, yearlessDocId]) {
      await waitFor(
        `the extraction pass to visit ${id}`,
        () =>
          bench.sql
            .prepare<
              [string],
              { stamped: string | null }
            >("SELECT dates_extracted_at AS stamped FROM documents WHERE id = ?")
            .get(id)?.stamped
            ? true
            : null,
        90_000,
      );
    }
    expect(controlDocId).not.toBe("");
    expect(yearlessDocId).not.toBe("");
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a year-less planning document still gets its dates extracted", () => {
    const rows = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_extracted_dates WHERE document_id = ?")
      .get(yearlessDocId);
    expect(
      rows?.n ?? 0,
      "the extraction pass stamped this document as visited, and stored nothing from it",
    ).toBeGreaterThan(0);
  }, 60_000);

  test("the gate admits the year-ful control to the backlog lane", async () => {
    await bench.clock.set(GATE_PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    const controlId = await bench.docId(CONTROL.externalId);
    await waitFor(
      "the control document to become a bootstrap candidate",
      () =>
        runRows(bench, "bootstrap").some((r) => r.dedupe_key === `bootstrap:doc:${controlId}`)
          ? true
          : null,
      90_000,
    );
    await bench.drainUntilQuiet();
  }, 180_000);

  test("the gate admits the year-less twin as well", () => {
    // The year-less date resolved against the anchor, so the still-future
    // condition holds and the gate opens exactly as for the control.
    expect(
      runRows(bench, "bootstrap").some((r) => r.dedupe_key === `bootstrap:doc:${yearlessDocId}`),
      "the year-less document never became a bootstrap candidate",
    ).toBe(true);
  }, 60_000);
});
