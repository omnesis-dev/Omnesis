// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { hashText } from "../capture/content-hash.js";
import {
  PAIRING_ATTEMPT_TTL_MS,
  isPairingAttempt,
  mintIdempotencyKey,
  resolvePairingAttempt,
} from "./pairing-attempt.js";

const request = {
  gatewayUrl: "https://gateway.example.com",
  pairingCode: "0123456789",
  now: 1_000,
};

describe("mintIdempotencyKey", () => {
  it("produces a 43-character base64url key from 32 random bytes", () => {
    const key = mintIdempotencyKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintIdempotencyKey()).not.toBe(key);
    // Padding and URL-unsafe characters are stripped or replaced.
    expect(mintIdempotencyKey(() => new Uint8Array(32).fill(0xff))).toBe("_".repeat(42) + "8");
  });
});

describe("resolvePairingAttempt", () => {
  it("mints a fresh attempt when nothing is stored", async () => {
    const attempt = await resolvePairingAttempt(undefined, request, hashText, () => "k".repeat(43));
    expect(attempt).toEqual({
      gatewayUrl: request.gatewayUrl,
      codeHash: await hashText(request.pairingCode),
      key: "k".repeat(43),
      at: 1_000,
    });
    // The code itself is never part of the stored record.
    expect(JSON.stringify(attempt)).not.toContain(request.pairingCode);
  });

  it("reuses the stored key for the same gateway and code while it is fresh", async () => {
    const first = await resolvePairingAttempt(undefined, request, hashText, () => "k".repeat(43));
    const retry = await resolvePairingAttempt(
      JSON.stringify(first),
      { ...request, now: 1_000 + PAIRING_ATTEMPT_TTL_MS - 1 },
      hashText,
      () => "n".repeat(43),
    );
    expect(retry).toEqual(first);
  });

  it("mints a new key for a different code, a different gateway, or a stale attempt", async () => {
    const first = await resolvePairingAttempt(undefined, request, hashText, () => "k".repeat(43));
    const mint = () => "n".repeat(43);
    expect(
      (
        await resolvePairingAttempt(
          JSON.stringify(first),
          { ...request, pairingCode: "9876543210" },
          hashText,
          mint,
        )
      ).key,
    ).toBe(mint());
    expect(
      (
        await resolvePairingAttempt(
          JSON.stringify(first),
          { ...request, gatewayUrl: "https://other.example.com" },
          hashText,
          mint,
        )
      ).key,
    ).toBe(mint());
    expect(
      (
        await resolvePairingAttempt(
          JSON.stringify(first),
          { ...request, now: 1_000 + PAIRING_ATTEMPT_TTL_MS },
          hashText,
          mint,
        )
      ).key,
    ).toBe(mint());
  });

  it("ignores corrupt stored attempts", async () => {
    const mint = () => "n".repeat(43);
    for (const stored of ["not-json", "{}", JSON.stringify({ key: "short" }), 42]) {
      expect((await resolvePairingAttempt(stored, request, hashText, mint)).key).toBe(mint());
    }
    expect(isPairingAttempt({ gatewayUrl: "x", codeHash: "y", key: "z", at: 1 })).toBe(false);
  });
});
