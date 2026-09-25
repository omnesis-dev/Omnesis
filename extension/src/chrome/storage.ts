// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { REQUIRED_WEB_SCOPE } from "../push/pairing.js";
import { CAPTURE_PERMISSION_STATE_KEY } from "./capture-permission-state.js";
import {
  PAIRING_KEY,
  hasExactWebScope,
  isBrowserPairing,
  parsePairing,
  type BrowserPairing,
} from "./pairing-record.js";
import type { DurableStore } from "../push/index.js";

export { PAIRING_KEY, hasExactWebScope, loadPairing } from "./pairing-record.js";
export {
  CAPTURE_PERMISSION_STATE_KEY,
  loadCapturePermissionState,
} from "./capture-permission-state.js";

/**
 * `DurableStore` backed by `chrome.storage.local` — the queue's persistence
 * layer in the running extension. `chrome.storage.local` survives service-
 * worker eviction AND browser restart (unlike SW memory or `sessionStorage`),
 * which is exactly the durability the persistent queue requires.
 */
export const chromeLocalStore: DurableStore = {
  async get(key) {
    const obj = await chrome.storage.local.get(key);
    const value = obj[key];
    return typeof value === "string" ? value : undefined;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

/**
 * The bearer token, alone. Only the worker and the extension's own pages
 * import this module; the content script imports `pairing-record.ts` and
 * never names this key (see there for why that split exists).
 */
export const TOKEN_KEY = "omnesis.token.v1";
/**
 * The combined record older installs wrote (pairing and token in one JSON
 * blob). Read only to migrate it into the two current keys on worker start.
 */
export const CONFIG_KEY = "omnesis.config.v1";

/** The full pairing, token included: what the worker and popup use. */
export interface ExtensionConfig extends BrowserPairing {
  token: string;
}

/** Read the stored pairing with its token, or `null` when not yet paired. */
export async function loadConfig(): Promise<ExtensionConfig | null> {
  const obj = await chrome.storage.local.get([PAIRING_KEY, TOKEN_KEY, CONFIG_KEY]);
  const pairing = parsePairing(obj[PAIRING_KEY]);
  const token = obj[TOKEN_KEY];
  if (pairing && typeof token === "string" && token.length > 0) return { ...pairing, token };
  return parseLegacyConfig(obj[CONFIG_KEY]);
}

/** Persist pairing config after the service worker redeems a browser code. */
export async function saveConfig(config: ExtensionConfig, rawProfileLabel?: string): Promise<void> {
  if (!isExtensionConfig(config)) throw new Error("Browser pairing configuration is invalid.");
  if (!hasExactWebScope(config)) {
    throw new Error(`Browser pairing must use exactly the ${REQUIRED_WEB_SCOPE} scope.`);
  }
  const profileLabel =
    rawProfileLabel === undefined ? undefined : normalizeProfileLabel(rawProfileLabel);
  if (rawProfileLabel !== undefined && profileLabel === null) {
    throw new Error("Chrome profile name is invalid.");
  }
  await chrome.storage.local.set({
    [PAIRING_KEY]: JSON.stringify(toPairing(config)),
    [TOKEN_KEY]: config.token,
    ...(profileLabel ? { [PROFILE_LABEL_KEY]: profileLabel } : {}),
  });
  await chrome.storage.local.remove(CONFIG_KEY);
}

/** Clear the pairing config ("unpair" affordance). */
export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove([PAIRING_KEY, TOKEN_KEY, CONFIG_KEY]);
}

/**
 * Record the gateway's version beside the pairing when it changed. The
 * `gatewayUrl` names the gateway the version was read from, so a re-pair to
 * another gateway that lands between the health check and this write is left
 * alone. Writing the pairing record with an unchanged identity reads as a
 * same-identity refresh to the content script, so this is cheap to call after
 * every health probe.
 */
export async function saveGatewayVersion(gatewayUrl: string, version: string): Promise<boolean> {
  const obj = await chrome.storage.local.get(PAIRING_KEY);
  const pairing = parsePairing(obj[PAIRING_KEY]);
  if (!pairing || pairing.gatewayUrl !== gatewayUrl || pairing.gatewayVersion === version) {
    return false;
  }
  if (!isBrowserPairing({ ...pairing, gatewayVersion: version })) return false;
  await chrome.storage.local.set({
    [PAIRING_KEY]: JSON.stringify({ ...pairing, gatewayVersion: version }),
  });
  return true;
}

/**
 * Split a legacy combined record into the two current keys. Runs on every
 * worker start; a no-op once the legacy key is gone. Writes the new keys before
 * removing the old one, so an interruption leaves a still-paired install. When
 * both layouts are present the current keys win — only current code writes
 * them, so they are the newer state.
 */
export async function migrateLegacyConfig(): Promise<boolean> {
  const obj = await chrome.storage.local.get([PAIRING_KEY, TOKEN_KEY, CONFIG_KEY]);
  const legacy = parseLegacyConfig(obj[CONFIG_KEY]);
  if (!legacy) return false;
  if (!parsePairing(obj[PAIRING_KEY]) || typeof obj[TOKEN_KEY] !== "string") {
    await chrome.storage.local.set({
      [PAIRING_KEY]: JSON.stringify(toPairing(legacy)),
      [TOKEN_KEY]: legacy.token,
    });
  }
  await chrome.storage.local.remove(CONFIG_KEY);
  return true;
}

export function saveCapturePermissionState(granted: boolean): Promise<void> {
  return chrome.storage.local.set({ [CAPTURE_PERMISSION_STATE_KEY]: granted });
}

export const INSTALL_ID_KEY = "omnesis.installId.v1";
export const PROFILE_LABEL_KEY = "omnesis.browserProfileLabel.v1";
/** Mirrored by the `maxlength` of the profile-label input in options.html. */
const MAX_PROFILE_LABEL_CHARS = 120;

export function normalizeProfileLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length > 0 && label.length <= MAX_PROFILE_LABEL_CHARS ? label : null;
}

