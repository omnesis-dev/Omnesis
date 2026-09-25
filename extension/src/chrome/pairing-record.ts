// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { normalizeGatewayUrl, REQUIRED_WEB_SCOPE } from "../push/pairing.js";

/**
 * The non-secret half of the pairing, and the only pairing module the content
 * script may import.
 *
 * The pairing lives under two `chrome.storage.local` keys so the bearer token
 * stays out of the page context: this record (which gateway, which device,
 * which scopes) under {@link PAIRING_KEY}, and the token alone under a key
 * that only `storage.ts` — imported by the worker and the extension's own
 * pages — knows. Keeping the two in separate modules makes the boundary a
 * property of the import graph rather than of bundler tree-shaking;
 * `bundle-boundaries.test.ts` asserts the content bundle names neither the
 * token key nor the legacy combined record. `chrome.storage.local` itself is
 * readable from a content script by API design (and `storage.onChanged`
 * delivers every changed key to any listener), so this is defence in depth,
 * not a hard wall.
 */
export const PAIRING_KEY = "omnesis.pairing.v1";

/** Bound on a gateway's advertised product version as stored beside the pairing. */
const MAX_GATEWAY_VERSION_CHARS = 64;

export interface BrowserPairing {
  gatewayUrl: string;
  scopes: string[];
  deviceId: string;
  pairedAt: number;
  /** The gateway's product version as last read from its health check. */
  gatewayVersion?: string;
}

/**
 * Read the pairing WITHOUT its token — the only form the content script asks
 * for. An install that still holds only the legacy combined record reads as
 * unpaired here until the worker has split it; the worker does that on start,
 * and the resulting storage change re-activates the page.
 */
export async function loadPairing(
  storage: Pick<chrome.storage.StorageArea, "get"> = chrome.storage.local,
): Promise<BrowserPairing | null> {
  const obj = await storage.get(PAIRING_KEY);
  return parsePairing(obj[PAIRING_KEY]);
}

export function isBrowserPairing(value: unknown): value is BrowserPairing {
  if (typeof value !== "object" || value === null) return false;
  const pairing = value as Partial<BrowserPairing>;
  if (
    typeof pairing.gatewayUrl !== "string" ||
    !Array.isArray(pairing.scopes) ||
    !pairing.scopes.every((scope) => typeof scope === "string") ||
    typeof pairing.deviceId !== "string" ||
    typeof pairing.pairedAt !== "number" ||
    !Number.isFinite(pairing.pairedAt) ||
    (pairing.gatewayVersion !== undefined &&
      (typeof pairing.gatewayVersion !== "string" ||
        pairing.gatewayVersion.length > MAX_GATEWAY_VERSION_CHARS))
  ) {
    return false;
  }
  try {
    return normalizeGatewayUrl(pairing.gatewayUrl) === pairing.gatewayUrl;
  } catch {
    return false;
  }
}

/** Whether a structurally valid pairing is safe for the browser push client. */
export function hasExactWebScope(pairing: Pick<BrowserPairing, "scopes">): boolean {
  return pairing.scopes.length === 1 && pairing.scopes[0] === REQUIRED_WEB_SCOPE;
}

export function parsePairing(raw: unknown): BrowserPairing | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isBrowserPairing(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
