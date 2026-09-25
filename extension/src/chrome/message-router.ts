// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  MAX_CAPTURE_DOMAIN_CHARS,
  normalizeCaptureDomain,
} from "@omnesis/provider-web/capture-policy";
import { MAX_CAPTURE_URL_CHARS } from "../capture/lifecycle.js";
import { normalizeGatewayUrl } from "../push/pairing.js";
import { normalizeProfileLabel } from "./storage.js";
import {
  type CaptureAck,
  type CaptureEligibilityResponse,
  type CapturePolicySnapshot,
  type ContentToSwMessage,
  type ExclusionAck,
  type OptionsToSwMessage,
  type PairingStateAck,
  type PauseAck,
  type PopupToSwMessage,
  isCaptureMessage,
} from "./messages.js";

interface MessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number; incognito?: boolean };
}

type ExclusionMessage = Extract<
  OptionsToSwMessage,
  { type: "add-excluded-domain" | "remove-excluded-domain" }
>;

export interface BackgroundMessageDeps {
  runtimeId: string;
  popupUrl: string;
  optionsUrl: string;
  handleCapture: (message: Extract<ContentToSwMessage, { type: "capture" }>) => Promise<CaptureAck>;
  drain: () => Promise<void>;
  judgeEligibility: (url: string) => Promise<CaptureEligibilityResponse>;
  handlePause: (
    message: Extract<PopupToSwMessage, { type: "resume" | "set-pause" }>,
  ) => Promise<void>;
  dismissDiagnostics: () => Promise<void>;
  checkNow: () => Promise<void>;
  readPolicy: () => Promise<CapturePolicySnapshot>;
  mutateExclusions: (message: ExclusionMessage) => Promise<{ purged: number }>;
  changePairing: (
    message: Extract<
      OptionsToSwMessage,
      { type: "pair-browser" | "unpair" | "revoke-capture-access" | "set-profile-label" }
    >,
  ) => Promise<{ warning?: string } | void>;
}

/** Validate and route one privileged runtime message without leaking rejections. */
export function routeBackgroundMessage(
  message: unknown,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void,
  deps: BackgroundMessageDeps,
): boolean {
  const fromThisExtension = sender.id === deps.runtimeId;
  if (
    fromThisExtension &&
    sender.tab?.id !== undefined &&
    sender.tab.incognito !== true &&
    isCaptureMessage(message)
  ) {
    respond(
      deps.handleCapture(message).then((ack) => {
        if (ack.ok && ack.accepted) runDetached(deps.drain());
        return ack;
      }),
      sendResponse,
      () => ({ ok: false, reason: "queue-unavailable" }) satisfies CaptureAck,
    );
    return true;
  }

  if (
    fromThisExtension &&
    sender.tab?.id !== undefined &&
    sender.tab.incognito !== true &&
    isObjectWithType(message, "capture-eligibility") &&
    typeof (message as { url?: unknown }).url === "string" &&
    (message as { url: string }).url.length <= MAX_CAPTURE_URL_CHARS
  ) {
    respond(
      deps.judgeEligibility((message as { url: string }).url),
      sendResponse,
      // A worker that cannot answer must not stop every page from arming its
      // dwell; the enqueue seam judges the capture again with the policy.
      () => ({ eligible: true, skipPasswordForms: true }) satisfies CaptureEligibilityResponse,
    );
    return true;
  }

  const fromPopup = fromThisExtension && sender.url === deps.popupUrl;
  const fromOptions = fromThisExtension && sender.url === deps.optionsUrl;
  if (fromPopup && isPauseMessage(message)) {
    respond(
      deps.handlePause(message).then(() => ({ ok: true }) satisfies PauseAck),
      sendResponse,
      failureAck,
    );
    return true;
  }
  if (fromPopup && isObjectWithType(message, "dismiss-diagnostics")) {
    respond(
      deps.dismissDiagnostics().then(() => ({ ok: true }) satisfies PauseAck),
      sendResponse,
      failureAck,
    );
    return true;
  }
  if ((fromPopup || fromOptions) && isObjectWithType(message, "check-now")) {
    respond(
      deps.checkNow().then(() => ({ ok: true }) satisfies PauseAck),
      sendResponse,
      failureAck,
    );
    return true;
  }
  if ((fromPopup || fromOptions) && isObjectWithType(message, "read-policy")) {
    respond(
      deps.readPolicy(),
      sendResponse,
      () => ({ policy: null, fetchedAt: null }) satisfies CapturePolicySnapshot,
    );
    return true;
  }
  if ((fromPopup || fromOptions) && isExclusionMessage(message)) {
    respond(
      deps
        .mutateExclusions(message)
        .then(({ purged }) => ({ ok: true, purged }) satisfies ExclusionAck),
      sendResponse,
      failureAck,
    );
    return true;
  }
  if (fromOptions && isPairingMessage(message)) {
    respond(
      deps.changePairing(message).then(
        (result) =>
          ({
            ok: true,
            ...(result?.warning ? { warning: result.warning } : {}),
          }) satisfies PairingStateAck,
      ),
      sendResponse,
      failureAck,
    );
    return true;
  }
  return false;
}

