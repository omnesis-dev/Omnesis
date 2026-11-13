// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  deviceKeyThumbprint,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  formatPairingCode,
  googleProofNonce,
  pairingCodeCommitment,
  pairingCodeSchema,
  pairingComparisonCode,
  parseDevicePublicKey,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signDeviceTranscript,
  signInProofNonce,
  signInProofSchema,
  tokenRotationTranscript,
  verifyDeviceSignature,
} from "./device-enrollment.js";

/**
 * Cross-platform vectors. ios/Tests and android tests assert these same values,
 * so a change here must be made in all three places.
 */
const VECTOR = {
  requestId: "11111111-2222-4333-8444-555555555555",
  kind: "ios" as const,
  name: 'Maya’s iPhone "16"/é',
  secret: "a".repeat(64),
  devicePublicKey:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGDyDirEL2lrGjSPy-YBjzDVmi8d4E-aXEboSjkFDnKjznab2Nbec2vu4J71RIvZmTL820xIfaxzOyXItT91cdQ",
  salt: "c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ",
  issuedAt: "1794240000",
  challenge: "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw",
  gatewaySpkiFingerprint: "b".repeat(64),
};

describe("cross-platform vectors", () => {
  const nonce = enrollmentNonce(VECTOR);
  test("thumbprint", () => {
    expect(deviceKeyThumbprint(VECTOR.devicePublicKey)).toBe(
      "cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba",
    );
  });
  test("enrollment nonce", () => {
    expect(nonce).toBe("omSCKSEVp23kSohLBrNIqacoYRMiGzYGcjIUhbS6Utw");
  });
  test("google nonce", () => {
    expect(googleProofNonce(VECTOR.salt, nonce)).toBe(
      "Z8TU9qZKGsXtT1SY13KcNLty5tRqlNr5UOvTqPcJeLc",
    );
  });
  test("passkey challenge", () => {
    expect(passkeyProofChallenge(VECTOR.salt, VECTOR.issuedAt, nonce)).toBe(
      "f-WX4FvBop2svycIMkHI019J6CxVseoBQsoKmoY5fHo",
    );
  });
  test("signature transcript", () => {
    expect(enrollmentSignatureTranscript(VECTOR).toString()).toBe(
      '["omnesis-device-enrollment-signature-v3","11111111-2222-4333-8444-555555555555","ios","5c543853f1bb8064d21e95a3a933cfbbb10f33c138e380e7003a483501b0b7a9","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]',
    );
  });
  test("rotation transcript", () => {
    expect(
      tokenRotationTranscript({
        deviceId: "99999999-8888-4777-8666-555555555555",
        gatewaySpkiFingerprint: VECTOR.gatewaySpkiFingerprint,
        challenge: VECTOR.challenge,
        devicePublicKey: VECTOR.devicePublicKey,
      }).toString(),
    ).toBe(
      '["omnesis-device-token-rotation-v1","99999999-8888-4777-8666-555555555555","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]',
    );
  });
  test("the vector key parses as P-256", () => {
    expect(parseDevicePublicKey(VECTOR.devicePublicKey).asymmetricKeyType).toBe("ec");
  });
});

/**
 * Comparison code vectors, shared with iOS, Android and the portal like the ones above.
 * `digest` is the SHA-256 of the transcript; its first six bytes, big-endian, modulo 1,000,000
 * are the code. The rows cover a first byte above 0x7f (a signed or 32-bit reading goes wrong)
 * and codes that begin with zeros (the padding must be kept).
 */
const CODE_VECTOR = {
  requestId: VECTOR.requestId,
  secret: VECTOR.secret,
  gatewayFingerprint: "c".repeat(64),
  rows: [
    {
      codeNonce: "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk",
      challenge: "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs",
      digest: "a135dede8d6e83ba3cc0c7ab60f6d6555e1fbe2f3592651ae338ca1139c0ab5a",
      code: "465 774",
    },
    {
      codeNonce: "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY",
      challenge: "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80",
      digest: "baae09897dda8c2e3cee88b712f71b7795a39d6e315f60d52e0e3afd20fab89a",
      code: "081 434",
    },
    {
      codeNonce: "1uSZpIa4poPLc_3XyndwQ-G7g8lP8Pqu8nqTsJIylT4",
      challenge: "Dp9I5hCYSrL266BmkV4wY-XWhsBYfJBky-T5WZTnOos",
      digest: "303047ca4c3bfbcc6b5d2a9517775f37bfe94b7ea21cd469f469a54041b299c2",
      code: "003 579",
    },
  ],
  /** The first row's request seen through another certificate. */
  otherGatewayFingerprint: "d".repeat(64),
  otherGatewayCode: "531 664",
};

