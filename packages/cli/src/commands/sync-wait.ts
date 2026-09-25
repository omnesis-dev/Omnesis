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
 * The guard: a terminal state is only accepted once we have first observed a
 * transition INTO `syncing` for that source. Until then, terminal snapshots
 * are treated as "still the old result, keep waiting". This makes the wait
 * observe a real sync cycle rather than rubber-stamping the previous one.
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
}

/** A single source's status as read from `/admin/sync/status`. */
export interface SyncStatusObservation {
  sourceId: string;
  state: WaitObservedState;
  errorMessage?: string;
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
export function initWaitStates(sourceIds: readonly string[]): Map<string, SourceWaitState> {
  const states = new Map<string, SourceWaitState>();
  for (const sourceId of sourceIds) {
    states.set(sourceId, { sourceId, observedSyncing: false });
  }
  return states;
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

    // Terminal states only count once we've seen the source actually start.
    // Before that, a terminal snapshot is the PRIOR cycle's result.
    if (!st.observedSyncing) continue;

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
}

export interface WaitOptions {
  sourceIds: readonly string[];
  timeoutMs: number;
  pollIntervalMs: number;
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
  const states = initWaitStates(opts.sourceIds);
  const deadline = deps.now() + opts.timeoutMs;

  // Poll immediately, then on each interval, until resolved or past deadline.
  for (;;) {
    const observations = await deps.fetchStatus();
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
