// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure poll state machine backing `omnesis sources sync --wait`.
 *
 * Splitting the decision logic out of the CLI command keeps it deterministic
 * and unit-testable: feed it a sequence of observed `/admin/sync/status`
 * snapshots plus an injected clock, and it yields exactly when each source
 * reached a terminal state, what that state means, and — crucially — whether
 * the wait is allowed to accept that terminal state yet.
 *
 * ## Race guard (why this is not just "poll until not-syncing")
 *
 * Triggering a sync is asynchronous: the gateway forwards the trigger to the
 * collector over the device WS, the collector picks it up on its own loop,
 * and only *then* does the source flip to `syncing`. In the window between
 * "we POSTed the trigger" and "the collector started", `/admin/sync/status`
 * still reports the source's PRIOR terminal state (`synced`, `idle`, or an
 * old `error`). A naive "wait until terminal" would accept that stale prior
 * result immediately and report success for a sync that never actually ran.
 *
 * The guard: a terminal state is accepted once we have observed a transition
 * INTO `syncing` for that source, or once the gateway records a run that
 * finished after the trigger: a `lastSyncAt` (every completed page commits
 * the cursor and stamps it) or an `erroredAt` that moved past the baseline
 * read before the trigger. Until then, terminal snapshots are treated as
 * "still the old result, keep waiting".
 *
 * The second arm matters because a poll can miss `syncing` entirely: a small
 * sync finishes between two polls, and a source that was already syncing when
 * the trigger arrived (the collector skips it, and the run in flight is the
 * one to wait for) may finish before the first poll. Both baselines are the
 * gateway's own timestamps, compared with each other, so no clock skew
 * between this host and the gateway's can mistake an old run for a new one.
 */

/**
 * The display states served by `/admin/sync/status`. Mirrors
 * `DisplaySyncState` in `packages/gateway/src/sync-status.ts` — kept as a
 * local literal union (not imported) because the CLI must not depend on the
 * gateway package. Nothing enforces the mirror, so a state added there has
 * to be added here by hand.
 */
export type WaitObservedState =
  | "idle"
  | "syncing"
  | "synced"
  | "error"
  | "paused"
  | "needs-auth"
  | "rate-limited"
  | "permission-degraded"
  | "background-access-missing"
  | "unavailable"
  | "auth-expiring"
  | "stale";

/** Outcome classification once a source's wait resolves. */
export type WaitOutcome =
  | "success" // synced after an observed sync cycle
  | "error" // generic sync failure
  | "needs-auth" // credential failure — terminal, not success
  | "rate-limited" // provider back-off — terminal, not success
  | "permission-degraded" // source completed with reduced permission scope
  | "background-access-missing" // foreground access works but background collection does not
  | "unavailable" // required platform capability is unavailable
  | "paused" // source paused mid-wait — terminal, not success
  | "timeout"; // never reached a terminal state in the budget

/** Per-source state carried across polls. */
export interface SourceWaitState {
  readonly sourceId: string;
  /** True once a `syncing` snapshot has been observed (arms the race guard). */
  observedSyncing: boolean;
  /** Set once the wait resolves; undefined while still pending. */
  outcome?: WaitOutcome;
  /** The last observed state, for diagnostics on timeout. */
  lastObserved?: WaitObservedState;
  /** Error/diagnostic message captured from the terminal snapshot, if any. */
  message?: string;
  /** The gateway's `lastSyncAt` before the trigger; a later one is a run that finished since. */
  baselineSyncAt?: string | null;
  /** The gateway's `erroredAt` before the trigger; a later one is a run that failed since. */
  baselineErroredAt?: string | null;
}

/** A single source's status as read from `/admin/sync/status`. */
export interface SyncStatusObservation {
  sourceId: string;
  state: WaitObservedState;
  errorMessage?: string;
  /** ISO time of the last successful cursor save, as `/admin/sync/status` serves it. */
  lastSyncAt?: string | null;
  /** ISO time of the last error, present with an error state. */
  erroredAt?: string;
}

/** Whether `next` is a gateway timestamp later than `baseline` (absent baseline: any). */
function movedPast(next: string | null | undefined, baseline: string | null | undefined): boolean {
  if (!next) return false;
  if (!baseline) return true;
  const a = Date.parse(next);
  const b = Date.parse(baseline);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : next !== baseline;
}

/** Terminal-not-success states still END the wait — they just aren't success. */
const TERMINAL_NON_SUCCESS: Record<string, WaitOutcome> = {
  error: "error",
  "needs-auth": "needs-auth",
  "rate-limited": "rate-limited",
  "permission-degraded": "permission-degraded",
  "background-access-missing": "background-access-missing",
  unavailable: "unavailable",
  paused: "paused",
};

/**
 * States the gateway derives as advisory overlays on a source that synced
 * perfectly well: `auth-expiring` (credentials lapse on a known future date)
 * and `stale` (the local feed has stopped delivering new data). Neither is a
 * sync failure — the cycle we are waiting on completed — so both resolve the
 * wait as success. They are listed explicitly because `deriveDisplayStatus`
 * returns them *instead of* `synced`, and a wait that only recognised `synced`
 * would spin until its timeout on a source that is working fine.
 */
const SUCCESS_STATES: ReadonlySet<string> = new Set(["synced", "auth-expiring", "stale"]);

