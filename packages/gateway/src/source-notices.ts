// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  aggregateDrivingMobilePermissionCapability,
  type MobilePermissionState,
} from "@omnesis/types/mobile-permission-health";
import type { SourceNotice, SyncIssueStatus, SyncRemediation } from "@omnesis/types";
import type { DisplaySyncStatus } from "./sync-status.js";

/**
 * What one device's replica keeps alive against a sibling's deletion: how many
 * items, and the names of the devices that reported them gone.
 */
export interface ReplicaDisputeContext {
  count: number;
  deletedBy: string[];
}

export interface SourceNoticeContext {
  /** Present only on a member of a replicated source that holds disputed items. */
  dispute?: ReplicaDisputeContext;
}

/**
 * The person-facing notices for one status — a member's own, or a
 * single-device source's — most severe first.
 *
 * Every client renders these verbatim, so this is the one place the wording
 * for a failing, degraded or caveated source lives. It reads only fields the
 * status already carries; a field that says nothing produces nothing. Nothing
 * here names a particular source: a source's own words arrive through the
 * fields it reports (`coverageDetail`, an issue's message, a remediation).
 */
export function buildSourceNotices(
  status: DisplaySyncStatus,
  context: SourceNoticeContext = {},
): SourceNotice[] {
  const notices: SourceNotice[] = [];
  const failure = failureNotice(status);
  if (failure) notices.push(failure);
  const permission = permissionNotice(status);
  if (permission) notices.push(permission);
  if (status.state === "stale") {
    notices.push({
      kind: "stale",
      severity: "warning",
      title: "No new data is arriving",
      detail:
        status.staleHint ??
        "The program this source reads from has stopped recording, so nothing new reaches it.",
    });
  }
  if (status.state === "auth-expiring") {
    const when = formatDay(status.consentExpiresAt);
    notices.push({
      kind: "auth-expiring",
      severity: "warning",
      title: when ? `Connection expires on ${when}` : "Connection expires soon",
      detail: "The source keeps syncing until then. Reconnecting before that date avoids a gap.",
      steps: ["Reconnect the account before then."],
    });
  }
  for (const issue of status.issues ?? []) notices.push(issueNotice(issue));
  if (context.dispute && context.dispute.count > 0) {
    notices.push(disputeNotice(context.dispute, status.unitName));
  }
  const coverage = coverageNotice(status);
  if (coverage) notices.push(coverage);
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return notices.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** A remedy's steps, with the two facts it carries beside them spelled out. */
function remediationSteps(remediation: SyncRemediation): string[] {
  const steps = [...remediation.steps];
  if (remediation.executable) {
    steps.push(`The program running the collector is ${remediation.executable}.`);
  }
  if (remediation.restartRequired) steps.push("Then restart the collector.");
  return steps;
}

function failureNotice(status: DisplaySyncStatus): SourceNotice | null {
  const message = status.errorMessage;
  const since = status.erroredAt;
  if (status.state === "needs-auth") {
    // The collector's own hint is written for a terminal; the step here is
    // the same action in words every client can show.
    return {
      kind: "needs-auth",
      severity: "error",
      title: "Needs sign-in",
      detail:
        "The account's sign-in has lapsed or was revoked, so nothing syncs until it is renewed.",
      steps: [
        status.providerId
          ? `Reconnect the account — in the portal, or with: omnesis sources reauth ${status.providerId}`
          : "Reconnect the account.",
      ],
      ...(since ? { since } : {}),
    };
  }
  if (status.state === "rate-limited") {
    // The provider's retry window is relative to when it was reported and
    // would go stale on screen, so it is left to `since`.
    return {
      kind: "rate-limited",
      severity: "info",
      title: "Paused by the provider's rate limit",
      detail: "Syncing resumes on its own once the provider allows it. Nothing needs doing.",
      ...(since ? { since } : {}),
    };
  }
  if (status.state === "error") {
    const remediation = status.remediation;
    if (remediation) {
      return {
        kind: "error",
        severity: "error",
        title: remediation.summary,
        ...(message ? { detail: message } : {}),
        steps: remediationSteps(remediation),
        ...(since ? { since } : {}),
      };
    }
    return {
      kind: "error",
      severity: "error",
      title: "The last sync failed",
      ...(message ? { detail: message } : {}),
      steps: ["It is retried on the next sync."],
      ...(since ? { since } : {}),
    };
  }
  return null;
}

const PERMISSION_TITLES: Record<
  Extract<
    MobilePermissionState,
    "permission-degraded" | "background-access-missing" | "unavailable"
  >,
  string
> = {
  "permission-degraded": "A permission this source needs is limited",
  "background-access-missing": "Background access is off",
  unavailable: "Not available on this device",
};

/** A phone's permission report, when it is what keeps the source from syncing fully. */
function permissionNotice(status: DisplaySyncStatus): SourceNotice | null {
  const health = status.permissionHealth;
  const state = status.state;
  if (
    !health ||
    (state !== "permission-degraded" &&
      state !== "background-access-missing" &&
      state !== "unavailable")
  ) {
    return null;
  }
  const capability = aggregateDrivingMobilePermissionCapability(health.capabilities);
  const detail = capability
    ? [capability.label, capability.impact].filter(Boolean).join(": ")
    : undefined;
  return {
    kind: "permission",
    severity: state === "unavailable" ? "error" : "warning",
    title: PERMISSION_TITLES[state],
    ...(detail ? { detail: sentence(detail) } : {}),
    ...(capability?.remediation ? { steps: [sentence(capability.remediation)] } : {}),
    since: new Date(health.checkedAt).toISOString(),
  };
}

function issueNotice(issue: SyncIssueStatus): SourceNotice {
  return {
    kind: "sync-issue",
    severity: "warning",
    title: issue.message,
    ...(issue.remediation?.summary ? { detail: issue.remediation.summary } : {}),
    ...(issue.remediation ? { steps: remediationSteps(issue.remediation) } : {}),
    since: new Date(issue.since).toISOString(),
  };
}

function disputeNotice(dispute: ReplicaDisputeContext, unitName: string | undefined): SourceNotice {
  // A source's unit name is already plural ("messages", "notes").
  const noun = dispute.count === 1 ? "item" : (unitName ?? "items");
  const others = dispute.deletedBy.length > 0 ? joinNames(dispute.deletedBy) : "another device";
  const verb = dispute.deletedBy.length > 1 ? "have" : "has";
  return {
    kind: "replica-dispute",
    severity: "info",
    title: `Keeping ${dispute.count} ${noun} that ${others} no longer ${verb}`,
    detail:
      `This device still has them; ${others} reported them gone. Omnesis keeps anything at ` +
      "least one device still has, and removes it only once every device agrees, so nothing " +
      "is lost. Devices that keep history for different lengths of time can disagree for good, " +
      "which is harmless.",
    steps: ["To clear this, delete the same items on this device too."],
  };
}

function coverageNotice(status: DisplaySyncStatus): SourceNotice | null {
  const reason = status.coverageDetail;
  // The source's own reason carries the substance: whether older history was
  // never reachable, or the app it reads keeps only so much and this source
  // follows it, is the source's to say.
  if (status.coverage === "partial") {
    return {
      kind: "coverage-partial",
      severity: "info",
      title: "Some history is not here",
      ...(reason ? { detail: sentence(reason) } : {}),
    };
  }
  if (status.coverage === "unknown") {
    return {
      kind: "coverage-unknown",
      severity: "info",
      title: "Older history may be incomplete",
      detail: `${reason ? `${sentence(reason)} ` : ""}Nothing needs doing.`,
    };
  }
  return null;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function formatDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
