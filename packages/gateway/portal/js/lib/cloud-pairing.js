// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const GOOGLE_PAIRING_STORAGE_KEY = "omnesis.google-pairing";
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const digest = async (text) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

export async function cloudPairingVerificationCode(request, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid gateway certificate fingerprint.");
  const raw = await digest(JSON.stringify(["omnesis-pairing-sas-v2", fingerprint,
    request.requestId, await digest(request.secret)]));
  return raw.slice(0, 20).toUpperCase().match(/.{4}/g).join("-");
}

export function newCloudPairing(name, fingerprint) {
  if (!name.trim() || name.trim().length > 80 || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("Invalid Google pairing configuration.");
  return { requestId: crypto.randomUUID(), name: name.trim(),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))), gatewayFingerprint: fingerprint,
    expiresAt: Date.now() + 600_000 };
}

export function restoreCloudPairing(storage, requestId) {
  try {
    const value = JSON.parse(storage.getItem(GOOGLE_PAIRING_STORAGE_KEY));
    if (!value || value.requestId !== requestId ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId) ||
      !/^[a-f0-9]{64}$/.test(value.secret) || !/^[a-f0-9]{64}$/.test(value.gatewayFingerprint) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 600_000) return null;
    return value;
  } catch { return null; }
}

export function googleAuthorizationUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" ||
    url.username || url.password || url.hash) throw new Error("Invalid Google sign-in destination.");
  return url.href;
}
