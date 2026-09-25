// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tiny key-value state store for the Cognition Steward's background engines —
 * the daily rhythm's last-run day marker and the decay engine's
 * dirty-mark bookkeeping. One row per key in `cognition_engine_state`.
 *
 * The decay dirty-mark follows the shared `DirtyMarks` OCC pattern
 * (`data/DirtyMarks.ts`): every loop mutation bumps a monotonic
 * `decay_dirty_version`; the sweep records the version it last acted on
 * and does zero work while the two match. It lives here (not in
 * `refresh_meta`) so the whole mechanism stays inside the feature
 * module.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/** `YYYY-MM-DD` (local) of the last daily-rhythm boundary acted on. */
export const COGNITION_DAILY_LAST_RUN_DAY_KEY = "daily_last_run_day";

/** Local day (`YYYY-MM-DD`) the morning digest last fired for. */
export const COGNITION_DIGEST_LAST_RUN_DAY_KEY = "digest_last_run_day";
/** Monotonic counter bumped by every open-loop mutation. */
const COGNITION_DECAY_DIRTY_VERSION_KEY = "decay_dirty_version";
/** The dirty version the decay sweep last completed against. */
export const COGNITION_DECAY_SWEPT_VERSION_KEY = "decay_swept_version";
/** Epoch-ms of the last synthesis ("Noticing") pass fired. */
export const COGNITION_SYNTHESIS_LAST_RUN_KEY = "synthesis_last_run_at";
/** Epoch-ms of the last cross-loop collision sweep fired. */
export const COGNITION_COLLISION_LAST_RUN_KEY = "collision_last_run_at";
/** Epoch-ms of the last re-verification sweep pass fired. */
export const COGNITION_REVERIFICATION_LAST_RUN_KEY = "reverification_last_run_at";
/**
 * The provenance-recheck sweep's watermark: the highest prior
 * `invalidated_at` already processed. Initialized to "now" on the sweep's
 * FIRST enabled pass (priors that died while the knob was off are not
 * back-processed), then advanced as deaths are handled.
 */
export const COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY = "provenance_recheck_watermark";
/**
 * One-shot marker: the deprecated `brain.sweeps` config overrides have been
 * converted to sweep files. Marked so that deleting a converted file — the
 * "revert to system" action — is not undone on the next boot.
 */
export const COGNITION_SWEEP_CONFIG_MIGRATED_KEY = "sweep_config_migrated";
/**
 * Per-sweep marker (epoch-ms) holding the BOUNDARY a sweep last fired for —
 * not the moment the tick happened to enqueue it. Storing the boundary is what
 * keeps a cadence from drifting by one tick interval per period; see
 * `sweeps/anchor.ts`.
 */
export function cognitionSweepLastBoundaryKey(sweepId: string): string {
  return `sweep_last_boundary_at:${sweepId}`;
}

/**
 * The pre-anchor marker, which held the wall-clock fire time. Read once as a
 * seed when a sweep has no boundary marker yet, so an install upgrading
 * mid-cadence does not immediately re-fire every theme; never written.
 */
export function cognitionSweepLegacyLastRunKey(sweepId: string): string {
  return `sweep_last_run_at:${sweepId}`;
}
/**
 * Bootstrap lane lifecycle: `running` | `drained` | `parked`. `drained` is the
 * cheap hint that lets a quiet lane skip its candidate probe; neither quiet
 * state is terminal (see `rhythm/bootstrap-enqueuer.ts`).
 */
export const COGNITION_BOOTSTRAP_STATE_KEY = "bootstrap_state";
/** Local day (`YYYY-MM-DD`) the bootstrap lane last drained on. */
export const COGNITION_BOOTSTRAP_DRAINED_DAY_KEY = "bootstrap_drained_day";
/** The source-roster high-water mark at the moment the lane drained. */
export const COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY = "bootstrap_drained_sources";
/**
 * Epoch-ms the current boot-window hold began, or `0` when no hold is in
 * effect. Persisted so the hold is bounded by wall-clock rather than by
 * process lifetime — see `rhythm/bootstrap-enqueuer.ts`.
 */
