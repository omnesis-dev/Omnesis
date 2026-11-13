// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  GooglePairingRequests,
  localIdentityProvider,
  type GoogleBrowserPort,
  type GoogleBrowserPending,
} from "@omnesis/cloud-relay";
import { afterEach, expect, test, vi } from "vitest";
import { ManagedWebGooglePairing } from "./ManagedWebGooglePairing.js";
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
  const broker: GoogleBrowserPort = {
    clientId: () => "fictional-client",
    deviceIdentity: () => undefined,
    callbackUrl: async (origin) => `${origin}/devices/google/callback`,
    begin: vi.fn(async (input) => ({
      ...input,
      operationId: randomUUID(),
      authorizeUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
      redemptionSecret: "private-test-secret",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      clientId: "fictional-client",
    })),
    redeem: vi.fn(async (operation) => ({
      idToken: await new SignJWT({ nonce: operation.nonce })
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
  const web = new ManagedWebGooglePairing({ broker, pairing });
  const request = () => ({
    requestId: randomUUID(),
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  });
  const callback = (state: string, origin = "https://direct.example.test") =>
    `${origin}/devices/google/callback?state=${state}&brokerResult=${"r".repeat(43)}`;
  return { web, broker, pairing, createPairing, request, callback };
}
test("central browser handoff returns to the initiating portal and still requires independent owner approval", async () => {
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
    ["https://direct.example.test/devices/google/callback", ""],
    [f.callback(start.browserState), "x"],
    [f.callback(start.browserState) + `&state=${start.browserState}`, start.browserState],
    [f.callback(start.browserState) + "&brokerResult=duplicate", start.browserState],
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
  let release!: (value: GoogleBrowserPending) => void;
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
    callbackUrl: "https://direct.example.test/devices/google/callback",
    browserState: "s".repeat(43),
    authorizeUrl: "https://relay.example.test",
    redemptionSecret: "secret",
    clientId: "client",
    expiresAt: 4_000_000_000,
    issuedAt: 1,
  });
  await expect(pending).rejects.toThrow();
  expect(delayed.createPairing).not.toHaveBeenCalled();
});

test("a device key offered to managed Google sign-in is ignored, so the request is still held for comparison", async () => {
  const f = fixture(),
    request = f.request();
  const start = await f.web.begin(
    { ...request, devicePublicKey: "k".repeat(91) },
    "https://direct.example.test",
  );
  expect(await f.web.complete(f.callback(start.browserState), start.browserState)).toBe(
    request.requestId,
  );
  expect(f.pairing.poll(request.requestId, request.secret).status).toBe("pending");
});
