// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { compareProductVersions, parseProductVersion } from "@omnesis/core/client-version";
import type { CaptureStatus } from "./status.js";

/**
 * A version-skew notice, or "" when the two versions are compatible or one is
 * unknown. HTTP changes within a minor are additive, so only a gateway on an
 * older minor (or a different major) than this extension is worth a warning.
 */
export function gatewayVersionNotice(
  gatewayVersion: string | null,
  extensionVersion: string | null,
): string {
  if (!gatewayVersion || !extensionVersion) return "";
  const gateway = parseProductVersion(gatewayVersion);
  const extension = parseProductVersion(extensionVersion);
  if (!gateway || !extension) return "";
  if (gateway.major !== extension.major) {
    return `This gateway (${gatewayVersion}) and this extension (${extensionVersion}) are on different major versions. Update the older one.`;
  }
  const order = compareProductVersions(
    `${gateway.major}.${gateway.minor}.0`,
    `${extension.major}.${extension.minor}.0`,
  );
  return order !== null && order < 0
    ? `This gateway (${gatewayVersion}) is behind this extension (${extensionVersion}). Update the gateway.`
    : "";
}

/** The single most important actionable warning, followed by historical loss notices. */
export function warningFor(status: CaptureStatus): string {
  // Every warning below describes something wrong with an existing pairing, and
  // a browser that has none is not faulty. Its state is carried by the summary
  // rather than by a warning.
  if (!status.paired) return "";
  if (status.health && !status.health.ok) {
    return `Pages are being rejected by the gateway: ${
      status.health.reason ?? "token lacks the required write scope"
    }. Re-pair this browser to refresh its token.`;
  }
  if (!status.scopeOk) {
    return "This browser's pairing has an outdated or unexpected scope instead of write:web only. Re-pair to fix.";
  }
  if (!status.hostPermissionOk) {
    return "Chrome is not allowing Omnesis to watch HTTPS pages. Open Pairing settings and grant HTTPS page access.";
  }
  if (status.handoffFailure) {
    return "Capture handoff is delayed. Omnesis is retrying; keep the page open.";
  }
  if (status.serverState) {
    return status.serverState.state === "paused"
      ? "Collecting from this browser is paused in Omnesis. Resume the Browser source there to continue."
      : "Omnesis stopped collecting from this browser — the Browser source was removed. Re-pair this browser to resume.";
  }
  if (status.retry) {
    const subject = status.retry.kind === "document" ? "page upload" : "visit-analytics upload";
    return `${subject[0].toUpperCase()}${subject.slice(1)} failed: ${status.retry.reason}. The upload is retained and will retry automatically.`;
  }
  if (status.connectivity && !status.connectivity.reachable) {
    return "Can't reach the gateway right now — captures are queued and will sync when it's back.";
  }
  if (status.connectivity?.degraded) {
    return `The gateway answered, but its health check was inconclusive${
      status.connectivity.reason ? ` (${status.connectivity.reason})` : ""
    }. Omnesis will check again automatically.`;
  }
  if (status.paired && !status.policyLoaded) {
    return "Capture settings have not been loaded from the gateway yet. Nothing is captured until they are; Omnesis keeps trying.";
  }
  if (status.queueCorruption) {
    const count = status.queueCorruption.discarded;
    return count === null
      ? "Stored pending uploads were damaged and had to be reset. New pages will continue syncing."
      : `${count} damaged pending upload${count === 1 ? " was" : "s were"} discarded. New pages will continue syncing.`;
  }
  if (status.queueOverflow) {
    const { discardedDocuments, discardedVisits } = status.queueOverflow;
    return `The local upload budget was reached. ${discardedDocuments} page upload${
      discardedDocuments === 1 ? " was" : "s were"
    } and ${discardedVisits} visit-analytics upload${
      discardedVisits === 1 ? " was" : "s were"
    } discarded; new captures continue.`;
  }
  if (status.handoffOverflow) {
    return `Durable tab-to-worker recovery was dropped for ${status.handoffOverflow.discarded} staged capture${status.handoffOverflow.discarded === 1 ? "" : "s"} after the local handoff budget was reached. Affected captures can still sync while their tabs remain open.`;
  }
  if (status.failure) {
    const subject = status.failure.kind === "document" ? "page upload" : "visit-analytics upload";
    return `${status.failure.count} ${subject}${status.failure.count === 1 ? " was" : "s were"} discarded: ${status.failure.reason}.`;
  }
  return gatewayVersionNotice(status.gatewayVersion, status.extensionVersion);
}

/** Historical loss notices do not mean current capture is still broken. */
export function hasActiveFailure(status: CaptureStatus): boolean {
  // Every condition below is a property of a pairing, so a browser without one
  // is not failing at any of them. Guarding once here rather than per clause
  // keeps the next condition added from having to remember it, and keeps this
  // answer consistent with `warningFor`.
  if (!status.paired) return false;
  return Boolean(
    (status.health && !status.health.ok) ||
    status.handoffFailure ||
    status.retry ||
    status.serverState ||
    !status.scopeOk ||
    !status.hostPermissionOk ||
    !status.policyLoaded ||
    (status.connectivity && (!status.connectivity.reachable || status.connectivity.degraded)),
  );
}