/** Initialise per-source wait state for the sources we triggered. */
export function initWaitStates(
  sourceIds: readonly string[],
  baseline: readonly SyncStatusObservation[] = [],
): Map<string, SourceWaitState> {
  const before = new Map(baseline.map((o) => [o.sourceId, o]));
  const states = new Map<string, SourceWaitState>();
  for (const sourceId of sourceIds) {
    const prior = before.get(sourceId);
    states.set(sourceId, {
      sourceId,
      observedSyncing: false,
      ...(prior
        ? { baselineSyncAt: prior.lastSyncAt ?? null, baselineErroredAt: prior.erroredAt ?? null }
        : {}),
    });
  }
  return states;
}

/**
 * Whether this snapshot is a run that finished after the trigger, judged by
 * the gateway's own timestamps against the baseline. Only a source with a
 * baseline can be judged this way; without one the observed `syncing` is
 * the only evidence.
 */
function finishedSinceBaseline(st: SourceWaitState, obs: SyncStatusObservation): boolean {
  if (st.baselineSyncAt === undefined) return false;
  if (SUCCESS_STATES.has(obs.state)) return movedPast(obs.lastSyncAt, st.baselineSyncAt);
  if (obs.state in TERMINAL_NON_SUCCESS) return movedPast(obs.erroredAt, st.baselineErroredAt);
  return false;
}

/**
 * Fold one poll's worth of observations into the wait state. Mutates and
 * returns `states`. A source absent from `observations` keeps its current
 * state (the status registry can momentarily drop a row); the race guard
 * still protects against accepting a stale terminal.
 */
export function applyObservations(
  states: Map<string, SourceWaitState>,
  observations: readonly SyncStatusObservation[],
): Map<string, SourceWaitState> {
  const byId = new Map(observations.map((o) => [o.sourceId, o]));
  for (const st of states.values()) {
    if (st.outcome) continue; // already resolved
    const obs = byId.get(st.sourceId);
    if (!obs) continue; // not reported this poll — keep waiting
    st.lastObserved = obs.state;

    if (obs.state === "syncing") {
      st.observedSyncing = true;
      continue;
    }

    // Terminal states only count once we've seen the source actually start,
    // or once the gateway stamps a run that finished after the trigger.
    // Before that, a terminal snapshot is the PRIOR cycle's result.
    if (!st.observedSyncing && !finishedSinceBaseline(st, obs)) continue;

    if (SUCCESS_STATES.has(obs.state)) {
      st.outcome = "success";
    } else if (obs.state in TERMINAL_NON_SUCCESS) {
      st.outcome = TERMINAL_NON_SUCCESS[obs.state];
      st.message = obs.errorMessage;
    }
    // `idle` after syncing is treated as still-settling — keep waiting.
  }
  return states;
}

/** True once every source has resolved to an outcome. */
export function allResolved(states: Map<string, SourceWaitState>): boolean {
  for (const st of states.values()) if (!st.outcome) return false;
  return true;
}

/** Mark every still-pending source as a timeout. Returns the timed-out ids. */
export function markTimedOut(states: Map<string, SourceWaitState>): string[] {
  const timedOut: string[] = [];
  for (const st of states.values()) {
    if (!st.outcome) {
      st.outcome = "timeout";
      timedOut.push(st.sourceId);
    }
  }
  return timedOut;
}

/** A wait is overall successful only if EVERY source ended in `success`. */
export function isOverallSuccess(states: Map<string, SourceWaitState>): boolean {
  for (const st of states.values()) if (st.outcome !== "success") return false;
  return true;
}

export interface WaitDeps {
  /** Fetch the current per-source status for the sources being waited on. */
  fetchStatus: () => Promise<SyncStatusObservation[]>;
  /** Injected clock — returns epoch millis. */
  now: () => number;
  /** Injected sleep — resolves after `ms` (real timer in prod, fake in tests). */
  sleep: (ms: number) => Promise<void>;
  /**
   * Whether a failed fetch is a passing connection fault (a refused or timed
   * out connect) worth another poll. Absent, every failure ends the wait.
   */
  isTransient?: (err: unknown) => boolean;
}

/**
 * How many polls in a row may fail on a connection fault before the wait gives
 * up. A gateway busy indexing the sync it is waiting on can miss one connect;
 * one that stays unreachable for this many polls is reported as down.
 */
export const MAX_CONSECUTIVE_FETCH_FAILURES = 5;

export interface WaitOptions {
  sourceIds: readonly string[];
  timeoutMs: number;
  pollIntervalMs: number;
  /** The sources' status read before the trigger, for the finished-since-baseline arm. */
  baseline?: readonly SyncStatusObservation[];
}

/**
 * Drive the poll loop to completion. Resolves when every source reaches a
 * terminal state or the timeout elapses (whichever first). Never throws on a
 * non-success outcome — the caller inspects the returned states and decides
 * the process exit code, so it can print a per-source breakdown first.
 */
export async function waitForSyncCompletion(
  opts: WaitOptions,
  deps: WaitDeps,
): Promise<Map<string, SourceWaitState>> {
  const states = initWaitStates(opts.sourceIds, opts.baseline);
  const deadline = deps.now() + opts.timeoutMs;

  // Poll immediately, then on each interval, until resolved or past deadline.
  let failures = 0;
  for (;;) {
    let observations: SyncStatusObservation[] = [];
    try {
      observations = await deps.fetchStatus();
      failures = 0;
    } catch (err) {
      failures++;
      if (!deps.isTransient?.(err) || failures >= MAX_CONSECUTIVE_FETCH_FAILURES) throw err;
    }
    applyObservations(states, observations);
    if (allResolved(states)) return states;
    if (deps.now() >= deadline) {
      markTimedOut(states);
      return states;
    }
    await deps.sleep(opts.pollIntervalMs);
    // Guard against a sleep that overshoots the deadline.
    if (deps.now() >= deadline && !allResolved(states)) {
      markTimedOut(states);
      return states;
    }
  }
}
