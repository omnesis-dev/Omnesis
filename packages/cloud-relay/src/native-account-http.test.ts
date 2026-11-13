// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { listen } from "../test/support.js";
import { testPasskeyAuthorization } from "../test/account-admission.js";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { createCloudRelay } from "./server.js";
import {
  AccountEnrollmentAuthority,
  AccountEnrollmentVerifier,
} from "./account-enrollment-proof.js";
import { keyBindingOwnerAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { Passkeys } from "./passkeys.js";

const origin = "https://relay.example.test";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const authority = new AccountEnrollmentAuthority(
    origin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const verify = vi.fn(async (_token: string, _nonce?: string) => ({
    issuer: "https://accounts.google.com",
    subject: "fictional-android-user",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));
  accounts.identities.signInFederated(
    "google",
    accountId({
      issuer: "https://accounts.google.com",
      subject: "fictional-android-user",
      expiresAt: 0,
    }),
  );
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    accountSignIn: { nativeGoogleIdentity: { verify }, enrollmentAuthority: authority },
  });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + "/_relay/v3/native/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const start = async () => {
    const verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const response = await post("start", {
      nonce,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      kind: "android",
    });
    expect(response.status).toBe(200);
    return { verifier, nonce, ...(await response.json()) };
  };
  return { url, post, start, sessions, accounts, verify };
}

test("account discovery selects among independent gateways and scopes its signed proof to the chosen gateway and private challenge", async () => {
  const f = await fixture(),
    started = await f.start();
  const result = await (
    await f.post("google", {
      operationId: started.operationId,
      ticket: started.ticket,
      verifier: started.verifier,
      idToken: "synthetic-android-token",
    })
  ).json();
  const bindings = ["one", "two"].map((name) => {
    const key = generateKeyPairSync("ed25519").publicKey;
    const binding = {
      gatewayId: randomUUID(),
      publicOrigin: `https://${name}.example.test`,
      certificate: "synthetic-directory-certificate",
      identityToken:
        KEY_BINDING_PREFIX + key.export({ format: "der", type: "spki" }).toString("base64url"),
    };
    const owner = keyBindingOwnerAccount(binding)!;
    f.accounts.registerKeyBinding(owner, binding, true);
    f.accounts.identities.linkGateway(
      result.accountId,
      owner,
      f.sessions.sealAccountGatewayLink(origin, result.accountId, owner),
    );
    return { owner, binding };
  });
  const get = (path: string, token = result.discoveryToken) =>
    fetch(f.url + "/_relay/v3/" + path, { headers: { authorization: `Bearer ${token}` } });
  const choices = await (await get("gateways")).json();
  expect(choices.gateways.map((value: { gatewayId: string }) => value.gatewayId).sort()).toEqual(
    bindings.map((value) => value.binding.gatewayId).sort(),
  );
  expect((await get("gateway")).status).toBe(400);
  const selected = bindings[1]!;
  const response = await get(`gateway?gatewayId=${selected.binding.gatewayId}`);
  expect(response.status).toBe(200);
  const selection = await response.json();
  expect(selection.binding).toEqual(selected.binding);
  const keys = createLocalJWKSet(await (await fetch(f.url + "/_relay/v3/account-keys")).json());
  const verifier = new AccountEnrollmentVerifier(
    origin,
    keys,
    selected.binding.gatewayId,
    selected.owner,
    result.accountId,
  );
  expect(await verifier.verify(selection.identityToken, started.nonce)).toMatchObject({
    subject: result.accountId,
  });
  await expect(
    verifier.verify(selection.identityToken, randomBytes(32).toString("base64url")),
  ).rejects.toThrow();
  const other = f.accounts.identities.signInFederated("google", "b".repeat(64));
  const otherToken = await f.sessions.issueAccountDiscovery(
    { accountId: other, version: 1 },
    started.nonce,
    origin,
  );
  expect(
    (await get(`gateway?gatewayId=${selected.binding.gatewayId}`, otherToken.discoveryToken))
      .status,
  ).toBe(404);
  expect((await get(`gateway?gatewayId=${randomUUID()}`)).status).toBe(404);
  expect((await get("gateways?unrecognized=1")).status).toBe(400);
  expect((await get(`gateways?after=${"x".repeat(1024)}`)).status).toBe(400);
  expect((await get("account-keys?unrecognized=1")).status).toBe(400);
  expect((await get("gateways", "invalid")).status).toBe(401);
  expect((await fetch(f.url + "/_relay/v3/gateways")).status).toBe(401);
  expect((await fetch(f.url + "/_relay/v3/gateways", { method: "POST" })).status).toBe(405);
  const root = await f.sessions.issueAccountSession(
    { accountId: result.accountId, version: 1 },
    "google",
    origin,
  );
  expect((await get("gateways", root.token)).status).toBe(401);
});

