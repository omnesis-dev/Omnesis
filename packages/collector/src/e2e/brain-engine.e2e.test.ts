// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area I: engine correctness.
 *
 * "Is the machine itself sound?" Every assertion here is about the queue,
 * the drainer and the run driver as mechanism: what authority a run
 * physically holds, what happens when the gate is off, when an attempt
 * crashes, when the model errors, when the backend disappears, when a
 * newer datum lands mid-flight, and in what order and with what
 * parallelism a backlog is consumed.
 *
 * None of it judges a decision the steward made. The puppet's plans exist
 * only to give the engine something concrete to execute.
 *
 * Some stimuli have no producer that a test can drive deterministically —
 * a morning digest fires on a calendar boundary, a re-grounding batch on a
 * sweep, a mixed backlog never occurs on demand. Those runs are seeded
 * directly into `cognition_runs` through a short-lived writable handle (the
 * pattern `enqueueCrashedDataRun` established), with the exact payload their
 * real producer writes, so the drainer claims and drives them for real.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  ref,
  sleep,
  waitFor,
  type PuppetBehavior,
  PuppetHttpRefusal,
} from "./brain-bench/index.js";

compressCognitionCadences();

// ── local helpers ──────────────────────────────────────────────────────────

/** One fresh, pending row of the run queue, as the batch seeder writes it. */
interface SeedRun {
  id: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string | null;
  nextAttemptAt?: number;
}

/**
 * Insert pending queue rows in ONE transaction, so the drainer (which ticks
 * every 150ms under the compressed cadences) can never observe half a
 * backlog — the claim-order, concurrency and budget-park assertions all rest
 * on the whole set becoming due at the same instant. `bench.seedRun` writes
 * one row per connection and so cannot promise that; it is used directly
 * wherever a single row is the whole stimulus.
 */
