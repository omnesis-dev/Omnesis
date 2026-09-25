// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pauseActive } from "@omnesis/provider-web/capture-policy";
import { readCachedPolicy } from "../capture/policy.js";
import { hasExactWebScope, type ExtensionConfig } from "./storage.js";
import {
  CAPTURE_HANDOFF_FAILURE_KEY,
  CAPTURE_HANDOFF_OVERFLOW_KEY,
  isCaptureHandoffFailure,
  isCaptureHandoffOverflow,
  type CaptureHandoffFailure,
  type CaptureHandoffOverflow,
} from "./messages.js";
import type {
  PushClient,
  PushHealth,
  PushFailure,
  PushRetry,
  PushServerState,
  RecentDelivery,
  Connectivity,
  DurableStore,
  QueueCorruption,
  QueueOverflow,
} from "../push/index.js";

/**
 * The single composed view of "is the extension working?" — assembled once and
 * read by BOTH the popup (to render) and the service worker (to drive the
 * toolbar badge). Building it in one place means the badge and the popup can
 * never disagree.
 */
export interface CaptureStatus {
  paired: boolean;
  gatewayUrl: string | null;
  /** The gateway's product version as last read from its health check, or null. */
  gatewayVersion: string | null;
  /** This extension build's product version (from its manifest), or null when unknown. */
  extensionVersion: string | null;
  /** Epoch-ms the extension paired (for a "Paired since" line). */
  pairedAt: number | null;
  /** Whether the stored token carries the scope needed to push pages. */
  scopeOk: boolean;
  /** Whether Chrome currently allows the content script on HTTPS pages. */
  hostPermissionOk: boolean;
  queueDepth: number;
  health: PushHealth | null;
  failure: PushFailure | null;
  retry: PushRetry | null;
  queueCorruption: QueueCorruption | null;
  queueOverflow: QueueOverflow | null;
  handoffFailure: CaptureHandoffFailure | null;
  handoffOverflow: CaptureHandoffOverflow | null;
  serverState: PushServerState | null;
  connectivity: Connectivity | null;
  /** The shared capture pause as the browser's copy of the policy reports it. */
  pause: CapturePauseStatus;
  /**
   * Whether this browser holds a copy of the gateway's capture settings. Until
   * it does, nothing is captured: the settings are what say which pages may
   * leave the browser.
   */
  policyLoaded: boolean;
  /** Recent successful deliveries, newest first (proof-of-life). */
  recent: RecentDelivery[];
  /** Epoch-ms of the newest delivery, or null. */
  lastSyncAt: number | null;
  /**
   * Epoch-ms a proactive liveness probe last reached the gateway, or null. Unlike
   * {@link lastSyncAt} (when a capture last synced), this proves the token +
   * gateway were verified even when there was nothing to capture.
   */
  lastCheckedAt: number | null;
}

/** Resolved pause state for the popup and the badge. */
interface CapturePauseStatus {
  paused: boolean;
  /** The resume instant (epoch-ms), or `null` for an indefinite pause / when active. */
  until: number | null;
}

export interface ComposeStatusDeps {
  config: ExtensionConfig | null;
  /** A push client over the same store, or null when not paired. */
  client: PushClient | null;
  hostPermissionOk: boolean;
  store: DurableStore;
  now: number;
  /** This extension build's product version; the popup compares it with the gateway's. */
  extensionVersion?: string;
}

/** Assemble the full capture status from the durable state. */
export async function composeStatus(deps: ComposeStatusDeps): Promise<CaptureStatus> {
  const { config, client, hostPermissionOk, store, now } = deps;
  const extensionVersion = deps.extensionVersion ?? null;
  const cachedPolicy = await readCachedPolicy(store);
  const policyPause = cachedPolicy?.policy.pause ?? null;
  const pause: CapturePauseStatus = pauseActive(policyPause, now)
    ? { paused: true, until: policyPause?.until ?? null }
    : { paused: false, until: null };
  const policyLoaded = cachedPolicy !== null;
  if (!config || !client) {
    const paired = config !== null;
    return {
      paired,
      gatewayUrl: config?.gatewayUrl ?? null,
      gatewayVersion: config?.gatewayVersion ?? null,
      extensionVersion,
      pairedAt: config?.pairedAt ?? null,
      scopeOk: config ? hasExactWebScope(config) : false,
      hostPermissionOk,
      queueDepth: 0,
      health: null,
      failure: null,
      retry: null,
      queueCorruption: null,
      queueOverflow: null,
      handoffFailure: null,
      handoffOverflow: null,
      serverState: null,
      connectivity: null,
      pause,
      policyLoaded,
      recent: [],
      lastSyncAt: null,
      lastCheckedAt: null,
    };
  }
  // Status reads are deliberately non-mutating. Queue repair belongs to the
  // service worker's serialized queue lane, never to the popup.
  const queueDepth = await client.queueDepth();
  const [
    health,
    failure,
    retry,
    queueCorruption,
    queueOverflow,
    handoffRaw,
    handoffOverflowRaw,
    serverState,
    connectivity,
    deliveries,
    lastCheckedAt,
  ] = await Promise.all([
    client.getHealth(),
    client.getFailure(),
    client.getRetry(),
    client.getQueueCorruption(),
    client.getQueueOverflow(),
    store.get(CAPTURE_HANDOFF_FAILURE_KEY),
    store.get(CAPTURE_HANDOFF_OVERFLOW_KEY),
    client.getServerState(),
    client.getConnectivity(),
    client.getRecentDeliveries(),
    client.getLastCheckedAt(),
  ]);
  let handoffFailure: CaptureHandoffFailure | null;
  try {
    const parsed = handoffRaw ? (JSON.parse(handoffRaw) as unknown) : null;
    handoffFailure = isCaptureHandoffFailure(parsed) ? parsed : null;
  } catch {
    handoffFailure = null;
  }
  let handoffOverflow: CaptureHandoffOverflow | null;
  try {
    const parsed = handoffOverflowRaw ? (JSON.parse(handoffOverflowRaw) as unknown) : null;
    handoffOverflow = isCaptureHandoffOverflow(parsed) ? parsed : null;
  } catch {
    handoffOverflow = null;
  }
  // The popup promises recently synced pages, not the extension's separate
  // analytics delivery for the same visit.
  const recent = deliveries.filter((delivery) => delivery.kind === "document");
  return {
    paired: true,
    gatewayUrl: config.gatewayUrl,
    gatewayVersion: config.gatewayVersion ?? null,
    extensionVersion,
    pairedAt: config.pairedAt,
    scopeOk: hasExactWebScope(config),
    hostPermissionOk,
    queueDepth,
    health,
    failure,
    retry,
    queueCorruption,
    queueOverflow,
    handoffFailure,
    handoffOverflow,
    serverState,
    connectivity,
    pause,
    policyLoaded,
    recent,
    lastSyncAt: recent.length ? recent[0].at : null,
    lastCheckedAt,
  };
}

