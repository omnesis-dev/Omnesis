// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  MAX_CAPTURE_TITLE_CHARS,
  MAX_CAPTURE_URL_CHARS,
  type CaptureEmission,
} from "../capture/lifecycle.js";
import type { CaptureRefusal, WebCapturePolicy } from "@omnesis/provider-web/capture-policy";

/**
 * Messages exchanged between the content script and the service worker.
 *
 * The service worker is the single owner of the persistent queue and the push
 * client (MV3 SWs are ephemeral but the queue's durable store is not), so the
 * content script never touches the queue directly: it runs the capture state
 * machine and posts each confirmed {@link CaptureEmission} to the SW, which
 * turns it into `enqueueDocument` / `enqueueVisit` calls.
 *
 * The content script also asks the SW whether the capture policy allows its
 * page (the SW holds the gateway's policy) rather than reading the policy
 * itself — keeping all network in one place and avoiding N content scripts
 * each polling the gateway.
 */

export type ContentToSwMessage =
  | { type: "capture"; emission: CaptureEmission; handoffKey?: string; pairingId?: string }
  | { type: "capture-eligibility"; url: string };

/** Why a page may not be captured, beyond the policy's own refusals. */
export type CaptureIneligibility = CaptureRefusal | "no-policy" | "unpaired";

export interface CaptureEligibilityResponse {
  eligible: boolean;
  reason?: CaptureIneligibility;
  /** The policy's built-in rule the content script applies itself, since only it sees the DOM. */
  skipPasswordForms: boolean;
}

/** Acknowledgement returned once a confirmed capture is durably queued. */
export type CaptureAck =
  | { ok: true; accepted: boolean }
  | { ok: false; reason: "queue-unavailable" };

/** Privacy-safe record written when a page cannot hand off to the worker. */
export interface CaptureHandoffFailure {
  at: number;
  attempts: number;
}

export function isCaptureHandoffFailure(value: unknown): value is CaptureHandoffFailure {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CaptureHandoffFailure>;
  return (
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.attempts === "number" &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0
  );
}

/**
 * Why the popup says a page is not being captured: every refusal the policy can
 * return, plus the one rule the page decides for itself — a password field in
 * the document, which no policy verdict describes.
 */
export type CaptureExclusionReason = CaptureIneligibility | "password-field";

export interface CaptureContentStatus {
  state: "checking" | "watching" | "excluded" | "handoff-delayed" | "policy-pending";
  /**
   * Why the page is not being captured. The popup names the reason rather than
   * saying only that some setting applies; absent while the page is being
   * judged or watched, and for a page held back by something the popup already
   * names from its own state, such as an unpaired browser.
   */
  reason?: CaptureExclusionReason;
}

export const CAPTURE_HANDOFF_FAILURE_KEY = "omnesis.capture.handoffFailure.v1";
export const CAPTURE_HANDOFF_OVERFLOW_KEY = "omnesis.capture.handoffOverflow.v1";
export const CAPTURE_PENDING_PREFIX = "omnesis.capture.pending.v1.";

export interface CaptureHandoffOverflow {
  at: number;
  discarded: number;
}

export function isCaptureHandoffOverflow(value: unknown): value is CaptureHandoffOverflow {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CaptureHandoffOverflow>;
  return (
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.discarded === "number" &&
    Number.isInteger(record.discarded) &&
    record.discarded >= 0
  );
}

export interface StoredCaptureHandoff {
  at: number;
  /** Total-order key minted when the content script observed the emission. */
  order: string;
  pairingId: string;
  emission: CaptureEmission;
}

export function isStoredCaptureHandoff(value: unknown): value is StoredCaptureHandoff {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredCaptureHandoff>;
  return (
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.order === "string" &&
    record.order.length > 0 &&
    record.order.length <= 160 &&
    isPairingId(record.pairingId) &&
    isCaptureEmission(record.emission)
  );
}

