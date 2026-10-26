// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain loop scorecard kit — the measurement half of the reconcile-quality
 * instrument.
 *
 * Where the reconcile e2e asserts individual behaviors, the scorecard runs
 * the FULL arc set through a spawned gateway and reduces the end state to
 * the reconcile-quality metrics, compared against each arc's gold:
 *
 *   duplicate_rate, resolution_recall, loop_precision, loop_recall,
 *   update_recall, silent_close_violations, observations_per_day,
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
 * arc pushes) the bench and reconcile e2e suites reuse.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { verifiedFrontierRetries } from "./briefs-frontier-retries.js";
import {
  verifiedConcurrentCreateRetries,
  verifiedCollectionCreateRetryOrdinals,
} from "./briefs-concurrency-retries.js";
import { BrainObs } from "./brain-bench/obs.js";
import { readMaintenanceProgress } from "./brain-bench/maintenance-progress.js";
import { generateArcSet, type Arc, type ArcDocument, type ArcSet } from "./briefs-arcs.js";
import { saboteurBehaviors } from "./briefs-saboteur.js";
import { startScriptedLoopModelServer } from "./fake-loop-model.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

// ── shared harness-probe helpers (used by the brain e2e suites too) ────────

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
 * Model a worker killed AFTER a `data` run created its loop/observation but BEFORE
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
    .prepare<[string, string], CognitionRunProbeRow>(
      `SELECT DISTINCT r.id,r.kind,r.status,r.payload_json,r.dedupe_key,r.usage_json
       FROM cognition_runs r WHERE r.dedupe_key=? OR EXISTS (
         SELECT 1 FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id
         WHERE w.subject_kind='source' AND w.subject_id=? AND (b.run_id=r.id OR json_extract(r.payload_json,'$.batchId')=b.id)
       ) ORDER BY r.enqueued_at,r.id`,
    )
    .all(`data:doc:${docId}`, docId);
}

/** Count settled original evidence work separately from catch-up and handed-off runs.
 * A queue run may complete while its source work is deferred to another batch;
 * that paid attempt belongs in total spend, not a second completed datum. */
