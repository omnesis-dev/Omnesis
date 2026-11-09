// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import {
  cloudPairingCodeCommitment,
  cloudPairingVerificationCode,
  GOOGLE_PAIRING_STORAGE_KEY,
  googleAuthorizationUrl,
  newCloudPairing,
  restoreCloudPairing,
  // @ts-expect-error — the portal is JavaScript without sibling declarations.
} from "./cloud-pairing.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
test("browser verification code matches the gateway transcript and changes for a substituted gateway", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const request = newCloudPairing("Fictional browser", "a".repeat(64));
  expect(request.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/);
  const nonce = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
  const expected = await cloudPairingVerificationCode(request, "a".repeat(64), nonce);
  expect(expected).toMatch(/^[0-9]{3} [0-9]{3}$/);
  // The same six bytes of the same transcript, read as one number.
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-pairing-code-v3",
        "a".repeat(64),
        request.requestId,
        digest(request.secret),
        nonce,
      ]),
    )
    .digest();
  const digits = String(Number(bytes.readUIntBE(0, 6) % 1_000_000)).padStart(6, "0");
  expect(expected).toBe(`${digits.slice(0, 3)} ${digits.slice(3)}`);
  await expect(cloudPairingVerificationCode(request, "invalid", nonce)).rejects.toThrow();
  for (const invalid of [undefined, "", "short", `${nonce}=`, 7])
    await expect(cloudPairingVerificationCode(request, "a".repeat(64), invalid)).rejects.toThrow(
      "Invalid pairing reply.",
    );
  for (const [name, fingerprint] of [
    [" ", "a".repeat(64)],
    ["x".repeat(81), "a".repeat(64)],
    ["name", "invalid"],
  ]) {
    expect(() => newCloudPairing(name, fingerprint)).toThrow();
  }
});

test("only restores the matching private browser challenge within its lifetime", () => {
  vi.stubGlobal("crypto", webcrypto);
  const value = newCloudPairing("Fictional browser", "a".repeat(64));
  const storage = { getItem: vi.fn(() => JSON.stringify(value)) };
  expect(restoreCloudPairing(storage, value.requestId)).toEqual(value);
  expect(storage.getItem).toHaveBeenCalledWith(GOOGLE_PAIRING_STORAGE_KEY);
  expect(restoreCloudPairing(storage, "other")).toBeNull();
  for (const replacement of [
    null,
    {},
    { ...value, requestId: "invalid" },
    { ...value, secret: "invalid" },
    { ...value, gatewayFingerprint: "invalid" },
    { ...value, name: 1 },
    { ...value, name: " " },
    { ...value, name: "x".repeat(81) },
    { ...value, expiresAt: Date.now() - 1 },
    { ...value, expiresAt: Date.now() + 700_000 },
    { ...value, expiresAt: "tomorrow" },
  ]) {
    storage.getItem.mockReturnValue(JSON.stringify(replacement));
    expect(restoreCloudPairing(storage, replacement?.requestId)).toBeNull();
  }
  storage.getItem.mockReturnValue("malformed JSON");
  expect(restoreCloudPairing(storage, value.requestId)).toBeNull();
  storage.getItem.mockImplementation(() => {
    throw new Error("storage disabled");
  });
  expect(restoreCloudPairing(storage, value.requestId)).toBeNull();
});

test("Google navigation cannot become an open redirect or an HTTP downgrade", () => {
  expect(
    googleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=fictional"),
  ).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  for (const url of [
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://attacker.example.test/o/oauth2/v2/auth",
    "https://accounts.google.com/other",
    "https://user:@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth#fragment",
    "invalid",
  ]) {
    expect(() => googleAuthorizationUrl(url)).toThrow();
  }
});

test("managed web pairing accepts only its independently configured relay launch", () => {
  const relay = "https://relay.example.test";
  const url =
    relay +
    "/_relay/v2/google/browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
    "a".repeat(43);
  expect(googleAuthorizationUrl(url, relay)).toBe(url);
  expect(() => googleAuthorizationUrl(url)).toThrow("Invalid sign-in destination");
  expect(() => googleAuthorizationUrl(url, "https://other.example.test")).toThrow(
    "Invalid sign-in destination",
  );
});

import {
  base64url,
  deviceKeyThumbprint,
  enrollmentSignatureTranscript,
  fromBase64url,
  signEnrollment,
  // @ts-expect-error — the portal is JavaScript without sibling declarations.
} from "./cloud-pairing.js";
import {
  enrollmentSignatureTranscript as gatewayTranscript,
  verifyDeviceSignature,
} from "@omnesis/cloud-relay";

