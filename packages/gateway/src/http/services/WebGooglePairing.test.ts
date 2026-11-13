// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  GooglePairingRequests,
  googlePairingNonce,
  localIdentityProvider,
} from "@omnesis/cloud-relay";
import { afterEach, expect, test, vi } from "vitest";
import { WebGooglePairing } from "./WebGooglePairing.js";

const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const owner = {
  issuer: "omnesis-local-test",
  subject: "fictional-web-owner",
  expiresAt: 4_000_000_000,
};
const createPairing = vi.fn(async () => ({
  pairingCode: "SYNTHETIC-WEB-CODE",
  expiresAt: Date.now() + 60_000,
}));
const request = () => ({
  requestId: randomUUID(),
  name: "Fictional browser",
  secret: randomBytes(32).toString("hex"),
});
function setup(transport = vi.fn<typeof fetch>()) {
  const pairing = new GooglePairingRequests({
    identity,
    ownerAccountId: createHash("sha256")
      .update(JSON.stringify([owner.issuer, owner.subject]))
      .digest("hex"),
    gatewayFingerprint: () => "a".repeat(64),
    createPairing,
  });
  const options = {
    clientId: "fictional-web-client",
    clientSecret: "fictional-backend-secret",
    publicBaseUrl: "https://gateway.example.test",
    identity,
    pairing,
    fetch: transport,
  };
  return { web: new WebGooglePairing(options), pairing, transport, options };
}
async function token(value: ReturnType<typeof request>, subject = owner.subject) {
  return new SignJWT({ nonce: googlePairingNonce({ ...value, kind: "portal" }) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(owner.issuer)
    .setSubject(subject)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}
afterEach(() => {
  vi.useRealTimers();
  createPairing.mockClear();
});

test("web code exchange uses a fixed HTTPS callback and PKCE, keeping identity tokens out of browser results", async () => {
  const { web, transport, pairing } = setup();
  const value = request();
  const start = web.begin(value);
  const url = new URL(start.authorizationUrl);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://gateway.example.test/devices/google/callback",
  );
  expect(url.searchParams.get("nonce")).toBe(googlePairingNonce({ ...value, kind: "portal" }));
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start).not.toHaveProperty("verifier");
  expect(start).not.toHaveProperty("clientSecret");
  transport.mockResolvedValue(
    new Response(JSON.stringify({ id_token: await token(value), token_type: "Bearer" })),
  );
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "fictional-code",
  }).toString();
  expect(await web.complete(callback.href, url.searchParams.get("state")!)).toBe(value.requestId);
  const [endpoint, init] = transport.mock.calls[0]!;
  expect(endpoint).toBe("https://oauth2.googleapis.com/token");
  const body = init!.body as URLSearchParams;
  expect(body.get("client_secret")).toBe("fictional-backend-secret");
  expect(body.get("code_verifier")).toHaveLength(64);
  expect(pairing.poll(value.requestId, value.secret).status).toBe("pending");
  expect(createPairing).not.toHaveBeenCalled();
  await expect(web.complete(callback.href, url.searchParams.get("state")!)).rejects.toThrow(
    "expired or was already used",
  );
});

test("does not allow caller-controlled callback URLs, extra scopes, or oversized request fields", () => {
  const { web, options } = setup();
  for (const publicBaseUrl of [
    "http://gateway.example.test",
    "https://user@gateway.example.test",
    "https://gateway.example.test/path",
    "https://gateway.example.test?query",
    "https://gateway.example.test#hash",
  ]) {
    expect(() => new WebGooglePairing({ ...options, publicBaseUrl })).toThrow();
  }
  expect(() => new WebGooglePairing({ ...options, clientId: " " })).toThrow();
  expect(() => new WebGooglePairing({ ...options, clientSecret: " " })).toThrow();
  expect(() => web.begin({ ...request(), redirectUri: "https://attacker.example.test" })).toThrow();
  expect(() => web.begin({ ...request(), scopes: ["admin"] })).toThrow();
  expect(() => web.begin({ ...request(), secret: "short" })).toThrow();
  expect(() => web.begin({ ...request(), name: "x".repeat(81) })).toThrow();
});

