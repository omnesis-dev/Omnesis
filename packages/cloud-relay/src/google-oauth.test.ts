// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  refreshGoogleAuthorization,
} from "./google-oauth.js";
import { localIdentityProvider } from "./identity.js";

const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const nonce = "fictional-private-key-binding-nonce";
const begin = (offline = false) =>
  beginGoogleAuthorization({
    clientId: "fictional-google-client",
    redirectUri: "http://127.0.0.1:18788/google/callback",
    nonce,
    offline,
  });
const callback = (auth: ReturnType<typeof begin>) =>
  `${auth.redirectUri}?code=fictional-code&state=${auth.state}`;
const credential = async (value = nonce) =>
  new SignJWT({ nonce: value })
    .setSubject("fictional-owner")
    .setIssuer("omnesis-local-test")
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("uses S256 PKCE, a private verifier, a fresh state and the caller's key-binding nonce", () => {
  const first = begin(true);
  const second = begin();
  const url = new URL(first.url);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("scope")).toBe("openid");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(first.verifier).digest("base64url"),
  );
  expect(url.searchParams.get("nonce")).toBe(nonce);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(first.url).not.toContain(first.verifier);
  expect(first.state).not.toBe(second.state);
  expect(first.verifier).not.toBe(second.verifier);
  expect(new URL(second.url).searchParams.has("access_type")).toBe(false);
});

test("exchanges an authorization code directly with Google and independently verifies its nonce", async () => {
  const authorization = begin();
  const token = await credential();
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      id_token: token,
      refresh_token: "fictional-refresh-token",
      token_type: "Bearer",
    }),
  );
  const result = await completeGoogleAuthorization({
    authorization,
    callbackUrl: callback(authorization),
    identity,
    clientSecret: "fictional-backend-only-secret",
    fetch: transport,
  });
  expect(result.idToken).toBe(token);
  expect(result.refreshToken).toBe("fictional-refresh-token");
  expect(result.identity.subject).toBe("fictional-owner");
  const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe("https://oauth2.googleapis.com/token");
  const body = init!.body as URLSearchParams;
  expect(body.get("code_verifier")).toBe(authorization.verifier);
  expect(body.get("client_secret")).toBe("fictional-backend-only-secret");
  expect(body.get("redirect_uri")).toBe(authorization.redirectUri);
  expect(init!.redirect).toBe("error");
  await expect(
    completeGoogleAuthorization({
      authorization,
      callbackUrl: callback(authorization),
      identity,
      fetch: transport,
    }),
  ).rejects.toThrow("Invalid or expired");
  expect(transport).toHaveBeenCalledTimes(1);
});

test("supports secretless native clients and HTTPS or registered Google native callbacks", async () => {
  for (const redirectUri of [
    "https://app.example.test/google/callback",
    "com.googleusercontent.apps.fixture:/oauth2redirect",
  ]) {
    const authorization = beginGoogleAuthorization({
      clientId: "fictional-client",
      redirectUri,
      nonce,
    });
    const transport = vi.fn<typeof fetch>(async (_, init) => {
      expect((init!.body as URLSearchParams).has("client_secret")).toBe(false);
      return Response.json({ id_token: await credential(), token_type: "Bearer" });
    });
    const result = await completeGoogleAuthorization({
      authorization,
      callbackUrl: callback(authorization),
      identity,
      fetch: transport,
    });
    expect(result.refreshToken).toBeUndefined();
  }
});

test.each([
  "http://app.example.test/callback",
  "http://localhost/callback",
  "https://user@app.example.test/callback",
  "https://app.example.test/callback?q=1",
  "https://app.example.test/callback#fragment",
  "ftp://app.example.test/callback",
  "arbitrary:/callback",
  "com.googleusercontent.apps.fixture://untrusted/callback",
])("refuses unsafe redirect %s", (redirectUri) => {
  expect(() => beginGoogleAuthorization({ clientId: "client", nonce, redirectUri })).toThrow();
});

