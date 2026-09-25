// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Direct coverage for the shared scrypt + AES-256-GCM sealing primitive that
 * both the recovery envelope and the passphrase secret store are built on. The
 * consumers have their own tests; these assert the primitive's own contract —
 * round-trip fidelity, the marker/AAD binding, and every rejection path.
 */

import { describe, expect, test } from "vitest";
import {
  openStringEnvelope,
  parseSealedEnvelope,
  sealStringEnvelope,
  SealedEnvelopeInvalidError,
  type SealedEnvelopeScope,
} from "./sealed-envelope.js";

const MARKER = "omnesis.test-scope.v1";
const PASSPHRASE = "correct horse battery staple";

describe("sealStringEnvelope / openStringEnvelope", () => {
  test("round-trips a value with a marker-only scope", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER };
    const env = sealStringEnvelope("super-secret-token", PASSPHRASE, scope);
    expect(env.omnesis).toBe(MARKER);
    expect(env.ciphertext).not.toContain("super-secret-token");
    expect(openStringEnvelope(env, PASSPHRASE, scope)).toBe("super-secret-token");
  });

  test("round-trips a value with a marker + aad scope", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER, aad: "entry-name" };
    const env = sealStringEnvelope("value-42", PASSPHRASE, scope);
    expect(openStringEnvelope(env, PASSPHRASE, scope)).toBe("value-42");
  });

  test("round-trips unicode and empty values", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER };
    for (const value of ["", "café ☕ — sk-\u{1f510}", "a".repeat(4096)]) {
      const env = sealStringEnvelope(value, PASSPHRASE, scope);
      expect(openStringEnvelope(env, PASSPHRASE, scope)).toBe(value);
    }
  });

  test("a fresh seal of the same value uses a random salt + iv", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER };
    const a = sealStringEnvelope("same", PASSPHRASE, scope);
    const b = sealStringEnvelope("same", PASSPHRASE, scope);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("a wrong passphrase is rejected, never returning garbage", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER };
    const env = sealStringEnvelope("secret", PASSPHRASE, scope);
    expect(() => openStringEnvelope(env, "wrong passphrase", scope)).toThrow(
      SealedEnvelopeInvalidError,
    );
  });

  test("the aad is bound: an envelope sealed under one aad will not open under another", () => {
    const env = sealStringEnvelope("secret", PASSPHRASE, { marker: MARKER, aad: "name-a" });
    // Right passphrase, right marker, WRONG aad → GCM auth fails.
    expect(() => openStringEnvelope(env, PASSPHRASE, { marker: MARKER, aad: "name-b" })).toThrow(
      SealedEnvelopeInvalidError,
    );
    // A marker-only scope is also a different AAD than marker+aad.
    expect(() => openStringEnvelope(env, PASSPHRASE, { marker: MARKER })).toThrow(
      SealedEnvelopeInvalidError,
    );
  });

  test("a foreign marker will not open even with the right passphrase", () => {
    const env = sealStringEnvelope("secret", PASSPHRASE, { marker: MARKER });
    expect(() => openStringEnvelope(env, PASSPHRASE, { marker: "omnesis.other-scope.v1" })).toThrow(
      SealedEnvelopeInvalidError,
    );
  });

  test("tampering with the ciphertext or tag is rejected", () => {
    const scope: SealedEnvelopeScope = { marker: MARKER };
    const env = sealStringEnvelope("secret", PASSPHRASE, scope);
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, "base64url");
      buf[0] ^= 0xff;
      return buf.toString("base64url");
    };
    expect(() =>
      openStringEnvelope({ ...env, ciphertext: flip(env.ciphertext) }, PASSPHRASE, scope),
    ).toThrow(SealedEnvelopeInvalidError);
    expect(() => openStringEnvelope({ ...env, tag: flip(env.tag) }, PASSPHRASE, scope)).toThrow(
      SealedEnvelopeInvalidError,
    );
  });
});

describe("parseSealedEnvelope", () => {
  test("accepts a well-formed envelope for its marker, without running the KDF", () => {
    const env = sealStringEnvelope("secret", PASSPHRASE, { marker: MARKER });
    const parsed = parseSealedEnvelope(JSON.parse(JSON.stringify(env)), MARKER);
    expect(parsed?.omnesis).toBe(MARKER);
  });

  test("rejects a foreign marker, non-objects, and malformed shapes", () => {
    const env = sealStringEnvelope("secret", PASSPHRASE, { marker: MARKER });
    expect(parseSealedEnvelope(env, "omnesis.other-scope.v1")).toBeNull();
    expect(parseSealedEnvelope(null, MARKER)).toBeNull();
    expect(parseSealedEnvelope("not-an-object", MARKER)).toBeNull();
    expect(parseSealedEnvelope({ omnesis: MARKER }, MARKER)).toBeNull();
  });
});
