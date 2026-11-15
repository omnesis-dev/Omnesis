// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A sign-in made on the Omnesis account page, handed to this portal in the URL
// fragment (docs/device-enrollment.md). The fragment never reaches a server. It
// is taken out of the address bar before anything else reads the URL, and kept
// only in this module until the sign-in view spends it. The module imports
// nothing, so the entry module can evaluate it before any other.

const PREFIX = "#account-signin=";
// A signed-in portal elsewhere opening this gateway's own address (routes/portal-handoff.ts).
const PORTAL_PREFIX = "#portal-handoff=";
const PORTAL_CODE = /^[A-Za-z0-9_-]{43}$/;
/** What the page opened by a handoff may be asked to do first. */
const PORTAL_NEXT = ["confirm-passkey"];
const MAX_LENGTH = 65_536;
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const DEVICE_KEY = /^[A-Za-z0-9_-]{64,256}$/;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

let captured = null;
let portalHandoff = null;
let handoffNext = null;

/** Moves a handed-over sign-in from the address bar into memory, whoever is signed in. */
export function captureAccountSignIn(location = window.location, history = window.history) {
  // Loading the portal must never fail here, whatever stands in for the page's location.
  const hash = String(location.hash ?? "");
  if (hash.startsWith(PREFIX)) captured = hash.slice(PREFIX.length);
  else if (hash.startsWith(PORTAL_PREFIX)) portalHandoff = hash.slice(PORTAL_PREFIX.length);
  else return;
  history.replaceState(history.state, "", location.pathname + location.search);
}

/** The captured sign-in, once. A second caller gets nothing. */
export function takeAccountSignIn() {
  const value = captured;
  captured = null;
  return value;
}

/**
 * The captured portal handoff's code, once, when it has the expected shape. What it asks the page
 * to do first is kept for `takeHandoffNext`.
 */
export function takePortalHandoff() {
  const [code, ...rest] = String(portalHandoff ?? "").split("&");
  portalHandoff = null;
  if (!PORTAL_CODE.test(code)) return null;
  const next = rest.length === 1 && rest[0].startsWith("next=") ? rest[0].slice(5) : null;
  handoffNext = PORTAL_NEXT.includes(next) ? next : null;
  return code;
}

/** What the page opened by a handoff should do first, once (`confirm-passkey`), or null. */
export function takeHandoffNext() {
  const value = handoffNext;
  handoffNext = null;
  return value;
}

/**
 * Spends a portal handoff: this browser gets a session on this gateway's own address for the
 * portal that opened it. Resolves to whether it worked; never throws.
 */
export async function redeemPortalHandoff(code, request = globalThis.fetch) {
  try {
    const response = await request("/portal/api/handoff/redeem", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const decode = (encoded) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
      char.charCodeAt(0),
    ),
  );

/** The handed-over sign-in when every field has the expected shape, otherwise null. */
export function parseAccountSignIn(encoded) {
  try {
    if (!text(encoded, MAX_LENGTH)) return null;
    const value = JSON.parse(decode(encoded));
    const key = value.privateKey;
    if (
      value.v !== 1 ||
      !matches(UUID, value.requestId) ||
      !text(value.name, 80) ||
      value.name !== value.name.trim() ||
      !matches(HEX64, value.secret) ||
      !matches(DEVICE_KEY, value.devicePublicKey) ||
      !text(value.identityToken, 16_384) ||
      typeof value.proof?.type !== "string" ||
      key?.kty !== "EC" ||
      key.crv !== "P-256" ||
      ![key.x, key.y, key.d].every((part) => matches(COORDINATE, part))
    )
      return null;
    return {
      requestId: value.requestId,
      name: value.name,
      secret: value.secret,
      devicePublicKey: value.devicePublicKey,
      identityToken: value.identityToken,
      proof: value.proof,
      privateKey: { kty: "EC", crv: "P-256", x: key.x, y: key.y, d: key.d },
    };
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") captureAccountSignIn();