/**
 * Messages the popup sends to the service worker to change capture state. The
 * capture settings live on the gateway and the SW owns the browser's copy of
 * them plus the toolbar badge, so the popup never writes those directly — it
 * asks the SW, which applies the change through the gateway and refreshes the
 * badge atomically.
 *
 *   - `set-pause` — pause capture in every paired browser until `until`
 *     (epoch-ms), or `null` to pause with no expiry (until someone resumes);
 *   - `resume` — clear the shared pause and start capturing again;
 *   - `check-now` — run a proactive liveness/auth probe (and a drain) right now,
 *     so opening the popup gives an up-to-the-second verdict on whether the
 *     token + gateway still work, rather than a possibly-stale cached one.
 */
export type PopupToSwMessage =
  | { type: "set-pause"; until: number | null }
  | { type: "resume" }
  | CheckNowMessage
  | { type: "dismiss-diagnostics" }
  | ReadPolicyMessage
  | AddExcludedDomainMessage;

/**
 * Sent by both the popup (on open) and the options page (after a pair) so the
 * worker re-probes the token and repaints the badge immediately.
 */
type CheckNowMessage = { type: "check-now" };

/** The popup and options page read the browser's copy of the shared policy. */
type ReadPolicyMessage = { type: "read-policy" };

/** Exclude a domain everywhere; `purge` also deletes its captured pages for good. */
type AddExcludedDomainMessage = { type: "add-excluded-domain"; input: string; purge?: boolean };

/** Pairing-state changes are committed by the service worker beside its queue. */
export type OptionsToSwMessage =
  | { type: "pair-browser"; gatewayUrl: string; pairingCode: string; profileLabel?: string }
  | { type: "unpair" }
  | { type: "revoke-capture-access" }
  | { type: "set-profile-label"; profileLabel: string }
  | AddExcludedDomainMessage
  | { type: "remove-excluded-domain"; domain: string }
  | ReadPolicyMessage
  | CheckNowMessage;

/** The browser's copy of the shared policy, or null before the first read succeeds. */
export interface CapturePolicySnapshot {
  policy: WebCapturePolicy | null;
  fetchedAt: number | null;
}

/** Acknowledgement of an exclusion edit. */
export type ExclusionAck = { ok: true; purged: number } | { ok: false; reason: string };

/**
 * The popup asks the active tab's content script for its capture state; the
 * content script answers with a {@link CaptureContentStatus}.
 */
export type PopupToContentMessage = { type: "capture-status" };
export const CAPTURE_STATUS_MESSAGE: PopupToContentMessage = { type: "capture-status" };

/** Acknowledgement returned for a {@link PopupToSwMessage}. */
export type PauseAck = { ok: true } | { ok: false; reason: string };

export type PairingStateAck = { ok: true; warning?: string } | { ok: false; reason: string };

/** Runtime guard for version-skewed content scripts and stored handoffs. */
function isCaptureEmission(value: unknown): value is CaptureEmission {
  if (typeof value !== "object" || value === null) return false;
  const emission = value as Partial<CaptureEmission>;
  if (
    (emission.kind !== "visit" && emission.kind !== "re-extract") ||
    typeof emission.normalizedUrl !== "string" ||
    emission.normalizedUrl.length > MAX_CAPTURE_URL_CHARS ||
    typeof emission.title !== "string" ||
    emission.title.length > MAX_CAPTURE_TITLE_CHARS ||
    typeof emission.text !== "string" ||
    emission.text.length > 250_000 ||
    typeof emission.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(emission.contentHash) ||
    typeof emission.visitedAt !== "string" ||
    !Number.isFinite(Date.parse(emission.visitedAt)) ||
    typeof emission.dwellMs !== "number" ||
    !Number.isFinite(emission.dwellMs) ||
    emission.dwellMs < 0 ||
    typeof emission.contentChanged !== "boolean"
  ) {
    return false;
  }
  try {
    const url = new URL(emission.normalizedUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isCaptureMessage(
  value: unknown,
): value is Extract<ContentToSwMessage, { type: "capture" }> {
  if (typeof value !== "object" || value === null) return false;
  const message = value as {
    type?: unknown;
    emission?: unknown;
    handoffKey?: unknown;
    pairingId?: unknown;
  };
  return (
    message.type === "capture" &&
    isCaptureEmission(message.emission) &&
    typeof message.handoffKey === "string" &&
    message.handoffKey.startsWith(CAPTURE_PENDING_PREFIX) &&
    message.handoffKey.length <= 256 &&
    isPairingId(message.pairingId)
  );
}

function isPairingId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