/** User-entered Chrome profile name; separate from immutable install/device identity. */
export async function loadProfileLabel(): Promise<string | null> {
  const obj = await chrome.storage.local.get(PROFILE_LABEL_KEY);
  return normalizeProfileLabel(obj[PROFILE_LABEL_KEY]);
}

export async function saveProfileLabel(rawLabel: string): Promise<void> {
  const label = normalizeProfileLabel(rawLabel);
  if (!label) {
    throw new Error("Chrome profile name is invalid.");
  }
  await chrome.storage.local.set({ [PROFILE_LABEL_KEY]: label });
}

/**
 * Stable per-install identity, minted once and kept in `chrome.storage.local`
 * (never `sync`, for the same reason as the device name). The gateway adopts
 * the device row carrying this id on re-pair, so renaming the row can't
 * sever the identity.
 */
export async function getOrCreateInstallId(): Promise<string> {
  const obj = await chrome.storage.local.get(INSTALL_ID_KEY);
  const existing = obj[INSTALL_ID_KEY];
  if (typeof existing === "string" && existing) return existing;
  // Callers that miss the read at the same time share one mint, so two
  // concurrent pairings can't stamp different identities.
  installIdMint ??= (async () => {
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    return id;
  })().finally(() => {
    installIdMint = null;
  });
  return installIdMint;
}
let installIdMint: Promise<string> | null = null;

function isExtensionConfig(value: unknown): value is ExtensionConfig {
  if (!isBrowserPairing(value)) return false;
  const token = (value as Partial<ExtensionConfig>).token;
  return typeof token === "string" && token.length > 0;
}

function toPairing(config: ExtensionConfig): BrowserPairing {
  return {
    gatewayUrl: config.gatewayUrl,
    scopes: config.scopes,
    deviceId: config.deviceId,
    pairedAt: config.pairedAt,
    ...(config.gatewayVersion ? { gatewayVersion: config.gatewayVersion } : {}),
  };
}

function parseLegacyConfig(raw: unknown): ExtensionConfig | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isExtensionConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