test("expiry and admission bounds prevent unbounded unauthenticated OAuth state", async () => {
  const { web, transport } = setup();
  let first!: URL;
  for (let index = 0; index < 32; index++) {
    const url = new URL(web.begin(request()).authorizationUrl);
    if (index === 0) first = url;
  }
  expect(() => web.begin(request())).toThrow("Too many");
  const callback = new URL(first.searchParams.get("redirect_uri")!);
  callback.search = `?state=${first.searchParams.get("state")}&code=fictional-code`;
  vi.useFakeTimers({ now: Date.now() + 300_001 });
  await expect(web.complete(callback.href, first.searchParams.get("state")!)).rejects.toThrow(
    "expired",
  );
  expect(transport).not.toHaveBeenCalled();
  expect(() => web.begin(request())).not.toThrow();
});

test("unknown and duplicate state never exchange a code; failed or cross-origin callbacks cannot be replayed", async () => {
  const { web, transport } = setup();
  await expect(
    web.complete("https://gateway.example.test/devices/google/callback?code=fictional-code", ""),
  ).rejects.toThrow();
  await expect(
    web.complete(
      "https://gateway.example.test/devices/google/callback?state=unknown&code=fictional-code",
      "unknown",
    ),
  ).rejects.toThrow();
  const url = new URL(web.begin(request()).authorizationUrl);
  const state = url.searchParams.get("state")!;
  await expect(
    web.complete(
      `https://gateway.example.test/devices/google/callback?state=${state}&state=${state}&code=fictional-code`,
      state,
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await expect(
    web.complete(
      `https://attacker.example.test/devices/google/callback?state=${state}&code=fictional-code`,
      state,
    ),
  ).rejects.toThrow();
  await expect(
    web.complete(
      `https://gateway.example.test/devices/google/callback?state=${state}&code=fictional-code`,
      state,
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

test("Google token substitution cannot create an owner request, and token-exchange failure consumes its state", async () => {
  const { web, transport, pairing } = setup();
  const value = request();
  const url = new URL(web.begin(value).authorizationUrl);
  const callback = `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=fictional-code`;
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: await token(value, "fictional-other-person"),
        token_type: "Bearer",
      }),
    ),
  );
  await expect(web.complete(callback, url.searchParams.get("state")!)).rejects.toThrow(
    "gateway owner",
  );
  expect(pairing.list()).toEqual([]);
  await expect(web.complete(callback, url.searchParams.get("state")!)).rejects.toThrow(
    "already used",
  );
  const second = new URL(web.begin(request()).authorizationUrl);
  transport.mockResolvedValue(new Response("refused", { status: 400 }));
  await expect(
    web.complete(
      `${second.searchParams.get("redirect_uri")}?state=${second.searchParams.get("state")}&code=fictional-code`,
      second.searchParams.get("state")!,
    ),
  ).rejects.toThrow("token exchange failed");
  expect(createPairing).not.toHaveBeenCalled();
});

test("the Google callback requires the state cookie from its initiating browser", async () => {
  const { web, transport } = setup();
  const value = request();
  const url = new URL(web.begin(value).authorizationUrl);
  const state = url.searchParams.get("state")!;
  const callback = `${url.searchParams.get("redirect_uri")}?state=${state}&code=fictional-code`;
  await expect(web.complete(callback, "")).rejects.toThrow("browser state mismatch");
  await expect(
    web.complete(callback, (state[0] === "a" ? "b" : "a") + state.slice(1)),
  ).rejects.toThrow("browser state mismatch");
  expect(transport).not.toHaveBeenCalled();
  transport.mockResolvedValue(
    new Response(JSON.stringify({ id_token: await token(value), token_type: "Bearer" })),
  );
  expect(await web.complete(callback, state)).toBe(value.requestId);
});

test("a device key offered to legacy Google web sign-in is ignored, so the request is still held for comparison", async () => {
  const { web, transport, pairing } = setup();
  const value = request();
  const devicePublicKey = "k".repeat(91);
  const url = new URL(web.begin({ ...value, devicePublicKey }).authorizationUrl);
  expect(url.searchParams.get("nonce")).toBe(googlePairingNonce({ ...value, kind: "portal" }));
  transport.mockResolvedValue(
    new Response(JSON.stringify({ id_token: await token(value), token_type: "Bearer" })),
  );
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "fictional-code",
  }).toString();
  expect(await web.complete(callback.href, url.searchParams.get("state")!)).toBe(value.requestId);
  expect(pairing.poll(value.requestId, value.secret).status).toBe("pending");
});
