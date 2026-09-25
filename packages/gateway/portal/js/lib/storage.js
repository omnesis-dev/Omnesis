// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Centralised prefix list for portal-owned session/local-storage keys.
//
// Different views key their caches with different separators:
//   - "omnesis_search_cache" (snake_case in search.js)
//   - "omnesis.sql.history"  (dotted in sql.js)
//
// Both are "ours" — keeping the list in one place means the logout
// path (and any future cache-flush button) doesn't have to keep
// learning new prefixes whenever a view adds storage.
import { THEME_KEY } from "./theme.js";

export const STORAGE_PREFIXES = ["omnesis_", "omnesis."];

// Stable, unique-per-browser device name. Minted once on first login and sent
// with every `/portal/api/login` so a nameless portal pairing gives THIS
// browser its own `portal` device row (see routes/portal.ts + AuthService).
// It is this browser's identity, not per-account data, so it must survive
// logout — otherwise the next login would mint a new name, spawn a new device
// row, and the two-browser collapse this key exists to prevent could recur.
const DEVICE_NAME_KEY = "omnesis.device-name";
const INSTALL_ID_KEY = "omnesis.install-id";

// Keys that survive logout: device-level UI preferences and this browser's
// identity, not per-user data. The light/dark theme is a property of this
// browser, not the signed-in account, so wiping it on sign-out would be
// surprising; the device name and install id must persist for the reason
// above.
const LOGOUT_PRESERVE = new Set([THEME_KEY, DEVICE_NAME_KEY, INSTALL_ID_KEY]);

/**
 * Return this browser's stable portal device name, minting + persisting one on
 * first call. The random suffix guarantees two browsers never collide (so
 * neither evicts the other's device row); persistence guarantees the SAME
 * browser reuses its row on re-pair (so device rows don't accumulate).
 */
export function portalDeviceName() {
  let name;
  try {
    name = localStorage.getItem(DEVICE_NAME_KEY);
  } catch {
    // localStorage unavailable (private mode / disabled) — fall back to an
    // ephemeral name. Worse than a stable one, but still unique per login so
    // it never collapses onto another browser's row.
    return `Portal ${randomSuffix()}`;
  }
  if (name) return name;
  name = `Portal ${randomSuffix()}`;
  try {
    localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    /* best-effort persistence; the ephemeral name is still safe to use */
  }
  return name;
}

/**
 * Stable per-install identity for this browser, minted once. The gateway
 * adopts the device row carrying it on re-login, so the row keeps its id —
 * and any rename — across sessions. Null when storage is unavailable.
 */
export function portalInstallId() {
  try {
    const existing = localStorage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;
    const c = globalThis.crypto;
    const id = c?.randomUUID ? c.randomUUID() : `${randomSuffix()}-${randomSuffix()}`;
    localStorage.setItem(INSTALL_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

function randomSuffix() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().slice(0, 8);
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(4));
    return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  }
  // Non-secure-context fallback only (the HTTPS portal always takes a branch
  // above). Pad so a `Math.random()` of 0 can't yield an empty suffix.
  return (Math.random().toString(16).slice(2) + "00000000").slice(0, 8);
}

/**
 * Wipe every session/local-storage key whose name starts with an Omnesis
 * prefix, except the device-level preferences in `LOGOUT_PRESERVE`. Intended
 * for the logout / session-expired path so user data doesn't linger across
 * sign-ins on a shared machine.
 *
 * Keys are collected first then removed — iterating + mutating
 * `Storage.length` in the same loop skips entries.
 */
export function clearOmnesisStorage() {
  for (const storage of [sessionStorage, localStorage]) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && !LOGOUT_PRESERVE.has(k) && STORAGE_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
    }
    for (const k of keys) {
      try { storage.removeItem(k); } catch { /* private mode / quota — ignore */ }
    }
  }
}
