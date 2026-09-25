// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { boundSyncIssues } from "@omnesis/core";
import type { WsEventPayload } from "@omnesis/core";
import type { StatusChangeEvent } from "./sync-engine-types.js";
import type { SourceFreshness } from "@omnesis/source-sdk";

const EVENT_STATE: Record<StatusChangeEvent["event"], WsEventPayload<"sync.status">["state"]> = {
  "sync.started": "syncing",
  "sync.progress": "syncing",
  "sync.deferred": "idle",
  "sync.aborted": "idle",
  "sync.completed": "completed",
  "sync.error": "error",
};

/**
 * The `sync.status` event the collector sends the gateway for one engine
 * status change. The engine fires `sync.error` for generic failures,
 * credential failures and rate-limit deferrals alike; the status's own state
 * is the discriminator, and it is surfaced so the gateway serves the right
 * pill instead of a generic red error. Everything the status knows that the
 * operator can act on — the message, its structured remedy, the freshness
 * claim — rides along verbatim.
 */
export function toSyncStatusPayload(change: StatusChangeEvent): WsEventPayload<"sync.status"> {
  let state = EVENT_STATE[change.event];
  if (change.event === "sync.error" && change.status.state === "needs-auth") {
    state = "needs-auth";
  } else if (change.event === "sync.error" && change.status.state === "rate-limited") {
    state = "rate-limited";
  }
  return {
    sourceId: change.sourceId,
    // The full `<providerType>:<accountId>` form, which renderers group
    // `needs-auth` rows by so one revoked grant shows one re-auth hint.
    providerId: change.status.providerId,
    state,
    progress: change.status.progress,
    coverage: change.status.coverage,
    coverageDetail: change.status.coverageDetail,
    errorMessage: change.status.lastError,
    remediation: change.status.remediation,
    // A successful but unassessed incremental tick is not evidence of recovery.
    issues:
      change.event === "sync.completed" && change.status.issues !== undefined
        ? boundSyncIssues(change.status.issues)
        : undefined,
    issueAssessments:
      change.event === "sync.completed" ? change.status.issueAssessments : undefined,
    unitName: change.status.unitName,
    startedAt: change.event === "sync.started" ? Date.now() : undefined,
    completedAt: change.event === "sync.completed" ? Date.now() : undefined,
    // The source's own freshness claim beside the collector's reading of it,
    // so the gateway can derive the `stale` warning without knowing which
    // sources read local files or what feeds them. Which of the source's two
    // hints goes is decided here, so the gateway sees one sentence and needs
    // to know nothing about launching.
    freshness: change.status.freshness
      ? {
          quietPeriodMs: change.status.freshness.quietPeriodMs,
          hint: freshnessHint(change.status.freshness, change.status.feedProcessLaunchFailing),
          processRunning: change.status.feedProcessRunning,
        }
      : undefined,
  };
}

/**
 * The ordinary hint, unless the collector has itself tried repeatedly to open
 * the feed program and it is still not running — then the sentence that sends
 * the operator to the app, when the source declared one.
 */
function freshnessHint(freshness: SourceFreshness, launchFailing: boolean | undefined): string {
  const failedHint = freshness.requiresProcess?.launch?.failedHint;
  return launchFailing && failedHint ? failedHint : freshness.hint;
}