/** The cross-platform vectors from packages/cloud-relay/src/device-enrollment.test.ts. */
const VECTOR = {
  requestId: "11111111-2222-4333-8444-555555555555",
  kind: "ios",
  name: 'Maya’s iPhone "16"/é',
  devicePublicKey:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGDyDirEL2lrGjSPy-YBjzDVmi8d4E-aXEboSjkFDnKjznab2Nbec2vu4J71RIvZmTL820xIfaxzOyXItT91cdQ",
  challenge: "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw",
  gatewaySpkiFingerprint: "b".repeat(64),
};
test("the browser's enrollment transcript matches the shared cross-platform vectors byte for byte", async () => {
  vi.stubGlobal("crypto", webcrypto);
  expect(await deviceKeyThumbprint(VECTOR.devicePublicKey)).toBe(
    "cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba",
  );
  const transcript = await enrollmentSignatureTranscript(VECTOR);
  expect(transcript).toBe(
    '["omnesis-device-enrollment-signature-v3","11111111-2222-4333-8444-555555555555","ios","5c543853f1bb8064d21e95a3a933cfbbb10f33c138e380e7003a483501b0b7a9","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]',
  );
  expect(transcript).toBe(gatewayTranscript(VECTOR).toString());
});
test("a WebCrypto P1363 signature over the portal transcript verifies on the gateway", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const publicKey = base64url(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  const input = { ...VECTOR, kind: "portal", devicePublicKey: publicKey };
  const signature = await signEnrollment(
    pair.privateKey,
    await enrollmentSignatureTranscript(input),
  );
  expect(fromBase64url(signature)).toHaveLength(64);
  expect(verifyDeviceSignature(publicKey, gatewayTranscript(input), signature)).toBe(true);
  expect(
    verifyDeviceSignature(
      publicKey,
      gatewayTranscript({ ...input, challenge: "c".repeat(43) }),
      signature,
    ),
  ).toBe(false);
});
test("base64url round-trips every padding length without padding or URL-unsafe characters", () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 97 + 251) % 256);
    const encoded = base64url(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    expect([...fromBase64url(encoded)]).toEqual([...bytes]);
  }
});
test("a request with a device key records it and refuses malformed keys or fingerprints", () => {
  vi.stubGlobal("crypto", webcrypto);
  const deviceKey = {
    devicePublicKey: VECTOR.devicePublicKey,
    gatewaySpkiFingerprint: "c".repeat(64),
  };
  const value = newCloudPairing("Fictional browser", "a".repeat(64), deviceKey);
  expect(value).toMatchObject(deviceKey);
  expect(newCloudPairing("Fictional browser", "a".repeat(64))).not.toHaveProperty(
    "devicePublicKey",
  );
  for (const bad of [
    { ...deviceKey, devicePublicKey: "short" },
    { ...deviceKey, gatewaySpkiFingerprint: "nope" },
  ])
    expect(() => newCloudPairing("Fictional browser", "a".repeat(64), bad)).toThrow();
  const storage = { getItem: vi.fn(() => JSON.stringify(value)) };
  expect(restoreCloudPairing(storage, value.requestId)).toEqual(value);
  for (const replacement of [
    { ...value, devicePublicKey: 7 },
    { ...value, devicePublicKey: "short" },
    { ...value, gatewaySpkiFingerprint: undefined },
    { ...value, gatewaySpkiFingerprint: "nope" },
  ]) {
    storage.getItem.mockReturnValue(JSON.stringify(replacement));
    expect(restoreCloudPairing(storage, value.requestId)).toBeNull();
  }
});

test("the commitment and the code match the vectors every platform shares", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const request = { requestId: "11111111-2222-4333-8444-555555555555", secret: "a".repeat(64) };
  for (const [codeNonce, challenge, code] of [
    [
      "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk",
      "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs",
      "465 774",
    ],
    [
      "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY",
      "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80",
      "081 434",
    ],
    [
      "1uSZpIa4poPLc_3XyndwQ-G7g8lP8Pqu8nqTsJIylT4",
      "Dp9I5hCYSrL266BmkV4wY-XWhsBYfJBky-T5WZTnOos",
      "003 579",
    ],
  ]) {
    expect(await cloudPairingCodeCommitment(codeNonce)).toBe(challenge);
    expect(await cloudPairingVerificationCode(request, "c".repeat(64), codeNonce)).toBe(code);
  }
  // Another certificate, another code.
  expect(
    await cloudPairingVerificationCode(
      request,
      "d".repeat(64),
      "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk",
    ),
  ).toBe("531 664");
  for (const invalid of [undefined, "", "short", 7])
    await expect(cloudPairingCodeCommitment(invalid)).rejects.toThrow("Invalid pairing reply.");
});
