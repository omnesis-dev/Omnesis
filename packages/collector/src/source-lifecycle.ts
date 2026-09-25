// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Logger } from "@omnesis/core";
import type { SyncIssue, SyncIssueAssessment, SyncRemediation } from "@omnesis/types";
import type {
  SourceFreshness,
  SourceIcon,
  SyncProgress,
  HistoryCoverage,
} from "@omnesis/source-sdk";

/**
 * Persisted status of a single registered source. State transitions are
 * handled via {@link SourceLifecycle} so the side-effect set (clear
 * progress, reset error, etc.) stays in one place.
 */
export interface SourceStatus {
  sourceId: string;
  providerId: string;
  sourceName: string;
  icon?: SourceIcon;
  unitName?: string;
  /**
   * `needs-auth` is a distinct sub-state of "stuck" reserved for
   * credential failures (OAuth token revoked, refresh-token expired,
   * source added without credentials). UIs render it with a remediation
   * hint instead of a generic red error pill — see
   * `NEEDS_AUTH_ERROR_PREFIX` on the gateway side.
   *
   * `rate-limited` is a "deferred, will-self-heal" sub-state — distinct
   * from `error` (a stuck/failure signal). A provider threw a typed
   * rate-limit `SyncError` carrying `retryAfterMs` (Coinbase's 60s through
   * Enable Banking's 6h ASPSP back-off); the engine parks the source here and
   * the scheduler defers its next tick until the deadline elapses rather than
   * retry-storming. The retry deadline is on `retryAfterMs`.
   */
  state: "idle" | "syncing" | "error" | "disabled" | "needs-auth" | "rate-limited";
  syncIntervalMs?: number;
  fileWatchActive?: boolean;
  lastSyncAt?: string;
  lastError?: string;
  /**
   * What the operator has to do before `lastError` can clear, when the source
   * raised its failure with one. Set only by `toError`, and dropped by every
   * transition that drops or replaces `lastError`, so it never outlives the
   * message it explains.
   */
  remediation?: SyncRemediation;
  /**
   * Retry hint in ms from the moment the source entered `rate-limited`.
   * Set only by `toRateLimited`; cleared on the next successful transition
   * out of the state. Surfaced so renderers can show "retrying in ~6h".
   */
  retryAfterMs?: number;
  /**
   * How much of its upstream history this source holds, as it last claimed.
   *
   * Deliberately not on `progress`. Progress is the in-flight meter and every
   * terminal transition clears it, so a claim carried there is visible only
   * while the source is mid-sync and gone at the moment it becomes true. This
   * is a statement about the corpus rather than about the run, so it outlives
   * the run and is replaced only when the source says something different.
   *
   * `"unknown"` is a real answer, and distinct from absent: a source that has
   * not established whether it is missing history has not said it is whole.
   */
  coverage?: HistoryCoverage;
  /**
   * What the last completed run cost that it survived.
   *
   * Beside the run stats rather than on `lastError`: that column is for the
   * failure that stopped a run, and a source reporting issues has not stopped.
   * Undefined means the run did not assess issues and durable warnings remain.
   * An explicit array replaces prior warnings after completion; [] confirms
   * recovery. A successful incremental tick need not assess enumeration.
   */
  issues?: SyncIssue[];
  /** When present, only these exact diagnostic keys were assessed this run. */
  issueAssessments?: SyncIssueAssessment[];
  /**
   * The source's own wording for that claim, when it gave one. Durable for the
   * same reason: the generic phrase is a fallback, not a replacement.
   */
  coverageDetail?: string;
  /**
   * What this source declared about how long it may plausibly stay quiet, copied
   * from its instance at registration. Absent for the majority of sources, which
   * make no such claim. See `SourceFreshness`.
   */
  freshness?: SourceFreshness;
  /**
   * Whether the process named by `freshness.requiresProcess` was running at the
   * last completed sync. `undefined` means the question doesn't apply (no
   * process declared) or couldn't be answered — never treat it as "not
   * running", or an un-probeable host manufactures a false staleness warning.
   */
  feedProcessRunning?: boolean;
  /**
   * Whether the collector has repeatedly opened that process itself without
   * it staying up (see `FeedProcessSupervisor`). Only ever true beside
   * `feedProcessRunning === false`; it selects the launch-failure hint over the
   * ordinary one when the status is reported.
   */
  feedProcessLaunchFailing?: boolean;
  progress?: SyncProgress;
  /** Stats from last completed sync */
  lastSyncStats?: {
    documents: number;
    deleted: number;
    pages: number;
    durationMs: number;
  };
}

