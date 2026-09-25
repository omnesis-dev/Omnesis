// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  COINBASE_JWT_NBF_BACKDATE_SECONDS,
  COINBASE_JWT_TTL_SECONDS,
  coinbaseJwtUri,
  signCoinbaseJwt,
} from "./jwt.js";

// Throwaway keys minted at runtime — no private key is ever committed (and the
// PEM banner literal is never written to the tree).
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ecPrivateKeyPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const ed = generateKeyPairSync("ed25519");
const edPrivateKeyPem = ed.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const KEY_ID = "organizations/00000000-0000-0000-0000-000000000000/apiKeys/test-key";
const NOW_S = 1_780_000_000;
const REQUEST = {
  method: "GET",
  host: "api.coinbase.com",
  path: "/api/v3/brokerage/accounts",
} as const;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

describe("coinbaseJwtUri", () => {
  test("formats METHOD host path with no scheme", () => {
    expect(coinbaseJwtUri(REQUEST)).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
  });

  test("uppercases the method", () => {
    expect(coinbaseJwtUri({ ...REQUEST, method: "get" })).toBe(
      "GET api.coinbase.com/api/v3/brokerage/accounts",
    );
  });
});

describe("signCoinbaseJwt — ES256 (EC P-256)", () => {
  test("pins the header (alg/kid/nonce) and claims (sub/iss/nbf/exp/uri)", () => {
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: ecPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
      nonce: "deadbeef",
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    expect(jwt.split(".")).toHaveLength(3);
    expect(signatureSeg).toBeTruthy();

    expect(decodeSegment(headerSeg)).toEqual({
      typ: "JWT",
      alg: "ES256",
      kid: KEY_ID,
      nonce: "deadbeef",
    });
    expect(decodeSegment(payloadSeg)).toEqual({
      sub: KEY_ID,
      iss: "cdp",
      nbf: NOW_S - COINBASE_JWT_NBF_BACKDATE_SECONDS,
      exp: NOW_S + COINBASE_JWT_TTL_SECONDS,
      uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
    });
    expect(COINBASE_JWT_TTL_SECONDS).toBe(120);
  });

  test("emits a JOSE raw (r‖s) 64-byte signature, not DER, that verifies", () => {
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: ecPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    const sig = Buffer.from(signatureSeg, "base64url");
    // JOSE P-256 signatures are exactly 64 bytes; a DER signature would be
    // ~70 and start with 0x30.
    expect(sig.length).toBe(64);

    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${headerSeg}.${payloadSeg}`, "utf-8"),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
    expect(ok).toBe(true);
  });

  test("accepts a PEM whose newlines were escaped twice", () => {
    // A value copied out of JSON that was itself serialised arrives with
    // `\\n`. Reading only a single backslash left one at the end of every
    // line, and the key was refused as unparseable.
    const doubled = ecPrivateKeyPem.replace(/\n/g, "\\\\n");
    expect(doubled).toContain("\\\\n");
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: doubled,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${headerSeg}.${payloadSeg}`, "utf-8"),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureSeg, "base64url"),
    );
    expect(ok).toBe(true);
  });

  test("accepts a PEM pasted with escaped newlines (CDP key-file format)", () => {
    // The CDP key file stores the private key as a JSON string with literal
    // `\n`; a user who pastes that value would otherwise hit
    // `error:1E08010C:DECODER routines::unsupported`.
    const escaped = ecPrivateKeyPem.replace(/\n/g, "\\n");
    expect(escaped).toContain("\\n");
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: escaped,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    expect(jwt.split(".")).toHaveLength(3);
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${headerSeg}.${payloadSeg}`, "utf-8"),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureSeg, "base64url"),
    );
    expect(ok).toBe(true);
  });

  test("throws an actionable error (not the raw OpenSSL code) on an unparseable key", () => {
    expect(() =>
      signCoinbaseJwt({
        keyId: KEY_ID,
        privateKeyPem: "not-a-pem",
        request: REQUEST,
        nowEpochSeconds: NOW_S,
      }),
    ).toThrow(/could not parse the API private key/);
  });

  test("a fresh nonce is generated per call when not overridden", () => {
    const opts = {
      keyId: KEY_ID,
      privateKeyPem: ecPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    };
    const a = decodeSegment(signCoinbaseJwt(opts).split(".")[0]);
    const b = decodeSegment(signCoinbaseJwt(opts).split(".")[0]);
    expect(a.nonce).toBeTruthy();
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("backdates nbf for clock skew; exp stays relative to the real now", () => {
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: ecPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S + 0.9,
    });
    const payload = decodeSegment(jwt.split(".")[1]);
    expect(payload.nbf).toBe(NOW_S - COINBASE_JWT_NBF_BACKDATE_SECONDS);
    expect(payload.exp).toBe(NOW_S + COINBASE_JWT_TTL_SECONDS);
  });

  test("tampering with the payload breaks verification", () => {
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: ecPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, , signatureSeg] = jwt.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: "evil" })).toString("base64url");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${headerSeg}.${forged}`, "utf-8"),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureSeg, "base64url"),
    );
    expect(ok).toBe(false);
  });
});

describe("signCoinbaseJwt — EdDSA (Ed25519)", () => {
  test("sets alg EdDSA and produces a signature that verifies", () => {
    const jwt = signCoinbaseJwt({
      keyId: KEY_ID,
      privateKeyPem: edPrivateKeyPem,
      request: REQUEST,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    expect(decodeSegment(headerSeg).alg).toBe("EdDSA");
    // Ed25519 signatures are 64 raw bytes.
    expect(Buffer.from(signatureSeg, "base64url").length).toBe(64);

    const ok = cryptoVerify(
      null,
      Buffer.from(`${headerSeg}.${payloadSeg}`, "utf-8"),
      ed.publicKey,
      Buffer.from(signatureSeg, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("signCoinbaseJwt — unsupported keys", () => {
  test("rejects an RSA key with a clear error", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(() =>
      signCoinbaseJwt({
        keyId: KEY_ID,
        privateKeyPem: rsaPem,
        request: REQUEST,
        nowEpochSeconds: NOW_S,
      }),
    ).toThrow(/unsupported key type/i);
  });

  test("rejects an EC key on the wrong curve", () => {
    const wrong = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const wrongPem = wrong.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(() =>
      signCoinbaseJwt({
        keyId: KEY_ID,
        privateKeyPem: wrongPem,
        request: REQUEST,
        nowEpochSeconds: NOW_S,
      }),
    ).toThrow(/P-256/i);
  });
});
