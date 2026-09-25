// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Briefs reconcile-quality E2E — the permanent regression net for the
 * make-or-break algorithm.
 *
 * A real spawned gateway runs the whole engine end-to-end on the
 * `loops-test-life` universe: the scripted fake OpenAI server
 * (`fake-loop-model.ts`) is assigned as the `background-agent` model, so
 * every queued run executes the REAL pipeline — waker → queue → run
 * driver → HttpAgentBackend → tool layer → write gate — with zero model
 * tokens. The planted arcs (`briefs-arcs.ts`, frozen seed) are delivered
 * over time via the harness push path (the sidecar-driver pattern —
 * universes have no timeline mechanism).
 *
 * Covered here:
 *  - inert-when-off, the (experimental unset, model assigned) prong,
 *    end-to-end on a spawned gateway (the other prong — experimental on,
 *    no model — is covered by cli.e2e.test.ts + the feature-gate units);
 *  - backfill immunity: seeding the whole universe enqueues zero data runs;
 *  - a scripted run creates a REAL open-loop row + its mirror document
 *    (the spec's mandated scripted-backend assert);
 *  - reconcile: a later resolving datum closes the tracked loop instead
 *    of minting a duplicate; ambiguous resolutions attach a confirm brief;
 *  - near-duplicate bait stays its own loop;
 *  - the diff engine: two rapid edits fold into ONE updated run whose
 *    prompt carries a diff spanning both edits; settled payloads are
 *    cleared (no prior version outlives the queue row);
 *  - the N>=2 concurrent-arrival case: same commitment twice at
 *    workerConcurrency 2 mints exactly one loop (queue serialization +
 *    the open_loop_search fresh-reads overlay);
 *  - waker heuristics: bulk mail / stale data / web ephemera never wake;
 *    conversations debounce into one run;
 *  - cost accounting: scripted usage lands in the per-day spend totals.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  arcById,
  generateArcSet,
  generateDatedReminderArcs,
  generateThreadReconcileArc,
  FROZEN_ARC_SEED,
} from "./briefs-arcs.js";
import {
  docIdByExternal,
  enqueueCrashedDataRun,
  loopsWithMarker,
  openHarnessDb,
  pushArcDoc,
  runsForDoc,
  seedLoopAndEnqueueDailyRun,
  sleep,
  waitFor,
} from "./briefs-scorecard.js";
import { startScriptedLoopModelServer, type ScriptedLoopModelServer } from "./fake-loop-model.js";
import type Database from "better-sqlite3";

// Compress the engine cadences (read by the spawned gateway from its env,
// which inherits ours). Durations like debounce come from the `briefs`
// config block instead — see `extraGatewayConfig` below.
process.env.OMNESIS_COGNITION_WAKER_INTERVAL_MS = "100";
process.env.OMNESIS_COGNITION_WAKER_IDLE_MS = "200";
process.env.OMNESIS_COGNITION_WAKER_START_DELAY_MS = "300";
process.env.OMNESIS_COGNITION_DRAIN_INTERVAL_MS = "150";
process.env.OMNESIS_COGNITION_DRAIN_IDLE_MS = "300";
process.env.OMNESIS_COGNITION_DRAIN_START_DELAY_MS = "500";

const ARCS = generateArcSet(FROZEN_ARC_SEED);
// Point-in-time surfacing arcs — computed at module load so the scheduled
// day is genuinely in the future (the dated brief is hidden until then).
const DATED = generateDatedReminderArcs(Date.now());
// The same-thread reconcile arc (identity-based reconcile candidates).
const THREAD = generateThreadReconcileArc();

interface FeedResponse {
  briefs: Array<{
    id: string;
    kind: string;
    title: string;
    state: string;
    citations: Array<{ docId: string; title: string }>;
  }>;
}