describe("comparison code", () => {
  const { rows, otherGatewayFingerprint, otherGatewayCode, ...request } = CODE_VECTOR;
  const first = { ...request, codeNonce: rows[0]!.codeNonce };

  test("cross-platform vectors", () => {
    for (const row of rows) {
      expect(pairingCodeCommitment(row.codeNonce)).toBe(row.challenge);
      expect(pairingComparisonCode({ ...request, codeNonce: row.codeNonce })).toBe(row.code);
      // The published digest is the transcript's, so another platform can check each step.
      const transcript = JSON.stringify([
        "omnesis-pairing-code-v3",
        request.gatewayFingerprint,
        request.requestId,
        createHash("sha256").update(request.secret).digest("hex"),
        row.codeNonce,
      ]);
      const digest = createHash("sha256").update(transcript).digest();
      expect(digest.toString("hex")).toBe(row.digest);
      expect(Number(BigInt(`0x${row.digest.slice(0, 12)}`) % 1_000_000n)).toBe(
        Number(row.code.replace(" ", "")),
      );
    }
    expect(pairingComparisonCode({ ...first, gatewayFingerprint: otherGatewayFingerprint })).toBe(
      otherGatewayCode,
    );
  });

  test("every input changes the code, and each code is six grouped digits", () => {
    const code = pairingComparisonCode(first);
    const others = [
      { ...first, gatewayFingerprint: otherGatewayFingerprint },
      { ...first, requestId: "11111111-2222-4333-8444-555555555556" },
      { ...first, secret: "b".repeat(64) },
      { ...first, codeNonce: rows[1]!.codeNonce },
    ].map(pairingComparisonCode);
    for (const other of [code, ...others])
      expect(pairingCodeSchema.safeParse(other).success).toBe(true);
    // Four unrelated six-digit values colliding with the first would be a broken derivation.
    expect(others).not.toContain(code);
  });

  test("refuses a malformed certificate fingerprint or nonce instead of deriving from it", () => {
    expect(() => pairingComparisonCode({ ...first, gatewayFingerprint: "C".repeat(64) })).toThrow();
    expect(() => pairingComparisonCode({ ...first, codeNonce: "short" })).toThrow();
    expect(() => pairingCodeCommitment("short")).toThrow();
  });

  test("the commitment hides the nonce and is not the nonce's plain hash", () => {
    const nonce = rows[0]!.codeNonce;
    expect(pairingCodeCommitment(nonce)).not.toBe(nonce);
    expect(pairingCodeCommitment(nonce)).not.toBe(
      createHash("sha256").update(nonce).digest("base64url"),
    );
    expect(pairingCodeCommitment(nonce)).not.toBe(pairingCodeCommitment(rows[1]!.codeNonce));
  });

  test("codes are spread evenly over the six digits", () => {
    // 20,000 nonces over 10 leading digits: each expects 2,000, and a truncation that favoured
    // some digits (a modulo of too few bits, a dropped leading zero) would stand out.
    const counts = new Array<number>(10).fill(0);
    for (let index = 0; index < 20_000; index++) {
      const codeNonce = createHash("sha256").update(`spread ${index}`).digest("base64url");
      counts[Number(pairingComparisonCode({ ...request, codeNonce })[0])]!++;
    }
    for (const count of counts) expect(Math.abs(count - 2000)).toBeLessThan(250);
  });

  test("one formatter: typed digits with spaces or hyphens become the shown form", () => {
    expect(formatPairingCode("465774")).toBe("465 774");
    expect(formatPairingCode(" 465 774\n")).toBe("465 774");
    expect(formatPairingCode("465-774")).toBe("465 774");
    expect(formatPairingCode("003579")).toBe("003 579");
    for (const wrong of ["", "46577", "4657745", "46577a", "４６５７７４", "465.774", "+65774"])
      expect(formatPairingCode(wrong)).toBeUndefined();
    expect(pairingCodeSchema.safeParse("465774").success).toBe(false);
    expect(pairingCodeSchema.safeParse("465  774").success).toBe(false);
  });
});

