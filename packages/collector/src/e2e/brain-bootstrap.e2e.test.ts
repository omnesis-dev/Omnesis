// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — the retrospective bootstrap lane.
 *
 * `brain-rhythm`'s `bootstrap coverage` block already covers the lane's PACING:
 * which documents it buys, how many, when, and what the counters say. It says
 * so in its own words — "not about what the steward writes when it reads one".
 *
 * This suite is the complement, and covers three things pacing cannot see:
 *
 *  - **What a run produces.** The lane exists to seed temporal annotations and
 *    open loops from history. A regression that left runs completing while
 *    writing nothing would keep every pacing assertion green.
 *  - **Marker discipline across the two lanes.** Three paths write
 *    `bootstrap_processed_at`: the enqueuer marks what it selects, a completed
 *    bootstrap run marks the older documents it opened (the cross-arc skip),
 *    and a completed `data` run marks the datum it reasoned over. The last two
 *    exist to stop the engine buying the same document twice, so their failure
 *    mode is invisible except as spend.
 *  - **The lane's lifecycle end to end.** `running` / `drained` / `parked` and
 *    the ways a quiet lane comes back. These are unit-tested against a fake
 *    write gate; here they run against the real queue, rhythm loop and config
 *    store.
 *
 * Every negative assertion goes through {@link awaitRhythmPasses}: proving a
 * lane bought NOTHING requires evidence it was asked, and elapsed wall time is
 * not that evidence.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  sleep,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Local midnight of the day `ms` falls in — see the note in `brain-rhythm`. */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local noon today: the anchor every instant below derives from. */
const D0_NOON = localMidnight(Date.now()) + 12 * HOUR;

/** D+1 noon — past the ten-minute boot hold whatever hour the suite starts. */
const PAST_HOLD_AT = localMidnight(D0_NOON + DAY) + 12 * HOUR;

const SRC = "synthetic:archive@example.com";
const SRC_OTHER = "synthetic:annexe@example.com";

/**
 * A key the rhythm loop stamps on every DISABLED provenance-recheck tick,
 * borrowed as a heartbeat. Valid here for the same reason as in `brain-rhythm`:
 * the lane is off in every bench below, so nothing else reads or writes it.
 */
const RHYTHM_HEARTBEAT_KEY = "provenance_recheck_watermark";