describe("Briefs inert-when-off (experimental unset, model assigned)", () => {
  let harness: SyntheticE2EHarness;
  let server: ScriptedLoopModelServer;

  beforeAll(async () => {
    server = await startScriptedLoopModelServer({ behaviors: ARCS.behaviors });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "loops-test-life",
      extraInference: {
        backends: { scripted: { type: "http", url: server.url } },
        assignments: { "background-agent": `scripted/${server.modelId}` },
      },
    });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await server?.close();
  }, 30_000);

  test("routes 404, /status says inactive, and an eligible datum enqueues nothing", async () => {
    const status = (await harness.gatewayJson("/status")) as {
      briefs: { active: boolean; modelAssigned: boolean };
    };
    expect(status.briefs.modelAssigned).toBe(true);
    expect(status.briefs.active).toBe(false);

    for (const path of ["/briefs/feed", "/admin/brain/loops", "/admin/brain/runs"]) {
      const res = await fetch(`${harness.gatewayUrl}${path}`, {
        headers: { Authorization: `Bearer ${harness.apiKey}` },
      });
      expect(res.status, path).toBe(404);
    }

    // An eligible fresh datum must not reach the queue: the waker is not
    // even subscribed when the gate is off.
    const invoice = arcById(ARCS, "invoice").steps[0]!.doc;
    await pushArcDoc(harness, invoice);
    await sleep(2_500);
    const db = openHarnessDb(harness);
    try {
      const rows = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get();
      expect(rows?.n).toBe(0);
      expect(server.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("Briefs reconcile quality on loops-test-life (scripted backend)", () => {
  let harness: SyntheticE2EHarness;
  let server: ScriptedLoopModelServer;
  let db: Database.Database;

  beforeAll(async () => {
    // Merge the dated-reminder arc behaviors (keyed by unique titles) so the
    // scripted model can drive the point-in-time surfacing scenario too.
    server = await startScriptedLoopModelServer({
      behaviors: new Map([...ARCS.behaviors, ...DATED.behaviors, ...THREAD.behaviors]),
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "loops-test-life",
      embedderBackend: "fake",
      extraInference: {
        backends: { scripted: { type: "http", url: server.url } },
        assignments: { "background-agent": `scripted/${server.modelId}` },
      },
      extraGatewayConfig: {
        brain: {
          // Criterion 4's N>=2 case: claim two runs per tick; non-daily
          // runs must serialize regardless.
          workerConcurrency: 2,
          conversationDebounce: "2s",
          documentUpdateDebounce: "2s",
        },
      },
    });
    await harness.start();
    for (const id of harness.getSourceIds()) {
      await harness.triggerSyncAndWait(id, 60_000);
    }
    await harness.refreshSearchSnapshot();
    db = openHarnessDb(harness);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
    await server?.close();
  }, 30_000);

  test("backfill immunity: the seeded universe enqueues zero data runs", async () => {
    const status = (await harness.gatewayJson("/status")) as { briefs: { active: boolean } };
    expect(status.briefs.active).toBe(true);
    // Not vacuous: the ambient corpus really landed (every fixture dated
    // past the recency window, so each upsert was a backfill datum the
    // waker had to consciously skip).
    const docs = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get();
    expect(docs?.n ?? 0).toBeGreaterThanOrEqual(10);
    // Waker start delay is 300ms; give it a couple of drain ticks.
    await sleep(1_500);
    const row = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'data'")
      .get();
    expect(row?.n).toBe(0);
  }, 60_000);

  test("a scripted run creates a real open loop, its mirror document, and an awareness brief", async () => {
    const arc = arcById(ARCS, "invoice");
    const marker = arc.marker!;
    await pushArcDoc(harness, arc.steps[0]!.doc);

    const loop = await waitFor(`open loop for ${marker}`, () => {
      const hits = loopsWithMarker(db, marker);
      return hits.length > 0 ? hits[0]! : null;
    });
    expect(loop.state).toBe("open");

    // Stamped with the run that created it — the exact completed data run.
    const docId = docIdByExternal(db, arc.steps[0]!.doc.externalId)!;
    const run = await waitFor(`completed run for ${docId}`, () => {
      const rows = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return rows.length > 0 ? rows[0]! : null;
    });
    expect(loop.created_by_run).toBe(run.id);

    // The searchable mirror document exists (external_id = loop id).
    expect(docIdByExternal(db, loop.id)).not.toBeNull();

    // The awareness brief is live on the feed, citing the source email.
    const feed = (await harness.gatewayJson("/briefs/feed")) as FeedResponse;
    const entry = feed.briefs.find((b) => b.title.includes(marker));
    expect(entry, `brief for ${marker} on the feed`).toBeDefined();
    expect(entry!.kind).toBe("loop");
    expect(entry!.citations.map((c) => c.docId)).toContain(docId);
  }, 90_000);

  test("a resolving datum closes the tracked loop instead of minting a duplicate (silent close + brief cleanup)", async () => {
    const arc = arcById(ARCS, "invoice");
    const marker = arc.marker!;
    await pushArcDoc(harness, arc.steps[1]!.doc);

    // Gate on the resolution RUN settling, not on the loop state: the
    // state flips to done one tool round before the brief cleanup and
    // ledger note land, and asserting mid-run is a race.
    const resolutionDocId = await waitFor(`document row for ${arc.steps[1]!.doc.externalId}`, () =>
      docIdByExternal(db, arc.steps[1]!.doc.externalId),
    );
    await waitFor(`completed resolution run for ${marker}`, () => {
      const done = runsForDoc(db, resolutionDocId).filter((r) => r.status === "completed");
      return done.length >= 1 ? true : null;
    });
    expect(loopsWithMarker(db, marker).some((l) => l.state === "done")).toBe(true);

    // Reconcile, not duplicate: exactly one loop carries the marker.
    const hits = loopsWithMarker(db, marker);
    expect(hits).toHaveLength(1);

    // Silent close removed the awareness brief from the feed.
    const feed = (await harness.gatewayJson("/briefs/feed")) as FeedResponse;
    expect(feed.briefs.find((b) => b.title.includes(marker))).toBeUndefined();

    // The resolution run stamped the ledger; the loop was created by a
    // DIFFERENT run (run-id stamping across the arc).
    const detail = (await harness.gatewayJson(`/admin/brain/loops/${hits[0]!.id}`)) as {
      loop: { createdByRun: string };
      ledger: Array<{ runId: string; note: string }>;
    };
    expect(detail.ledger.length).toBeGreaterThanOrEqual(1);
    const ledgerRunIds = new Set(detail.ledger.map((e) => e.runId));
    expect(ledgerRunIds.has(detail.loop.createdByRun)).toBe(false);
  }, 90_000);

  test("a near-duplicate commitment becomes its own loop and stays open", async () => {
    const twin = arcById(ARCS, "invoice-twin");
    const marker = twin.marker!;
    await pushArcDoc(harness, twin.steps[0]!.doc);

    await waitFor(`open loop for ${marker}`, () => {
      const hits = loopsWithMarker(db, marker);
      return hits.length > 0 ? hits[0]! : null;
    });
    expect(loopsWithMarker(db, marker)).toHaveLength(1);

    // The resolved first-invoice loop was not resurrected or touched.
    const first = loopsWithMarker(db, arcById(ARCS, "invoice").marker!);
    expect(first).toHaveLength(1);
    expect(first[0]!.state).toBe("done");
  }, 90_000);

  test("criterion 5: a worker killed after its first create re-claims to exactly one loop and one brief", async () => {
    const twin = arcById(ARCS, "invoice-twin");
    const marker = twin.marker!;
    let docId = docIdByExternal(db, twin.steps[0]!.doc.externalId);
    if (!docId) {
      await pushArcDoc(harness, twin.steps[0]!.doc);
      docId = await waitFor(`doc row ${twin.steps[0]!.doc.externalId}`, () =>
        docIdByExternal(db, twin.steps[0]!.doc.externalId),
      );
    }
    await waitFor(`open loop for ${marker}`, () => {
      const hits = loopsWithMarker(db, marker);
      return hits.length === 1 ? true : null;
    });
    await waitFor(`settled initial data run for ${marker}`, () => {
      const rows = runsForDoc(db, docId);
      return rows.some((r) => r.status === "completed") && rows.every((r) => r.status !== "pending")
        ? true
        : null;
    });
    expect(loopsWithMarker(db, marker)).toHaveLength(1);
    const createsFor = () =>
      server.calls.filter(
        (c) =>
          c.emitted.kind === "tool" && c.emitted.name === "open_loop_create" && c.docId === docId,
      ).length;
    const createsBefore = createsFor();
    const completedBefore = runsForDoc(db, docId).filter((r) => r.status === "completed").length;

    // The crash: the create attempt's loop + brief landed durably but the run
    // never settled, so a re-claimable pending run for the same datum reappears.
    enqueueCrashedDataRun(harness, {
      runId: `run_crash_c5_${Date.now()}`,
      docId,
      datumAt: Date.now(),
      now: Date.now(),
    });

    // The drainer re-claims and re-runs it; reconcile-before-create finds the
    // loop the crashed attempt created and adopts it instead of duplicating.
    await waitFor("the re-attempt over the crashed run completes", () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed").length;
      return done > completedBefore ? true : null;
    });

    // EXACTLY one loop and one brief — the re-attempt duplicated neither, and
    // emitted no second open_loop_create.
    expect(loopsWithMarker(db, marker)).toHaveLength(1);
    expect(createsFor()).toBe(createsBefore);
    const feed = (await harness.gatewayJson("/briefs/feed")) as FeedResponse;
    expect(feed.briefs.filter((b) => b.title.includes(marker))).toHaveLength(1);
  }, 90_000);

  test("an ambiguous fulfilment attaches a confirmation brief and leaves the loop open", async () => {
    const arc = arcById(ARCS, "request");
    const marker = arc.marker!;
    await pushArcDoc(harness, arc.steps[0]!.doc);
    const loop = await waitFor(`open loop for ${marker}`, () => {
      const hits = loopsWithMarker(db, marker);
      return hits.length > 0 ? hits[0]! : null;
    });
    const requestDocId = await waitFor(`document row for ${arc.steps[0]!.doc.externalId}`, () =>
      docIdByExternal(db, arc.steps[0]!.doc.externalId),
    );
    await waitFor(`completed request run for ${marker}`, () => {
      const done = runsForDoc(db, requestDocId).filter((run) => run.status === "completed");
      return done.length >= 1 ? true : null;
    });

    await pushArcDoc(harness, arc.steps[1]!.doc);
    const fulfilmentDocId = await waitFor(`document row for ${arc.steps[1]!.doc.externalId}`, () =>
      docIdByExternal(db, arc.steps[1]!.doc.externalId),
    );
    await waitFor(`completed ambiguous-fulfilment run for ${marker}`, () => {
      const done = runsForDoc(db, fulfilmentDocId).filter((run) => run.status === "completed");
      return done.length >= 1 ? true : null;
    });

    const detail = (await harness.gatewayJson(`/admin/brain/loops/${loop.id}`)) as {
      briefs: Array<{ state: string; title: string }>;
    };
    const active = detail.briefs.filter(
      (brief) => brief.state === "unread" || brief.state === "read",
    );
    expect(active).toHaveLength(1);
    const fulfilmentAction = arc.steps[1]!.doc.behavior.onCreated;
    if (fulfilmentAction.kind !== "resolve") {
      throw new Error("request arc fulfilment step must be a resolution");
    }
    expect(active[0]!.title).toBe(fulfilmentAction.confirmBriefTitle);

    // Still exactly one loop, still open — ambiguity never closes silently.
    const hits = loopsWithMarker(db, marker);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.state).toBe("open");
  }, 90_000);

  test("a dated to-do surfaces on its scheduled day: brief held until nextShow + a re-verify run tied to the loop", async () => {
    const arc = DATED.dated;
    const marker = arc.marker!;
    const taskDoc = arc.steps[0]!.doc;
    await pushArcDoc(harness, taskDoc);

    // The agent tracks the dated item as an open loop...
    const loop = await waitFor(`open loop for ${marker}`, () => {
      const hits = loopsWithMarker(db, marker);
      return hits.length > 0 ? hits[0]! : null;
    });
    expect(loop.state).toBe("open");

    // ...and the data run that built it has fully settled (loop + brief +
    // scheduled run all landed).
    const taskDocId = docIdByExternal(db, taskDoc.externalId)!;
    await waitFor(`completed run for ${taskDoc.externalId}`, () => {
      const done = runsForDoc(db, taskDocId).filter((r) => r.status === "completed");
      return done.length > 0 ? true : null;
    });

    // The brief is attached to the loop and HELD until the scheduled-day
    // morning (nextShow), with eventAt on the day.
    const brief = db
      .prepare<
        [string],
        { id: string; next_show: number | null; event_at: number | null; title: string }
      >(
        `SELECT b.id, b.next_show, b.event_at, b.title
           FROM briefs b JOIN brief_related_loops brl ON brl.brief_id = b.id
          WHERE brl.loop_id = ?`,
      )
      .get(loop.id);
    expect(brief, "dated brief attached to the loop").toBeDefined();
    expect(brief!.next_show).toBe(Date.parse(DATED.nextShowIso));
    expect(brief!.event_at).toBe(Date.parse(DATED.eventAtIso));

    // Hidden until its day: not on today's feed.
    const feed = (await harness.gatewayJson("/briefs/feed")) as FeedResponse;
    expect(feed.briefs.find((b) => b.title.includes(marker))).toBeUndefined();

    // A re-verify run is scheduled for that day, tied to the loop via loopId
    // (never claimed today — its next_attempt_at is in the future), so
    // resolving the loop early can cascade-retract it.
    const scheduledRun = () =>
      db
        .prepare<
          [string],
          { id: string; status: string; attempts: number; next_attempt_at: number }
        >(
          `SELECT id, status, attempts, next_attempt_at FROM cognition_runs
            WHERE kind = 'time_based' AND json_extract(payload_json, '$.loopId') = ?`,
        )
        .get(loop.id);
    const run = scheduledRun();
    expect(run, "scheduled re-verify run tied to the loop").toBeDefined();
    expect(run!.status).toBe("pending");
    expect(run!.attempts).toBe(0);
    expect(run!.next_attempt_at).toBeGreaterThan(Date.now());

    // Completing the task early resolves the loop; its cascade retracts the
    // never-fired scheduled run and cleans up the held brief.
    await pushArcDoc(harness, arc.steps[1]!.doc);
    const doneDocId = await waitFor(`document row for ${arc.steps[1]!.doc.externalId}`, () =>
      docIdByExternal(db, arc.steps[1]!.doc.externalId),
    );
    await waitFor(`completed resolution run for ${marker}`, () => {
      const done = runsForDoc(db, doneDocId).filter((r) => r.status === "completed");
      return done.length > 0 ? true : null;
    });
    expect(loopsWithMarker(db, marker).some((l) => l.state === "done")).toBe(true);
    expect(scheduledRun(), "scheduled run cascade-retracted on resolve").toBeUndefined();
  }, 90_000);

  test("an undated to-do is read but never auto-briefed (dated-only scope)", async () => {
    const arc = DATED.undated;
    const marker = arc.marker!;
    const doc = arc.steps[0]!.doc;
    await pushArcDoc(harness, doc);
    const docId = await waitFor(`document row for ${doc.externalId}`, () =>
      docIdByExternal(db, doc.externalId),
    );
    await waitFor(`completed run for ${doc.externalId}`, () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return done.length > 0 ? true : null;
    });

    // No natural moment to resurface → no loop, no brief, nothing on the feed.
    expect(loopsWithMarker(db, marker)).toHaveLength(0);
    const feed = (await harness.gatewayJson("/briefs/feed")) as FeedResponse;
    expect(feed.briefs.find((b) => b.title.includes(marker))).toBeUndefined();

    // The transcript confirms the agent fetched it, then declined to brief.
    const calls = server.calls.filter((c) => c.docId === docId);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      if (call.emitted.kind === "tool") expect(call.emitted.name).toBe("fetch_many");
    }
  }, 90_000);

  test("rapid edits to an updatable document fold into one run whose diff spans both edits; no prior version outlives the settle", async () => {
    const arc = arcById(ARCS, "doc-edit");
    const doc = arc.steps[0]!.doc;
    const [rev1, rev2] = ARCS.docEditRevisions;

    await pushArcDoc(harness, doc);
    const docId = await waitFor(`document row for ${doc.externalId}`, () =>
      docIdByExternal(db, doc.externalId),
    );
    await waitFor(`created run for ${doc.externalId}`, () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return done.length >= 1 ? true : null;
    });

    // Two edits inside the 2s update debounce → ONE folded updated run.
    await pushArcDoc(harness, doc, { content: rev1 });
    await pushArcDoc(harness, doc, { content: rev2 });
    await waitFor(
      () =>
        `folded update run for ${doc.externalId} — rows at timeout: ${JSON.stringify(
          db
            .prepare<
              [string],
              Record<string, unknown>
            >("SELECT id, kind, status, attempts, last_error, next_attempt_at FROM cognition_runs WHERE dedupe_key = ?")
            .all(`data:doc:${docId}`),
        )}; model calls for doc: ${JSON.stringify(
          server.calls.filter((c) => c.docId === docId).map((c) => c.emitted),
        )}`,
      () => {
        const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
        return done.length >= 2 ? true : null;
      },
    );
    const runs = runsForDoc(db, docId);
    expect(runs).toHaveLength(2);

    // The updated run's prompt carried a diff spanning BOTH edits.
    const updatedCall = server.calls.find(
      (c) => c.docId === docId && c.event === "updated" && c.prompt.includes("<diff>"),
    );
    expect(updatedCall, "model saw an updated-run prompt with a diff").toBeDefined();
    expect(updatedCall!.prompt).toContain("rev-alpha");
    expect(updatedCall!.prompt).toContain("rev-beta");

    // No prior version outlives the queue row: settling strips the fold
    // snapshot + diff text; the reference-shaped rest is retained.
    for (const run of runs) {
      expect(run.status).toBe("completed");
      expect(run.payload_json).not.toContain("snapshot");
      expect(run.payload_json).not.toContain("diff");
      expect(run.payload_json).not.toContain("rev-alpha");
      expect(run.payload_json).not.toContain("rev-beta");
      expect(JSON.parse(run.payload_json as string)).toMatchObject({ docId });
    }
  }, 90_000);

  test("concurrent same-commitment arrival at N>=2 mints exactly one loop (criterion 4)", async () => {
    const arc = arcById(ARCS, "concurrent");
    const marker = arc.marker!;
    const [a, b] = [arc.steps[0]!.doc, arc.steps[1]!.doc];
    await harness.pushDocuments([
      {
        externalId: a.externalId,
        documentType: a.documentType,
        title: a.title,
        content: a.content,
      },
      {
        externalId: b.externalId,
        documentType: b.documentType,
        title: b.title,
        content: b.content,
      },
    ]);

    // Both runs complete...
    for (const doc of [a, b]) {
      const docId = await waitFor(`document row for ${doc.externalId}`, () =>
        docIdByExternal(db, doc.externalId),
      );
      await waitFor(`completed run for ${doc.externalId}`, () => {
        const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
        return done.length >= 1 ? true : null;
      });
    }

    // ...but exactly ONE loop exists: the second run's reconcile saw the
    // first run's loop (queue serialization + fresh-reads overlay) and
    // adopted it with a ledger note instead of creating.
    expect(loopsWithMarker(db, marker)).toHaveLength(1);
    const creates = server.calls.filter(
      (c) =>
        c.emitted.kind === "tool" &&
        c.emitted.name === "open_loop_create" &&
        String((c.emitted.args as { title?: unknown }).title ?? "").includes(marker),
    );
    expect(creates).toHaveLength(1);
    const adopts = server.calls.filter(
      (c) =>
        c.emitted.kind === "tool" &&
        c.emitted.name === "open_loop_ledger_append" &&
        String((c.emitted.args as { note?: unknown }).note ?? "").includes("adopted"),
    );
    expect(adopts.length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  test("waker heuristics: bulk mail, stale data, and web ephemera never wake the agent", async () => {
    const bulk = arcById(ARCS, "distractor-bulk").steps[0]!.doc;
    const stale = arcById(ARCS, "distractor-stale").steps[0]!.doc;
    await pushArcDoc(harness, bulk);
    await pushArcDoc(harness, stale);
    await harness.pushDocument({
      externalId: "arc-distractor-webpage",
      documentType: "webpage",
      title: "Some article",
      content: "web ephemera the waker must skip",
    });

    await sleep(2_500);
    for (const externalId of [bulk.externalId, stale.externalId, "arc-distractor-webpage"]) {
      const docId = docIdByExternal(db, externalId);
      expect(docId, externalId).not.toBeNull();
      expect(runsForDoc(db, docId!), externalId).toHaveLength(0);
    }
  }, 60_000);

  test("an eligible but unimportant datum completes a run with zero mutations", async () => {
    const boring = arcById(ARCS, "distractor-boring").steps[0]!.doc;
    const loopsBefore = (
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM open_loops").get() ?? { n: 0 }
    ).n;
    const briefsBefore = (
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get() ?? { n: 0 }
    ).n;

    await pushArcDoc(harness, boring);
    const docId = await waitFor(`document row for ${boring.externalId}`, () =>
      docIdByExternal(db, boring.externalId),
    );
    await waitFor(`completed run for ${boring.externalId}`, () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return done.length >= 1 ? true : null;
    });

    const after = {
      loops: (
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM open_loops").get() ?? { n: 0 }
      ).n,
      briefs: (db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get() ?? { n: 0 })
        .n,
    };
    expect(after.loops).toBe(loopsBefore);
    expect(after.briefs).toBe(briefsBefore);

    // The scripted transcript confirms: fetch, then done — no mutations.
    const calls = server.calls.filter((c) => c.docId === docId);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      if (call.emitted.kind === "tool") {
        expect(call.emitted.name).toBe("fetch_many");
      }
    }
  }, 90_000);

  test("conversation updates debounce into a single run", async () => {
    await harness.pushDocument({
      externalId: "arc-conversation",
      documentType: "conversation",
      title: "Group chat: camping",
      content: "first message",
    });
    await sleep(150);
    await harness.pushDocument({
      externalId: "arc-conversation",
      documentType: "conversation",
      title: "Group chat: camping",
      content: "first message\nsecond message",
    });

    const docId = await waitFor("conversation document row", () =>
      docIdByExternal(db, "arc-conversation"),
    );
    await waitFor("debounced conversation run", () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return done.length >= 1 ? true : null;
    });
    expect(runsForDoc(db, docId)).toHaveLength(1);
  }, 90_000);

  test("a bare same-thread confirmation reconciles onto its loop via identity (no duplicate)", async () => {
    // Graph-based reconcile candidates: the confirmation's wording shares no
    // marker or token with the loop the request opened, so lexical + semantic
    // reconcile both miss it — only the shared-thread identity signal links it
    // back. Both messages are pushed as backfill (the waker skips stale data),
    // so we drive the two data runs manually, in order, AFTER the resolved
    // part-of-thread edge exists — exercising identity reconcile race-free.
    const [requestDoc, confirmDoc] = [THREAD.arc.steps[0]!.doc, THREAD.arc.steps[1]!.doc];
    // Backdate both so the waker's recency gate skips them (no auto runs).
    const stale = { sourceAgeDays: 30 };
    await pushArcDoc(harness, { ...requestDoc, ...stale });
    await pushArcDoc(harness, { ...confirmDoc, ...stale });

    const reqDocId = await waitFor(`request doc row ${requestDoc.externalId}`, () =>
      docIdByExternal(db, requestDoc.externalId),
    );
    const confDocId = await waitFor(`confirmation doc row ${confirmDoc.externalId}`, () =>
      docIdByExternal(db, confirmDoc.externalId),
    );

    // Link extraction resolves the two messages into a part-of-thread edge.
    await waitFor("resolved part-of-thread edge between the two thread messages", () => {
      const row = db
        .prepare<[string, string, string, string], { c: number }>(
          `SELECT COUNT(*) AS c FROM document_links WHERE link_type = 'part-of-thread'
             AND ((source_doc_id = ? AND target_doc_id = ?)
                OR (source_doc_id = ? AND target_doc_id = ?))`,
        )
        .get(reqDocId, confDocId, confDocId, reqDocId);
      return (row?.c ?? 0) > 0 ? true : null;
    });

    // Backfill data never woke the agent — the two runs below are ours alone.
    expect(runsForDoc(db, reqDocId)).toHaveLength(0);
    expect(runsForDoc(db, confDocId)).toHaveLength(0);

    // Run 1: the booking request opens the tracked loop.
    enqueueCrashedDataRun(harness, {
      runId: `run_thread_req_${Date.now()}`,
      docId: reqDocId,
      datumAt: Date.now(),
      now: Date.now(),
    });
    const loop = await waitFor(`open loop for ${THREAD.marker}`, () => {
      const hits = loopsWithMarker(db, THREAD.marker);
      return hits.length > 0 ? hits[0]! : null;
    });
    await waitFor("request run completed", () =>
      runsForDoc(db, reqDocId).some((r) => r.status === "completed") ? true : null,
    );
    expect(loopsWithMarker(db, THREAD.marker)).toHaveLength(1);
    const creatingRun = loop.created_by_run;

    // Run 2: the bare same-thread confirmation. Its query is drawn from the
    // reply's own words and misses the loop lexically/semantically — identity
    // is the only path that can reconcile.
    enqueueCrashedDataRun(harness, {
      runId: `run_thread_conf_${Date.now()}`,
      docId: confDocId,
      datumAt: Date.now(),
      now: Date.now(),
    });
    await waitFor("confirmation run completed", () =>
      runsForDoc(db, confDocId).some((r) => r.status === "completed") ? true : null,
    );

    // Reconciled, not duplicated: still exactly one loop, now closed, and the
    // confirmation run did NOT create it — it adopted the existing loop.
    const hits = loopsWithMarker(db, THREAD.marker);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.state).toBe("done");
    expect(hits[0]!.created_by_run).toBe(creatingRun);

    // The confirmation run minted nothing and closed the existing loop — its
    // transcript shows an open_loop_update, never an open_loop_create.
    const confCalls = server.calls.filter((c) => c.docId === confDocId);
    const created = confCalls.filter(
      (c) => c.emitted.kind === "tool" && c.emitted.name === "open_loop_create",
    );
    expect(created).toHaveLength(0);
    const updated = confCalls.some(
      (c) => c.emitted.kind === "tool" && c.emitted.name === "open_loop_update",
    );
    expect(updated).toBe(true);
  }, 120_000);

  test("cost accounting: scripted usage lands in the per-day spend totals", async () => {
    const spend = (await harness.gatewayJson("/admin/brain/spend")) as {
      items: Array<{ day: string; runs: number; promptTokens: number; completionTokens: number }>;
    };
    expect(spend.items.length).toBeGreaterThanOrEqual(1);
    const today = spend.items[0]!;
    expect(today.runs).toBeGreaterThan(0);
    expect(today.promptTokens).toBeGreaterThan(0);
    expect(today.completionTokens).toBeGreaterThan(0);
  }, 60_000);

  test("cost accounting: real runs attribute to their cognitive workflow, not their queue kind", async () => {
    // The end-to-end proof of the workflow split: runs driven through the real
    // queue must land in per-workflow buckets. `daily` in particular carries
    // three different procedures, and blending them is what makes a
    // per-workload model decision unanswerable.
    const spend = (await harness.gatewayJson("/admin/cognition/spend")) as {
      rows: Array<{ mechanism: string; mechanismLabel: string; runs: number }>;
    };
    const mechanisms = new Set(spend.rows.map((r) => r.mechanism));
    expect(mechanisms.size).toBeGreaterThan(0);

    // No row may carry a bare queue kind — that is the pre-split attribution.
    const queueKinds = ["data", "daily", "time_based", "feedback", "synthesis", "sweep"];
    expect([...mechanisms].filter((m) => queueKinds.includes(m))).toEqual([]);

    // Nor may a run land in the could-not-decode bucket: every payload this
    // suite enqueues is one the vocabulary is supposed to recognise.
    expect(mechanisms).not.toContain("unrecognized");

    // Datum intake is the suite's dominant lane and must be named as itself.
    expect(mechanisms).toContain("datum-intake");

    // A `daily` row resolved to a specific procedure rather than the kind —
    // the split's whole point, and `daily` is the kind that multiplexes.
    // Seeded here rather than relying on another test having driven one, so
    // the assertion does not depend on file order.
    const probeDoc = db
      .prepare<
        [],
        { id: string; source_id: string }
      >("SELECT id, source_id FROM documents WHERE source_id NOT LIKE '%open-loop%' ORDER BY id LIMIT 1")
      .get();
    expect(probeDoc, "the synced universe produced at least one source document").toBeDefined();
    const dailyRunId = "run_daily_spend_probe";
    seedLoopAndEnqueueDailyRun(harness, {
      runId: dailyRunId,
      loopId: "loop_daily_spend_probe",
      loopTitle: "Probe loop: reconcile the spend attribution",
      docId: probeDoc!.id,
      sourceId: probeDoc!.source_id,
      now: Date.now(),
    });
    // Waited for on the row itself rather than on the model call that precedes
    // it. The call is recorded when the backend answers; the row is written by
    // the accounting that follows, and nothing bounds the gap between them —
    // so a read taken the moment the call lands is a race the busiest machine
    // loses.
    type SpendRow = { mechanism: string; mechanismLabel: string; runs: number };
    const after = await waitFor(
      () => `daily run ${dailyRunId} to be accounted for`,
      async () => {
        const spend = (await harness.gatewayJson("/admin/cognition/spend")) as {
          rows: SpendRow[];
        };
        return spend.rows.some((r) => r.mechanism === "daily-source-review") ? spend : null;
      },
      30_000,
    );
    expect(after.rows.map((r) => r.mechanism)).toContain("daily-source-review");
    for (const row of after.rows) expect(row.mechanismLabel).toBeTruthy();
  }, 90_000);

  test("a daily run's prompt delta-primes the batched source's own loops", async () => {
    // A real universe document + its source (never the open-loop mirror source).
    const doc = db
      .prepare<
        [],
        { id: string; source_id: string }
      >("SELECT id, source_id FROM documents WHERE source_id NOT LIKE '%open-loop%' ORDER BY id LIMIT 1")
      .get();
    expect(doc, "the synced universe produced at least one source document").toBeDefined();

    const runId = "run_daily_prime_probe";
    const loopTitle = "Probe loop: reconcile the quarterly figures";
    seedLoopAndEnqueueDailyRun(harness, {
      runId,
      loopId: "loop_daily_prime_probe",
      loopTitle,
      docId: doc!.id,
      sourceId: doc!.source_id,
      now: Date.now(),
    });

    // The drainer claims and drives the daily run; the scripted model records
    // its prompt (it has no scripted behaviour for `daily`, but the prompt —
    // built with the delta-prime block — is still captured).
    const call = await waitFor(
      () => `daily run ${runId} to be driven (calls: ${server.calls.map((c) => c.runId)})`,
      () => server.calls.find((c) => c.runId === runId) ?? null,
      30_000,
    );
    expect(call.kind).toBe("daily");
    expect(call.prompt).toContain(`Daily batch review for source "${doc!.source_id}"`);
    // The delta-prime block is present and names THIS source's tracked loop —
    // the agent's own derived state, never inlined source data.
    expect(call.prompt).toContain(loopTitle);
  }, 60_000);
});