export function completedSourceRunCounts(db: Database.Database, sourceIds: Iterable<string>) {
  const original = new Set<string>();
  const all = new Set<string>();
  const read = db.prepare<[string, string], { id: string; original: number }>(`
    SELECT r.id, (r.dedupe_key=? OR EXISTS (
      SELECT 1 FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id
      WHERE w.subject_kind='source' AND w.subject_id=? AND w.reason='change' AND w.status='completed'
      AND (b.run_id=r.id OR json_extract(r.payload_json,'$.batchId')=b.id)
    )) AS original FROM cognition_runs r WHERE r.status='completed'
  `);
  for (const sourceId of sourceIds) {
    const related = new Set(
      runsForDoc(db, sourceId)
        .filter((r) => r.status === "completed")
        .map((r) => r.id),
    );
    for (const row of read.all(`data:doc:${sourceId}`, sourceId)) {
      if (!related.has(row.id)) continue;
      all.add(row.id);
      if (row.original) original.add(row.id);
    }
  }
  return {
    dataRunsCompleted: original.size,
    sourceMaintenanceRunsCompleted: all.size - original.size,
  };
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

/**
 * Land several pushes while background dispatch is paused, so the Brain's
 * maintenance tick admits them together: edits that arrive while a source's
 * change work is still pending fold into that work. Document ingest is
 * realtime priority and proceeds while paused. Dispatch always resumes.
 */
export async function pushEditsTogether(
  h: SyntheticE2EHarness,
  push: () => Promise<void>,
): Promise<void> {
  const paused = await h.gatewayJson<{ paused: boolean }>("/admin/background/pause", {
    method: "POST",
  });
  if (!paused.paused) throw new Error("background dispatch did not pause");
  let resumed: { paused: boolean };
  try {
    await push();
  } finally {
    resumed = await h.gatewayJson<{ paused: boolean }>("/admin/background/resume", {
      method: "POST",
    });
  }
  if (resumed.paused) throw new Error("background dispatch did not resume");
}

// ── the daily datum mix ─────────────────────────────────────────────────────

/**
 * The datum mix one full arc-set delivery represents. By declaration it
 * models ONE representative day of life — the basis of the scorecard's
 * `observations_per_day` / `tokens_per_day` reporting (criterion 13). The
 * committed copy lives at `evals/universes/loops-test-life/daily-mix.json`;
 * callers compare it against this derivation and fail loud on drift.
 */
export interface DailyMix {
  representsDays: number;
  /** Documents the driver pushes (arc steps + the two doc-edit revisions). */
  datumsDelivered: number;
  /** Datums the waker must turn into runs (created events). */
  eligibleWakes: number;
  /** Inputs with no scripted canonical outcome. Discovery may still inspect them. */
  wakerSkips: number;
  /** Agent runs a correct engine completes (wakes + one folded update run). */
  expectedRuns: number;
}

export function computeDailyMix(set: ArcSet): DailyMix {
  let datums = 0;
  let wakes = 0;
  let skips = 0;
  let updateRuns = 0;
  for (const arc of set.arcs) {
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

/** Sequential quality cases wait for their canonical follow-ups and publication
 * reconsideration. Deliberately future scheduled/decay runs are not drained. */
async function settleScorecardMaintenance(harness: SyntheticE2EHarness, db: Database.Database) {
  const obs = new BrainObs(harness);
  let quietSince: number | null = null;
  await waitFor(
    () =>
      `scorecard maintenance to settle: ${JSON.stringify({
        work: db
          .prepare(
            "SELECT subject_id,reason,status,last_error FROM knowledge_work WHERE status IN ('pending','batched') AND due_at<=? LIMIT 20",
          )
          .all(Date.now() + 2000),
        runs: db
          .prepare(
            "SELECT id,kind,status,attempts,last_error FROM cognition_runs WHERE status='pending' AND next_attempt_at<=? LIMIT 20",
          )
          .all(Date.now() + 2000),
        progress: readMaintenanceProgress(db, Date.now() + 2000),
      })}`,
    async () => {
      const pulse = await obs.pulse();
      const now = Date.now();
      // Include this fixture's 1s tiers and 2s debounce, not future reminders.
      const dueRuns = db
        .prepare<
          [number],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_runs WHERE status='pending' AND next_attempt_at<=?")
        .get(now + 2000)!.n;
      const quiet =
        dueRuns === 0 &&
        pulse.counts.bufferedWakes === 0 &&
        pulse.runningRuns.length === 0 &&
        readMaintenanceProgress(db, now + 2000).pending === 0;
      if (!quiet) {
        quietSince = null;
        return null;
      }
      quietSince ??= now;
      return now - quietSince >= 600 ? true : null;
    },
    120_000,
  );
}

/**
 * Deliver the full arc set through the harness push path, arc by arc,
 * step by step — each expected run is awaited before the next datum of
 * the same arc is pushed, so reconcile always races only where the arc
 * intends it to (the concurrent pair). Throws on any instrument-integrity
 * violation (a negative input creating an obligation, a run never completing):
 * the engine under the scripted backend is deterministic, so a violation
 * means the instrument is broken, not that the agent scored badly.
 */
async function deliverArcSet(
  harness: SyntheticE2EHarness,
  db: Database.Database,
  set: ArcSet,
  opts: { guard?: ScorecardRunGuard } = {},
): Promise<void> {
  const negatives: string[] = [];
  const attributedRuns = new Set<string>();
  const settleUsage = (key: string, runs: CognitionRunProbeRow[]): void => {
    const unseen = runs.filter((run) => !attributedRuns.has(run.id));
    for (const run of unseen) attributedRuns.add(run.id);
    opts.guard?.settle(key, usageOfRuns(unseen));
  };
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
  const refreshIndex = async (): Promise<void> => {
    await harness.refreshSearchSnapshot();
    await settleScorecardMaintenance(harness, db);
  };
  const runGuarded = async (
    datumKey: string,
    push: () => Promise<void>,
    settleWait: () => Promise<CognitionRunProbeRow[]>,
  ): Promise<void> => {
    await opts.guard?.reserve(datumKey);
    await push();
    const runs = await settleWait();
    settleUsage(datumKey, runs);
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
        settleUsage(`${doc.externalId}#created`, runs);
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
      // Both edits land while the first one's change work is still pending →
      // ONE folded updated run. Background dispatch (the maintenance tick that
      // admits and batches change work) is held while they land, so a slow
      // second push cannot miss the fold window; ingest is realtime.
      await pushEditsTogether(harness, async () => {
        await pushArcDoc(harness, doc, { content: rev1 });
        await pushArcDoc(harness, doc, { content: rev2 });
      });
      const all = await waitForCompletedRuns(
        db,
        docId,
        2,
        `folded update run for ${doc.externalId}`,
      );
      settleUsage(
        `${doc.externalId}#updated`,
        all.filter((r) => !createdRunIds.has(r.id)),
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
  }

  // The held-back long-horizon steps, after every arc's regular traffic.
  for (const step of lateSteps) {
    await deliverStep(step);
  }

  // Let current work settle, then check negative inputs created no obligations.
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
    await waitFor(`current interpretation of negative source ${externalId}`, () =>
      db
        .prepare(
          `SELECT 1 FROM knowledge_discovery_coverage c JOIN documents d ON d.id=c.subject_id
       WHERE d.id=? AND c.input_revision=d.content_hash AND c.phase='interpretation' AND c.status IN ('considered','gated')`,
        )
        .get(docId)
        ? true
        : null,
    );
    // Discovery may inspect old or bulk inputs; a negative fixture must not
    // manufacture a canonical outcome merely because a model run occurred.
    const mutations =
      db
        .prepare<
          [string, string],
          { n: number }
        >("SELECT (SELECT COUNT(*) FROM open_loop_docs WHERE doc_id=?) + (SELECT COUNT(*) FROM observation_citations WHERE doc_id=?) AS n")
        .get(docId, docId)?.n ?? 0;
    if (mutations)
      throw new Error(`instrument integrity: negative source ${externalId} created a loop`);
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
  failedActions?: Array<{ tool: string; detail?: string }>;
  loops: ObservedLoop[];
  /** Successful `observation_note` calls, from the decision view. */
  observationNotes: number;
  loopCreates: number;
  runsCompleted: number;
  runsFailed: number;
  /**
   * Completed original source-change work (or legacy data runs), the slice
   * predicted by the daily mix. A completed run whose work was handed off
   * remains paid maintenance, not another successfully processed datum.
   */
  dataRunsCompleted: number;
  /** Other completed runs touching expected sources, including deferred handoffs. */
  sourceMaintenanceRunsCompleted?: number;
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
  /** Proven concurrent-create CAS retries; included in the raw refused count. */
  verifiedConcurrentCreateRetries?: number;
  /** Observed stale-frontier retries followed by a fresh save and completed batch. */
  verifiedFrontierRetries?: number;
  /** Fresh same-query collection-CAS recovery ending in an identical successful create. */
  verifiedCollectionCreateRetries?: number;
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
    items: Array<{
      runId: string;
      attempt: number;
      actions: Array<{ tool: string; ok: boolean; detail?: string }>;
    }>;
  }>("/admin/brain/decisions?limit=200");
  const failedRuns = decisions.items.filter((row) => row.actions.some((action) => !action.ok));
  if (failedRuns.length) {
    const obs = new BrainObs(harness);
    createLogger("collector:briefs-scorecard").error(
      `Refused scorecard mutations: ${JSON.stringify(
        await Promise.all(
          [...new Set(failedRuns.map((row) => row.runId))].slice(0, 12).map(async (id) => ({
            id,
            errors: (await obs.executedTools(id)).filter((step) => step.result?.kind === "error"),
          })),
        ),
      )}`,
    );
  }
  let observationNotes = 0;
  let loopCreates = 0;
  let mutatingToolCalls = 0;
  let mutatingToolCallsFailed = 0;
  let mutatingToolCallsUncorrected = 0;
  let verifiedCreateRetries = 0;
  let verifiedFrontierRetryCount = 0;
  let verifiedCollectionRetryCount = 0;
  const obs = new BrainObs(harness);
  let scheduledRuns = 0;
  for (const decision of decisions.items) {
    // Only the deliberate concurrent fixture may produce an expected losing
    // create. Search visibility alone cannot prove concurrency (ranking and
    // result limits change); require a sole canonical winner owned by the
    // other source's run in this explicit two-source race.
    const permittedWinnerIds = new Set<string>();
    for (const arc of set.arcs.filter((candidate) => candidate.kind === "concurrent")) {
      if (!arc.marker) continue;
      const peers = new Set(
        arc.steps.flatMap((step) => {
          const docId = docIdByExternal(db, step.doc.externalId);
          return docId ? runsForDoc(db, docId).map((run) => run.id) : [];
        }),
      );
      const owners = loopsWithMarker(db, arc.marker);
      const winner = owners.length === 1 ? owners[0] : undefined;
      if (
        winner &&
        typeof winner.created_by_run === "string" &&
        peers.has(decision.runId) &&
        peers.has(winner.created_by_run) &&
        winner.created_by_run !== decision.runId &&
        db
          .prepare(
            `SELECT 1 FROM open_loops l JOIN cognition_runs r ON r.id=?
          WHERE l.id=? AND r.attempts=? AND r.last_attempt_at<=l.created_at`,
          )
          .get(decision.runId, winner.id, decision.attempt)
      )
        permittedWinnerIds.add(winner.id);
    }
    const failedCreates = decision.actions.filter(
      (action) => !action.ok && action.tool === "open_loop_create",
    );
    const failedSaves = decision.actions.filter(
      (action) => !action.ok && action.tool === "knowledge_save",
    );
    const steps =
      failedCreates.length || failedSaves.length
        ? await obs.executedTools(decision.runId, decision.attempt)
        : [];
    // A missing/truncated attempt cannot establish a correspondence with the
    // decision summary: keep all its refusals in the malformed partition.
    const verified =
      steps.filter((step) => step.tool === "open_loop_create" && step.result?.kind === "error")
        .length === failedCreates.length
        ? verifiedConcurrentCreateRetries(steps, permittedWinnerIds)
        : new Set<number>();
    const collectionRetries =
      steps.filter((step) => step.tool === "open_loop_create" && step.result?.kind === "error")
        .length === failedCreates.length
        ? verifiedCollectionCreateRetryOrdinals(steps)
        : new Set<number>();
    const frontierRetries =
      steps.filter((step) => step.tool === "knowledge_save" && step.result?.kind === "error")
        .length === failedSaves.length
        ? verifiedFrontierRetries(steps)
        : new Set<number>();
    let failedSaveOrdinal = 0;
    let failedCreateOrdinal = 0;
    const malformedActions = decision.actions.filter((action) => {
      if (
        action.tool === "knowledge_save" &&
        !action.ok &&
        frontierRetries.has(failedSaveOrdinal++)
      ) {
        verifiedFrontierRetryCount += 1;
        return false;
      }
      if (action.tool !== "open_loop_create" || action.ok) return true;
      const ordinal = failedCreateOrdinal++;
      if (verified.has(ordinal)) {
        verifiedCreateRetries += 1;
        return false;
      }
      if (collectionRetries.has(ordinal)) {
        verifiedCollectionRetryCount += 1;
        return false;
      }
      return true;
    });
    mutatingToolCallsUncorrected += countUncorrectedFailures(malformedActions);
    for (const action of decision.actions) {
      mutatingToolCalls += 1;
      if (!action.ok) {
        mutatingToolCallsFailed += 1;
        continue;
      }
      if (action.tool === "observation_note") observationNotes += 1;
      if (action.tool === "open_loop_create") loopCreates += 1;
      if (action.tool === "schedule_agent_run") scheduledRuns += 1;
    }
  }

  const runs = await harness.gatewayJson<{ items: Array<{ status: string; kind: string }> }>(
    "/admin/brain/runs?limit=500",
  );
  const runsCompleted = runs.items.filter((r) => r.status === "completed").length;
  const runsFailed = runs.items.filter((r) => r.status === "failed").length;
  const expectedSourceIds = new Set(
    set.arcs
      .flatMap((arc) =>
        arc.steps
          .filter((step) => step.expectRun)
          .map((step) => docIdByExternal(db, step.doc.externalId)),
      )
      .filter((id): id is string => id !== null),
  );
  const { dataRunsCompleted, sourceMaintenanceRunsCompleted } = completedSourceRunCounts(
    db,
    expectedSourceIds,
  );

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
  // datum's document). Current sources join durable work to their batch and
  // continuation runs; explicit legacy recovery retains its data dedupe key.
  // Source prose and prior revisions are not needed for this attribution.
  const runIdsByDocId = new Map<string, string[]>();
  for (const docId of docIdsByExternalId.values())
    runIdsByDocId.set(
      docId,
      runsForDoc(db, docId).map((run) => run.id),
    );
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
    failedActions: decisions.items
      .flatMap((row) =>
        row.actions.filter((action) => !action.ok).map(({ tool, detail }) => ({ tool, detail })),
      )
      .slice(0, 20),
    loops: loops.items,
    observationNotes,
    loopCreates,
    runsCompleted,
    runsFailed,
    dataRunsCompleted,
    sourceMaintenanceRunsCompleted,
    promptTokens,
    completionTokens,
    docIdsByExternalId,
    runIdsByDocId,
    ledgerRunIdsByLoopId,
    mutatingToolCalls,
    mutatingToolCallsFailed,
    verifiedConcurrentCreateRetries: verifiedCreateRetries,
    verifiedFrontierRetries: verifiedFrontierRetryCount,
    verifiedCollectionCreateRetries: verifiedCollectionRetryCount,
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
  /** Ambiguous resolutions closed silently instead of raising a confirmation. */
  silentCloseViolations: number;
  /** Successful `observation_note` calls per represented day (informational). */
  observationsPerDay: number;
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
  observationsNoted: number;
  runsCompleted: number;
  runsFailed: number;
  dataRunsCompleted: number;
  sourceMaintenanceRunsCompleted: number;
  mutatingToolCalls: number;
  mutatingToolCallsFailed: number;
  verifiedConcurrentCreateRetries: number;
  verifiedFrontierRetries: number;
  verifiedCollectionCreateRetries: number;
  malformedToolCallsFailed: number;
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
    observationsPerDay: observations.observationNotes / representsDays,
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
    observationsNoted: observations.observationNotes,
    runsCompleted: observations.runsCompleted,
    runsFailed: observations.runsFailed,
    dataRunsCompleted: observations.dataRunsCompleted,
    sourceMaintenanceRunsCompleted: observations.sourceMaintenanceRunsCompleted ?? 0,
    mutatingToolCalls: observations.mutatingToolCalls,
    mutatingToolCallsFailed: observations.mutatingToolCallsFailed,
    verifiedConcurrentCreateRetries: observations.verifiedConcurrentCreateRetries ?? 0,
    verifiedFrontierRetries: observations.verifiedFrontierRetries ?? 0,
    verifiedCollectionCreateRetries: observations.verifiedCollectionCreateRetries ?? 0,
    malformedToolCallsFailed:
      observations.mutatingToolCallsFailed -
      (observations.verifiedConcurrentCreateRetries ?? 0) -
      (observations.verifiedFrontierRetries ?? 0) -
      (observations.verifiedCollectionCreateRetries ?? 0),
    mutatingToolCallsUncorrected: observations.mutatingToolCallsUncorrected,
    scheduledRuns: observations.scheduledRuns,
    promptTokens: observations.promptTokens,
    completionTokens: observations.completionTokens,
  };
  return { metrics, counts };
}

// ── run artifacts ───────────────────────────────────────────────────────────

/**
 * Dump the run's observable end-state — loops, observations, queue runs, the
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
  await dump("/admin/brain/observations?limit=500", "observations.json");
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
  failedActions?: Array<{ tool: string; detail?: string }>;
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
function isPricedScorecard(backend: ScorecardBackendSpec): boolean {
  return backend.kind === "http";
}

export async function runScorecard(opts: {
  gatewayMode: "experimental";
  backend: ScorecardBackendSpec;
  seed: number;
  guard?: ScorecardRunGuard;
  /** When set, the observable end-state is dumped here before teardown. */
  artifactsDir?: string;
}): Promise<ScorecardRunResult> {
  if (isPricedScorecard(opts.backend)) {
    throw new Error(
      "Priced scorecard execution is unavailable: maintenance batches and continuation runs require actual-run budget reservation and usage settlement. The legacy per-document spend guard does not cover this scheduler. Use the scripted instrument lane.",
    );
  }
  prepareScorecardEnv();
  const set = generateArcSet(opts.seed);

  const scripted =
    opts.backend.kind === "scripted"
      ? await startScriptedLoopModelServer({
          behaviors: opts.backend.script === "saboteur" ? saboteurBehaviors(set) : set.behaviors,
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
        bootstrap: { enabled: false },
        knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
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
    await settleScorecardMaintenance(harness, db);
    await deliverArcSet(harness, db, set, opts.guard ? { guard: opts.guard } : {});
    const observations = await collectScorecardObservations(harness, db, set);
    if (opts.artifactsDir !== undefined) await dumpScorecardArtifacts(harness, opts.artifactsDir);
    const mix = computeDailyMix(set);
    const { metrics, counts } = computeScorecardMetrics(set, observations, mix.representsDays);
    if (
      observations.mutatingToolCallsFailed > (observations.verifiedConcurrentCreateRetries ?? 0) ||
      observations.dataRunsCompleted !== mix.expectedRuns
    ) {
      // Preserve fixture evidence before teardown: a post-write CAS refusal needs
      // the revision history as well as the final tool error to diagnose safely.
      const diagnostics = mkdtempSync(join(tmpdir(), "omnesis-scorecard-refusals-"));
      await db.backup(join(diagnostics, "snapshot.db"));
      await dumpScorecardArtifacts(harness, diagnostics);
      copyFileSync(harness.getGatewayLogPath(), join(diagnostics, "gateway.log"));
      createLogger("collector:briefs-scorecard").error(
        `Refusal diagnostics retained at ${diagnostics}`,
      );
    }
    return { seed: opts.seed, mix, metrics, counts, failedActions: observations.failedActions };
  } finally {
    db?.close();
    await harness.destroy();
    await scripted?.close();
  }
}
