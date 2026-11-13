// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { decodeJwt } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { testAccountAdmission } from "../test/account-admission.js";
import { registeredPasskey } from "../test/operation-sign-in.js";
import { listen, closeServer } from "../test/support.js";
import { AccountAuthentication } from "./account-authentication.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { AccountWeb } from "./account-web.js";
import { passkeyProofChallenge } from "./device-enrollment.js";
import { GatewayDirectory } from "./gateway-directory.js";
import { KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { RelaySessions } from "./identity.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { Passkeys } from "./passkeys.js";
import { PortalSignIn } from "./portal-sign-in.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage } from "node:http";

const origin = "https://relay.example.test";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(withPortal = true) {
  const db = new Database(":memory:"),
    accounts = new OmnesisAccounts(db),
    sessions = new RelaySessions(randomBytes(32));
  const authentication = new AccountAuthentication(
    origin,
    accounts,
    sessions,
    {
      verify: async () => ({
        issuer: "https://accounts.google.com",
        subject: "fictional-portal-account",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    },
    undefined,
    () => testAccountAdmission(),
  );
  const passkeys = new Passkeys(accounts, { origin });
  const owner = generateKeyPairSync("ed25519").publicKey;
  const binding = {
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    certificate: "synthetic-directory-certificate",
    identityToken:
      KEY_BINDING_PREFIX + owner.export({ type: "spki", format: "der" }).toString("base64url"),
  };
  const directory = new GatewayDirectory({
    accounts: () => ["owner"],
    binding: () => binding,
    name: () => undefined,
  });
  const portal = withPortal
    ? new PortalSignIn({
        directory,
        authority: new AccountEnrollmentAuthority(
          origin,
          generateKeyPairSync("ed25519").privateKey,
        ),
        assertCurrent() {},
        assertAccount(account) {
          if (!accounts.activeSession(account.accountId, account.version, account.sessionId))
            throw new RelayError(401, "Revoked account");
        },
      })
    : undefined;
  const signupAdmission = vi.fn(() => testAccountAdmission());
  const web = new AccountWeb({
    origin,
    accounts,
    authentication,
    passkeys,
    choices: (account) => directory.choices(account),
    deleteAccount: () => {},
    googleAvailable: true,
    portal,
    signupAdmission,
  });
  const server = createServer((req, res) => {
    void web.handle(req, res).catch((error: unknown) => {
      res.writeHead(error instanceof RelayError ? error.status : 500, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "refused" }));
    });
  });
  const url = await listen(server);
  cleanup.push(async () => {
    portal?.close();
    passkeys.close();
    authentication.close();
    await closeServer(server);
    db.close();
  });
  const page = await fetch(url + "/_relay/account");
  const browser = page.headers.getSetCookie()[0]!.split(";")[0]!;
  const post = (path: string, body: unknown, cookie = browser, requestOrigin = origin) =>
    fetch(url + "/_relay/account/api/" + path, {
      method: "POST",
      headers: { origin: requestOrigin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const session = async (query: string, cookie = browser) =>
    fetch(url + "/_relay/account/api/session" + query, { headers: { cookie } });
  const start = async () => {
    const nonce = randomBytes(32).toString("base64url");
    const response = await post("portal/start", { nonce });
    return { nonce, ...((await response.json()) as { operationId: string; expiresAt: number }) };
  };
  return { url, browser, post, session, start, accounts, web, portal, binding, signupAdmission };
}

test("the plain page starts a portal sign-in from its own browser only", async () => {
  const f = await fixture();
  const nonce = randomBytes(32).toString("base64url");
  const started = await f.post("portal/start", { nonce });
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({
    operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    expiresAt: expect.any(Number),
  });
  expect((await f.post("portal/start", { nonce: "short" })).status).toBe(400);
  expect((await f.post("portal/start", { nonce }, "")).status).toBe(400);
  expect(
    (await f.post("portal/start", { nonce }, f.browser, "https://other.example.test")).status,
  ).toBe(403);
  // An operation page never starts one.
  expect((await f.post(`portal/start?portal=${randomUUID()}`, { nonce })).status).toBe(400);

  const unavailable = await fixture(false);
  expect((await unavailable.post("portal/start", { nonce })).status).toBe(503);
  const plain = await unavailable.session(`?portal=${randomUUID()}`);
  expect(await plain.json()).toEqual({
    authenticated: false,
    googleAvailable: true,
    canCreateAccount: true,
  });
  // A request with no cookies at all is answered the same way.
  const bare = await fetch(`${f.url}/_relay/account/api/session?portal=${randomUUID()}`);
  expect(await bare.json()).not.toHaveProperty("handoff");
});

test("a portal sign-in keeps the plain account page and only reports whether it is ready", async () => {
  const f = await fixture(),
    op = await f.start();
  const response = await f.session(`?portal=${op.operationId}`);
  // No `pending`: the page shows its normal views, and may still create an account.
  expect(await response.json()).toEqual({
    authenticated: false,
    googleAvailable: true,
    canCreateAccount: true,
    handoff: { ready: false },
  });
  expect(f.signupAdmission).toHaveBeenLastCalledWith(undefined, f.browser);
  // An unknown or expired operation, or another browser's, is simply not offered.
  for (const [query, cookie] of [
    [`?portal=${randomUUID()}`, f.browser],
    [`?portal=${op.operationId}`, `__Host-omnesis-account-browser=${"b".repeat(43)}`],
  ] as const) {
    const other = await f.session(query, cookie);
    expect(other.status).toBe(200);
    expect(await other.json()).not.toHaveProperty("handoff");
  }
  expect((await f.session(`?portal=${op.operationId}&desktop=${randomUUID()}`)).status).toBe(400);
  expect((await f.post(`continue?portal=${op.operationId}`, {})).status).toBe(401);
  vi.spyOn(f.portal!, "describe").mockImplementation(() => {
    throw new Error("synthetic broker failure");
  });
  expect((await f.session(`?portal=${op.operationId}`)).status).toBe(500);
});

test("a passkey sign-in bound to the operation is handed over once, to the signed-in browser", async () => {
  const f = await fixture(),
    accountId = f.accounts.signInFederated("google", "a".repeat(64)),
    passkey = await registeredPasskey(f.accounts, { accountId, version: 1 }),
    op = await f.start(),
    query = `?portal=${op.operationId}`;
  const begun = await (await f.post("passkeys/authenticate/options" + query, {})).json();
  const commitment = f.portal!.proofCommitment(op.operationId, f.browser);
  expect(begun.options.challenge).toBe(
    passkeyProofChallenge(commitment.salt, commitment.issuedAt, op.nonce),
  );
  const completed = await f.post("passkeys/authenticate/complete" + query, {
    ceremonyId: begun.ceremonyId,
    credential: passkey.authenticator.authentication(begun.options.challenge, passkey.userHandle),
  });
  expect(completed.status).toBe(200);
  const cookie = `${f.browser}; ${completed.headers.getSetCookie()[0]!.split(";")[0]!}`;
  const signedIn = await (await f.session(query, cookie)).json();
  expect(signedIn).toMatchObject({
    authenticated: true,
    gateways: [{ gatewayId: f.binding.gatewayId, publicOrigin: f.binding.publicOrigin }],
    handoff: { ready: true },
  });
  expect(signedIn).not.toHaveProperty("pending");
  // Managing sign-in methods stays off the operation, and it has nothing to confirm.
  expect((await f.post("passkeys/register/options" + query, {}, cookie)).status).toBe(409);
  expect((await f.post("continue" + query, {}, cookie)).status).toBe(400);

  const body = { gatewayId: f.binding.gatewayId };
  expect((await f.post("portal/handoff", body, cookie)).status).toBe(400);
  expect((await f.post("portal/handoff" + query, {}, cookie)).status).toBe(400);
  expect((await f.post("portal/handoff" + query, body)).status).toBe(401);
  expect(
    (await f.post("portal/handoff" + query, body, cookie, "https://other.example.test")).status,
  ).toBe(403);
  expect((await f.post("portal/handoff" + query, { gatewayId: randomUUID() }, cookie)).status).toBe(
    404,
  );
  const handed = await f.post("portal/handoff" + query, body, cookie);
  expect(handed.status).toBe(200);
  const value = await handed.json();
  expect(value).toMatchObject({
    publicOrigin: f.binding.publicOrigin,
    credentialPublicKey: expect.any(String),
    signInProof: {
      type: "passkey",
      salt: commitment.salt,
      issuedAt: commitment.issuedAt,
      credentialPublicKey: value.credentialPublicKey,
    },
  });
  expect(decodeJwt(value.identityToken)).toMatchObject({
    sub: accountId,
    gatewayId: f.binding.gatewayId,
    nonce: op.nonce,
  });
  expect((await f.post("portal/handoff" + query, body, cookie)).status).toBe(403);
  expect(await (await f.session(query, cookie)).json()).not.toHaveProperty("handoff");
});

test("Google sign-in returns to the plain page with both the portal sign-in and the front-door request", async () => {
  const f = await fixture(),
    op = await f.start(),
    request = (query: string) =>
      ({ url: "/_relay/web/start" + query, headers: { cookie: f.browser } }) as IncomingMessage;
  const { context, nonce } = await f.web.googleContext(
    request(`?portal=${op.operationId}&open=portal&then=add-passkey`),
  );
  // A sign-in method change is never resumed on a portal sign-in.
  expect(JSON.parse(context!)).toEqual({ open: "portal", portal: op.operationId });
  expect(nonce).toBe(f.portal!.googleProofNonce(op.operationId, f.browser));
  expect(f.web.googleFailure(context)).toBe(
    `/_relay/account?failed=google&portal=${op.operationId}&open=portal`,
  );
  const signedIn = await f.web.completeGoogle(
    "verified-fixture-google-token",
    nonce!,
    context,
    request(""),
  );
  expect(signedIn.location).toBe(`/_relay/account?portal=${op.operationId}&open=portal`);
  expect(f.portal!.describe(op.operationId, f.browser)).toEqual({ ready: true });

  const without = await f.start();
  const alone = await f.web.googleContext(request(`?portal=${without.operationId}`));
  expect(JSON.parse(alone.context!)).toEqual({ portal: without.operationId });
  expect(
    (
      await f.web.completeGoogle(
        "verified-fixture-google-token",
        alone.nonce!,
        alone.context,
        request(""),
      )
    ).location,
  ).toBe(`/_relay/account?portal=${without.operationId}`);
  await expect(
    f.web.googleContext(request(`?portal=${randomUUID()}&open=portal`)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.web.completeGoogle(
      "verified-fixture-google-token",
      "fictional-nonce",
      JSON.stringify({ portal: op.operationId, desktop: op.operationId }),
      request(""),
    ),
  ).rejects.toThrow("Invalid account request");
});