function respond<T>(
  task: Promise<T>,
  sendResponse: (response?: unknown) => void,
  onError: (error: unknown) => unknown,
): void {
  void task.then(sendResponse, (error: unknown) => sendResponse(onError(error)));
}

function runDetached(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

function failureAck(error: unknown): PairingStateAck {
  return { ok: false, reason: error instanceof Error ? error.message : String(error) };
}

function isObjectWithType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

function isPauseMessage(
  value: unknown,
): value is Extract<PopupToSwMessage, { type: "resume" | "set-pause" }> {
  if (isObjectWithType(value, "resume")) return true;
  return (
    isObjectWithType(value, "set-pause") &&
    ((value as { until?: unknown }).until === null ||
      (typeof (value as { until?: unknown }).until === "number" &&
        Number.isFinite((value as { until: number }).until)))
  );
}

function isExclusionMessage(value: unknown): value is ExclusionMessage {
  if (isObjectWithType(value, "add-excluded-domain")) {
    const candidate = value as { input?: unknown; purge?: unknown };
    return (
      typeof candidate.input === "string" &&
      candidate.input.length <= 8_192 &&
      (candidate.purge === undefined || typeof candidate.purge === "boolean")
    );
  }
  if (isObjectWithType(value, "remove-excluded-domain")) {
    const domain = (value as { domain?: unknown }).domain;
    return (
      typeof domain === "string" &&
      domain.length > 0 &&
      domain.length <= MAX_CAPTURE_DOMAIN_CHARS &&
      normalizeCaptureDomain(domain) === domain
    );
  }
  return false;
}

function isPairingMessage(
  value: unknown,
): value is Extract<
  OptionsToSwMessage,
  { type: "pair-browser" | "unpair" | "revoke-capture-access" | "set-profile-label" }
> {
  if (isObjectWithType(value, "pair-browser")) {
    const candidate = value as {
      gatewayUrl?: unknown;
      pairingCode?: unknown;
      profileLabel?: unknown;
    };
    if (
      typeof candidate.gatewayUrl !== "string" ||
      candidate.gatewayUrl.length > 2_048 ||
      typeof candidate.pairingCode !== "string" ||
      candidate.pairingCode.length === 0 ||
      candidate.pairingCode.length > 256 ||
      (candidate.profileLabel !== undefined &&
        normalizeProfileLabel(candidate.profileLabel) === null)
    ) {
      return false;
    }
    try {
      return normalizeGatewayUrl(candidate.gatewayUrl) === candidate.gatewayUrl;
    } catch {
      return false;
    }
  }
  if (isObjectWithType(value, "set-profile-label")) {
    return normalizeProfileLabel((value as { profileLabel?: unknown }).profileLabel) !== null;
  }
  return isObjectWithType(value, "unpair") || isObjectWithType(value, "revoke-capture-access");
}
