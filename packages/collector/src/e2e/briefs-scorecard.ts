// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs scorecard kit — the measurement half of the reconcile-quality
 * instrument.
 *
 * Where the reconcile e2e asserts individual behaviors, the scorecard runs
 * the FULL arc set through a spawned gateway and reduces the end state to
 * the reconcile-quality metrics, compared against each arc's gold:
 *
 *   duplicate_rate, resolution_recall, loop_precision, loop_recall,
 *   update_recall, silent_close_violations, briefs_per_day,
 *   tokens_per_day, infra_failure_rate, malformed_tool_call_rate
 *   (uncorrected failures only; the raw all-failures rate is reported
 *   as malformed_tool_call_rate_raw, informational), scheduled_runs
 *
 * Gold matching is fuzzy and NEVER keys on exact title strings: a loop is
 * attributed to an arc by cited document ids first (the loop's `docs`
 * intersecting the arc's pushed documents), falling back to the arc's
 * stable marker token appearing anywhere in the loop's text.
 *
 * The `evals/briefs/src/scorecard.ts` CLI (`npm run briefs:scorecard`)
 * drives `runScorecard` and wraps the result into `scorecard.json` + the
 * convergence-ledger row; the instrument-validation e2e drives the same
 * function with the perfect and saboteur behavior tables.
 *
 * This module also hosts the shared harness-probe helpers (SQLite polling,
 * arc pushes) the briefs e2e suites reuse.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { generateArcSet, type Arc, type ArcDocument, type ArcSet } from "./briefs-arcs.js";
import { saboteurBehaviors } from "./briefs-saboteur.js";
import { startScriptedLoopModelServer } from "./fake-loop-model.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

// ── shared harness-probe helpers (used by the briefs e2e suites too) ────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  what: string | (() => string),
  probe: () => Promise<T | null> | T | null,
  timeoutMs = 45_000,
  intervalMs = 300,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      // `what` may be a closure so the message can carry live diagnostic
      // state (queue rows, transcripts) evaluated AT timeout time.
      throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    }
    await sleep(intervalMs);
  }
}

