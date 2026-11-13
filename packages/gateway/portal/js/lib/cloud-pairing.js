// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { googleAuthorizationUrl as trustedGoogleAuthorizationUrl } from "./cloud-relay-api.js";

export const GOOGLE_PAIRING_STORAGE_KEY = "omnesis.google-pairing";
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const digest = async (text) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

const sha256 = async (text) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const CODE_NONCE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Byte-for-byte pairingCodeCommitment from packages/cloud-relay/src/device-enrollment.ts.
 * The gateway's challenge is this hash of the nonce it reveals with its reply, so the
 * gateway chose the nonce before it saw this browser's secret.
 */
export async function cloudPairingCodeCommitment(codeNonce) {
  if (typeof codeNonce !== "string" || !CODE_NONCE.test(codeNonce))
    throw new Error("Invalid pairing reply.");
  return base64url(await sha256(JSON.stringify(["omnesis-pairing-code-commitment-v1", codeNonce])));
}

/**
 * Byte-for-byte pairingComparisonCode from the same file: six digits in two groups, from the
 * certificate this browser connected to, the request, its secret and the gateway's nonce.
 */
export async function cloudPairingVerificationCode(request, fingerprint, codeNonce) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("Invalid gateway certificate fingerprint.");
  if (typeof codeNonce !== "string" || !CODE_NONCE.test(codeNonce))
    throw new Error("Invalid pairing reply.");
  const bytes = await sha256(
    JSON.stringify([
      "omnesis-pairing-code-v3",
      fingerprint,
      request.requestId,
      await digest(request.secret),
      codeNonce,
    ]),
  );
  // Six bytes as one unsigned 48-bit number. Plain arithmetic: bitwise operators stop at 32 bits.
  let number = 0;
  for (const byte of bytes.subarray(0, 6)) number = number * 256 + byte;
  const digits = String(number % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

const DEVICE_KEY = /^[A-Za-z0-9_-]{64,256}$/;
const HEX64 = /^[a-f0-9]{64}$/;

/**
 * A fresh request. With a device key (automatic enrollment) it also records the
 * key and the gateway's TLS key fingerprint the browser will sign for.
 */
export function newCloudPairing(name, fingerprint, deviceKey) {
  if (!name.trim() || name.trim().length > 80 || !HEX64.test(fingerprint))
    throw new Error("Invalid sign-in configuration.");
  if (
    deviceKey &&
    (!DEVICE_KEY.test(deviceKey.devicePublicKey) || !HEX64.test(deviceKey.gatewaySpkiFingerprint))
  )
    throw new Error("Invalid sign-in configuration.");
  return {
    requestId: crypto.randomUUID(),
    name: name.trim(),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    gatewayFingerprint: fingerprint,
    expiresAt: Date.now() + 600_000,
    ...(deviceKey
      ? {
          devicePublicKey: deviceKey.devicePublicKey,
          gatewaySpkiFingerprint: deviceKey.gatewaySpkiFingerprint,
        }
      : {}),
  };
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  const binary = atob(
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const sha256Hex = async (bytes) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** SHA-256 hex of the DER SubjectPublicKeyInfo, as packages/cloud-relay names a device key. */
export function deviceKeyThumbprint(devicePublicKey) {
  return sha256Hex(fromBase64url(devicePublicKey));
}

/**
 * Byte-for-byte enrollmentSignatureTranscript from
 * packages/cloud-relay/src/device-enrollment.ts: a JSON array of ASCII strings,
 * with the name hashed first so no JSON escaping can differ between platforms.
 */
export async function enrollmentSignatureTranscript(input) {
  return JSON.stringify([
    "omnesis-device-enrollment-signature-v3",
    input.requestId,
    input.kind,
    await sha256Hex(new TextEncoder().encode(input.name)),
    input.gatewaySpkiFingerprint,
    input.challenge,
    await deviceKeyThumbprint(input.devicePublicKey),
  ]);
}

/** ECDSA P-256 over SHA-256. WebCrypto returns IEEE P1363, which the gateway accepts. */
export async function signEnrollment(privateKey, transcript) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(transcript),
  );
  return base64url(signature);
}

export function restoreCloudPairing(storage, requestId) {
  try {
    const value = JSON.parse(storage.getItem(GOOGLE_PAIRING_STORAGE_KEY));
    if (
      !value ||
      value.requestId !== requestId ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId) ||
      !/^[a-f0-9]{64}$/.test(value.secret) ||
      !/^[a-f0-9]{64}$/.test(value.gatewayFingerprint) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80 ||
      (value.devicePublicKey !== undefined &&
        (typeof value.devicePublicKey !== "string" ||
          !DEVICE_KEY.test(value.devicePublicKey) ||
          typeof value.gatewaySpkiFingerprint !== "string" ||
          !HEX64.test(value.gatewaySpkiFingerprint))) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 600_000
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function googleAuthorizationUrl(value, installationRelayUrl) {
  try {
    if (new URL(value).hash) throw new Error();
    return trustedGoogleAuthorizationUrl(value, installationRelayUrl);
  } catch {
    throw new Error("Invalid sign-in destination.");
  }
}