test("native Google HTTP exchange verifies its server nonce and returns only discovery authority", async () => {
  const f = await fixture(),
    started = await f.start();
  const input = {
    operationId: started.operationId,
    ticket: started.ticket,
    verifier: started.verifier,
    idToken: "synthetic-android-token",
  };
  const response = await f.post("google", input);
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.verify).toHaveBeenCalledWith(input.idToken, started.googleNonce);
  const result = await response.json();
  expect(await f.sessions.verifyAccountDiscovery(result.discoveryToken, origin)).toMatchObject({
    nonce: started.nonce,
    accountId: result.accountId,
  });
  await expect(f.sessions.verifyAccountSession(result.discoveryToken, origin)).rejects.toThrow();
  expect((await f.post("google", input)).status).toBe(403);
  const cancelled = await f.start();
  const cancellation = { operationId: cancelled.operationId, ticket: cancelled.ticket };
  expect((await f.post("cancel", cancellation)).status).toBe(200);
  expect((await f.post("passkeys/options", cancellation)).status).toBe(403);
});

test("a native sign-in that no Omnesis account uses is answered with a machine-readable refusal", async () => {
  const f = await fixture(),
    started = await f.start();
  f.verify.mockResolvedValueOnce({
    issuer: "https://accounts.google.com",
    subject: "fictional-unknown-user",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const response = await f.post("google", {
    operationId: started.operationId,
    ticket: started.ticket,
    verifier: started.verifier,
    idToken: "synthetic-android-token",
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe('{"error":"no-account"}');
  // Every other refusal keeps its bare status.
  const other = await f.post("google", {
    operationId: started.operationId,
    ticket: started.ticket,
    verifier: started.verifier,
    idToken: "synthetic-android-token",
  });
  expect(other.status).toBe(403);
  expect(other.headers.get("content-type")).toBeNull();
  expect(await other.text()).toBe("");
});

test("native passkey HTTP exchange verifies a real platform assertion without browser cookies", async () => {
  const f = await fixture(),
    authenticator = passkeyAuthenticator();
  const registrationService = new Passkeys(f.accounts.identities, { origin });
  const binding = randomBytes(32).toString("base64url");
  const registration = await registrationService.beginRegistration(
    binding,
    undefined,
    "Passkey",
    testPasskeyAuthorization(f.accounts.identities),
  );
  await registrationService.finishRegistration(
    registration.ceremonyId,
    binding,
    authenticator.registration(registration.options.challenge),
  );
  registrationService.close();
  const started = await f.start(),
    operation = { operationId: started.operationId, ticket: started.ticket };
  const login = await (await f.post("passkeys/options", operation)).json();
  const response = await f.post("passkeys/complete", {
    ...operation,
    verifier: started.verifier,
    ceremonyId: login.ceremonyId,
    credential: authenticator.authentication(login.options.challenge, registration.options.user.id),
  });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(
    await f.sessions.verifyAccountDiscovery((await response.json()).discoveryToken, origin),
  ).toMatchObject({ nonce: started.nonce });
  expect(f.verify).not.toHaveBeenCalled();
});

test("native HTTP boundaries reject browser requests, ambiguous payloads, query parameters and oversized bodies", async () => {
  const f = await fixture();
  const browserHeaders: Record<string, string>[] = [
    { origin },
    { origin: "null" },
    { "sec-fetch-site": "same-origin" },
  ];
  for (const headers of browserHeaders)
    expect((await f.post("start", {}, headers)).status).toBe(403);
  expect((await f.post("start", {}, { "content-type": "text/plain" })).status).toBe(415);
  expect((await f.post("start", {})).status).toBe(400);
  expect((await f.post("google", {})).status).toBe(400);
  expect((await f.post("passkeys/complete", {})).status).toBe(400);
  expect((await f.post("cancel", {})).status).toBe(400);
  expect((await f.post("start?unexpected=1", {})).status).toBe(400);
  expect((await f.post("unknown", {})).status).toBe(404);
  expect((await fetch(f.url + "/_relay/v3/native/start")).status).toBe(405);
  expect((await f.post("start", { oversized: "x".repeat(65_536) })).status).toBe(413);
  expect(
    (
      await fetch(f.url + "/_relay/v3/native/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
});