test("invalid, expired, ambiguous, cancelled and wrong-state callbacks never reach the token endpoint", async () => {
  const auth = begin();
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of [
    callback(auth).replace("127.0.0.1", "evil.example.test"),
    `${auth.redirectUri}?code=fictional-code`,
    callback(auth).replace("/google/callback", "/other"),
    callback(auth) + "#fragment",
    callback(auth).replace(auth.state, "short"),
    callback(auth).replace(auth.state, "x".repeat(auth.state.length)),
    callback(auth) + "&state=another",
    callback(auth) + "&code=another",
    callback(auth) + "&error=a&error=b",
    `${auth.redirectUri}?state=${auth.state}`,
    `${auth.redirectUri}?state=${auth.state}&error=access_denied`,
    callback(auth) + "&error=access_denied",
    `${auth.redirectUri}?state=${auth.state}&code=${"x".repeat(8193)}`,
  ])
    await expect(
      completeGoogleAuthorization({ authorization: auth, callbackUrl: value, identity, fetch }),
    ).rejects.toThrow();
  vi.useFakeTimers({ now: auth.expiresAt });
  await expect(
    completeGoogleAuthorization({
      authorization: auth,
      callbackUrl: callback(auth),
      identity,
      fetch,
    }),
  ).rejects.toThrow("expired");
  expect(fetch).not.toHaveBeenCalled();
});

test("refresh uses Google's fixed token endpoint by default without treating routing identity as a key proof", async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ id_token: await credential(), token_type: "Bearer" }),
  );
  vi.stubGlobal("fetch", transport);
  expect(
    (
      await refreshGoogleAuthorization({
        clientId: "client",
        refreshToken: "original-refresh",
        identity,
      })
    ).identity.subject,
  ).toBe("fictional-owner");
  expect(transport.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/token");
});

test("does not expose token endpoint error bodies and bounds successful responses", async () => {
  for (const response of [
    new Response("fictional-sensitive-server-error", { status: 400 }),
    new Response("x".repeat(32769)),
    new Response(null),
    new Response("not json"),
    Response.json({ token_type: "Bearer" }),
    Response.json({ id_token: "invalid", token_type: "Basic" }),
  ]) {
    const auth = begin();
    await expect(
      completeGoogleAuthorization({
        authorization: auth,
        callbackUrl: callback(auth),
        identity,
        fetch: async () => response,
      }),
    ).rejects.not.toThrow("fictional-sensitive-server-error");
  }
  const auth = begin();
  await expect(
    completeGoogleAuthorization({
      authorization: auth,
      callbackUrl: callback(auth),
      identity,
      fetch: async () =>
        Response.json({ id_token: await credential("wrong-nonce"), token_type: "Bearer" }),
    }),
  ).rejects.toThrow("nonce");
});

test("refresh retains or rotates private refresh credentials and requires the original signed nonce", async () => {
  for (const rotate of [false, true]) {
    const transport = vi.fn<typeof fetch>(async (_, init) => {
      const body = init!.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("original-refresh");
      expect(body.has("client_secret")).toBe(rotate);
      return Response.json({
        id_token: await credential(),
        token_type: "Bearer",
        ...(rotate ? { refresh_token: "rotated-refresh" } : {}),
      });
    });
    const result = await refreshGoogleAuthorization({
      clientId: "client",
      refreshToken: "original-refresh",
      nonce,
      identity,
      fetch: transport,
      ...(rotate ? { clientSecret: "server-secret" } : {}),
    });
    expect(result.refreshToken).toBe(rotate ? "rotated-refresh" : "original-refresh");
  }
  await expect(
    refreshGoogleAuthorization({
      clientId: "client",
      refreshToken: "original-refresh",
      nonce,
      identity,
      fetch: async () =>
        Response.json({ id_token: await credential("lost-key-binding"), token_type: "Bearer" }),
    }),
  ).rejects.toThrow("nonce");
});