function seedBatch(bench: BrainBench, rows: readonly SeedRun[], now: number): void {
  if (!Number.isFinite(now)) throw new Error(`seedBatch: \`now\` is not unix ms (${String(now)})`);
  bench.withWriteHandle((db) => {
    const stmt = db.prepare<unknown[]>(
      `INSERT INTO cognition_runs
         (id, kind, payload_json, dedupe_key, status, attempts, next_attempt_at, enqueued_at, cycle_anchor_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const r of rows) {
        const due = r.nextAttemptAt ?? now;
        if (!Number.isFinite(due)) {
          throw new Error(`seedBatch: run ${r.id} has a non-numeric due time (${String(due)})`);
        }
        stmt.run(r.id, r.kind, JSON.stringify(r.payload ?? {}), r.dedupeKey ?? null, due, now, now);
      }
    })();
  });
}

/** Seed an `open` loop stamped with the run that (notionally) created it. */
function seedLoop(
  bench: BrainBench,
  opts: { id: string; createdByRun: string; title: string; now: number },
): void {
  bench.withWriteHandle((db) => {
    db.prepare<unknown[]>(
      `INSERT INTO open_loops
         (id, created_by_run, state, confidence, importance, title, description, created_at, last_update)
       VALUES (?, ?, 'open', 0.85, 0.7, ?, '', ?, ?)`,
    ).run(opts.id, opts.createdByRun, opts.title, opts.now, opts.now);
  });
}

/** The raw queue columns `bench.runRow` serves. */
type RunColumns = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  failure_code: string | null;
  next_attempt_at: number;
  last_attempt_at: number | null;
  payload_json: string;
};

interface RunProbe {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  failureCode: string | null;
  nextAttemptAt: number;
  lastAttemptAt: number | null;
  payloadJson: string;
}

/** `bench.runRow` projected into the camel-cased shape the assertions read. */
function runRow(bench: BrainBench, id: string): RunProbe | null {
  const r = bench.runRow(id) as RunColumns | undefined;
  return r
    ? {
        id: r.id,
        kind: r.kind,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        failureCode: r.failure_code,
        nextAttemptAt: r.next_attempt_at,
        lastAttemptAt: r.last_attempt_at,
        payloadJson: r.payload_json,
      }
    : null;
}

function runRows(bench: BrainBench, ids: readonly string[]): RunProbe[] {
  return ids.map((id) => {
    const row = runRow(bench, id);
    if (!row) throw new Error(`seeded run ${id} vanished from the queue`);
    return row;
  });
}

/** Every tool call a run made, as `tool → result kind/code`. */
async function toolOutcomes(
  bench: BrainBench,
  runId: string,
): Promise<Array<{ tool: string; kind: string; code: string | null }>> {
  const steps = await bench.obs.executedTools(runId);
  return steps.map((s) => ({
    tool: s.tool,
    kind: s.result?.kind ?? "?",
    code: s.result?.code ?? null,
  }));
}

/** Wait until every named run has left `pending`. */
async function waitSettled(
  bench: BrainBench,
  ids: readonly string[],
  timeoutMs = 120_000,
): Promise<void> {
  await waitFor(
    () => `runs ${ids.join(", ")} to settle: ${JSON.stringify(runRows(bench, ids))}`,
    () => (runRows(bench, ids).every((r) => r.status !== "pending") ? true : null),
    timeoutMs,
    200,
  );
}

/** Replace one queue row's payload — a fold, written the way the enqueuer writes one. */
function foldPayload(bench: BrainBench, runId: string, payload: unknown): void {
  bench.withWriteHandle((db) => {
    db.prepare<[string, string]>("UPDATE cognition_runs SET payload_json = ? WHERE id = ?").run(
      JSON.stringify(payload),
      runId,
    );
  });
}

async function readConfig(bench: BrainBench): Promise<Record<string, unknown>> {
  const res = await bench.harness.gatewayJson<{ config: Record<string, unknown> }>("/admin/config");
  return res.config;
}

function todayIso(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
//  I.1  authority · I.3 crash re-claim · I.6 in-flight fold · I.7 claim
//       priority · I.8 worker concurrency — one gateway, real clock
// ─────────────────────────────────────────────────────────────────────────────

const MARK_GRANTED = "NORTHSTAR-GRANTED";
const MARK_DIGEST = "NORTHSTAR-DIGEST";
const MARK_VERIFY = "NORTHSTAR-VERIFY";
const MARK_NOTES = "NORTHSTAR-NOTES";
const MARK_CRASH = "NORTHSTAR-CRASH";

const GRANT_QUOTE = "Please confirm the rehearsal slot before Friday";

const GRANT_DOC = email({
  externalId: "engine-authority-grant",
  title: "Rehearsal booking for the Northstar showcase",
  content: `Hi Alex,\n\nWe have pencilled in the rehearsal room for the showcase. ${GRANT_QUOTE} so we can release the hold.\n\nStudio Northstar`,
});

const CRASH_DOC = email({
  externalId: "engine-crash-reclaim",
  title: "Backline hire for the Northstar showcase",
  content:
    "Hi Alex,\n\nThe backline hire quote is attached. Approve the backline hire quote by Thursday or the reservation lapses.\n\nCedar Grove Supplies",
  ageDays: 40,
});

const FOLD_DOC = email({
  externalId: "engine-inflight-fold",
  title: "Load-in schedule for the Northstar showcase",
  content:
    "Hi Alex,\n\nLoad-in is currently pencilled for 14:00 on the Friday. We will confirm the crew list separately.\n\nStudio Northstar",
});

const IDLE_DOC = email({
  externalId: "engine-idle-subject",
  title: "Parking arrangements for the Northstar showcase",
  content:
    "Hi Alex,\n\nThe loading bay takes two vans. Nothing needs doing about this before the showcase.\n\nRiverside Estate",
  ageDays: 40,
});

const SLOW_DOC_A = email({
  externalId: "engine-slow-a",
  title: "Crew list draft A for the Northstar showcase",
  content: "Hi Alex,\n\nFirst draft of the crew list for the showcase.\n\nStudio Northstar",
  ageDays: 40,
});

const SLOW_DOC_B = email({
  externalId: "engine-slow-b",
  title: "Crew list draft B for the Northstar showcase",
  content: "Hi Alex,\n\nSecond draft of the crew list for the showcase.\n\nStudio Northstar",
  ageDays: 40,
});

/** A plan long enough to be caught mid-flight by a polling observer. */
function slowPlan(marker: string) {
  return {
    calls: Array.from({ length: 12 }, () => call("open_loop_search", { query: marker })),
    finalText: "Looked around and found nothing worth writing.",
  };
}

describe("brain engine — authority, re-claim, folding, ordering", () => {
  let bench: BrainBench;

  // Filled in by the tests, read by plans at model-turn time.
  let grantDocId = "";
  let grantAnnotationId = "";
  let foldRunId = "";
  let foldDocId = "";
  let foldApplied = false;

  const behaviors: PuppetBehavior[] = [
    // The positive control: a `data` run carries the DEFAULT authority, so
    // the very tools the narrowed workflows below cannot reach all land here.
    {
      flavour: "data.created",
      docTitle: GRANT_DOC.title,
      plan: (ctx) => ({
        calls: [
          call("open_loop_create", {
            title: `Confirm the rehearsal slot ${MARK_GRANTED}`,
            description: "Tracked from the booking request.",
            confidence: 0.9,
            importance: 0.7,
            docs: [ctx.subject],
          }),
          call("brief_create", {
            kind: "info",
            title: `Rehearsal hold expires ${MARK_GRANTED}`,
            description: "The studio releases the hold unless the slot is confirmed.",
            citations: [ctx.subject],
            confidence: 0.85,
            urgency: 0.6,
          }),
          call("annotate_durable", {
            docId: ctx.subject,
            claimType: "commitment",
            claimText: "The rehearsal slot must be confirmed before Friday.",
            evidenceDocId: ctx.subject,
            evidenceQuote: GRANT_QUOTE,
            confidence: 0.8,
            claimBasis: "quoted",
          }),
        ],
        finalText: "Tracked the rehearsal hold.",
      }),
    },
    // morning-digest: authority is `brief` only.
    {
      flavour: "daily.digest",
      plan: () => ({
        calls: [
          call("open_loop_create", {
            title: `Digest tried to mint a loop ${MARK_DIGEST}`,
            confidence: 0.8,
            importance: 0.5,
          }),
          call("brief_create", {
            kind: "info",
            title: `Morning read ${MARK_DIGEST}`,
            description: "One card composed by the digest pass.",
            confidence: 0.8,
            urgency: 0.4,
          }),
        ],
        finalText: "Digest composed.",
      }),
    },
    // memory-regrounding (`verification`): annotations only.
    {
      flavour: "verification",
      plan: () => ({
        calls: [
          call("brief_create", {
            kind: "info",
            title: `Verification tried to raise a card ${MARK_VERIFY}`,
            description: "A re-grounding pass must not interrupt the user.",
            confidence: 0.8,
            urgency: 0.4,
          }),
          call("annotation_revise", { id: grantAnnotationId, confidence: 0.45 }),
        ],
        finalText: "Re-grounded the batch.",
      }),
    },
    // notes-compaction: the notes blob only.
    {
      flavour: "notes_compaction",
      plan: () => ({
        calls: [
          call("open_loop_create", {
            title: `Notes compaction tried to mint a loop ${MARK_NOTES}`,
            confidence: 0.8,
            importance: 0.5,
          }),
          call("annotate_durable", {
            docId: grantDocId,
            claimType: "commitment",
            claimText: "Compaction tried to write a durable prior.",
            evidenceDocId: grantDocId,
            evidenceQuote: GRANT_QUOTE,
            confidence: 0.8,
            claimBasis: "quoted",
          }),
          call("notes_rewrite", { text: `Compacted operating notes ${MARK_NOTES}` }),
        ],
        finalText: "Notes compacted.",
      }),
    },
    // The re-claimed crash attempt: reconcile, then adopt.
    {
      flavour: "data.created",
      docTitle: CRASH_DOC.title,
      plan: () => ({
        calls: [
          call("open_loop_search", { query: `${MARK_CRASH} backline hire` }),
          call("open_loop_ledger_append", {
            id: ref("open_loop_search", "loops.0.id"),
            note: "Adopted the loop this run's earlier attempt already created.",
          }),
        ],
        finalText: "Adopted the partial work.",
      }),
    },
    // The in-flight fold: the plan folds a newer payload onto the row it is
    // itself executing — the gateway is blocked on this very response, so the
    // run is unambiguously in flight.
    {
      flavour: "data.created",
      docTitle: FOLD_DOC.title,
      plan: (ctx) => {
        if (!foldApplied) {
          foldApplied = true;
          foldRunId = ctx.runId;
          foldPayload(bench, ctx.runId, {
            docId: ctx.subject,
            event: "updated",
            datumAt: Date.now(),
            diff: "-Load-in is currently pencilled for 14:00\n+Load-in has moved to 11:00",
          });
        }
        return { calls: [], finalText: "Noted the load-in schedule." };
      },
    },
    {
      flavour: "data.updated",
      docTitle: FOLD_DOC.title,
      plan: () => ({ calls: [], finalText: "Noted the revised load-in schedule." }),
    },
    // The concurrency probes: deliberately many round-trips, so a poller can
    // catch two of them overlapping (or prove they never do).
    { flavour: "daily.source", plan: () => slowPlan("crew list") },
    { flavour: "data.created", docTitle: SLOW_DOC_A.title, plan: () => slowPlan("crew list") },
    { flavour: "data.created", docTitle: SLOW_DOC_B.title, plan: () => slowPlan("crew list") },
  ];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: { behaviors },
      // The retrospective lane would fill the queue with its own runs and make
      // every claim-order and concurrency assertion below unreadable.
      brain: { bootstrap: { enabled: false } },
    });
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a granted workflow really can write the artifacts the narrowed ones cannot", async () => {
    [grantDocId] = await bench.pushAndSettle([GRANT_DOC]);

    const loops = await bench.obs.loopsMatching(MARK_GRANTED);
    expect(loops).toHaveLength(1);
    const briefs = await bench.obs.briefsMatching(MARK_GRANTED);
    expect(briefs).toHaveLength(1);
    const annotations = await bench.obs.docAnnotations(grantDocId);
    expect(annotations.annotations).toHaveLength(1);
    grantAnnotationId = annotations.annotations[0]!.id;

    // Not vacuous: the same three tools are attempted below on runs whose
    // workflow lacks them, and none of those calls even reaches a handler.
    const runs = await bench.obs.settledRuns("data");
    const dataRun = runs.find((r) => r.dedupeKey === `data:doc:${grantDocId}`);
    expect(dataRun?.status).toBe("completed");
    const calls = await toolOutcomes(bench, dataRun!.id);
    expect(calls.filter((c) => c.kind === "error")).toEqual([]);
  }, 180_000);

  test("a morning digest cannot create a loop — the tool is not in its toolset", async () => {
    const now = Date.now();
    const runId = bench.seedRun({
      id: `run_${randomUUID()}`,
      kind: "daily",
      payload: { digest: true, date: todayIso(now) },
      dedupeKey: `daily:digest:probe-${now}`,
    });
    await waitSettled(bench, [runId]);

    expect(runRow(bench, runId)!.status).toBe("completed");
    // (a) no row appeared,
    expect(await bench.obs.loopsMatching(MARK_DIGEST)).toEqual([]);
    // (b) the call was answered with "no such tool", not executed and declined.
    const calls = await toolOutcomes(bench, runId);
    expect(calls).toContainEqual({ tool: "open_loop_create", kind: "error", code: "unknown_tool" });
    // …while the artifact the digest IS authorized over went through.
    expect(calls.find((c) => c.tool === "brief_create")?.kind).toBe("structured");
    expect(await bench.obs.briefsMatching(MARK_DIGEST)).toHaveLength(1);
  }, 180_000);

  test("a re-grounding pass cannot create a brief, but can revise its annotations", async () => {
    expect(grantAnnotationId).not.toBe("");
    const runId = bench.seedRun({
      id: `run_${randomUUID()}`,
      kind: "verification",
      payload: { annotationIds: [grantAnnotationId], store: "doc" },
      dedupeKey: `verify:doc:probe-${Date.now()}`,
    });
    await waitSettled(bench, [runId]);

    expect(runRow(bench, runId)!.status).toBe("completed");
    expect(await bench.obs.briefsMatching(MARK_VERIFY)).toEqual([]);
    const calls = await toolOutcomes(bench, runId);
    expect(calls).toContainEqual({ tool: "brief_create", kind: "error", code: "unknown_tool" });
    expect(calls.find((c) => c.tool === "annotation_revise")?.kind).toBe("structured");

    const after = await bench.obs.docAnnotations(grantDocId);
    expect(after.annotations.find((a) => a.id === grantAnnotationId)?.confidence).toBeCloseTo(
      0.45,
      5,
    );
  }, 180_000);

  test("notes compaction can only touch the notes blob", async () => {
    const annotationsBefore = (await bench.obs.docAnnotations(grantDocId)).annotations.length;
    const runId = bench.seedRun({
      id: `run_${randomUUID()}`,
      kind: "notes_compaction",
      payload: { reason: "probe: notes crossed their soft cap" },
      dedupeKey: `notes-compaction-probe-${Date.now()}`,
    });
    await waitSettled(bench, [runId]);

    expect(runRow(bench, runId)!.status).toBe("completed");
    expect(await bench.obs.loopsMatching(MARK_NOTES)).toEqual([]);
    expect((await bench.obs.docAnnotations(grantDocId)).annotations).toHaveLength(
      annotationsBefore,
    );

    const calls = await toolOutcomes(bench, runId);
    expect(calls).toContainEqual({ tool: "open_loop_create", kind: "error", code: "unknown_tool" });
    expect(calls).toContainEqual({ tool: "annotate_durable", kind: "error", code: "unknown_tool" });
    expect(calls.find((c) => c.tool === "notes_rewrite")?.kind).not.toBe("error");
    expect(await bench.obs.notes()).toContain(MARK_NOTES);
  }, 180_000);

  test("a re-claimed crashed run adopts its own partial work instead of duplicating it", async () => {
    await bench.pushAll([CRASH_DOC]);
    const docId = await bench.docId(CRASH_DOC.externalId);
    // Backdated past the recency window, so the live waker never wakes on it
    // and the only run over this document is the crash residue seeded below.
    await sleep(1500);
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ?")
        .get(`data:doc:${docId}`)!.n,
    ).toBe(0);

    const now = Date.now();
    const runId = `run_${randomUUID()}`;
    const loopId = `loop_${randomUUID()}`;
    seedLoop(bench, {
      id: loopId,
      createdByRun: runId,
      title: `Approve the backline hire quote ${MARK_CRASH}`,
      now,
    });
    bench.seedRun({
      id: runId,
      kind: "data",
      payload: { docId, event: "created", datumAt: now - 40 * 86_400_000 },
      dedupeKey: `data:doc:${docId}`,
      attempts: 1,
      enqueuedAt: now,
    });
    await waitSettled(bench, [runId]);

    // The re-claim bumped attempts to 2, so the prompt carries the caution.
    expect(runRow(bench, runId)!.attempts).toBe(2);
    const prompt = await bench.obs.promptFor(runId);
    expect(prompt).toContain("A previous attempt of this run may have partially completed");

    // Exactly one loop, and it is the one the crashed attempt left behind.
    const loops = await bench.obs.loopsMatching(MARK_CRASH);
    expect(loops.map((l) => l.id)).toEqual([loopId]);
    const ledger = await bench.obs.ledger(loopId);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]!.runId).toBe(runId);
    expect(ledger.items[0]!.note).toContain("Adopted the loop");
  }, 240_000);

  test("a payload folded onto a run in flight gets its own execution, not silence", async () => {
    await bench.pushAll([FOLD_DOC]);
    foldDocId = await bench.docId(FOLD_DOC.externalId);

    // The fold is applied from inside the model turn, so by construction it
    // lands while the row is claimed and executing.
    await waitFor(
      () => `the fold to be applied (foldApplied=${foldApplied})`,
      () => (foldApplied ? true : null),
      120_000,
      200,
    );
    expect(foldRunId).not.toBe("");

    // The completing attempt saw a payload the row no longer carries, so the
    // row is resurrected rather than settled — and re-executed on the newer
    // payload after its quiet window.
    await waitFor(
      () =>
        `run ${foldRunId} to complete on the folded payload: ${JSON.stringify(runRow(bench, foldRunId))}`,
      () => {
        const row = runRow(bench, foldRunId);
        if (!row || row.status !== "completed") return null;
        return row.payloadJson.includes('"updated"') ? true : null;
      },
      120_000,
      250,
    );

    // One row for the document — the newer datum did NOT mint a second run,
    // and did not vanish either: the same row ran twice.
    const rowsForDoc = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ?")
      .get(`data:doc:${foldDocId}`)!.n;
    expect(rowsForDoc).toBe(1);

    const flavours = bench.puppetCalls
      .filter((c) => c.runId === foldRunId)
      .map((c) => c.flavour)
      .filter((f): f is string => f !== null);
    expect(flavours).toContain("data.created");
    expect(flavours).toContain("data.updated");
  }, 240_000);

  test("the claim order is feedback > data > the rest > the backlog kinds (oldest-due within rank)", async () => {
    expect(grantAnnotationId).not.toBe("");
    await bench.pushAll([IDLE_DOC]);
    const idleDocId = await bench.docId(IDLE_DOC.externalId);
    await bench.drainUntilQuiet();

    const now = Date.now();
    const ids = {
      feedback: `run_${randomUUID()}`,
      data: `run_${randomUUID()}`,
      synthesis: `run_${randomUUID()}`,
      bootstrap: `run_${randomUUID()}`,
      verification: `run_${randomUUID()}`,
    };
    // Due times run OPPOSITE to the expected claim order, so an engine that
    // merely honoured "oldest due first" would produce the exact reverse.
    // `bootstrap` and `verification` share a kind rank, so the order BETWEEN
    // those two is the oldest-due tiebreak, seeded here as bootstrap first.
    seedBatch(
      bench,
      [
        {
          id: ids.bootstrap,
          kind: "bootstrap",
          payload: { docId: idleDocId, datumAt: now - 40 * 86_400_000 },
          nextAttemptAt: now - 5_000,
        },
        {
          id: ids.verification,
          kind: "verification",
          payload: { annotationIds: [grantAnnotationId], store: "doc" },
          nextAttemptAt: now - 4_000,
        },
        {
          id: ids.synthesis,
          kind: "synthesis",
          payload: { focus: "noticing", date: todayIso(now) },
          nextAttemptAt: now - 3_000,
        },
        {
          id: ids.data,
          kind: "data",
          payload: { docId: idleDocId, event: "created", datumAt: now - 40 * 86_400_000 },
          nextAttemptAt: now - 2_000,
        },
        {
          id: ids.feedback,
          kind: "feedback",
          payload: { briefId: `brief_${randomUUID()}` },
          nextAttemptAt: now - 1_000,
        },
      ],
      now,
    );

    // Read the rows back in the REVERSE of the expected order: `runRows`
    // preserves the order it is given and `Array.prototype.sort` is stable, so
    // a set of rows sharing one claim stamp would come out reversed here — the
    // expectation cannot be satisfied by ties.
    const reverseOfExpected = [
      ids.verification,
      ids.bootstrap,
      ids.synthesis,
      ids.data,
      ids.feedback,
    ];
    await waitSettled(bench, reverseOfExpected);

    const rows = runRows(bench, reverseOfExpected);
    // `last_attempt_at` IS the claim time, and one claim stamps a whole batch
    // with it. Five distinct stamps is the proof that the drainer took these
    // five one at a time and therefore genuinely ordered them.
    expect(new Set(rows.map((r) => r.lastAttemptAt)).size).toBe(5);
    const order = [...rows]
      .sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0))
      .map((r) => r.kind);
    expect(order).toEqual(["feedback", "data", "synthesis", "bootstrap", "verification"]);
  }, 240_000);

  test("worker concurrency parallelizes daily batches and still serializes the rest", async () => {
    await bench.patchConfig({ brain: { workerConcurrency: 2 } });
    // The drainer re-reads the knob per tick; give it one.
    await sleep(1_000);

    const sourceIds = bench.harness.getSourceIds();
    expect(sourceIds.length).toBeGreaterThanOrEqual(2);

    // ── daily, non-digest: allowed to use the full N in parallel.
    const now = Date.now();
    const dailyIds = [`run_${randomUUID()}`, `run_${randomUUID()}`];
    seedBatch(
      bench,
      dailyIds.map((id, i) => ({
        id,
        kind: "daily",
        payload: {
          sourceId: sourceIds[i]!,
          dateFrom: new Date(now - 86_400_000).toISOString(),
          dateTo: new Date(now).toISOString(),
        },
        dedupeKey: `daily:source:${sourceIds[i]}:probe-${id}`,
      })),
      now,
    );
    const dailyMax = await maxConcurrent(bench, dailyIds);
    expect(dailyMax).toBe(2);
    expectOneClaimBatch(bench, dailyIds);

    // ── data: reconcile-before-create is read-then-write, so these never overlap.
    await bench.pushAll([SLOW_DOC_A, SLOW_DOC_B]);
    const docA = await bench.docId(SLOW_DOC_A.externalId);
    const docB = await bench.docId(SLOW_DOC_B.externalId);
    await bench.drainUntilQuiet();

    const then = Date.now();
    const dataIds = [`run_${randomUUID()}`, `run_${randomUUID()}`];
    seedBatch(
      bench,
      [
        {
          id: dataIds[0]!,
          kind: "data",
          payload: { docId: docA, event: "created", datumAt: then - 40 * 86_400_000 },
        },
        {
          id: dataIds[1]!,
          kind: "data",
          payload: { docId: docB, event: "created", datumAt: then - 40 * 86_400_000 },
        },
      ],
      then,
    );
    const dataMax = await maxConcurrent(bench, dataIds);
    // Not vacuous: the pair was claimed by ONE tick, so the drainer had both
    // in hand and chose to run them one after the other.
    expectOneClaimBatch(bench, dataIds);
    expect(dataMax).toBe(1);
  }, 240_000);
});

/**
 * Assert a set of runs was claimed by a single drain tick: the claim statement
 * stamps one `last_attempt_at` across the whole batch, so equal stamps (with
 * no re-claim) mean the drainer held them all at once.
 */
function expectOneClaimBatch(bench: BrainBench, ids: readonly string[]): void {
  const rows = runRows(bench, ids);
  expect(rows.map((r) => r.attempts)).toEqual(ids.map(() => 1));
  expect(new Set(rows.map((r) => r.lastAttemptAt)).size).toBe(1);
}

/**
 * Sample `/admin/brain/pulse` while a seeded set drains, returning the
 * highest number of them ever executing at once. Reads the live-run registry
 * the operator surface reads, so it measures the engine, not a proxy.
 */
async function maxConcurrent(
  bench: BrainBench,
  ids: readonly string[],
  timeoutMs = 180_000,
): Promise<number> {
  const wanted = new Set(ids);
  let max = 0;
  let sawRunning = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pulse = await bench.obs.pulse();
    const mine = pulse.runningRuns.filter((r) => wanted.has(r.id));
    if (mine.length > 0) sawRunning = true;
    max = Math.max(max, mine.length);
    if (runRows(bench, ids).every((r) => r.status !== "pending")) {
      if (!sawRunning) throw new Error(`never observed ${ids.join(", ")} executing`);
      return max;
    }
    if (Date.now() > deadline) {
      throw new Error(`runs did not settle: ${JSON.stringify(runRows(bench, ids))}`);
    }
    await sleep(25);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  I.2  the gate off — the whole engine is inert
// ─────────────────────────────────────────────────────────────────────────────

const GATE_DOC = email({
  externalId: "engine-gate-off",
  title: "Catering headcount for the Northstar showcase",
  content:
    "Hi Alex,\n\nWe need the final catering headcount by Wednesday to lock the menu.\n\nRiverside Estate",
  metadata: { addressedToAgent: true },
});

describe("brain engine — the experimental gate off", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({ experimental: false });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the engine reports itself off, its routes 404, and nothing wakes", async () => {
    const status = await bench.obs.status();
    // A model IS assigned — the only thing missing is the experimental switch,
    // so this is the gate talking, not a misconfiguration.
    expect(status.briefs.modelAssigned).toBe(true);
    expect(status.briefs.enabled).toBe(false);
    expect(status.briefs.active).toBe(false);

    expect(await bench.obs.statusOf("/briefs/feed")).toBe(404);
    expect(await bench.obs.statusOf("/admin/brain/loops")).toBe(404);
    expect(await bench.obs.statusOf("/admin/brain/runs")).toBe(404);

    // A document the waker would wake on instantly (addressed to the agent →
    // zero debounce, dated today → inside the recency window).
    await bench.push(GATE_DOC);
    const docId = await bench.docId(GATE_DOC.externalId);
    expect(docId).not.toBe("");
    await sleep(6_000);

    const runs = bench.sql
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs")
      .get()!.n;
    expect(runs).toBe(0);
    expect(bench.puppetCalls).toEqual([]);
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  I.4 retry + exhaustion · I.5 backend unavailable · I.9 budget park/resume
//  — one gateway on the virtual clock, so back-offs and the day boundary are
//    crossed deliberately instead of waited out.
// ─────────────────────────────────────────────────────────────────────────────

const FAIL_DOC = email({
  externalId: "engine-retry-subject",
  title: "Insurance certificate for the Northstar showcase",
  content:
    "Hi Alex,\n\nThe venue needs the insurance certificate before load-in.\n\nRiverside Estate",
  ageDays: 40,
});

const HOLD_DOC = email({
  externalId: "engine-hold-subject",
  title: "Stage plot for the Northstar showcase",
  content: "Hi Alex,\n\nHere is the stage plot for the showcase.\n\nStudio Northstar",
  ageDays: 40,
});

const QUIET_DOC = email({
  externalId: "engine-quiet-subject",
  title: "Dressing room allocation for the Northstar showcase",
  content: "Hi Alex,\n\nDressing rooms are allocated as follows.\n\nRiverside Estate",
  ageDays: 40,
});

/** Tokens the cognition engine has spent inside one local spend day. */
async function tokensSpentOn(bench: BrainBench, day: string): Promise<number> {
  const spend = await bench.obs.mechanismSpend();
  return spend.rows
    .filter((r) => r.day === day)
    .reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
}

/** The drain loop's most recent tick, from the scheduler's own metrics. */
async function lastDrainTickAt(bench: BrainBench): Promise<number | null> {
  const snapshot = await bench.harness.gatewayJson<{
    jobs: Array<{ id: string; observation: { lastTickAt?: number } }>;
  }>("/admin/background-jobs");
  const job = snapshot.jobs.find((j) => j.id === "cognition.drain");
  if (!job) throw new Error("the cognition drain job is not registered");
  return job.observation.lastTickAt ?? null;
}

/**
 * Wait until the drain loop has ticked `count` further times.
 *
 * A queue that is PARKED and one that is merely slow both look like "nothing
 * happened for a while", so the difference has to be counted in ticks the
 * drainer actually took while claiming nothing.
 */
async function awaitDrainTicks(bench: BrainBench, count: number): Promise<void> {
  const start = await lastDrainTickAt(bench);
  const seen = new Set<number>();
  await waitFor(
    () => `${count} further drain ticks (saw ${seen.size})`,
    async () => {
      const at = await lastDrainTickAt(bench);
      if (at !== null && at !== start) seen.add(at);
      return seen.size >= count ? true : null;
    },
    60_000,
    50,
  );
}

describe("brain engine — failure, backpressure and the budget", () => {
  let bench: BrainBench;

  /** Flipped by the test that needs the model to blow up on every attempt. */
  let modelExplodes = false;
  /**
   * Flipped by the test that needs the model to REJECT the payload rather than
   * fail beneath it. The two settle differently, so a test asserting either
   * one has to choose deliberately.
   */
  let modelRejects = false;
  /** Resolved once the mid-flight config change has landed. */
  let assignmentRemoved = false;

  const behaviors: PuppetBehavior[] = [
    {
      flavour: "data.created",
      docTitle: FAIL_DOC.title,
      plan: () => {
        if (modelRejects) {
          // A 400 blames the request: this payload is bad and will be bad
          // again, so the run is allowed to exhaust its budget and retire.
          throw new PuppetHttpRefusal(400, "brain-bench: scripted payload rejection");
        }
        if (modelExplodes) {
          // Throwing out of the puppet's decision is a 500 from the model
          // server — the shape of a backend that is up but broken. That blames
          // the environment, so the run waits it out rather than retiring.
          throw new Error("brain-bench: scripted model failure");
        }
        return { calls: [], finalText: "Nothing to do." };
      },
    },
    {
      // Holds its run open until the background-agent assignment has been
      // removed, so the NEXT run in the same claimed batch executes with no
      // backend to resolve.
      flavour: "data.created",
      docTitle: HOLD_DOC.title,
      plan: () => ({
        calls: assignmentRemoved
          ? []
          : Array.from({ length: 40 }, () => call("open_loop_search", { query: "stage plot" })),
        finalText: "Held until the assignment was removed.",
      }),
    },
  ];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: { behaviors },
      clock: "virtual",
      brain: { bootstrap: { enabled: false } },
    });
    await bench.drainUntilQuiet();
    await bench.pushAll([FAIL_DOC, HOLD_DOC, QUIET_DOC]);
    await bench.drainUntilQuiet();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a rejected payload backs off exponentially, then gives up terminally", async () => {
    // Retiring a run discards the work it carried, so it is only correct when
    // the payload itself is what failed — the same payload will be rejected
    // again however long anyone waits. The backend-fault case is the test
    // below, and it settles the opposite way.
    const docId = await bench.docId(FAIL_DOC.externalId);
    modelRejects = true;

    const virtualNow = (await bench.clock.now()).now;
    const runId = `run_${randomUUID()}`;
    bench.seedRun({
      id: runId,
      kind: "data",
      payload: { docId, event: "created", datumAt: virtualNow - 40 * 86_400_000 },
      dedupeKey: `data:doc:retry-${runId}`,
      nextAttemptAt: virtualNow,
      enqueuedAt: virtualNow,
    });

    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const row = await waitFor(
        () => `attempt ${attempt} of ${runId}: ${JSON.stringify(runRow(bench, runId))}`,
        () => {
          const r = runRow(bench, runId);
          if (!r || r.attempts !== attempt) return null;
          // Settled, or soft-failed and rescheduled into the future.
          if (r.status === "failed") return r;
          return r.lastError !== null && r.nextAttemptAt > (r.lastAttemptAt ?? 0) ? r : null;
        },
        120_000,
        150,
      );
      if (row.status === "failed") {
        expect(attempt).toBe(5);
        break;
      }
      gaps.push(row.nextAttemptAt - (row.lastAttemptAt ?? 0));
      // Cross the back-off deliberately rather than waiting it out.
      await bench.clock.set(row.nextAttemptAt + 10);
    }

    modelRejects = false;

    // base 60s, doubling per attempt.
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000]);

    const terminal = runRow(bench, runId)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.attempts).toBe(5);
    expect(terminal.failureCode).toBe("http_api_error");
    expect(terminal.lastError).toBeTruthy();

    const pulse = await bench.obs.pulse();
    expect(pulse.counts.failedRuns24h).toBeGreaterThanOrEqual(1);
  }, 240_000);

  test("a broken backend is waited out, not charged to the document", async () => {
    // The regression this guards is the one that cost a live install 385
    // documents: every call failing identically, five attempts spent in under
    // an hour on a fault no payload could fix, and the run retired with its
    // document marked as though it had been reasoned over.
    const docId = await bench.docId(FAIL_DOC.externalId);
    modelExplodes = true;

    const virtualNow = (await bench.clock.now()).now;
    const runId = `run_${randomUUID()}`;
    bench.seedRun({
      id: runId,
      kind: "data",
      payload: { docId, event: "created", datumAt: virtualNow - 40 * 86_400_000 },
      dedupeKey: `data:doc:outage-${runId}`,
      nextAttemptAt: virtualNow,
      enqueuedAt: virtualNow,
    });

    // Walk past more back-offs than the retry budget would have allowed, so a
    // run that could still retire has every chance to.
    for (let i = 0; i < 8; i++) {
      const row = await waitFor(
        () => `deferral ${i + 1} of ${runId}: ${JSON.stringify(runRow(bench, runId))}`,
        () => {
          const r = runRow(bench, runId);
          if (!r) return null;
          if (r.status === "failed") return r;
          return r.lastError !== null && r.nextAttemptAt > (r.lastAttemptAt ?? 0) ? r : null;
        },
        120_000,
        150,
      );
      expect(row.status).toBe("pending");
      await bench.clock.set(row.nextAttemptAt + 10);
    }

    modelExplodes = false;

    const held = runRow(bench, runId)!;
    // Still owed, and still inside its budget: the attempts it spent on the
    // backend were refunded, which is what keeps it claimable at all — the
    // claim query skips rows at the cap, so a run pending AT the cap would be
    // just as lost as one marked failed.
    expect(held.status).toBe("pending");
    expect(held.attempts).toBeLessThan(5);
  }, 300_000);

  test("an unresolvable backend soft-fails the run and writes no transcript", async () => {
    const config = await readConfig(bench);
    const inference = config.inference as { assignments?: Record<string, string> };
    const original = inference.assignments?.["background-agent"];
    expect(original).toBeTruthy();

    await bench.patchConfig({ brain: { workerConcurrency: 2 } });
    await sleep(1_000);

    const holdDocId = await bench.docId(HOLD_DOC.externalId);
    const quietDocId = await bench.docId(QUIET_DOC.externalId);
    const virtualNow = (await bench.clock.now()).now;
    const holdRunId = `run_${randomUUID()}`;
    const orphanRunId = `run_${randomUUID()}`;
    assignmentRemoved = false;

    // Both are claimed by the same tick (limit 2) and then executed strictly
    // one at a time, so the assignment can be pulled between them.
    seedBatch(
      bench,
      [
        {
          id: holdRunId,
          kind: "data",
          payload: { docId: holdDocId, event: "created", datumAt: virtualNow - 40 * 86_400_000 },
          nextAttemptAt: virtualNow - 2_000,
        },
        {
          id: orphanRunId,
          kind: "data",
          payload: { docId: quietDocId, event: "created", datumAt: virtualNow - 40 * 86_400_000 },
          nextAttemptAt: virtualNow - 1_000,
        },
      ],
      virtualNow,
    );

    // Wait until the holding run is genuinely executing, then remove the model.
    await waitFor(
      () => `run ${holdRunId} to start executing`,
      async () => {
        const pulse = await bench.obs.pulse();
        return pulse.runningRuns.some((r) => r.id === holdRunId) ? true : null;
      },
      120_000,
      50,
    );
    await bench.patchConfig({ inference: { assignments: { "background-agent": null } } });
    assignmentRemoved = true;

    await waitFor(
      () => `run ${orphanRunId} to soft-fail: ${JSON.stringify(runRow(bench, orphanRunId))}`,
      () => {
        const r = runRow(bench, orphanRunId);
        return r && r.attempts >= 1 && r.lastError !== null ? r : null;
      },
      120_000,
      150,
    );

    const orphan = runRow(bench, orphanRunId)!;
    // Soft, not terminal: still pending, rescheduled, one attempt burned.
    expect(orphan.status).toBe("pending");
    expect(orphan.attempts).toBe(1);
    expect(orphan.failureCode).toBeNull();
    expect(orphan.lastError).toContain("background-agent backend unavailable");
    expect(orphan.nextAttemptAt).toBeGreaterThan(virtualNow);

    // The gateway is alive and says why it is idle.
    const off = await bench.obs.status();
    expect(off.briefs.modelAssigned).toBe(false);
    expect(off.briefs.active).toBe(false);
    expect(off.briefs.reason).toBeTruthy();

    // Restore the model and cross the back-off: the run is retried, not lost.
    // (The admin surface 404s while the gate is shut, so the transcript
    // assertion below waits for the engine to come back — restoring the model
    // cannot conjure a transcript for an attempt that never opened a session.)
    await bench.patchConfig({
      inference: { assignments: { "background-agent": original! } },
    });
    await waitFor(
      () => "the engine to come back",
      async () => ((await bench.obs.status()).briefs.active ? true : null),
      60_000,
      200,
    );

    // No session ran, so there is nothing to transcribe.
    const transcripts = await bench.obs.transcripts({ runId: orphanRunId });
    expect(transcripts.items).toEqual([]);

    await bench.clock.set(orphan.nextAttemptAt + 10);
    await waitSettled(bench, [orphanRunId]);
    expect(runRow(bench, orphanRunId)!.status).toBe("completed");
    expect(runRow(bench, orphanRunId)!.attempts).toBe(2);

    await bench.patchConfig({ brain: { workerConcurrency: 1 } });
    await sleep(1_000);
  }, 240_000);

  test("an exhausted token budget parks the backlog, and the new day resumes it", async () => {
    await bench.drainUntilQuiet();
    const virtualNow = (await bench.clock.now()).now;
    // The ceiling is compared against ONE local day's spend, on the cognition
    // clock — so the baseline has to be scoped to the same day.
    const day = bench.clock.localDay(virtualNow);
    const spentToday = await tokensSpentOn(bench, day);
    // A ceiling one run's-worth above what today has already cost: the first
    // claim goes through, and its spend closes the day.
    const ceiling = spentToday + 1;
    await bench.patchConfig({ brain: { budget: { dailyTokens: ceiling } } });
    await sleep(500);

    const quietDocId = await bench.docId(QUIET_DOC.externalId);
    const backlog = Array.from({ length: 4 }, (_, i) => ({
      id: `run_${randomUUID()}`,
      kind: "data",
      payload: {
        docId: quietDocId,
        event: "created" as const,
        datumAt: virtualNow - 40 * 86_400_000,
      },
      nextAttemptAt: virtualNow - (10 - i) * 1_000,
    }));
    seedBatch(bench, backlog, virtualNow);
    const ids = backlog.map((r) => r.id);

    // The park condition is the day's spend having MET the ceiling — assert
    // that, not the mere absence of progress, which a slow-but-healthy drainer
    // produces just as well.
    await waitFor(
      () =>
        `the day's spend to reach ${ceiling} and a first run to settle: ${JSON.stringify(runRows(bench, ids))}`,
      async () =>
        (await tokensSpentOn(bench, day)) >= ceiling &&
        runRows(bench, ids).some((r) => r.status === "completed")
          ? true
          : null,
      120_000,
      150,
    );
    // Then let the drainer look several more times with the gate shut: the
    // remaining rows survive ticks that happened, not a wall-clock interval in
    // which the drainer might simply not have got to them.
    await awaitDrainTicks(bench, 5);
    const parked = runRows(bench, ids);
    const settledBefore = parked.filter((r) => r.status !== "pending").map((r) => r.id);
    expect(settledBefore.length).toBeGreaterThanOrEqual(1);
    expect(settledBefore.length).toBeLessThan(ids.length);
    // Parked, not failed: every remaining row is untouched and still claimable.
    for (const row of parked.filter((r) => r.status === "pending")) {
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBeNull();
      expect(row.nextAttemptAt).toBeLessThanOrEqual(virtualNow);
    }

    // Cross into a new local day — the spend window resets, nothing else does.
    await bench.clock.advance(86_400_000);
    await waitSettled(bench, ids);
    const resumed = runRows(bench, ids);
    expect(resumed.map((r) => r.status)).toEqual(ids.map(() => "completed"));
    // The runs that already ran were not run again.
    for (const id of settledBefore) {
      expect(runRow(bench, id)!.attempts).toBe(1);
    }

    await bench.patchConfig({ brain: { budget: { dailyTokens: null } } });
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  I.9  a scheduled check that collides with a pending one — one gateway,
//       real clock
// ─────────────────────────────────────────────────────────────────────────────

const MARK_COLLIDE = "NORTHSTAR-COLLIDE";
const MARK_STAND = "NORTHSTAR-STAND";

/**
 * The UTC day every check in this arc is asked for — three days out, so no
 * check is ever due and the queue keeps every row for the assertions to read.
 */
const CHECK_DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const MORNING_AT = `${CHECK_DAY}T07:00:00.000Z`;
const EVENING_AT = `${CHECK_DAY}T18:00:00.000Z`;
const LATE_AT = `${CHECK_DAY}T21:00:00.000Z`;

const COLLIDE_DOC = email({
  externalId: "engine-schedule-collide",
  title: "Sound check window for the Northstar showcase",
  content:
    "Hi Alex,\n\nThe sound check window is pencilled for the showcase morning. The evening slot still needs confirming with the crew.\n\nStudio Northstar",
});

const STAND_DOC = email({
  externalId: "engine-schedule-stand",
  title: "Catering headcount for the Northstar showcase",
  content:
    "Hi Alex,\n\nPlease confirm the catering headcount for the showcase by the day before.\n\nRiverside Estate",
});

const COLLIDE_MORNING = `Re-verify the sound check window (${MARK_COLLIDE}).`;
const COLLIDE_EVENING = `Refresh the sound check brief before the evening slot (${MARK_COLLIDE}).`;
const COLLIDE_LATE = `Confirm the crew list was closed out (${MARK_COLLIDE}).`;
const STAND_MORNING = `Re-verify the catering headcount (${MARK_STAND}).`;
const STAND_EVENING = `Refresh the catering brief before the evening (${MARK_STAND}).`;

describe("brain engine — a scheduled check that collides with a pending one", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          {
            // The full exchange: a morning check lands, an evening one for the
            // same loop is refused, the retry with `merge` folds it into the
            // morning check, and a late one with `add` stands on its own.
            flavour: "data.created",
            docTitle: COLLIDE_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_create", {
                  title: `Confirm the sound check window (${MARK_COLLIDE})`,
                  confidence: 0.9,
                  importance: 0.6,
                  docs: [ctx.subject],
                }),
                call("schedule_agent_run", {
                  when: MORNING_AT,
                  prompt: COLLIDE_MORNING,
                  loopId: ref("open_loop_create", "loop.id"),
                }),
                call("schedule_agent_run", {
                  when: EVENING_AT,
                  prompt: COLLIDE_EVENING,
                  loopId: ref("open_loop_create", "loop.id"),
                }),
                call("schedule_agent_run", {
                  when: EVENING_AT,
                  prompt: COLLIDE_EVENING,
                  loopId: ref("open_loop_create", "loop.id"),
                  onConflict: "merge",
                }),
                call("schedule_agent_run", {
                  when: LATE_AT,
                  prompt: COLLIDE_LATE,
                  loopId: ref("open_loop_create", "loop.id"),
                  onConflict: "add",
                }),
              ],
              finalText: "Scheduled the day-of checks.",
            }),
          },
          {
            // The refusal with no retry: deciding the second check was
            // redundant needs no flag at all.
            flavour: "data.created",
            docTitle: STAND_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_create", {
                  title: `Confirm the catering headcount (${MARK_STAND})`,
                  confidence: 0.9,
                  importance: 0.6,
                  docs: [ctx.subject],
                }),
                call("schedule_agent_run", {
                  when: MORNING_AT,
                  prompt: STAND_MORNING,
                  loopId: ref("open_loop_create", "loop.id"),
                }),
                call("schedule_agent_run", {
                  when: EVENING_AT,
                  prompt: STAND_EVENING,
                  loopId: ref("open_loop_create", "loop.id"),
                }),
              ],
              finalText: "The morning check already covers it.",
            }),
          },
          { kind: "data", plan: { calls: [] } },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  /** The `schedule_agent_run` calls a run made, in order, with the gateway's answers. */
  async function scheduleCalls(docId: string) {
    const run = await bench.obs.runForDoc(docId);
    const steps = await bench.obs.executedTools(run.id);
    return steps.filter((s) => s.tool === "schedule_agent_run");
  }

  /**
   * Every pending `schedule_agent_run` check the queue holds for a loop,
   * soonest first. The scheduled view also lists the decay engine's own
   * check for the loop (keyed on `decayCheckLoopId`), which never takes part
   * in a collision, so rows are kept by the structured `loopId` their payload
   * carries.
   */
  async function pendingChecksFor(loopId: string) {
    const page = await bench.obs.scheduled();
    return page.items
      .filter((r) => r.status === "pending")
      .filter((r) => (bench.runPayload(r.id) as { loopId?: string }).loopId === loopId)
      .map((r) => ({ id: r.id, fireAt: runRow(bench, r.id)!.nextAttemptAt }))
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  test("a colliding check is refused with what already exists; merge joins it at its own hour, add stands beside it", async () => {
    const [collideDocId] = await bench.pushAndSettle([COLLIDE_DOC, STAND_DOC]);
    const [first, refused, merged, added] = await scheduleCalls(collideDocId!);
    expect([first, refused, merged, added].every((s) => s !== undefined)).toBe(true);

    // The morning check landed, reported at the hour it fires.
    expect(first!.result?.kind).toBe("structured");
    const morningRunId = first!.result?.data?.runId as string;
    expect(first!.result?.data?.scheduledFor).toBe(MORNING_AT);

    // The evening check was refused as an ERROR the run cannot mistake for a
    // scheduled run, and the error carries the choice: the morning check's
    // id, its real fire time, its instruction, and both retries by name.
    expect(refused!.result?.kind).toBe("error");
    expect(refused!.result?.code).toBe("schedule_conflict");
    const message = refused!.result?.message ?? "";
    expect(message).toContain(morningRunId);
    expect(message).toContain(MORNING_AT);
    expect(message).toContain(COLLIDE_MORNING);
    expect(message).toContain('onConflict: "merge"');
    expect(message).toContain('onConflict: "add"');

    // The merge retry landed on the morning check — same id, and the time
    // reported is the MORNING hour, not the evening one it asked for.
    expect(merged!.result?.kind).toBe("structured");
    expect(merged!.result?.data).toMatchObject({
      runId: morningRunId,
      scheduledFor: MORNING_AT,
      merged: true,
    });

    // The add retry is a run of its own, at its own hour.
    expect(added!.result?.kind).toBe("structured");
    const lateRunId = added!.result?.data?.runId as string;
    expect(lateRunId).not.toBe(morningRunId);
    expect(added!.result?.data?.scheduledFor).toBe(LATE_AT);

    // What the queue holds for the loop: exactly the morning check and the
    // late one, never a row for the refused or the merged call.
    const loop = (await bench.obs.loopsMatching(MARK_COLLIDE))[0];
    expect(loop).toBeDefined();
    expect(await pendingChecksFor(loop!.id)).toEqual([
      { id: morningRunId, fireAt: Date.parse(MORNING_AT) },
      { id: lateRunId, fireAt: Date.parse(LATE_AT) },
    ]);

    // The morning check now carries both instructions, the merged one
    // annotated with the hour it was written for; the late check carries
    // its own alone.
    expect(bench.runPayload(morningRunId)).toEqual({
      prompt: `${COLLIDE_MORNING}\n\nAlso requested for ${EVENING_AT}: ${COLLIDE_EVENING}`,
      loopId: loop!.id,
    });
    expect(bench.runPayload(lateRunId)).toEqual({ prompt: COLLIDE_LATE, loopId: loop!.id });
  }, 180_000);

  test("a refusal that is never retried leaves the pending check exactly as it was", async () => {
    const standDocId = await bench.docId(STAND_DOC.externalId);
    const [first, refused, ...rest] = await scheduleCalls(standDocId);
    expect(rest).toHaveLength(0);
    expect(first!.result?.kind).toBe("structured");
    expect(refused!.result?.kind).toBe("error");
    expect(refused!.result?.code).toBe("schedule_conflict");

    const morningRunId = first!.result?.data?.runId as string;
    const loop = (await bench.obs.loopsMatching(MARK_STAND))[0];
    expect(loop).toBeDefined();
    expect(await pendingChecksFor(loop!.id)).toEqual([
      { id: morningRunId, fireAt: Date.parse(MORNING_AT) },
    ]);
    expect(bench.runPayload(morningRunId)).toEqual({ prompt: STAND_MORNING, loopId: loop!.id });
    expect(runRow(bench, morningRunId)).toMatchObject({ status: "pending", attempts: 0 });
  }, 60_000);
});
