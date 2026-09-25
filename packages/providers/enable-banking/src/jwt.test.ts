// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EB_JWT_IAT_BACKDATE_SECONDS, EB_JWT_TTL_SECONDS, signEnableBankingJwt } from "./jwt.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const APP_ID = "11111111-2222-3333-4444-555555555555";
const NOW_S = 1_780_000_000;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

describe("signEnableBankingJwt", () => {
  test("pins the exact header and payload claims (iat backdated 60s for clock skew)", () => {
    const jwt = signEnableBankingJwt({
      applicationId: APP_ID,
      privateKeyPem,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    expect(signatureSeg).toBeTruthy();

    expect(decodeSegment(headerSeg)).toEqual({ typ: "JWT", alg: "RS256", kid: APP_ID });
    expect(decodeSegment(payloadSeg)).toEqual({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: NOW_S - EB_JWT_IAT_BACKDATE_SECONDS,
      exp: NOW_S + EB_JWT_TTL_SECONDS,
    });
    expect(EB_JWT_IAT_BACKDATE_SECONDS).toBe(60);
  });

  test("floors fractional epoch seconds; exp stays relative to the real now", () => {
    const jwt = signEnableBankingJwt({
      applicationId: APP_ID,
      privateKeyPem,
      nowEpochSeconds: NOW_S + 0.75,
    });
    const payload = decodeSegment(jwt.split(".")[1]);
    expect(payload.iat).toBe(NOW_S - 60);
    expect(payload.exp).toBe(NOW_S + 3600);
  });

  test("produces a signature that verifies against the public key", () => {
    const jwt = signEnableBankingJwt({
      applicationId: APP_ID,
      privateKeyPem,
      nowEpochSeconds: NOW_S,
    });
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${payloadSeg}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signatureSeg, "base64url"))).toBe(true);

    // Tampering with the payload must break verification.
    const tamperedPayload = Buffer.from(JSON.stringify({ iss: "evil" })).toString("base64url");
    const verifier2 = createVerify("RSA-SHA256");
    verifier2.update(`${headerSeg}.${tamperedPayload}`);
    verifier2.end();
    expect(verifier2.verify(publicKey, Buffer.from(signatureSeg, "base64url"))).toBe(false);
  });
});