describe("device signatures", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const transcript = Buffer.from("transcript");

  test("verifies DER signatures from native clients", () => {
    expect(
      verifyDeviceSignature(
        publicKey,
        transcript,
        signDeviceTranscript(pair.privateKey, transcript),
      ),
    ).toBe(true);
  });
  test("verifies IEEE P1363 signatures from WebCrypto", () => {
    const signature = sign("sha256", transcript, {
      key: pair.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    expect(verifyDeviceSignature(publicKey, transcript, signature)).toBe(true);
  });
  test("refuses another transcript, garbage and non-canonical encodings", () => {
    const signature = signDeviceTranscript(pair.privateKey, transcript);
    expect(verifyDeviceSignature(publicKey, Buffer.from("other"), signature)).toBe(false);
    expect(verifyDeviceSignature(publicKey, transcript, "A".repeat(90))).toBe(false);
    expect(verifyDeviceSignature(publicKey, transcript, signature + "=")).toBe(false);
    // Spare bits in the last character make a second spelling of the same bytes.
    expect(verifyDeviceSignature(publicKey, transcript, "A".repeat(65) + "B")).toBe(false);
    expect(verifyDeviceSignature("not-a-key".repeat(10), transcript, signature)).toBe(false);
  });
  test("refuses keys that are not P-256", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const encoded = other.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    expect(() => parseDevicePublicKey(encoded)).toThrow("P-256");
    const ed = generateKeyPairSync("ed25519").publicKey;
    expect(() =>
      parseDevicePublicKey(
        createPublicKey(ed).export({ type: "spki", format: "der" }).toString("base64url"),
      ),
    ).toThrow();
  });
});

describe("sign-in proof schema", () => {
  test("rejects unknown fields and unknown types", () => {
    expect(
      signInProofSchema.safeParse({ type: "google", idToken: "x", salt: "a".repeat(43), extra: 1 })
        .success,
    ).toBe(false);
    expect(signInProofSchema.safeParse({ type: "relay", idToken: "x" }).success).toBe(false);
  });
  test("accepts a Google proof", () => {
    expect(
      signInProofSchema.safeParse({ type: "google", idToken: "x", salt: "a".repeat(43) }).success,
    ).toBe(true);
  });
});

describe("passkey endorsement", () => {
  test("the nonce names one passkey id and public key, and nothing else", () => {
    const id = "Y3JlZGVudGlhbC1pZA",
      publicKey = "cHVibGljLWtleQ";
    // The relay and every gateway derive this same value.
    expect(passkeyEndorsementNonce(id, publicKey)).toBe(
      "MzDlQtEtG05JVFHKoJRzWS19ZC-uUFdEDbdmUal3l9s",
    );
    const others = [
      passkeyEndorsementNonce(id + "A", publicKey),
      passkeyEndorsementNonce(id, publicKey + "A"),
      // Moving a character across the boundary names a different passkey.
      passkeyEndorsementNonce(id + "c", "HVibGljLWtleQ"),
      passkeyEndorsementNonce(publicKey, id),
      // A sign-in for an enrollment or another proof can't be mistaken for a vouching.
      googleProofNonce(id, publicKey),
      passkeyProofChallenge(id, "1794240000", publicKey),
    ];
    expect(new Set([passkeyEndorsementNonce(id, publicKey), ...others]).size).toBe(7);
  });
});

describe("sign-in purposes", () => {
  const nonce = enrollmentNonce(VECTOR);
  test("an enrollment sign-in commits to the device's own nonce, which the native apps compute", () => {
    expect(signInProofNonce("device-enrollment", nonce)).toBe(nonce);
  });
  test("a link sign-in commits to the gateway's nonce under its own label, never to an enrollment nonce", () => {
    const linked = signInProofNonce("gateway-link", nonce);
    expect(linked).toBe(
      createHash("sha256")
        .update(JSON.stringify(["omnesis-gateway-link-proof-v1", nonce]))
        .digest("base64url"),
    );
    expect(linked).not.toBe(nonce);
    expect(googleProofNonce(VECTOR.salt, linked)).not.toBe(googleProofNonce(VECTOR.salt, nonce));
    expect(passkeyProofChallenge(VECTOR.salt, VECTOR.issuedAt, linked)).not.toBe(
      passkeyProofChallenge(VECTOR.salt, VECTOR.issuedAt, nonce),
    );
  });
});
