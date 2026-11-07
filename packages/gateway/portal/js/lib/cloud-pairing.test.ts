// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import {
  cloudPairingVerificationCode,
  GOOGLE_PAIRING_STORAGE_KEY,
  googleAuthorizationUrl,
  newCloudPairing,
  restoreCloudPairing,
  // @ts-expect-error — the portal is JavaScript without sibling declarations.
} from "./cloud-pairing.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
test("browser verification code matches the gateway transcript and changes for a substituted gateway", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const request = newCloudPairing("Fictional browser", "a".repeat(64));
  expect(request.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/);
  const expected = digest(JSON.stringify(["omnesis-pairing-sas-v2", "a".repeat(64),
    request.requestId, digest(request.secret)])).slice(0, 20).toUpperCase().match(/.{4}/g)!.join("-");
  expect(await cloudPairingVerificationCode(request, "a".repeat(64))).toBe(expected);
  expect(await cloudPairingVerificationCode(request, "b".repeat(64))).not.toBe(expected);
  await expect(cloudPairingVerificationCode(request, "invalid")).rejects.toThrow();
  for (const [name, fingerprint] of [[" ", "a".repeat(64)], ["x".repeat(81), "a".repeat(64)], ["name", "invalid"]]) {
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
  for (const replacement of [null, {}, { ...value, requestId: "invalid" }, { ...value, secret: "invalid" },
    { ...value, gatewayFingerprint: "invalid" }, { ...value, name: 1 }, { ...value, name: " " },
    { ...value, name: "x".repeat(81) }, { ...value, expiresAt: Date.now() - 1 },
    { ...value, expiresAt: Date.now() + 700_000 }, { ...value, expiresAt: "tomorrow" }]) {
    storage.getItem.mockReturnValue(JSON.stringify(replacement));
    expect(restoreCloudPairing(storage, replacement?.requestId)).toBeNull();
  }
  storage.getItem.mockReturnValue("malformed JSON");
  expect(restoreCloudPairing(storage, value.requestId)).toBeNull();
  storage.getItem.mockImplementation(() => { throw new Error("storage disabled"); });
  expect(restoreCloudPairing(storage, value.requestId)).toBeNull();
});

test("Google navigation cannot become an open redirect or an HTTP downgrade", () => {
  expect(googleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=fictional"))
    .toBe("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  for (const url of ["http://accounts.google.com/o/oauth2/v2/auth", "https://attacker.example.test/o/oauth2/v2/auth",
    "https://accounts.google.com/other", "https://user:@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth#fragment", "invalid"]) {
    expect(() => googleAuthorizationUrl(url)).toThrow();
  }
});


test("managed web pairing accepts only its independently configured relay launch", () => {
  const relay = "https://relay.example.test";
  const url = relay + "/_relay/v2/google/browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" + "a".repeat(43);
  expect(googleAuthorizationUrl(url, relay)).toBe(url);
  expect(() => googleAuthorizationUrl(url)).toThrow("Invalid Google sign-in destination");
  expect(() => googleAuthorizationUrl(url, "https://other.example.test")).toThrow("Invalid Google sign-in destination");
});
