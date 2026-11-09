// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  GooglePairingRequests,
  enrollmentNonce,
  localIdentityProvider,
  type AccountBrowserPort,
  type AccountBrowserPending,
} from "@omnesis/cloud-relay";
import { afterEach, expect, test, vi } from "vitest";
import { ManagedWebAccountPairing } from "./ManagedWebAccountPairing.js";
const key = randomBytes(32),
  owner = { issuer: "omnesis-local-test", subject: "fictional-owner", expiresAt: 4_000_000_000 };
afterEach(() => vi.useRealTimers());
function fixture() {
  const createPairing = vi.fn(async () => ({
    pairingCode: "fictional-code",
    expiresAt: Date.now() + 60_000,
  }));
  const pairing = new GooglePairingRequests({
    identity: localIdentityProvider(key, "127.0.0.1"),
    ownerAccountId: createHash("sha256")
      .update(JSON.stringify([owner.issuer, owner.subject]))
      .digest("hex"),
    gatewayFingerprint: () => "a".repeat(64),
    createPairing,
  });
  const operationIds = new Map<string, string>();
  const broker: AccountBrowserPort = {
    available: () => true,
    authorizationOrigin: () => "https://relay.example.test",
    refresh: async () => {},
    cancel: () => {},
    unlink: async () => {},
    verifyEnrollment: async () => owner,
    callbackUrl: async (origin) => `${origin}/devices/account/callback`,
    begin: vi.fn(async (input) => {
      const operationId = randomUUID();
      operationIds.set(input.browserState, operationId);
      return {
        ...input,
        operationId,
        authorizeUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
        redemptionSecret: "private-test-secret",
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        relayOrigin: "https://relay.example.test",
        owner: {
          ownerAccountId: "a".repeat(64),
          gatewayId: "b7d97902-0e3d-4f92-8a4c-7ed5b0213b92",
          publicOrigin: "https://direct.example.test",
          tlsSpkiFingerprint: "a".repeat(64),
          ownerPublicKey: "synthetic",
        },
      };
    }),
    redeem: vi.fn(async (operation) => ({
      identityToken: await new SignJWT({ nonce: operation.nonce })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(owner.issuer)
        .setSubject(owner.subject)
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key),
      identity: owner,
    })),
  };
  const web = new ManagedWebAccountPairing({ broker, pairing });
  const request = () => ({
    requestId: randomUUID(),
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  });
  const callback = (state: string, origin = "https://direct.example.test") => {
    return `${origin}/devices/account/callback?operationId=${operationIds.get(state)}&state=${state}&result=${"r".repeat(43)}`;
  };
  return { web, broker, pairing, createPairing, request, callback };
}
test("account browser handoff returns to the initiating portal and still requires independent owner approval", async () => {
  const f = fixture(),
    request = f.request();
  const start = await f.web.begin(request, "https://direct.example.test");
  expect(start.authorizationUrl).toContain("relay.example.test");
  expect(start).not.toHaveProperty("redemptionSecret");
  expect(await f.web.complete(f.callback(start.browserState), start.browserState)).toBe(
    request.requestId,
  );
  expect(f.pairing.poll(request.requestId, request.secret).status).toBe("pending");
  expect(f.createPairing).not.toHaveBeenCalled();
  await expect(f.web.complete(f.callback(start.browserState), start.browserState)).rejects.toThrow(
    "already used",
  );
});
test("missing, duplicate, wrong-browser and substituted callback origins never redeem identity", async () => {
  const f = fixture(),
    start = await f.web.begin(f.request(), "https://direct.example.test");
  for (const [url, cookie] of [
    ["https://direct.example.test/devices/account/callback", ""],
    [f.callback(start.browserState), "x"],
    [f.callback(start.browserState) + `&state=${start.browserState}`, start.browserState],
    [f.callback(start.browserState) + "&result=duplicate", start.browserState],
    [f.callback(start.browserState), "x".repeat(43)],
  ])
    await expect(f.web.complete(url!, cookie!)).rejects.toThrow();
  expect(f.broker.redeem).not.toHaveBeenCalled();
  await expect(
    f.web.complete(
      f.callback(start.browserState, "https://other.example.test"),
      start.browserState,
    ),
  ).rejects.toThrow("expired");
  expect(f.broker.redeem).not.toHaveBeenCalled();
});
test("pending and concurrent admission is bounded; expiry, cancellation and late begin cannot create pairing grants", async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) await f.web.begin(f.request(), "https://direct.example.test");
  await expect(f.web.begin(f.request(), "https://direct.example.test")).rejects.toThrow("Too many");
  vi.useFakeTimers({ now: Date.now() + 301_000 });
  const start = await f.web.begin(f.request(), "https://direct.example.test");
  f.web.cancel();
  await expect(
    f.web.complete(f.callback(start.browserState), start.browserState),
  ).rejects.toThrow();
  const delayed = fixture();
  let release!: (value: AccountBrowserPending) => void;
  vi.mocked(delayed.broker.begin).mockImplementation(
    (input) =>
      new Promise((resolve) => {
        release = (value) => resolve({ ...value, ...input });
      }),
  );
  const pending = delayed.web.begin(delayed.request(), "https://direct.example.test");
  await Promise.resolve();
  await Promise.resolve();
  delayed.web.cancel();
  release({
    operationId: randomUUID(),
    purpose: "device-enrollment",
    nonce: "n".repeat(43),
    callbackUrl: "https://direct.example.test/devices/account/callback",
    browserState: "s".repeat(43),
    authorizeUrl: "https://relay.example.test",
    redemptionSecret: "secret",
    relayOrigin: "https://relay.example.test",
    owner: {
      ownerAccountId: "a".repeat(64),
      gatewayId: randomUUID(),
      publicOrigin: "https://direct.example.test",
      tlsSpkiFingerprint: "a".repeat(64),
      ownerPublicKey: "synthetic",
    },
    expiresAt: 4_000_000_000,
    issuedAt: 1,
  });
  await expect(pending).rejects.toThrow();
  expect(delayed.createPairing).not.toHaveBeenCalled();
});

test("a browser with a device key binds sign-in to its key and the gateway holds the proof for the signed request", async () => {
  const f = fixture();
  const hold = vi.spyOn(f.pairing, "holdProof");
  const start = vi.spyOn(f.pairing, "start");
  const devicePublicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url");
  const proof = {
    type: "google" as const,
    idToken: "header.payload.signature",
    salt: "s".repeat(43),
  };
  const redeem = vi.mocked(f.broker.redeem);
  const original = redeem.getMockImplementation()!;
  for (const extra of [
    { signInProof: proof, credentialPublicKey: "fictional-credential-key" },
    {},
  ]) {
    redeem.mockImplementationOnce(async (...args) => ({ ...(await original(...args)), ...extra }));
    const request = { ...f.request(), devicePublicKey };
    const begun = await f.web.begin(request, "https://direct.example.test");
    expect(vi.mocked(f.broker.begin).mock.lastCall![0].nonce).toBe(
      enrollmentNonce({ ...request, kind: "portal", devicePublicKey }),
    );
    expect(await f.web.complete(f.callback(begun.browserState), begun.browserState)).toBe(
      request.requestId,
    );
    const [requestId, held] = hold.mock.lastCall!;
    expect(requestId).toBe(request.requestId);
    expect(held).toEqual({
      identityToken: expect.any(String),
      ...(extra.signInProof ? { proof } : {}),
      ...(extra.credentialPublicKey ? { credentialPublicKey: extra.credentialPublicKey } : {}),
    });
  }
  expect(start).not.toHaveBeenCalled();
  expect(f.createPairing).not.toHaveBeenCalled();
});