export type SourceState = SourceStatus["state"];

/**
 * Emit a uniform transition log line. Captured before the state mutation
 * so the `from` state reflects what we actually came from.
 */
function logTransition(log: Logger, status: SourceStatus, to: SourceState, detail?: string): void {
  if (status.state === to) return; // no-op transitions stay quiet
  const tail = detail ? ` (${detail})` : "";
  log.info(`Source ${status.sourceId} state: ${status.state} → ${to}${tail}`);
}

/**
 * State-transition helpers for SourceStatus. Each method mutates the
 * passed status in place AND emits a single info-level log line via the
 * supplied logger so transitions across `SourceLifecycle.toX`,
 * `markNeedsAuth`, `enableSource`, and `disableSource` are uniformly
 * traceable in collector logs. Behaviour otherwise
 * mirrors the prior literal `status.state = "..."` assignments — same end
 * states, same cleared fields. The `log` argument is optional so existing
 * call-sites that already log themselves can opt out.
 */
export const SourceLifecycle = {
  /** Move to `syncing` — clears progress + lastError + retry hint. */
  toSyncing(status: SourceStatus, log?: Logger): void {
    if (log) logTransition(log, status, "syncing");
    status.state = "syncing";
    status.progress = undefined;
    status.lastError = undefined;
    status.remediation = undefined;
    status.retryAfterMs = undefined;
  },

  /** Move to `idle` — clears progress + retry hint. */
  toIdle(status: SourceStatus, log?: Logger): void {
    if (log) logTransition(log, status, "idle");
    status.state = "idle";
    status.progress = undefined;
    status.remediation = undefined;
    status.retryAfterMs = undefined;
  },

  /**
   * Move to `error` with a message — clears progress + retry hint. A
   * `remediation` is what the operator has to do before the failure can clear,
   * carried beside the message for the clients that render it as an affordance.
   */
  toError(
    status: SourceStatus,
    message: string,
    log?: Logger,
    remediation?: SyncRemediation,
  ): void {
    if (log) logTransition(log, status, "error", message);
    status.state = "error";
    status.lastError = message;
    status.remediation = remediation;
    status.progress = undefined;
    status.retryAfterMs = undefined;
  },

  /** Move to `needs-auth` with a remediation hint — clears progress + retry hint. */
  toNeedsAuth(status: SourceStatus, hint: string, log?: Logger): void {
    if (log) logTransition(log, status, "needs-auth", hint);
    status.state = "needs-auth";
    status.lastError = hint;
    status.remediation = undefined;
    status.progress = undefined;
    status.retryAfterMs = undefined;
  },

  /**
   * Move to `rate-limited` — the provider asked us to back off for
   * `retryAfterMs`. Unlike `error` / `needs-auth`, this is NOT a failure:
   * the data and cursor are fine, the upstream is just temporarily
   * unavailable. We therefore **preserve** `progress` (a rate-limit can hit
   * mid-bootstrap; clearing the bar would make a healthy source look like it
   * reset). The `hint` becomes `lastError` so the same persist-on-error path
   * surfaces it to the operator; `retryAfterMs` records the back-off so the
   * scheduler can defer the next tick and renderers can show the deadline.
   */
  toRateLimited(status: SourceStatus, hint: string, retryAfterMs: number, log?: Logger): void {
    if (log) logTransition(log, status, "rate-limited", hint);
    status.state = "rate-limited";
    status.lastError = hint;
    status.remediation = undefined;
    status.retryAfterMs = retryAfterMs;
  },

  /**
   * Move to `disabled`. Clears progress + watch flag +
   * sync-interval display so the UI shows a clean disabled card.
   */
  toDisabled(status: SourceStatus, log?: Logger): void {
    if (log) logTransition(log, status, "disabled");
    status.state = "disabled";
    status.fileWatchActive = false;
    status.syncIntervalMs = undefined;
    status.progress = undefined;
    status.remediation = undefined;
    status.retryAfterMs = undefined;
  },

  /**
   * Re-enable a `disabled` or `needs-auth` source — flip back to idle
   * and clear stale errors. Used by re-register flows where new
   * credentials are now in place. No-op if already in some other state.
   */
  reactivateFromStuck(status: SourceStatus, log?: Logger): void {
    if (status.state !== "disabled" && status.state !== "needs-auth") return;
    if (log) logTransition(log, status, "idle", "reactivated");
    status.state = "idle";
    status.lastError = undefined;
    status.remediation = undefined;
  },
};
