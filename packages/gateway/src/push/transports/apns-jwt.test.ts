// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, test } from "vitest";

import { signApnsJwt } from "./apns-jwt.js";
import type { createPublicKey } from "node:crypto";

/**
 * Mint a P-256 EC key pair in the .p8-compatible PEM format. Apple
 * issues these keys as `BEGIN PRIVATE KEY` PKCS#8; Node's
 * `generateKeyPairSync` emits the same shape, so we can verify our
 * signer end-to-end without shelling out to OpenSSL.
 */
function mintP256Pem(): { privateKeyPem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  return { privateKeyPem, publicKey };
}

function base64urlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

describe("signApnsJwt", () => {
  test("produces a verifiable ES256 JWT in JWS-compact form", () => {
    const { privateKeyPem, publicKey } = mintP256Pem();
    const jwt = signApnsJwt({
      keyPem: privateKeyPem,
      keyId: "ABCDE12345",
      teamId: "TEAM123456",
      nowSeconds: 1_700_000_000,
    });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(base64urlDecode(parts[0]!).toString("utf8"));
    expect(header).toEqual({ alg: "ES256", kid: "ABCDE12345" });

    const claims = JSON.parse(base64urlDecode(parts[1]!).toString("utf8"));
    expect(claims).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });

    // ES256 raw signature is 64 bytes (32-byte R || 32-byte S).
    const sig = base64urlDecode(parts[2]!);
    expect(sig.length).toBe(64);

    // Verify with the public key — proves the signature is real
    // ES256 over the signing input, not an arbitrary blob.
    const verifier = createVerify("SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    const ok = verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
    expect(ok).toBe(true);
  });

  test("iat defaults to floor(Date.now() / 1000) when nowSeconds is omitted", () => {
    const { privateKeyPem } = mintP256Pem();
    const before = Math.floor(Date.now() / 1000);
    const jwt = signApnsJwt({
      keyPem: privateKeyPem,
      keyId: "ABCDE12345",
      teamId: "TEAM123456",
    });
    const after = Math.floor(Date.now() / 1000);
    const claims = JSON.parse(base64urlDecode(jwt.split(".")[1]!).toString("utf8")) as {
      iat: number;
    };
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
  });
});
