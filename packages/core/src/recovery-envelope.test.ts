// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createRecoveryEnvelope,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openRecoveryEnvelope,
  parseRecoveryEnvelope,
  RecoveryCodeInvalidError,
  type RecoveryEnvelopeV1,
} from "./recovery-envelope.js";

function fakeRootKey(): string {
  return `omn_root_v1_${randomBytes(32).toString("base64url")}`;
}

describe("recovery envelope", () => {
  test("round-trips the root key with the correct code", () => {
    const rootKey = fakeRootKey();
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(rootKey, code);
    expect(openRecoveryEnvelope(envelope, code)).toBe(rootKey);
  });

  test("the envelope does not contain the plaintext root key", () => {
    const rootKey = fakeRootKey();
    const envelope = createRecoveryEnvelope(rootKey, generateRecoveryCode());
    expect(JSON.stringify(envelope)).not.toContain(rootKey);
    expect(JSON.stringify(envelope)).not.toContain(rootKey.slice("omn_root_v1_".length));
  });

  test("a wrong code throws RecoveryCodeInvalidError", () => {
    const envelope = createRecoveryEnvelope(fakeRootKey(), generateRecoveryCode());
    expect(() => openRecoveryEnvelope(envelope, generateRecoveryCode())).toThrow(
      RecoveryCodeInvalidError,
    );
  });

  test("the code matches regardless of hyphens/whitespace/case", () => {
    const rootKey = fakeRootKey();
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(rootKey, code);
    const retyped = ` ${code.replace(/-/g, "").toLowerCase()} `;
    expect(normalizeRecoveryCode(retyped)).toBe(normalizeRecoveryCode(code));
    expect(openRecoveryEnvelope(envelope, retyped)).toBe(rootKey);
  });

  test("a tampered ciphertext is rejected (GCM auth tag)", () => {
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(fakeRootKey(), code);
    const flipped = Buffer.from(envelope.ciphertext, "base64url");
    flipped[0] ^= 0xff;
    const tampered = { ...envelope, ciphertext: flipped.toString("base64url") };
    expect(() => openRecoveryEnvelope(tampered, code)).toThrow(RecoveryCodeInvalidError);
  });

  test("a wrong version/marker is rejected", () => {
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(fakeRootKey(), code);
    expect(() => openRecoveryEnvelope({ ...envelope, version: 2 as 1 }, code)).toThrow(
      RecoveryCodeInvalidError,
    );
  });

  test("rejects out-of-spec scrypt params fast, before running the KDF (DoS guard)", () => {
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(fakeRootKey(), code);
    // Inflated cost params (large N×p, small r) that stay under the maxmem cap
    // would pin a CPU for seconds-to-hours in scrypt if trusted. The guard must
    // reject them from a cheap field comparison, before deriving the KEK.
    const hostile = { ...envelope, n: 1 << 16, r: 1, p: 1 << 8 };
    const start = performance.now();
    expect(() => openRecoveryEnvelope(hostile, code)).toThrow(RecoveryCodeInvalidError);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test("two envelopes for the same key+code differ (random salt/iv)", () => {
    const rootKey = fakeRootKey();
    const code = generateRecoveryCode();
    const a = createRecoveryEnvelope(rootKey, code);
    const b = createRecoveryEnvelope(rootKey, code);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
    // Both still recover correctly.
    expect(openRecoveryEnvelope(a, code)).toBe(rootKey);
    expect(openRecoveryEnvelope(b, code)).toBe(rootKey);
  });

  test("generated codes are grouped Crockford-base32 with real entropy", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
    // 160 bits → 32 base32 chars → 8 groups of 4.
    expect(normalizeRecoveryCode(code)).toHaveLength(32);
    // Unlikely to collide across a handful of draws.
    const codes = new Set(Array.from({ length: 20 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(20);
  });
});

describe("parseRecoveryEnvelope", () => {
  test("returns the typed envelope for a well-formed v1 escrow", () => {
    const envelope = createRecoveryEnvelope(fakeRootKey(), generateRecoveryCode());
    const parsed = parseRecoveryEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(parsed).toEqual(envelope);
  });

  test("returns null for non-object inputs", () => {
    expect(parseRecoveryEnvelope(null)).toBeNull();
    expect(parseRecoveryEnvelope("string")).toBeNull();
    expect(parseRecoveryEnvelope(42)).toBeNull();
  });

  test("returns null when the marker or version is wrong", () => {
    const envelope = createRecoveryEnvelope(fakeRootKey(), generateRecoveryCode());
    expect(parseRecoveryEnvelope({ ...envelope, omnesis: "not-omnesis" })).toBeNull();
    expect(parseRecoveryEnvelope({ ...envelope, version: 2 })).toBeNull();
  });

  test("returns null when the pinned scrypt parameters are altered", () => {
    const envelope = createRecoveryEnvelope(fakeRootKey(), generateRecoveryCode());
    expect(parseRecoveryEnvelope({ ...envelope, n: envelope.n * 2 })).toBeNull();
    expect(parseRecoveryEnvelope({ ...envelope, r: 1 })).toBeNull();
    expect(parseRecoveryEnvelope({ ...envelope, p: 99 })).toBeNull();
  });

  test("returns null when a ciphertext field is missing or non-string", () => {
    const envelope = createRecoveryEnvelope(fakeRootKey(), generateRecoveryCode());
    const { ciphertext: _dropped, ...withoutCiphertext } = envelope;
    expect(parseRecoveryEnvelope(withoutCiphertext)).toBeNull();
    expect(parseRecoveryEnvelope({ ...envelope, salt: 123 })).toBeNull();
  });
});

describe("frozen wire-format compatibility", () => {
  // Sealed once with a fixed code and embedded verbatim: if the KDF input,
  // AAD bytes, or envelope shape ever drift, this stops opening and CI reddens
  // — protecting every recovery envelope users have already printed codes for.
  const FROZEN_CODE = "H2M9-4KQ7-TEST-CODE-AAAA-BBBB-CCCC-DDDD";
  const FROZEN_ROOT = "omn_root_v1_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
  const FROZEN_ENVELOPE = {
    omnesis: "omnesis.recovery-key",
    version: 1,
    alg: "aes-256-gcm",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: "x61WhBPVAb6G8tRNGBXlAw",
    iv: "ePYckIhshZ5Np85b",
    tag: "HlzmZLXKlaX0-i0Fg2xg9w",
    ciphertext: "c5qOaL7Vta0sYzdrd3U6_z9zvngOBvurPprBfqHJCSfjYgo7dps4WykYAMIXzl_rfog5FwL2sQ",
  } as const;

  test("an envelope sealed by an earlier build still opens", () => {
    expect(openRecoveryEnvelope(FROZEN_ENVELOPE as RecoveryEnvelopeV1, FROZEN_CODE)).toBe(
      FROZEN_ROOT,
    );
  });

  test("the frozen envelope still opens from a retyped, lower-cased code", () => {
    expect(
      openRecoveryEnvelope(
        FROZEN_ENVELOPE as RecoveryEnvelopeV1,
        FROZEN_CODE.toLowerCase().replaceAll("-", " "),
      ),
    ).toBe(FROZEN_ROOT);
  });
});