/** Read-only view over the spawned gateway's SQLite (WAL readers are safe). */
export function openHarnessDb(h: SyntheticE2EHarness): Database.Database {
  const db = new Database(h.getDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  return db;
}

/**
 * Model a worker killed AFTER a `data` run created its loop/brief but BEFORE
 * it settled: insert a re-claimable pending `data` run for `docId`, its
 * payload intact and `attempts` bumped exactly as a crash leaves the row.
 * The drainer re-claims it; the agent's reconcile-before-create must adopt the
 * loop the crashed attempt already created rather than duplicate it. Writes
 * through a short-lived writable handle (the gateway owns the WAL; a single
 * bounded write is safe). Used by the criterion-5 exact-crash e2e.
 */
export function enqueueCrashedDataRun(
  h: SyntheticE2EHarness,
  opts: { runId: string; docId: string; datumAt: number; now: number },
): void {
  const db = new Database(h.getDbPath(), { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  try {
    db.prepare(
      `INSERT INTO cognition_runs (
         id, kind, payload_json, dedupe_key, status, attempts, next_attempt_at, enqueued_at
       ) VALUES (?, 'data', ?, ?, 'pending', 1, ?, ?)`,
    ).run(
      opts.runId,
      JSON.stringify({ docId: opts.docId, event: "created", datumAt: opts.datumAt }),
      `data:doc:${opts.docId}`,
      opts.now,
      opts.now,
    );
  } finally {
    db.close();
  }
}

/**
 * Delta-priming (daily rhythm) probe: seed an `open` loop touching one
 * document's source, then enqueue a `daily` batch run for that source — the
 * exact shape the daily enqueuer produces. The drainer claims and drives it,
 * so the recorded prompt shows the delta-prime block naming the source's own
 * loops. Writes through a short-lived writable handle (the gateway owns the
 * WAL; bounded writes are safe), the same pattern as enqueueCrashedDataRun.
 * The dedupe key carries a probe-scoped day so it never collides with a real
 * daily run the rhythm enqueues.
 */
export function seedLoopAndEnqueueDailyRun(
  h: SyntheticE2EHarness,
  opts: {
    runId: string;
    loopId: string;
    loopTitle: string;
    docId: string;
    sourceId: string;
    now: number;
  },
): void {
  const db = new Database(h.getDbPath(), { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  try {
    db.prepare(
      `INSERT INTO open_loops (
         id, created_by_run, state, confidence, importance, title, description, created_at, last_update
       ) VALUES (?, 'run_seed', 'open', 0.8, 0.9, ?, '', ?, ?)`,
    ).run(opts.loopId, opts.loopTitle, opts.now, opts.now);
    db.prepare("INSERT OR IGNORE INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)").run(
      opts.loopId,
      opts.docId,
    );
    db.prepare(
      `INSERT INTO cognition_runs (
         id, kind, payload_json, dedupe_key, status, attempts, next_attempt_at, enqueued_at
       ) VALUES (?, 'daily', ?, ?, 'pending', 0, ?, ?)`,
    ).run(
      opts.runId,
      JSON.stringify({
        sourceId: opts.sourceId,
        dateFrom: new Date(opts.now - 86_400_000).toISOString(),
        dateTo: new Date(opts.now).toISOString(),
      }),
      `daily:source:${opts.sourceId}:probe-${opts.runId}`,
      opts.now,
      opts.now,
    );
  } finally {
    db.close();
  }
}

export function docIdByExternal(db: Database.Database, externalId: string): string | null {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  return row?.id ?? null;
}

export interface CognitionRunProbeRow {
  id: string;
  kind: string;
  status: string;
  payload_json: string;
  dedupe_key: string | null;
  usage_json: string | null;
}

export function runsForDoc(db: Database.Database, docId: string): CognitionRunProbeRow[] {
  return db
    .prepare<
      [string],
      CognitionRunProbeRow
    >("SELECT id, kind, status, payload_json, dedupe_key, usage_json FROM cognition_runs WHERE dedupe_key = ?")
    .all(`data:doc:${docId}`);
}

export function loopsWithMarker(
  db: Database.Database,
  marker: string,
): Array<{ id: string; state: string; title: string; created_by_run: string }> {
  return db
    .prepare<
      [string],
      { id: string; state: string; title: string; created_by_run: string }
    >("SELECT id, state, title, created_by_run FROM open_loops WHERE title LIKE ? ESCAPE '\\'")
    .all(`%${marker.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
}

export async function pushArcDoc(
  h: SyntheticE2EHarness,
  doc: ArcDocument,
  overrides: { content?: string } = {},
): Promise<void> {
  const ageMs = (doc.sourceAgeDays ?? 0) * 86_400_000;
  const at = new Date(Date.now() - ageMs).toISOString();
  await h.pushDocument({
    externalId: doc.externalId,
    documentType: doc.documentType,
    title: doc.title,
    content: overrides.content ?? doc.content,
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
  });
}

// ── the daily datum mix ─────────────────────────────────────────────────────

/**
 * The datum mix one full arc-set delivery represents. By declaration it
 * models ONE representative day of life — the basis of the scorecard's
 * `briefs_per_day` / `tokens_per_day` reporting (criterion 13). The
 * committed copy lives at `evals/universes/loops-test-life/daily-mix.json`;
 * callers compare it against this derivation and fail loud on drift.
 */
export interface DailyMix {
  representsDays: number;
  /** Documents the driver pushes (arc steps + the two doc-edit revisions). */
  datumsDelivered: number;
  /** Datums the waker must turn into runs (created events). */
  eligibleWakes: number;
  /** Datums the waker must skip (bulk mail, stale/backfill data). */
  wakerSkips: number;
  /** Agent runs a correct engine completes (wakes + one folded update run). */
  expectedRuns: number;
  /** Simulated brief dismissals, each enqueuing one `feedback` run. */
  feedbackRuns: number;
}

export function computeDailyMix(set: ArcSet): DailyMix {
  let datums = 0;
  let wakes = 0;
  let skips = 0;
  let updateRuns = 0;
  let feedbackRuns = 0;
  for (const arc of set.arcs) {
    if (arc.dismissal) feedbackRuns += 1;
    for (const step of arc.steps) {
      datums += 1;
      if (step.expectRun) wakes += 1;
      else skips += 1;
    }
    if (arc.kind === "doc-edit") {
      // The driver applies both revisions inside the update debounce: two
      // more datums that fold into ONE updated run.
      datums += 2;
      updateRuns += 1;
    }
  }
  return {
    representsDays: 1,
    datumsDelivered: datums,
    eligibleWakes: wakes,
    wakerSkips: skips,
    expectedRuns: wakes + updateRuns,
    feedbackRuns,
  };
}

// ── the spend guard hook ────────────────────────────────────────────────────

/**
 * Per-run budget hook for priced (model-in-the-loop) backends: `reserve`
 * is called BEFORE the datum that will trigger the run is pushed, and
 * `settle` once the run completed, with its recorded usage. The scripted
 * backend runs guardless (zero tokens by construction).
 */
export interface ScorecardRunGuard {
  reserve(datumKey: string): void | Promise<void>;
  settle(
    datumKey: string,
    usage: { promptTokens: number; completionTokens: number; cacheReadTokens: number },
  ): void;
}

function usageOfRuns(runs: readonly CognitionRunProbeRow[]): {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  for (const run of runs) {
    if (run.usage_json === null) continue;
    const usage = JSON.parse(run.usage_json) as {
      promptTokens?: number;
      completionTokens?: number;
      cacheReadTokens?: number;
    };
    promptTokens += usage.promptTokens ?? 0;
    completionTokens += usage.completionTokens ?? 0;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
  }
  return { promptTokens, completionTokens, cacheReadTokens };
}

// ── arc delivery ────────────────────────────────────────────────────────────

/**
 * The arc's dismissable brief: an active (unread/read) brief whose title
 * carries the arc's marker, else one attached to a loop whose title does —
 * the LLM lane may word the brief title freely, but the loop reliably
 * carries the marker.
 */
function findArcBriefId(
  db: Database.Database,
  marker: string,
  arcDocIds: readonly string[],
): string | null {
  const like = `%${marker.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const byTitle = db
    .prepare<
      [string],
      { id: string }
    >(`SELECT id FROM briefs WHERE state IN ('unread','read') AND title LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(like);
  if (byTitle) return byTitle.id;
  const byLoop = db
    .prepare<[string], { id: string }>(
      `SELECT b.id FROM briefs b
         JOIN brief_related_loops brl ON brl.brief_id = b.id
         JOIN open_loops ol ON ol.id = brl.loop_id
        WHERE b.state IN ('unread','read') AND ol.title LIKE ? ESCAPE '\\' LIMIT 1`,
    )
    .get(like);
  if (byLoop) return byLoop.id;
  // Last resort — a freely-worded brief title with no marker: the brief
  // citing one of the arc's own documents.
  for (const docId of arcDocIds) {
    const byCitation = db
      .prepare<[string], { id: string }>(
        `SELECT b.id FROM briefs b
           JOIN brief_citations bc ON bc.brief_id = b.id
          WHERE b.state IN ('unread','read') AND bc.doc_id = ? LIMIT 1`,
      )
      .get(docId);
    if (byCitation) return byCitation.id;
  }
  return null;
}

/** Wait for the (single) completed feedback run a dismissal enqueued. */
async function waitForCompletedFeedbackRun(
  db: Database.Database,
  briefId: string,
  what: string,
): Promise<CognitionRunProbeRow[]> {
  const dedupeKey = `feedback:brief:${briefId}`;
  return waitFor(
    () =>
      `${what} — rows at timeout: ${JSON.stringify(
        db
          .prepare<
            [string],
            Record<string, unknown>
          >("SELECT id, kind, status, attempts, last_error FROM cognition_runs WHERE dedupe_key = ?")
          .all(dedupeKey),
      )}`,
    () => {
      const done = db
        .prepare<[string], CognitionRunProbeRow>(
          `SELECT id, kind, status, payload_json, dedupe_key, usage_json
             FROM cognition_runs WHERE dedupe_key = ? AND status = 'completed'`,
        )
        .all(dedupeKey);
      return done.length >= 1 ? done : null;
    },
    300_000,
  );
}

async function waitForCompletedRuns(
  db: Database.Database,
  docId: string,
  count: number,
  what: string,
): Promise<CognitionRunProbeRow[]> {
  return waitFor(
    () =>
      `${what} — rows at timeout: ${JSON.stringify(
        db
          .prepare<
            [string],
            Record<string, unknown>
          >("SELECT id, kind, status, attempts, last_error FROM cognition_runs WHERE dedupe_key = ?")
          .all(`data:doc:${docId}`),
      )}`,
    () => {
      const done = runsForDoc(db, docId).filter((r) => r.status === "completed");
      return done.length >= count ? done : null;
    },
    // Sized for a priced model's slowest multi-tool run plus one
    // infra-failure retry with back-off — INCLUDING a single API call
    // stalling for minutes (observed live: one stalled call left the run
    // claimed past a 150s ceiling, the throw tore the harness down
    // mid-invocation, and the whole priced run set was lost).
    300_000,
  );
}

/**
 * Deliver the full arc set through the harness push path, arc by arc,
 * step by step — each expected run is awaited before the next datum of
 * the same arc is pushed, so reconcile always races only where the arc
 * intends it to (the concurrent pair). Throws on any instrument-integrity
 * violation (a skipped datum waking the agent, a wake never completing):
 * the engine under the scripted backend is deterministic, so a violation
 * means the instrument is broken, not that the agent scored badly.
 */
async function deliverArcSet(
  harness: SyntheticE2EHarness,
  db: Database.Database,
  set: ArcSet,
  opts: { guard?: ScorecardRunGuard } = {},
): Promise<void> {
  const preexisting = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'data'")
    .get();
  if ((preexisting?.n ?? 0) !== 0) {
    throw new Error(
      `instrument integrity: ${preexisting?.n} data runs exist before arc delivery — ` +
        `the seeded universe must be pure backfill (recency gate breach?)`,
    );
  }

  const negatives: string[] = [];
  // Steps flagged `late` are held back until every arc's regular steps have
  // been delivered — the long-horizon probe: a full day of unrelated traffic
  // lands between the commitment and its resolution.
  const lateSteps: Array<{ doc: ArcDocument; expectRun: boolean }> = [];
  // Re-snapshot document search after every delivered datum: in production a
  // datum that synced earlier has been indexed by the time a later datum's
  // run fires, and several traps (out-of-order resolution, cross-source
  // re-statement) hinge on the agent being ABLE to find the earlier datum via
  // search_many. Without this, pushed datums stay invisible to search
  // and a search-miss would indict the instrument, not the agent.
  const refreshIndex = (): Promise<void> => harness.refreshSearchSnapshot();
  const runGuarded = async (
    datumKey: string,
    push: () => Promise<void>,
    settleWait: () => Promise<CognitionRunProbeRow[]>,
  ): Promise<void> => {
    await opts.guard?.reserve(datumKey);
    await push();
    const runs = await settleWait();
    opts.guard?.settle(datumKey, usageOfRuns(runs));
    await refreshIndex();
  };
  const deliverStep = async (step: { doc: ArcDocument; expectRun: boolean }): Promise<void> => {
    if (!step.expectRun) {
      await pushArcDoc(harness, step.doc);
      negatives.push(step.doc.externalId);
      await refreshIndex();
      return;
    }
    let docId = "";
    await runGuarded(
      `${step.doc.externalId}#created`,
      async () => {
        await pushArcDoc(harness, step.doc);
        docId = await waitFor(`document row for ${step.doc.externalId}`, () =>
          docIdByExternal(db, step.doc.externalId),
        );
      },
      () => waitForCompletedRuns(db, docId, 1, `completed run for ${step.doc.externalId}`),
    );
  };

  for (const arc of set.arcs) {
    if (arc.kind === "concurrent") {
      // The one intended race: both copies land in the same waker sweep.
      const [a, b] = [arc.steps[0]!.doc, arc.steps[1]!.doc];
      await opts.guard?.reserve(`${a.externalId}#created`);
      await opts.guard?.reserve(`${b.externalId}#created`);
      await harness.pushDocuments(
        [a, b].map((doc) => ({
          externalId: doc.externalId,
          documentType: doc.documentType,
          title: doc.title,
          content: doc.content,
        })),
      );
      for (const doc of [a, b]) {
        const docId = await waitFor(`document row for ${doc.externalId}`, () =>
          docIdByExternal(db, doc.externalId),
        );
        const runs = await waitForCompletedRuns(
          db,
          docId,
          1,
          `completed run for ${doc.externalId}`,
        );
        opts.guard?.settle(`${doc.externalId}#created`, usageOfRuns(runs));
      }
      await refreshIndex();
      continue;
    }

    if (arc.kind === "doc-edit") {
      const doc = arc.steps[0]!.doc;
      const [rev1, rev2] = set.docEditRevisions;
      let docId = "";
      await runGuarded(
        `${doc.externalId}#created`,
        async () => {
          await pushArcDoc(harness, doc);
          docId = await waitFor(`document row for ${doc.externalId}`, () =>
            docIdByExternal(db, doc.externalId),
          );
        },
        () => waitForCompletedRuns(db, docId, 1, `created run for ${doc.externalId}`),
      );
      const createdRunIds = new Set(runsForDoc(db, docId).map((r) => r.id));
      await opts.guard?.reserve(`${doc.externalId}#updated`);
      // Both edits inside the update debounce → ONE folded updated run.
      await pushArcDoc(harness, doc, { content: rev1 });
      await pushArcDoc(harness, doc, { content: rev2 });
      const all = await waitForCompletedRuns(
        db,
        docId,
        2,
        `folded update run for ${doc.externalId}`,
      );
      opts.guard?.settle(
        `${doc.externalId}#updated`,
        usageOfRuns(all.filter((r) => !createdRunIds.has(r.id))),
      );
      await refreshIndex();
      continue;
    }

    for (const step of arc.steps) {
      if (step.late) {
        lateSteps.push({ doc: step.doc, expectRun: step.expectRun });
        continue;
      }
      await deliverStep(step);
    }

    // Simulated user reaction: dismiss the arc's brief through the REAL
    // dismissal endpoint (state flip + feedback-run enqueue in one write)
    // and wait for the feedback run — priced like any other run.
    if (arc.dismissal) {
      const marker = arc.marker;
      if (marker === null) throw new Error(`arc ${arc.id}: dismissal requires a marker`);
      const arcDocIds = arc.steps
        .map((step) => docIdByExternal(db, step.doc.externalId))
        .filter((id): id is string => id !== null);
      // The arc's data run has already completed, so its brief either exists
      // now or never will. A model that chose not to brief the datum has NOT
      // crashed the instrument — the dismissal is simply skipped and the
      // arc's gold measures the consequence (an unresolved loop, a stray
      // record) as a metric miss instead of an aborted run set.
      const briefId = findArcBriefId(db, marker, arcDocIds);
      if (briefId === null) {
        process.stderr.write(
          `scorecard: arc ${arc.id} produced no dismissable brief (marker ${marker}) — ` +
            `skipping the ${arc.dismissal.reason} dismissal; the gold judges the end state\n`,
        );
        continue;
      }
      const datumKey = `${arc.id}#dismiss-${arc.dismissal.reason}`;
      await opts.guard?.reserve(datumKey);
      const res = await harness.gatewayJson<{ state?: string; error?: string }>(
        `/briefs/${briefId}/dismiss`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: arc.dismissal.reason,
            ...(arc.dismissal.snoozeHours !== undefined
              ? {
                  snoozeUntil: new Date(
                    Date.now() + arc.dismissal.snoozeHours * 3_600_000,
                  ).toISOString(),
                }
              : {}),
          }),
        },
      );
      if (typeof res.state !== "string" || !res.state.startsWith("dismissed")) {
        throw new Error(`dismissal of ${briefId} (${arc.id}) failed: ${JSON.stringify(res)}`);
      }
      const runs = await waitForCompletedFeedbackRun(db, briefId, `feedback run for ${arc.id}`);
      opts.guard?.settle(datumKey, usageOfRuns(runs));
      await refreshIndex();
    }
  }

  // The held-back long-horizon steps, after every arc's regular traffic.
  for (const step of lateSteps) {
    await deliverStep(step);
  }

  // Let the queue settle, then check the waker skipped what it had to.
  // Only DUE pending rows block settling: a real-model agent legitimately
  // leaves future-dated pending rows behind (schedule_agent_run follow-ups,
  // decay status checks) — those are agent output, not unfinished delivery.
  await waitFor(
    "steward run queue to settle",
    () => {
      const pending = db
        .prepare<
          [number],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_runs WHERE status = 'pending' AND next_attempt_at <= ?")
        .get(Date.now());
      return (pending?.n ?? 0) === 0 ? true : null;
    },
    60_000,
  );
  await sleep(1_500);
  for (const externalId of negatives) {
    const docId = docIdByExternal(db, externalId);
    if (docId === null) throw new Error(`instrument integrity: ${externalId} never landed`);
    const runs = runsForDoc(db, docId);
    if (runs.length !== 0) {
      throw new Error(
        `instrument integrity: skipped datum ${externalId} woke the agent (${runs.length} runs)`,
      );
    }
  }
}

// ── observation & metric reduction ──────────────────────────────────────────

export interface ObservedLoop {
  id: string;
  state: string;
  title: string;
  description: string;
  docs: string[];
}

/** The raw end-state the metrics reduce — backend-agnostic by design. */
export interface ScorecardObservations {
  loops: ObservedLoop[];
  /** Successful `brief_create` / `open_loop_create` calls, from the decision view. */
  briefCreates: number;
  loopCreates: number;
  runsCompleted: number;
  runsFailed: number;
  /**
   * Completed runs of kind `data` only — the slice the daily mix's
   * `expectedRuns` predicts. Engine-initiated runs (scheduled sweeps, decay
   * status checks) complete alongside and are deliberately excluded.
   */
  dataRunsCompleted: number;
  promptTokens: number;
  completionTokens: number;
  /** externalId → document id for every arc datum. */
  docIdsByExternalId: Map<string, string>;
  /** Triggering document id → ids of the `data` runs it enqueued. */
  runIdsByDocId: Map<string, string[]>;
  /** Loop id → run ids stamped on its ledger entries (update evidence). */
  ledgerRunIdsByLoopId: Map<string, string[]>;
  /** Mutating tool calls across all runs, and how many errored. */
  mutatingToolCalls: number;
  mutatingToolCallsFailed: number;
  /** Errored mutating calls never followed by a successful same-tool call
   * in the same run (see `countUncorrectedFailures`) — the gated slice. */
  mutatingToolCallsUncorrected: number;
  /** Successful `schedule_agent_run` calls (informational; epic H3). */
  scheduledRuns: number;
}

/**
 * Failed mutating tool calls the run never corrected. A failure counts as
 * CORRECTED when a later call to the SAME tool in the same run succeeded —
 * the observed live pattern is a burst of empty-args `open_loop_create`
 * emissions followed by a well-formed call, leaving the end state correct.
 * Same-tool-later-succeeded is a proxy for "retried the same intent";
 * within a single data run (one datum, one obligation) that is near-always
 * true, and the raw failure rate stays reported informationally so a
 * masked genuinely-lost mutation would still be visible.
 */
export function countUncorrectedFailures(
  actions: ReadonlyArray<{ tool: string; ok: boolean }>,
): number {
  let uncorrected = 0;
  for (const [i, action] of actions.entries()) {
    if (action.ok) continue;
    const corrected = actions.slice(i + 1).some((a) => a.tool === action.tool && a.ok);
    if (!corrected) uncorrected += 1;
  }
  return uncorrected;
}

async function collectScorecardObservations(
  harness: SyntheticE2EHarness,
  db: Database.Database,
  set: ArcSet,
): Promise<ScorecardObservations> {
  const loops = await harness.gatewayJson<{ items: ObservedLoop[] }>(
    "/admin/brain/loops?limit=500",
  );

  const decisions = await harness.gatewayJson<{
    items: Array<{ actions: Array<{ tool: string; ok: boolean }> }>;
  }>("/admin/brain/decisions?limit=200");
  let briefCreates = 0;
  let loopCreates = 0;
  let mutatingToolCalls = 0;
  let mutatingToolCallsFailed = 0;
  let mutatingToolCallsUncorrected = 0;
  let scheduledRuns = 0;
  for (const decision of decisions.items) {
    mutatingToolCallsUncorrected += countUncorrectedFailures(decision.actions);
    for (const action of decision.actions) {
      mutatingToolCalls += 1;
      if (!action.ok) {
        mutatingToolCallsFailed += 1;
        continue;
      }
      if (action.tool === "brief_create") briefCreates += 1;
      if (action.tool === "open_loop_create") loopCreates += 1;
      if (action.tool === "schedule_agent_run") scheduledRuns += 1;
    }
  }

  const runs = await harness.gatewayJson<{ items: Array<{ status: string; kind: string }> }>(
    "/admin/brain/runs?limit=500",
  );
  const runsCompleted = runs.items.filter((r) => r.status === "completed").length;
  const runsFailed = runs.items.filter((r) => r.status === "failed").length;
  const dataRunsCompleted = runs.items.filter(
    (r) => r.status === "completed" && r.kind === "data",
  ).length;

  const spend = await harness.gatewayJson<{
    items: Array<{ day: string; runs: number; promptTokens: number; completionTokens: number }>;
  }>("/admin/brain/spend");
  const promptTokens = spend.items.reduce((sum, d) => sum + d.promptTokens, 0);
  const completionTokens = spend.items.reduce((sum, d) => sum + d.completionTokens, 0);

  const docIdsByExternalId = new Map<string, string>();
  for (const arc of set.arcs) {
    for (const step of arc.steps) {
      const docId = docIdByExternal(db, step.doc.externalId);
      if (docId !== null) docIdsByExternalId.set(step.doc.externalId, docId);
    }
  }

  // Update evidence, from the DB: which runs each datum enqueued, and which
  // run ids are stamped on each loop's ledger — a later datum "landed" on a
  // loop when its run appended to that loop's ledger (or the loop cites the
  // datum's document). The triggering doc is read from the dedupe key
  // (`data:doc:<id>`), which survives completion — a completed run's
  // payload is deliberately wiped (the no-prior-version-storage discard).
  const runIdsByDocId = new Map<string, string[]>();
  for (const row of db
    .prepare<
      [],
      { id: string; dedupe_key: string | null }
    >("SELECT id, dedupe_key FROM cognition_runs WHERE kind = 'data'")
    .all()) {
    const docId = row.dedupe_key?.startsWith("data:doc:")
      ? row.dedupe_key.slice("data:doc:".length)
      : null;
    if (docId === null) continue;
    const ids = runIdsByDocId.get(docId) ?? [];
    ids.push(row.id);
    runIdsByDocId.set(docId, ids);
  }
  const ledgerRunIdsByLoopId = new Map<string, string[]>();
  for (const row of db
    .prepare<
      [],
      { loop_id: string; run_id: string }
    >("SELECT loop_id, run_id FROM open_loop_ledger")
    .all()) {
    const ids = ledgerRunIdsByLoopId.get(row.loop_id) ?? [];
    ids.push(row.run_id);
    ledgerRunIdsByLoopId.set(row.loop_id, ids);
  }

  return {
    loops: loops.items,
    briefCreates,
    loopCreates,
    runsCompleted,
    runsFailed,
    dataRunsCompleted,
    promptTokens,
    completionTokens,
    docIdsByExternalId,
    runIdsByDocId,
    ledgerRunIdsByLoopId,
    mutatingToolCalls,
    mutatingToolCallsFailed,
    mutatingToolCallsUncorrected,
    scheduledRuns,
  };
}

export interface ScorecardMetrics {
  /** Reconcile opportunities answered by minting a duplicate loop. */
  duplicateRate: number;
  /** Delivered resolutions that actually closed the tracked loop. */
  resolutionRecall: number;
  /** Minted loops that the gold justifies. */
  loopPrecision: number;
  /** Arcs expecting a tracked loop that actually have one. */
  loopRecall: number;
  /** Relevant later datums whose run left a trace on the tracked loop. */
  updateRecall: number;
  /** Ambiguous resolutions closed silently instead of confirm-briefed. */
  silentCloseViolations: number;
  briefsPerDay: number;
  tokensPerDay: number;
  infraFailureRate: number;
  /**
   * Mutating tool calls that errored AND were never corrected by a later
   * successful same-tool call in the same run — the gated malformed-call
   * metric. Self-corrected bursts (the tool layer rejects a malformed
   * emission, the agent retries well-formed, the end state is correct)
   * are excluded here and reported via the raw rate below.
   */
  malformedToolCallRate: number;
  /** ALL errored mutating calls over all mutating calls (informational). */
  malformedToolCallRateRaw: number;
  /** Successful `schedule_agent_run` calls per represented day (informational). */
  scheduledRuns: number;
}

export interface ScorecardCounts {
  arcs: number;
  loopsTotal: number;
  loopsJustified: number;
  duplicatesMinted: number;
  reconcileOpportunities: number;
  resolutionTargets: number;
  resolutionsObserved: number;
  /** Arcs whose gold demands a tracked loop / how many have one. */
  loopArcTargets: number;
  loopArcsTracked: number;
  /** Later datums that must land on the tracked loop / how many did. */
  updateTargets: number;
  updatesLanded: number;
  briefsCreated: number;
  runsCompleted: number;
  runsFailed: number;
  dataRunsCompleted: number;
  mutatingToolCalls: number;
  mutatingToolCallsFailed: number;
  mutatingToolCallsUncorrected: number;
  scheduledRuns: number;
  promptTokens: number;
  completionTokens: number;
}

/** Steps whose CORRECT behavior touches a tracked loop, by action kind. */
function correctActionKinds(arc: Arc): string[] {
  return arc.steps.map((s) => s.doc.behavior.onCreated.kind);
}

function arcHasAmbiguousResolve(arc: Arc): boolean {
  return arc.steps.some(
    (s) => s.doc.behavior.onCreated.kind === "resolve" && s.doc.behavior.onCreated.ambiguous,
  );
}

/**
 * Attribute each observed loop to an arc — by cited document ids first,
 * then by the arc's marker token appearing in the loop's text. Exact
 * title strings are never compared (the gold contract).
 *
 * A loop may legitimately cite a SIBLING arc's document as context — the
 * canonical case is the same-vendor/same-amount quote citing the
 * near-identical invoice it was disambiguated against. When cited docs
 * span several arcs, the loop's own text is the identity signal: the arc
 * whose marker token the loop carries (title first, then description)
 * wins; only a loop carrying no marker at all falls back to the first
 * doc-cited arc.
 */
export function attributeLoops(
  set: ArcSet,
  observations: Pick<ScorecardObservations, "loops" | "docIdsByExternalId">,
): Map<string, ObservedLoop[]> {
  const byArc = new Map<string, ObservedLoop[]>(set.arcs.map((a) => [a.id, []]));
  const markerIn = (arc: Arc, hay: string): boolean =>
    arc.marker !== null && hay.includes(arc.marker.toLowerCase());
  for (const loop of observations.loops) {
    const title = loop.title.toLowerCase();
    const text = `${loop.title}\n${loop.description}`.toLowerCase();
    const docOwners: Arc[] = [];
    for (const arc of set.arcs) {
      const arcDocIds = arc.steps
        .map((s) => observations.docIdsByExternalId.get(s.doc.externalId))
        .filter((id): id is string => id !== undefined);
      if (loop.docs.some((docId) => arcDocIds.includes(docId))) docOwners.push(arc);
    }
    let owner: Arc | undefined;
    if (docOwners.length === 1) {
      owner = docOwners[0];
    } else if (docOwners.length > 1) {
      owner =
        docOwners.find((arc) => markerIn(arc, title)) ??
        docOwners.find((arc) => markerIn(arc, text)) ??
        docOwners[0];
    }
    if (!owner) {
      owner = set.arcs.find((arc) => markerIn(arc, text));
    }
    if (owner) byArc.get(owner.id)!.push(loop);
  }
  return byArc;
}

export function computeScorecardMetrics(
  set: ArcSet,
  observations: ScorecardObservations,
  representsDays: number,
): { metrics: ScorecardMetrics; counts: ScorecardCounts } {
  if (!(representsDays > 0)) throw new Error("representsDays must be positive");
  const byArc = attributeLoops(set, observations);

  let duplicates = 0;
  let opportunities = 0;
  let justified = 0;
  let resolutionTargets = 0;
  let resolutionsObserved = 0;
  let loopArcTargets = 0;
  let loopArcsTracked = 0;
  let updateTargets = 0;
  let updatesLanded = 0;
  let silentCloseViolations = 0;

  for (const arc of set.arcs) {
    const observed = byArc.get(arc.id)!;
    const expected = arc.gold.loopsWithMarker;
    const kinds = correctActionKinds(arc);
    const commits = kinds.filter((k) => k === "commit").length;
    const reconciles = kinds.filter(
      (k) => k === "resolve" || k === "note" || k === "resolvedCommit" || k === "retract",
    ).length;
    opportunities += reconciles + Math.max(0, commits - expected);
    if (expected >= 1) duplicates += Math.max(0, observed.length - expected);
    justified += Math.min(observed.length, expected);
    if (expected >= 1 && !arc.gold.zeroLoopsAcceptable) {
      loopArcTargets += 1;
      if (observed.length >= 1) loopArcsTracked += 1;
    }
    if (arc.gold.finalLoopState === "done") {
      resolutionTargets += 1;
      // Zero-loops-acceptable arcs resolve when nothing is left `open`
      // (no loop at all is fine); regular arcs need the tracked loop done.
      const resolved = arc.gold.zeroLoopsAcceptable
        ? observed.every((l) => l.state !== "open")
        : observed.some((l) => l.state === "done");
      if (resolved) resolutionsObserved += 1;
    }
    if (
      arcHasAmbiguousResolve(arc) &&
      arc.gold.finalLoopState === "open" &&
      observed.some((l) => l.state === "done")
    ) {
      silentCloseViolations += 1;
    }
    // Update quality: every `note` datum must leave a trace on the arc's
    // tracked loop — a ledger entry stamped by the run that processed it,
    // or the datum's document cited on the loop.
    for (const step of arc.steps) {
      if (step.doc.behavior.onCreated.kind !== "note") continue;
      updateTargets += 1;
      const docId = observations.docIdsByExternalId.get(step.doc.externalId);
      if (docId === undefined) continue;
      const runIds = observations.runIdsByDocId.get(docId) ?? [];
      const landed = observed.some(
        (loop) =>
          loop.docs.includes(docId) ||
          (observations.ledgerRunIdsByLoopId.get(loop.id) ?? []).some((runId) =>
            runIds.includes(runId),
          ),
      );
      if (landed) updatesLanded += 1;
    }
  }

  const loopsTotal = observations.loops.length;
  const runsTotal = observations.runsCompleted + observations.runsFailed;
  const metrics: ScorecardMetrics = {
    duplicateRate: opportunities === 0 ? 0 : duplicates / opportunities,
    resolutionRecall: resolutionTargets === 0 ? 1 : resolutionsObserved / resolutionTargets,
    loopPrecision: loopsTotal === 0 ? 1 : justified / loopsTotal,
    loopRecall: loopArcTargets === 0 ? 1 : loopArcsTracked / loopArcTargets,
    updateRecall: updateTargets === 0 ? 1 : updatesLanded / updateTargets,
    silentCloseViolations,
    briefsPerDay: observations.briefCreates / representsDays,
    tokensPerDay: (observations.promptTokens + observations.completionTokens) / representsDays,
    infraFailureRate: runsTotal === 0 ? 0 : observations.runsFailed / runsTotal,
    malformedToolCallRate:
      observations.mutatingToolCalls === 0
        ? 0
        : observations.mutatingToolCallsUncorrected / observations.mutatingToolCalls,
    malformedToolCallRateRaw:
      observations.mutatingToolCalls === 0
        ? 0
        : observations.mutatingToolCallsFailed / observations.mutatingToolCalls,
    scheduledRuns: observations.scheduledRuns / representsDays,
  };
  const counts: ScorecardCounts = {
    arcs: set.arcs.length,
    loopsTotal,
    loopsJustified: justified,
    duplicatesMinted: duplicates,
    reconcileOpportunities: opportunities,
    resolutionTargets,
    resolutionsObserved,
    loopArcTargets,
    loopArcsTracked,
    updateTargets,
    updatesLanded,
    briefsCreated: observations.briefCreates,
    runsCompleted: observations.runsCompleted,
    runsFailed: observations.runsFailed,
    dataRunsCompleted: observations.dataRunsCompleted,
    mutatingToolCalls: observations.mutatingToolCalls,
    mutatingToolCallsFailed: observations.mutatingToolCallsFailed,
    mutatingToolCallsUncorrected: observations.mutatingToolCallsUncorrected,
    scheduledRuns: observations.scheduledRuns,
    promptTokens: observations.promptTokens,
    completionTokens: observations.completionTokens,
  };
  return { metrics, counts };
}

// ── run artifacts ───────────────────────────────────────────────────────────

/**
 * Dump the run's observable end-state — loops, briefs, queue runs, the
 * per-datum decision view, per-day spend, and every stored transcript —
 * into `dir` before teardown. This is the raw material for Phase Two's
 * qualitative failure analysis (the epic mandates reading what the
 * model-driven agent actually produced, not just the metrics). Run
 * outputs live under the git-ignored `evals/briefs/runs/`.
 */
async function dumpScorecardArtifacts(harness: SyntheticE2EHarness, dir: string): Promise<void> {
  const transcriptsDir = join(dir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const dump = async (path: string, file: string): Promise<void> => {
    const body = await harness.gatewayJson<unknown>(path);
    writeFileSync(join(dir, file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  };
  await dump("/admin/brain/loops?limit=500", "loops.json");
  await dump("/admin/brain/briefs?limit=500", "briefs.json");
  await dump("/admin/brain/runs?limit=500", "runs.json");
  await dump("/admin/brain/decisions?limit=200", "decisions.json");
  await dump("/admin/brain/spend", "spend.json");
  const refs = await harness.gatewayJson<{ items: Array<{ fileName: string }> }>(
    "/admin/brain/transcripts?limit=500",
  );
  for (const ref of refs.items) {
    const body = await harness.gatewayJson<{ transcript: unknown }>(
      `/admin/brain/transcripts/${encodeURIComponent(ref.fileName)}`,
    );
    writeFileSync(
      join(transcriptsDir, ref.fileName),
      `${JSON.stringify(body.transcript, null, 2)}\n`,
      "utf8",
    );
  }
}

// ── the full run ────────────────────────────────────────────────────────────

/**
 * Worker-side synth discovery plus the compressed steward cadences the
 * spawned gateway needs. Its feature mode is selected separately by the
 * harness rather than inherited from this process.
 */
function prepareScorecardEnv(): void {
  process.env.OMNESIS_SYNTHETIC = "1";
  process.env.OMNESIS_SYNTH_AUTH_DELAY_MS = process.env.OMNESIS_SYNTH_AUTH_DELAY_MS ?? "50";
  process.env.OMNESIS_SYNTH_PRE_DISCOVERED = process.env.OMNESIS_SYNTH_PRE_DISCOVERED ?? "1";
  process.env.OMNESIS_COGNITION_WAKER_INTERVAL_MS = "100";
  process.env.OMNESIS_COGNITION_WAKER_IDLE_MS = "200";
  process.env.OMNESIS_COGNITION_WAKER_START_DELAY_MS = "300";
  process.env.OMNESIS_COGNITION_DRAIN_INTERVAL_MS = "150";
  process.env.OMNESIS_COGNITION_DRAIN_IDLE_MS = "300";
  process.env.OMNESIS_COGNITION_DRAIN_START_DELAY_MS = "500";
}

export type ScorecardBackendSpec =
  | { kind: "scripted"; script: "perfect" | "saboteur" }
  | {
      /** A real OpenAI-compatible backend (the Phase Two deepseek lane). */
      kind: "http";
      backendName: string;
      url: string;
      apiKey?: string;
      modelId: string;
    };

export interface ScorecardRunResult {
  seed: number;
  mix: DailyMix;
  metrics: ScorecardMetrics;
  counts: ScorecardCounts;
}

/**
 * One full scorecard run: boot a spawned gateway on `loops-test-life`
 * with the requested backend assigned as `background-agent`, deliver the
 * seeded arc set, reduce the end state to the metrics, tear down.
 *
 * `guard` is MANDATORY for http (priced) backends — every priced run goes
 * through the spend meter's reserve-then-run discipline. The scripted lane
 * runs guardless by default (zero tokens by construction); the instrument
 * e2e attaches a recording guard there to validate the plumbing itself.
 */
export async function runScorecard(opts: {
  gatewayMode: "experimental";
  backend: ScorecardBackendSpec;
  seed: number;
  guard?: ScorecardRunGuard;
  /** When set, the observable end-state is dumped here before teardown. */
  artifactsDir?: string;
}): Promise<ScorecardRunResult> {
  if (opts.backend.kind === "http" && !opts.guard) {
    throw new Error("priced (http) scorecard backends require a spend guard");
  }
  prepareScorecardEnv();
  const set = generateArcSet(opts.seed);

  const scripted =
    opts.backend.kind === "scripted"
      ? await startScriptedLoopModelServer({
          behaviors: opts.backend.script === "saboteur" ? saboteurBehaviors(set) : set.behaviors,
          feedbackPolicy: opts.backend.script === "saboteur" ? "saboteur" : "correct",
        })
      : null;
  const backendName = opts.backend.kind === "scripted" ? "scripted" : opts.backend.backendName;
  const backendConfig: { type: "http"; url: string } & Record<string, unknown> =
    opts.backend.kind === "scripted"
      ? { type: "http", url: scripted!.url }
      : {
          type: "http",
          url: opts.backend.url,
          ...(opts.backend.apiKey !== undefined ? { apiKey: opts.backend.apiKey } : {}),
        };
  const modelId = opts.backend.kind === "scripted" ? scripted!.modelId : opts.backend.modelId;

  const harness = new SyntheticE2EHarness({
    gatewayMode: opts.gatewayMode,
    universe: "loops-test-life",
    embedderBackend: "fake",
    extraInference: {
      backends: { [backendName]: backendConfig },
      assignments: { "background-agent": `${backendName}/${modelId}` },
      // Priced backends are cloud hosts; the URL policy refuses non-loopback
      // inference addresses unless the config opts in. The scripted lane
      // stays loopback-only (policy default).
      ...(opts.backend.kind === "http" ? { allowRemoteInference: true } : {}),
    },
    extraGatewayConfig: {
      brain: {
        workerConcurrency: 2,
        conversationDebounce: "2s",
        documentUpdateDebounce: "2s",
      },
    },
  });

  let db: Database.Database | null = null;
  try {
    await harness.start();
    for (const id of harness.getSourceIds()) {
      await harness.triggerSyncAndWait(id, 60_000);
    }
    await harness.refreshSearchSnapshot();
    db = openHarnessDb(harness);
    await deliverArcSet(harness, db, set, opts.guard ? { guard: opts.guard } : {});
    const observations = await collectScorecardObservations(harness, db, set);
    if (opts.artifactsDir !== undefined) await dumpScorecardArtifacts(harness, opts.artifactsDir);
    const mix = computeDailyMix(set);
    const { metrics, counts } = computeScorecardMetrics(set, observations, mix.representsDays);
    return { seed: opts.seed, mix, metrics, counts };
  } finally {
    db?.close();
    await harness.destroy();
    await scripted?.close();
  }
}