/** The toolbar-badge appearance for a status. */
export interface BadgeSpec {
  /** Badge text ("" = no badge). Kept ≤4 chars (Chrome truncates). */
  text: string;
  /** Background colour (hex). */
  color: string;
  /** The toolbar tooltip. */
  title: string;
}

// Badge colours — aligned with the popup's GitHub-dark palette (`ui.css`).
const RED = "#d73a4a";
const AMBER = "#d29922";
const GREY = "#6e7681";
const BLUE = "#1f6feb";
const GREEN = "#238636";

/**
 * Derive the always-on toolbar badge from the composed status, in a strict
 * priority order so the single most important condition shows:
 *
 *   error (pages rejected) > source paused/removed in Omnesis > user-paused >
 *   gateway offline > settings not yet loaded > pending count > clean.
 *
 * Pure — no `chrome.*` — so it's unit-tested directly.
 */
export function badgeFor(status: CaptureStatus): BadgeSpec {
  if (!status.paired) return { text: "", color: GREY, title: "Omnesis — not paired" };

  if (status.health && !status.health.ok) {
    return {
      text: "!",
      color: RED,
      title: `Omnesis — pages rejected by the gateway${
        status.health.reason ? `: ${status.health.reason}` : ""
      }. Re-pair to fix.`,
    };
  }
  if (!status.scopeOk) {
    return {
      text: "!",
      color: RED,
      title: "Omnesis — pairing scope is outdated or unexpected; re-pair to use write:web only",
    };
  }
  if (!status.hostPermissionOk) {
    return {
      text: "!",
      color: RED,
      title: "Omnesis — HTTPS page access is missing; open Pairing settings to grant it",
    };
  }
  if (status.handoffFailure) {
    return {
      text: "!",
      color: RED,
      title: "Omnesis — capture handoff delayed; retrying while the page remains open",
    };
  }
  if (status.serverState) {
    return {
      text: "!",
      color: AMBER,
      title:
        status.serverState.state === "paused"
          ? "Omnesis — collecting from this browser is paused in Omnesis"
          : "Omnesis — the Browser source was removed in Omnesis; re-pair to resume",
    };
  }
  if (status.retry) {
    return {
      text: "!",
      color: RED,
      title: `Omnesis — upload retained for retry: ${status.retry.reason}`,
    };
  }
  if (status.pause.paused) {
    return {
      text: "॥",
      color: AMBER,
      title: "Omnesis — capture paused",
    };
  }
  if (status.connectivity && !status.connectivity.reachable) {
    return {
      text: "·",
      color: GREY,
      title: `Omnesis — gateway unreachable${
        status.queueDepth ? `; ${status.queueDepth} queued` : ""
      }`,
    };
  }
  if (status.connectivity?.degraded) {
    return {
      text: "!",
      color: AMBER,
      title: `Omnesis — gateway check was inconclusive${
        status.connectivity.reason ? `: ${status.connectivity.reason}` : ""
      }`,
    };
  }
  if (!status.policyLoaded) {
    return {
      text: "!",
      color: AMBER,
      title: "Omnesis — waiting for the gateway's capture settings; nothing is captured yet",
    };
  }
  if (status.queueCorruption) {
    return {
      text: "!",
      color: AMBER,
      title: "Omnesis — damaged pending uploads were discarded; new captures continue",
    };
  }
  if (status.queueOverflow) {
    return {
      text: "!",
      color: AMBER,
      title: "Omnesis — local upload budget was reached; older pending data was discarded",
    };
  }
  if (status.handoffOverflow) {
    return {
      text: "!",
      color: AMBER,
      title:
        "Omnesis — the local capture handoff budget was reached; older staged pages were discarded",
    };
  }
  if (status.failure) {
    return {
      text: "!",
      color: AMBER,
      title: `Omnesis — an upload was discarded: ${status.failure.reason}`,
    };
  }
  if (status.queueDepth > 0) {
    return {
      text: status.queueDepth > 99 ? "99+" : String(status.queueDepth),
      color: BLUE,
      title: `Omnesis — ${status.queueDepth} upload${status.queueDepth === 1 ? "" : "s"} queued`,
    };
  }
  return { text: "", color: GREEN, title: "Omnesis — ready to capture" };
}