export const COGNITION_BOOTSTRAP_HOLD_SINCE_KEY = "bootstrap_hold_since";
/** Per-day count of bootstrap runs enqueued (spend guard): `bootstrap_enqueued:<day>`. */
export function cognitionBootstrapEnqueuedKey(day: string): string {
  return `bootstrap_enqueued:${day}`;
}
/** Cumulative bootstrap runs ever enqueued — the durable total-budget guard. */
export const COGNITION_BOOTSTRAP_TOTAL_KEY = "bootstrap_total_enqueued";

/**
 * When the operator started the retrospective backfill, as epoch ms. Absent
 * means they never have.
 *
 * The lane buys nothing until this is set. Assigning a background-agent model
 * is a capability choice — which model does the Brain use — and reading it as
 * consent to spend for days working through history is a commitment the
 * operator never knowingly made. Starting is its own act.
 *
 * Kept here rather than as a `bootstrap.enabled` default of false, because
 * that key already means something different: whether the lane is paused. An
 * install that has been running for weeks and one that has never begun are not
 * the same state, and a surface that showed them identically would leave a
 * new operator watching a lane that was never going to move.
 */
export const COGNITION_BOOTSTRAP_STARTED_AT_KEY = "bootstrap_started_at";

export function getCognitionEngineState(db: Db, key: string): string | null {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM cognition_engine_state WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setCognitionEngineState(db: Db, key: string, value: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO cognition_engine_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Add to a numeric engine-state counter, in SQL.
 *
 * The counters here are advanced from a value read earlier in the same pass —
 * read, enqueue, mark, write back an absolute total — with `await`s in
 * between. `setCognitionEngineState` then writes last-writer-wins, so any
 * increment computed from a stale read silently replaces a newer one, and a
 * crash or restart between the read and the write drops it entirely. The loss
 * is permanent: nothing recomputes a lifetime counter.
 *
 * Measured on a live install, `bootstrap_total_enqueued` had drifted 226 below
 * the number of bootstrap runs still on the ledger — and the ledger is pruned,
 * so the true shortfall is larger. That counter is the lane's lifetime
 * backstop, so drifting low means the backstop fires later than the operator
 * asked.
 *
 * Doing the arithmetic in the UPDATE removes the window: the read and the
 * write are one statement. The bound delta is explicitly cast because the
 * SQLite driver binds JavaScript numbers as REAL; integer arithmetic keeps
 * the persisted TEXT canonical (`"12"`, never `"12.0"`).
 */
export function addToCognitionEngineCounter(db: Db, key: string, delta: number): void {
  db.prepare<[string, string, number]>(
    `INSERT INTO cognition_engine_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE
       SET value = CAST(
         CAST(cognition_engine_state.value AS INTEGER) + CAST(? AS INTEGER)
         AS TEXT
       )`,
  ).run(key, String(delta), delta);
}

/**
 * Bump the decay dirty-mark. Called from every open-loop mutation path
 * (create / update / ledger append / delete / privacy cascade) so the
 * decay sweep knows loop state changed since it last ran.
 */
export function bumpCognitionDecayDirty(db: Db): void {
  db.prepare<[string]>(
    `INSERT INTO cognition_engine_state (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run(COGNITION_DECAY_DIRTY_VERSION_KEY);
}

/** Current decay dirty version (0 when never bumped). */
export function readCognitionDecayDirtyVersion(db: Db): number {
  const raw = getCognitionEngineState(db, COGNITION_DECAY_DIRTY_VERSION_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The dirty version the decay sweep last completed against (0 = never swept). */
export function readCognitionDecaySweptVersion(db: Db): number {
  const raw = getCognitionEngineState(db, COGNITION_DECAY_SWEPT_VERSION_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}
