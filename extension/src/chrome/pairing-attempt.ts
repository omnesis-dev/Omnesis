// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Crash-safe pairing attempts.
 *
 * Redeeming a one-time code is not naturally retryable: if the request times
 * out after the gateway has already spent the code, the credentials are lost
 * and a plain retry gets "invalid or expired". The gateway therefore accepts a
 * client-chosen idempotency key and replays the first response for the same
 * code + key + capabilities. This module owns that key on the extension side:
 * one key per (gateway, code) attempt, persisted so a retry after a timeout —
 * or after the worker was evicted mid-request — reuses it.
 */

export const PAIRING_ATTEMPT_KEY = "omnesis.pairing.attempt.v1";
/** How long a stored attempt stays reusable; matches the gateway's code lifetime order of magnitude. */
export const PAIRING_ATTEMPT_TTL_MS = 15 * 60 * 1000;

export interface PairingAttempt {
  gatewayUrl: string;
  /** SHA-256 of the pairing code; the code itself is never persisted. */
  codeHash: string;
  /** The idempotency key sent with every request of this attempt. */
  key: string;
  at: number;
}

/** 32 random bytes as base64url: 43 characters, the gateway's minimum. */
export function mintIdempotencyKey(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isPairingAttempt(value: unknown): value is PairingAttempt {
  if (typeof value !== "object" || value === null) return false;
  const attempt = value as Partial<PairingAttempt>;
  return (
    typeof attempt.gatewayUrl === "string" &&
    typeof attempt.codeHash === "string" &&
    /^[a-f0-9]{64}$/.test(attempt.codeHash) &&
    typeof attempt.key === "string" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(attempt.key) &&
    typeof attempt.at === "number" &&
    Number.isFinite(attempt.at)
  );
}

/**
 * The attempt to use for this request: the stored one when it is for the same
 * gateway and code and still fresh, otherwise a new key.
 */
export async function resolvePairingAttempt(
  stored: unknown,
  request: { gatewayUrl: string; pairingCode: string; now: number },
  hash: (text: string) => Promise<string>,
  mint: () => string = mintIdempotencyKey,
): Promise<PairingAttempt> {
  const codeHash = await hash(request.pairingCode);
  let previous: unknown = stored;
  if (typeof stored === "string") {
    try {
      previous = JSON.parse(stored) as unknown;
    } catch {
      previous = null;
    }
  }
  if (
    isPairingAttempt(previous) &&
    previous.gatewayUrl === request.gatewayUrl &&
    previous.codeHash === codeHash &&
    request.now - previous.at >= 0 &&
    request.now - previous.at < PAIRING_ATTEMPT_TTL_MS
  ) {
    return previous;
  }
  return { gatewayUrl: request.gatewayUrl, codeHash, key: mint(), at: request.now };
}
