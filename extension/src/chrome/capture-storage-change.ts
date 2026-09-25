// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CAPTURE_POLICY_KEY } from "../capture/policy.js";
import { CAPTURE_PERMISSION_STATE_KEY } from "./capture-permission-state.js";
import { PAIRING_KEY, hasExactWebScope, isBrowserPairing } from "./pairing-record.js";

export type CaptureStorageAction =
  | "none"
  | "refresh"
  | "rejudge"
  | "reconcile"
  | "deactivate"
  | "terminate";

/**
 * Classify only the storage keys that control content-script authorization.
 * The token key is deliberately not one of them: a page-side script never
 * needs the token, and a token rotation alone changes nothing about which
 * pages may be captured. The gateway's capture settings are one of them: a page
 * is judged afresh whenever they change, so excluding a domain takes hold on the
 * pages already open rather than only on the next load. A refresh that re-reads
 * the same settings changes nothing and is ignored.
 */
export function captureStorageAction(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
): CaptureStorageAction {
  if (areaName !== "local") return "none";
  if (
    CAPTURE_PERMISSION_STATE_KEY in changes &&
    changes[CAPTURE_PERMISSION_STATE_KEY]?.newValue !== true
  ) {
    return "terminate";
  }
  if (PAIRING_KEY in changes && changes[PAIRING_KEY]?.newValue === undefined) {
    return "deactivate";
  }
  if (PAIRING_KEY in changes) {
    const change = changes[PAIRING_KEY];
    const oldIdentity = pairingIdentity(change?.oldValue);
    const newIdentity = pairingIdentity(change?.newValue);
    return oldIdentity !== null && oldIdentity === newIdentity && hasValidWebScope(change?.newValue)
      ? "refresh"
      : "reconcile";
  }
  if (CAPTURE_PERMISSION_STATE_KEY in changes) return "refresh";
  if (CAPTURE_POLICY_KEY in changes) {
    const change = changes[CAPTURE_POLICY_KEY];
    if (capturePolicyOf(change?.oldValue) !== capturePolicyOf(change?.newValue)) return "rejudge";
  }
  return "none";
}

/**
 * The settings themselves, as a comparable string. The stored record also
 * carries the instant it was read, which changes on every refresh; comparing
 * the settings alone keeps an unchanged re-read from restarting every page.
 */
function capturePolicyOf(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed = JSON.parse(value) as { policy?: unknown };
    return parsed.policy === undefined ? "" : JSON.stringify(parsed.policy);
  } catch {
    return "";
  }
}

function hasValidWebScope(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isBrowserPairing(parsed) && hasExactWebScope(parsed);
  } catch {
    return false;
  }
}

export function applyCaptureStorageAction(
  action: CaptureStorageAction,
  handlers: Record<Exclude<CaptureStorageAction, "none">, () => void>,
): void {
  if (action !== "none") handlers[action]();
}

function pairingIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isBrowserPairing(parsed) ? `${parsed.gatewayUrl}\0${parsed.deviceId}` : null;
  } catch {
    return null;
  }
}