/**
 * Block until the rhythm loop has run passes at the CURRENT cognition instant.
 * Arming the heartbeat one millisecond behind `now` and waiting for a tick to
 * lift it back proves the loop is alive, the clock landed, and a due-gate was
 * consulted — the three things an "it bought nothing" assertion really claims.
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

/** Grant the explicit operator consent required before the bootstrap lane runs. */
async function startBootstrap(bench: BrainBench): Promise<void> {
  await bench.obs.startBootstrap();
  await bench.markers.waitFor("bootstrap_hold_since", (value) => value !== undefined, 60_000);
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

/** The document a bootstrap run was bought for — it lives in the payload. */
function takenDocId(bench: BrainBench, runId: string): string {
  return (bench.runPayload(runId) as { docId: string }).docId;
}

/** Whether the lane has marked this document, by any of the three paths. */
function isMarked(bench: BrainBench, docId: string): boolean {
  const row = bench.sql
    .prepare<
      [string],
      { marked: string | null }
    >("SELECT bootstrap_processed_at AS marked FROM documents WHERE id = ?")
    .get(docId);
  return row?.marked != null;
}

/**
 * Wait until the deterministic date extractor has stored dates for a document.
 * Bootstrap eligibility is a join against `document_extracted_dates`, so a
 * document with no row there is invisible to the lane however it is dated —
 * seeding without this wait would assert nothing.
 */
async function awaitExtractedDates(bench: BrainBench, docId: string, label: string): Promise<void> {
  await waitFor(
    `extracted dates for ${label}`,
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

/**
 * Every lane off except the one under test. `bootstrap` and
 * `mergeAdjudication` are deliberately outside the bench's own quiet baseline
 * (they ship on for reasons of their own), so a bootstrap suite has to name
 * them or share its queue with the adjudicator.
 */
const LANES_OFF = { mergeAdjudication: { enabled: false } } as const;

// ═══════════════════════════════════════════════════════════════════════════
// What a run writes, and what it marks on the way
// ═══════════════════════════════════════════════════════════════════════════

describe("bootstrap: what a run writes", () => {
  let bench: BrainBench;

  /**
   * The subject. Its quote is reproduced verbatim below: the annotation write
   * verifies quote-in-document before persisting, so a paraphrase would fail
   * the write rather than the assertion.
   */
  const LEASE = {
    externalId: "bs-lease",
    title: "Rehearsal room lease renewal",
    content:
      "Your rehearsal room lease at Fenwick Hall renews on 14 March 2029. Give notice in writing before then if you do not intend to continue.",
  };
  const LEASE_QUOTE = "renews on 14 March 2029";

  /**
   * The arc. The per-day cap of one keeps this out of the lane's own reach, so
   * the cross-arc skip is the only thing that could ever mark it.
   */
  const ANNEXE = {
    externalId: "bs-annexe",
    title: "Annexe access terms",
    content:
      "Access to the Fenwick Hall annexe is included until 14 March 2029 under the same agreement.",
  };

  let leaseId = "";
  let annexeId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        ...LANES_OFF,
        // A frozen clock never advances past a deferred run's due time.
        derivationBarrier: "0s",
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 1,
          maxRunsPerDay: 1,
          maxRuns: 50,
          batchSize: 10,
        },
      },
      behaviors: {
        behaviors: [
          {
            flavour: "bootstrap",
            // A function, so `annexeId` is read when the run happens rather
            // than when the table is declared.
            plan: (ctx) => ({
              calls: [
                // The puppet already fetched the subject; this second batch
                // pulls the arc document in, and the run-driver counts every
                // id in a `fetch_many` batch as opened.
                call("fetch_many", { documents: [{ documentId: annexeId }] }),
                // Reconcile before writing, as the production prompt instructs:
                // the lane walks history newest-first, so a later document may
                // already carry this fact.
                call("temporal_query", { from: "2029-03-01", to: "2029-03-31" }),
                call("temporal_annotation_add", {
                  when: "2029-03-14",
                  sentence: "BS-LEASE Fenwick Hall rehearsal room lease renews.",
                  kind: "event",
                  documentIds: [ctx.subject!],
                  evidence: { docId: ctx.subject!, quote: LEASE_QUOTE },
                }),
                call("open_loop_search", { query: "Fenwick Hall lease notice" }),
                call("open_loop_create", {
                  title: "BS-LOOP Decide on the Fenwick Hall lease before it renews",
                  description:
                    "The lease renews automatically on 14 March 2029 unless notice is given in writing.",
                  confidence: 0.85,
                  importance: 0.6,
                  docs: [ctx.subject],
                }),
              ],
              finalText: "Seeded the renewal date and the notice decision.",
            }),
          },
        ],
      },
    });
    await startBootstrap(bench);

    // Outside the waker's 7-day recency window, so these belong to the
    // retrospective lane; recent enough that `recent-first` reaches them
    // before the universe's ambient corpus.
    //
    // The two are deliberately a day apart. `recent-first` then makes the
    // LEASE the subject every time, which is what lets the arc document be
    // reachable only across the run's own fetch — on equal timestamps the
    // tie breaks arbitrarily and the test asserts a different thing each run.
    for (const [doc, ageDays] of [
      [LEASE, 8],
      [ANNEXE, 9],
    ] as const) {
      await bench.push({
        ...doc,
        documentType: "email",
        sourceId: SRC,
        providerId: SRC,
        at: D0_NOON - ageDays * DAY,
      });
    }
    leaseId = await bench.docId(LEASE.externalId);
    annexeId = await bench.docId(ANNEXE.externalId);
    await awaitExtractedDates(bench, leaseId, LEASE.externalId);
    await awaitExtractedDates(bench, annexeId, ANNEXE.externalId);

    await bench.clock.set(PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    await waitFor(
      "a bootstrap run to be enqueued",
      () => (runRows(bench, "bootstrap").length > 0 ? true : null),
      60_000,
    );
    await bench.drainUntilQuiet();
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("one run is bought, for the newest candidate, and it completes", () => {
    const runs = runRows(bench, "bootstrap");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.dedupe_key).toBe(`bootstrap:doc:${takenDocId(bench, runs[0]!.id)}`);
    // `recent-first` under a cap of one takes the LEASE. Asserted rather than
    // assumed: every later assertion here reads on the subject being that
    // document, and the arc document being reachable only across the fetch.
    expect(takenDocId(bench, runs[0]!.id)).toBe(leaseId);
  });

  test("it writes a temporal annotation carrying the document's future date", async () => {
    const runId = runRows(bench, "bootstrap")[0]!.id;
    const tools = await bench.obs.executedTools(runId);
    const added = tools.filter((t) => t.tool === "temporal_annotation_add");
    expect(added).toHaveLength(1);

    // A tool reporting success is not the same as the entry being readable:
    // assert through the window the product actually serves.
    const window = await bench.obs.temporalWindow({
      from: Date.parse("2029-03-01T00:00:00Z"),
      to: Date.parse("2029-03-31T23:59:59Z"),
    });
    expect(JSON.stringify(window.items)).toContain("BS-LEASE");
  }, 120_000);

  test("it opens a loop for the obligation the document leaves outstanding", async () => {
    const loops = await bench.obs.loopsMatching("BS-LOOP");
    expect(loops).toHaveLength(1);
    expect(loops[0]!.state).toBe("open");
  }, 120_000);

  test("the cross-arc skip marks the older document the run pulled in", () => {
    // The subject carries the marker from mark-at-enqueue; the arc document
    // only from the run settling with it among the ids it fetched.
    expect(isMarked(bench, leaseId)).toBe(true);
    expect(isMarked(bench, annexeId)).toBe(true);
  });

  test("neither document earns a second run once a fresh day restores the cap", async () => {
    const before = runRows(bench, "bootstrap").map((r) => r.id);
    // A new local day hands the lane its allowance back, so the marker — not
    // the pace cap — is what has to hold these two documents back.
    await bench.clock.set(localMidnight(PAST_HOLD_AT + DAY) + 12 * HOUR);
    await awaitRhythmPasses(bench);
    await bench.drainUntilQuiet();

    for (const run of runRows(bench, "bootstrap").filter((r) => !before.includes(r.id))) {
      const taken = takenDocId(bench, run.id);
      expect(taken).not.toBe(leaseId);
      expect(taken).not.toBe(annexeId);
    }
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// The boundary with the live lane
// ═══════════════════════════════════════════════════════════════════════════

describe("bootstrap: the boundary with the live lane", () => {
  let bench: BrainBench;

  /** Reasoned over live, then left to age past the recency window. */
  const COVERED = {
    externalId: "bs-covered",
    title: "Kestrel Instruments service plan",
    content: "Service plan for the Kestrel Instruments desk is valid until 9 October 2029.",
  };
  /**
   * The control, and the reason this test discriminates. Identical in every
   * respect the lane selects on — same source, same age, its own future date —
   * but never reasoned over live. Without it, "bootstrap skipped COVERED"
   * would also pass on a lane that had simply stopped selecting anything.
   */
  const UNCOVERED = {
    externalId: "bs-uncovered",
    title: "Harbourline rehearsal booking",
    content: "Rehearsal block at Harbourline Studios is held for you until 9 October 2029.",
  };

  let coveredId = "";
  let uncoveredId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        ...LANES_OFF,
        derivationBarrier: "0s",
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 10,
          maxRunsPerDay: 10,
          maxRuns: 50,
          batchSize: 10,
        },
      },
      behaviors: {
        behaviors: [
          // The live run need not write anything: settling `completed` is what
          // stamps the marker under test.
          { flavour: "data.created", plan: { calls: [], finalText: "Noted." } },
          { flavour: "bootstrap", plan: { calls: [], finalText: "Nothing to seed." } },
        ],
      },
    });
    await startBootstrap(bench);

    await bench.clock.set(D0_NOON);
    // Inside the waker's recency window at this instant, so the live lane takes it.
    await bench.push({
      ...COVERED,
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: D0_NOON - 1 * DAY,
    });
    coveredId = await bench.docId(COVERED.externalId);
    await awaitExtractedDates(bench, coveredId, COVERED.externalId);

    // Nudge the frozen clock past the conversation/document debounce so the
    // waker's run becomes due at all, then wait for it to SETTLE — the marker
    // is written on settle, not on claim.
    await bench.clock.set(D0_NOON + 1 * HOUR);
    await waitFor(
      "the live lane to reason over the fresh datum",
      () => (runRows(bench, "data").some((r) => r.status === "completed") ? true : null),
      180_000,
    );
    await bench.drainUntilQuiet();

    // The control arrives already old, so the live lane never sees it.
    await bench.push({
      ...UNCOVERED,
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: D0_NOON - 8 * DAY,
    });
    uncoveredId = await bench.docId(UNCOVERED.externalId);
    await awaitExtractedDates(bench, uncoveredId, UNCOVERED.externalId);
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a completed live run marks its own datum", () => {
    expect(isMarked(bench, coveredId)).toBe(true);
    // The control is untouched — nothing has selected it yet.
    expect(isMarked(bench, uncoveredId)).toBe(false);
  });

  test("once it ages out, the lane buys the control and never the covered datum", async () => {
    // Ten days on, COVERED's own timestamp is well outside the recency window,
    // so on the lane/waker boundary alone it is squarely a candidate.
    await bench.clock.set(localMidnight(D0_NOON + 10 * DAY) + 12 * HOUR);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    await waitFor(
      "the retrospective lane to buy the control",
      () =>
        runRows(bench, "bootstrap").some((r) => takenDocId(bench, r.id) === uncoveredId)
          ? true
          : null,
      180_000,
    );
    await bench.drainUntilQuiet();

    // The lane is demonstrably selecting — and it still never bought the
    // document the live lane had already reasoned over.
    const taken = runRows(bench, "bootstrap").map((r) => takenDocId(bench, r.id));
    expect(taken).toContain(uncoveredId);
    expect(taken).not.toContain(coveredId);
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// The lane's lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("bootstrap: the lane's lifecycle", () => {
  let bench: BrainBench;
  const SEEDS = [
    {
      externalId: "bs-life-1",
      title: "Public liability schedule",
      content: "Public liability policy for Harbourline Studios expires on 30 June 2029.",
    },
    {
      externalId: "bs-life-2",
      title: "Trade membership term",
      content: "Trade membership at Cedar Row Supplies runs through to 11 November 2029.",
    },
  ];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        ...LANES_OFF,
        derivationBarrier: "0s",
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 10,
          maxRunsPerDay: 10,
          // A lifetime backstop of one, so the park and the resume are both
          // reachable inside a single suite.
          maxRuns: 1,
          batchSize: 10,
        },
      },
      behaviors: {
        behaviors: [
          { flavour: "bootstrap", plan: { calls: [], finalText: "Nothing to seed." } },
          { flavour: "bootstrap.deleted", plan: { calls: [], finalText: "Document is gone." } },
        ],
      },
    });
    await startBootstrap(bench);

    await bench.clock.set(D0_NOON);
    for (const seed of SEEDS) {
      await bench.push({
        ...seed,
        documentType: "email",
        sourceId: SRC,
        providerId: SRC,
        at: D0_NOON - 8 * DAY,
      });
      await awaitExtractedDates(bench, await bench.docId(seed.externalId), seed.externalId);
    }

    await bench.clock.set(PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("it parks at the lifetime backstop", async () => {
    await bench.markers.waitFor("bootstrap_state", (v) => v === "parked", 180_000);
    expect(bench.markers.get("bootstrap_total_enqueued")).toBe("1");
    expect(runRows(bench, "bootstrap")).toHaveLength(1);
  }, 240_000);

  test("raising the ceiling resumes it, with no restart", async () => {
    // The operator-facing promise: the backstop is re-read live, so the lane
    // comes back on the next tick rather than needing a state row edited or a
    // process bounced.
    await bench.patchConfig({ brain: { bootstrap: { maxRuns: 50 } } });
    await bench.markers.waitFor("bootstrap_state", (v) => v === "running", 180_000);
    await waitFor(
      "the lane to buy again past the raised ceiling",
      () => (runRows(bench, "bootstrap").length > 1 ? true : null),
      180_000,
    );
    await bench.drainUntilQuiet();
    expect(Number(bench.markers.get("bootstrap_total_enqueued"))).toBeGreaterThan(1);
  }, 300_000);

  test("with nothing left to review it goes drained, recording what would wake it", async () => {
    await bench.markers.waitFor("bootstrap_state", (v) => v === "drained", 240_000);
    // Going quiet is only safe if the lane also recorded the two facts that
    // justify it — otherwise a later pass has no basis for staying quiet.
    expect(bench.markers.get("bootstrap_drained_day")).toBeTruthy();
    expect(bench.markers.get("bootstrap_drained_sources")).toBeTruthy();
  }, 300_000);

  test("a source arriving with history behind it reopens the lane", async () => {
    // The history first, so the reopened lane has something to find.
    await bench.push({
      externalId: "bs-life-3",
      title: "Annexe insurance certificate",
      content: "Annexe cover for Harbourline Studios is in force until 4 April 2029.",
      documentType: "email",
      sourceId: SRC_OTHER,
      providerId: SRC_OTHER,
      at: D0_NOON - 9 * DAY,
    });
    const newDocId = await bench.docId("bs-life-3");
    await awaitExtractedDates(bench, newDocId, "bs-life-3");

    // Ingesting under a novel source id does NOT put a row in `sources`: push
    // self-registration is skipped for a token holding `write:*`, which the
    // bench's is. So the roster is the stimulus that has to be written — and
    // the roster is exactly what the enqueuer watches. It polls
    // MAX(sources.created_at) rather than being notified, so that no
    // source-add path can forget to tell it, and so a source added while the
    // Brain was off is still noticed when it comes back.
    const device = bench.sql.prepare<[], { id: string }>("SELECT id FROM devices LIMIT 1").get()!;
    const newest =
      bench.sql
        .prepare<[], { newest: number | null }>("SELECT MAX(created_at) AS newest FROM sources")
        .get()?.newest ?? 0;
    bench.withWriteHandle((db) => {
      db.prepare(
        `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', 1, ?, ?)`,
      ).run(SRC_OTHER, "synthetic", "annexe@example.com", device.id, newest + 1, newest + 1);
    });

    // The clock does not move in this test, so the local day cannot change —
    // the roster's high-water mark is the only reason the lane can reopen, and
    // a pass reaching `running` is therefore evidence of that specific reason.
    await bench.markers.waitFor("bootstrap_state", (v) => v === "running", 240_000);

    // And it does more than change state: the reopened lane goes on to buy the
    // history the new source brought with it.
    await waitFor(
      "the reopened lane to buy the new source's history",
      () =>
        runRows(bench, "bootstrap").some((r) => takenDocId(bench, r.id) === newDocId) ? true : null,
      180_000,
    );
  }, 300_000);

  test("a run whose document was deleted is told so, and creates nothing", async () => {
    // The lane marks and queues at SELECTION time, so a privacy delete landing
    // between selection and drain leaves a run pointing at a document that no
    // longer exists. The run has to absorb that — completing rather than
    // failing, and without reasoning from remembered content.
    //
    // Seeded rather than caught in flight: waiting for a *pending* run to
    // appear races the drainer that is emptying the queue, and a test that has
    // to win a race against the system under test is a flake waiting to be
    // written. Seeding the row states the situation exactly.
    await bench.push({
      externalId: "bs-life-doomed",
      title: "Cancelled hall booking",
      content: "Booking at Fenwick Hall is held until 21 August 2029 pending confirmation.",
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: D0_NOON - 10 * DAY,
    });
    const doomedId = await bench.docId("bs-life-doomed");
    await bench.deleteDoc(doomedId);

    const { now } = await bench.clock.now();
    const runId = bench.seedRun({
      id: `run_${"deleted-doc".padEnd(8, "x")}-${now}`,
      kind: "bootstrap",
      payload: { docId: doomedId, datumAt: D0_NOON - 10 * DAY },
      dedupeKey: `bootstrap:doc:${doomedId}`,
      nextAttemptAt: now,
      enqueuedAt: now,
      cycleAnchorAt: now,
    });
    const loopsBefore = (await bench.obs.loops({ limit: 500 })).items.length;

    await waitFor(
      "the seeded run to settle",
      () => {
        const row = bench.sql
          .prepare<[string], { status: string }>("SELECT status FROM cognition_runs WHERE id = ?")
          .get(runId);
        return row && row.status !== "pending" ? true : null;
      },
      180_000,
    );

    const settled = bench.sql
      .prepare<[string], { status: string }>("SELECT status FROM cognition_runs WHERE id = ?")
      .get(runId)!;
    // Absorbed, not failed: a vanished document is an ordinary state of the
    // world for a lane that queues ahead of itself, not an error.
    expect(settled.status).toBe("completed");
    // The prompt is where the contract lives — being told the document is gone
    // is what stops the run fetching it or reasoning from memory.
    expect(await bench.obs.promptFor(runId)).toContain("DELETED");
    // And nothing was minted off a document that no longer exists.
    expect((await bench.obs.loops({ limit: 500 })).items.length).toBe(loopsBefore);
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// A provider outage must cost time, never documents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The lane marks a document processed when it ENQUEUES it, so that a later
 * pass never buys the same work twice. That marker is what makes a failed run
 * expensive: retire the run and the document keeps a marker it never earned,
 * and the enqueuer — which selects on the marker being absent — can never
 * reach it again.
 *
 * A model backend refusing every call is the case where that goes wrong at
 * scale rather than one document at a time. Every claimed run fails
 * identically, so an outage long enough to exhaust the retry ladder would
 * quietly retire as many documents as the daily cap allows, none of them ever
 * reasoned over, with nothing in the corpus recording that they were skipped.
 *
 * The contract asserted here is that an outage costs only time: runs keep
 * their attempts, documents keep their place, the brain stops asking a backend
 * that cannot answer, and service resumes on its own when the backend does.
 */
describe("bootstrap: a provider outage", () => {
  let bench: BrainBench;
  let docId = "";

  const NOTICE = {
    externalId: "bs-outage",
    title: "Storage unit renewal",
    content:
      "Your storage unit at Kestrel Yard renews on 9 October 2031. Cancel in writing before that date to avoid the next term.",
  };
  const NOTICE_QUOTE = "renews on 9 October 2031";

  /** Bootstrap runs, whatever their state. */
  const bootstrapRuns = () => runRows(bench, "bootstrap");

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        ...LANES_OFF,
        derivationBarrier: "0s",
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 1,
          maxRunsPerDay: 1,
          maxRuns: 50,
          batchSize: 10,
        },
      },
      behaviors: {
        behaviors: [
          {
            flavour: "bootstrap",
            plan: (ctx) => ({
              calls: [
                call("temporal_annotation_add", {
                  when: "2031-10-09",
                  sentence: "BS-OUTAGE Kestrel Yard storage unit renews.",
                  kind: "event",
                  documentIds: [ctx.subject!],
                  evidence: { docId: ctx.subject!, quote: NOTICE_QUOTE },
                }),
              ],
              finalText: "Seeded the renewal date.",
            }),
          },
        ],
      },
    });
    await startBootstrap(bench);

    await bench.push({
      ...NOTICE,
      documentType: "email",
      sourceId: SRC,
      providerId: SRC,
      at: D0_NOON - 8 * DAY,
    });
    docId = await bench.docId(NOTICE.externalId);
    await awaitExtractedDates(bench, docId, NOTICE.externalId);

    // The outage opens BEFORE the lane's first pass, so the very first attempt
    // on this document is refused — the shape of waking to a dead account.
    bench.refuseModelWith(412, "Account has insufficient credit.");

    await bench.clock.set(PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    await waitFor(
      "a bootstrap run to be enqueued",
      () => (bootstrapRuns().length > 0 ? true : null),
      60_000,
    );
    // Nothing below means anything unless the refusal actually reached the
    // brain, so pin that first and separately: an outage the model never saw
    // would fail every later assertion for the wrong reason.
    await waitFor(
      "the first attempt to be refused by the backend",
      () => {
        const err =
          bench.sql
            .prepare<
              [],
              { last_error: string | null }
            >("SELECT last_error FROM cognition_runs WHERE kind = 'bootstrap'")
            .get()?.last_error ?? "";
        return err.includes("412") ? err : null;
      },
      120_000,
    );

    // Retries come due on a backoff, and a virtual clock does not advance on
    // its own — so the outage is walked forward one retry at a time rather
    // than waited out. Each step clears the backoff and no more, which keeps
    // the loop from overshooting the breaker's own cooldown the moment it
    // trips and closing it again before anything can observe it.
    for (let i = 0; i < 15 && breakerOpenUntil() === 0; i++) {
      await bench.clock.advance(61_000);
      await sleep(3_000);
    }
    await waitFor(
      "the drainer to stop claiming against the failing backend",
      () => (breakerOpenUntil() > 0 ? breakerOpenUntil() : null),
      30_000,
    );
  }, 600_000);

  /** The breaker's mirrored open-until, 0 when it has never tripped. */
  function breakerOpenUntil(): number {
    return Number(
      bench.sql
        .prepare<
          [string],
          { value: string }
        >("SELECT value FROM cognition_engine_state WHERE key = ?")
        .get("provider_breaker_open_until")?.value ?? "0",
    );
  }

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the run is not retired — an outage is not a verdict on the document", () => {
    const runs = bootstrapRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("pending");
  });

  test("the attempts are refunded, so the run stays inside its retry budget", () => {
    // Not merely "not terminal": claiming spends an attempt and the claim
    // query skips rows at the cap, so a run left pending at the cap would be
    // just as unreachable as one marked failed.
    const attempts = bench.sql
      .prepare<[string], { attempts: number }>("SELECT attempts FROM cognition_runs WHERE id = ?")
      .get(bootstrapRuns()[0]!.id)!.attempts;
    expect(attempts).toBeLessThanOrEqual(1);
  });

  test("the outage is visible rather than silent", async () => {
    // The whole failure mode is a brain that has stopped with nothing saying
    // so, which is what the panel exists to prevent.
    const status = await bench.obs.bootstrapStatus();
    expect(status.providerOutage).not.toBeNull();
    expect(status.providerOutage!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(status.providerOutage!.lastError).toContain("412");
  });

  test("the document keeps its place, and the work happens once credit returns", async () => {
    bench.refuseModelWith(null);
    // Past the breaker's cooldown: the next claim is the probe, and a probe
    // that succeeds closes it.
    await bench.clock.advance(20 * 60_000);
    await waitFor(
      "the deferred run to complete once the backend answers",
      () => (bootstrapRuns()[0]?.status === "completed" ? true : null),
      180_000,
    );

    // And it produced what the lane exists to produce — the document was
    // waiting, not skipped.
    const window = await bench.obs.temporalWindow({
      from: Date.parse("2031-10-01T00:00:00Z"),
      to: Date.parse("2031-10-31T23:59:59Z"),
    });
    expect(JSON.stringify(window.items)).toContain("BS-OUTAGE");
  }, 240_000);
});
