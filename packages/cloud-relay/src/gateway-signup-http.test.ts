// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, UnsecuredJWT } from "jose";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { fixtureBrowser, registeredPasskey, signInOnOperation } from "../test/operation-sign-in.js";
import { listen, tlsFiles } from "../test/support.js";
import {
  AccountEnrollmentAuthority,
  AccountGatewayLinkVerifier,
} from "./account-enrollment-proof.js";
import { RelayAccounts } from "./accounts.js";
import { googleProofNonce, passkeyProofChallenge, type SignInProof } from "./device-enrollment.js";
import { gatewayKeyAccount, gatewayKeyIdentity, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { GatewaySignInVerifier } from "./gateway-sign-in-proof.js";
import { GATEWAY_SIGNUP_PROTOCOL, gatewaySignupTranscript } from "./gateway-signup-contract.js";
import { GatewaySignupClient } from "./gateway-signup-client.js";
import { readOrCreateGatewayOwnerKey, type registerGatewayKey } from "./gateway-key-client.js";
import { accountId, RelaySessions } from "./identity.js";
import { ACCOUNT_TERMS_VERSION } from "./omnesis-accounts.js";
import { createCloudRelay } from "./server.js";
import type Database from "better-sqlite3";
import type { SignupConfiguration } from "./gateway-signup.js";

const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url"),
  cleanup: (() => Promise<void>)[] = [],
  googleSubject = "fictional-signup-account";
const googleIdentity = () => ({
  issuer: "https://accounts.google.com",
  subject: googleSubject,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
let directory: string, certificate: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-signup-http-"));
  certificate = await readFile(tlsFiles(directory, "*.example.test").certFile, "utf8");
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  signup: SignupConfiguration | undefined,
  maxAccounts = 100,
  connectShortUrl?: string,
  loginLimits?: Parameters<typeof createCloudRelay>[0]["loginLimits"],
  /** What the ID token says besides its issue time, such as the email. */
  idTokenClaims: Record<string, unknown> = {},
) {
  const accounts = new RelayAccounts(":memory:", maxAccounts),
    sessions = new RelaySessions(randomBytes(32)),
    authority = new AccountEnrollmentAuthority(origin, generateKeyPairSync("ed25519").privateKey);
  const verify = vi.fn(async (_token: string, _nonce?: string) => googleIdentity());
  // Decodable like Google's, so the gateway's freshness check can read its issue time.
  const idToken = new UnsecuredJWT(idTokenClaims).setIssuedAt().encode();
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    loginLimits,
    accountSignIn: { enrollmentAuthority: authority, signup, connectShortUrl },
    webLogin: {
      clientId: "fictional-web-client",
      clientSecret: "fictional-server-secret",
      publicOrigin: origin,
      identity: { verify },
      fetch: async () => Response.json({ id_token: idToken, token_type: "Bearer" }),
    },
  });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  const key = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    ownerPublicKey = key.publicKey.export({ format: "pem", type: "spki" }).toString(),
    ownerAccountId = gatewayKeyAccount({ gatewayId, ownerPublicKey });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/_relay/v3/signup/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  /** The intent is sent beside the signed request; a gateway that sends none signs in. */
  const start = async (overrides: Record<string, unknown> = {}, intent?: "create" | "existing") => {
    const now = Math.floor(Date.now() / 1000),
      redemptionSecret = opaque();
    const unsigned = {
      protocol: GATEWAY_SIGNUP_PROTOCOL,
      operationId: randomUUID(),
      gatewayId,
      ownerPublicKey,
      displayName: "Fictional gateway",
      nonce: opaque(),
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt: now,
      expiresAt: now + 300,
      ...overrides,
    } as Parameters<typeof gatewaySignupTranscript>[1];
    const response = await post("start", {
      ...unsigned,
      ownerSignature: sign(
        null,
        gatewaySignupTranscript(origin, unsigned),
        key.privateKey,
      ).toString("base64url"),
      ...(intent ? { intent } : {}),
    });
    return {
      response,
      unsigned,
      redemption: { operationId: unsigned.operationId, redemptionSecret },
    };
  };
  const launched = async (intent?: "create" | "existing") => {
    const op = await start({}, intent);
    expect(op.response.status).toBe(200);
    const started = await op.response.json(),
      target = new URL(started.authorizeUrl);
    const launch = await fetch(url + target.pathname + target.search, { redirect: "manual" });
    expect(launch.status).toBe(303);
    expect(launch.headers.get("location")).toBe(
      `/_relay/account?signup=${op.unsigned.operationId}`,
    );
    return {
      ...op,
      started,
      id: op.unsigned.operationId,
      query: `?signup=${op.unsigned.operationId}`,
      cookie: launch.headers.getSetCookie()[0]!.split(";")[0]!,
    };
  };
  type Launched = Awaited<ReturnType<typeof launched>>;
  const api = (path: string, query: string, cookie: string, body: unknown = {}) =>
    fetch(`${url}/_relay/account/api/${path}${query}`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const session = async (op: Launched, extra = "") =>
    (
      await fetch(`${url}/_relay/account/api/session${op.query}`, {
        headers: { cookie: `${op.cookie}${extra}` },
      })
    ).json();
  const google = async (op: Launched) => {
    const begun = await fetch(`${url}/_relay/web/start${op.query}`, {
      method: "POST",
      headers: { origin, cookie: op.cookie },
      redirect: "manual",
    });
    expect(begun.status).toBe(303);
    const authorization = new URL(begun.headers.get("location")!),
      state = begun.headers.getSetCookie()[0]!.split(";")[0]!;
    const callback = await fetch(
      `${url}/_relay/web/callback?state=${authorization.searchParams.get("state")}&code=fictional-code`,
      { headers: { cookie: `${op.cookie}; ${state}` }, redirect: "manual" },
    );
    return {
      callback,
      scope: authorization.searchParams.get("scope"),
      nonce: authorization.searchParams.get("nonce")!,
      cookie:
        callback.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Host-omnesis-account="))
          ?.split(";")[0] ?? "",
    };
  };
  /** What the gateway does once it holds the invitation: register, then authenticate as owner. */
  const registerGateway = async () => {
    accounts.registerKeyBinding(
      ownerAccountId,
      {
        gatewayId,
        publicOrigin: "https://gateway.example.test",
        certificate,
        identityToken:
          KEY_BINDING_PREFIX +
          key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      },
      true,
    );
    const owner = await sessions.issue(
      gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
    );
    return { authorization: `Bearer ${owner.token}` };
  };
  return {
    url,
    relay,
    accounts,
    /** What each account agreed to when it was created. */
    consents: () =>
      (accounts as unknown as { db: Database.Database }).db
        .prepare("SELECT account_id, terms_version FROM omnesis_account_consents ORDER BY rowid")
        .all() as { account_id: string; terms_version: string }[],
    identities: accounts.identities,
    sessions,
    authority,
    verify,
    idToken,
    gatewayId,
    ownerPublicKey,
    ownerAccountId,
    post,
    start,
    launched,
    api,
    session,
    google,
    registerGateway,
  };
}
/** Stands in for Google's signature check; the nonce comparison is the part under test. */
const verifier = (trusted: () => string = () => origin) =>
  new GatewaySignInVerifier({
    google: () => ({
      verify: async (_token: string, nonce?: string) => {
        if (!nonce || nonce !== committedNonce) throw new Error("Identity nonce mismatch");
        return googleIdentity();
      },
    }),
    relayOrigin: trusted,
    passkeyOrigins: () => [],
    trusted: () => [],
  });
async function allowlist(value: unknown) {
  const file = join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
}
const subjectDigest = () => accountId(googleIdentity());
/** The OAuth nonce the relay sent Google, which a real token would carry. */
let committedNonce: string | undefined;

test("a new gateway connects end to end: passkey account, proof, invitation, registration and link", async () => {
  const f = await fixture({ policy: "open" });
  const op = await f.launched("create");
  expect(op.started.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  expect(await f.session(op)).toMatchObject({
    authenticated: false,
    canCreateAccount: true,
    pending: {
      purpose: "gateway-signup",
      gatewayName: "Fictional gateway",
      code: op.started.code,
      needsProof: true,
      intent: "create",
    },
  });
  const browser = fixtureBrowser(),
    cookie = `${op.cookie}; ${browser}`,
    authenticator = passkeyAuthenticator();
  const options = await (
    await f.api("passkeys/register/options", op.query, cookie, { createAccount: true })
  ).json();
  const completed = await f.api("passkeys/register/complete", op.query, cookie, {
    ceremonyId: options.ceremonyId,
    credential: authenticator.registration(options.options.challenge),
  });
  expect(completed.status).toBe(200);
  const accountCookie = completed.headers.getSetCookie()[0]!.split(";")[0]!,
    signedIn = `${cookie}; ${accountCookie}`;
  expect(await f.session(op, `; ${accountCookie}`)).toMatchObject({
    authenticated: true,
    pending: { needsProof: false },
  });
  expect(await (await f.post("poll", op.redemption)).json()).toEqual({
    status: "pending",
    expiresAt: op.unsigned.expiresAt,
  });

  const confirmed = await f.api("continue", op.query, signedIn);
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ location: `${origin}/_relay/v3/signup/complete` });
  const finished = await fetch(`${f.url}/_relay/v3/signup/complete`);
  expect(await finished.text()).toContain("Go back to your gateway");

  const polled = await (await f.post("poll", op.redemption)).json();
  expect(polled.status).toBe("approved");
  expect(polled.credentialPublicKey).toBeUndefined();
  await f.sessions.verifyEnrollmentInvitation(polled.enrollmentToken, f.gatewayId, origin);
  // The proof is what a real gateway verifies itself, against the nonce it signed.
  const proof = polled.signInProof as Extract<SignInProof, { type: "passkey-registration" }>;
  expect(proof.type).toBe("passkey-registration");
  expect(options.options.challenge).toBe(
    passkeyProofChallenge(proof.salt, proof.issuedAt, op.unsigned.nonce),
  );
  const registered = await verifier().verify(proof, op.unsigned.nonce);
  expect(registered).toMatchObject({
    type: "passkey",
    id: authenticator.id,
    trusted: false,
  });
  expect(await verifier().verify(proof, opaque())).toBeUndefined();
  expect((await f.post("poll", op.redemption)).status).toBe(409);

  const headers = await f.registerGateway();
  expect((await f.post("link", op.redemption)).status).toBe(401);
  const linked = await f.post("link", op.redemption, headers);
  expect(linked.status).toBe(200);
  const result = await linked.json();
  expect(result.accountId).toBe(polled.accountId);
  expect(
    await new AccountGatewayLinkVerifier(
      origin,
      createLocalJWKSet(f.authority.jwks()),
      f.gatewayId,
      f.ownerAccountId,
    ).verify(result.identityToken, op.unsigned.nonce),
  ).toMatchObject({ subject: polled.accountId });
  expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(polled.accountId);
  expect(f.accounts.gatewayDisplayName(f.ownerAccountId)).toBe("Fictional gateway");
  expect((await f.post("poll", op.redemption)).status).toBe(410);
  // The admission this gateway spent is durable, so it can't mint a second account.
  expect(f.identities.canAdmitGateway(f.gatewayId)).toBe(false);

  const credentials = await fetch(`${f.url}/_relay/v3/account-browser/credentials`, { headers });
  expect(await credentials.json()).toEqual({
    accountId: polled.accountId,
    google: [],
    // The key with the id: a gateway pins a passkey only as the relay registered it.
    passkeys: [
      { id: authenticator.id, publicKey: (registered!.pin as { publicKey: string }).publicKey },
    ],
  });
});

test("an allowlisted Google subject connects, and its digest is what a gateway computes", async () => {
  const f = await fixture({
    policy: "allowlist",
    allowlistFile: await allowlist({ googleSubjects: [subjectDigest()] }),
  });
  const op = await f.launched("create");
  expect(await f.session(op)).toMatchObject({ canCreateAccount: false });
  const signIn = await f.google(op);
  // Without a group, the relay never asks Google for the address.
  expect(signIn.scope).toBe("openid");
  expect(signIn.callback.headers.get("location")).toBe(`${origin}/_relay/account${op.query}`);
  expect(f.verify).toHaveBeenCalledWith(f.idToken, signIn.nonce);
  const signedIn = `${op.cookie}; ${signIn.cookie}`;
  expect((await f.api("continue", op.query, signedIn)).status).toBe(200);
  const polled = await (await f.post("poll", op.redemption)).json();
  expect(polled.signInProof).toEqual({
    type: "google",
    idToken: f.idToken,
    salt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  // The OAuth nonce commits to the gateway's own nonce, which is what lets the gateway trust it.
  expect(signIn.nonce).toBe(googleProofNonce(polled.signInProof.salt, op.unsigned.nonce));
  committedNonce = signIn.nonce;
  // Both sides must arrive at the same digest for trusted sign-ins and the allowlist to work.
  expect(await verifier().verify(polled.signInProof, op.unsigned.nonce)).toMatchObject({
    type: "google",
    id: subjectDigest(),
  });
  expect(await verifier().verify(polled.signInProof, opaque())).toBeUndefined();
  const headers = await f.registerGateway();
  await f.post("link", op.redemption, headers);
  const credentials = await (
    await fetch(`${f.url}/_relay/v3/account-browser/credentials`, { headers })
  ).json();
  expect(credentials.google).toEqual([subjectDigest()]);
  expect(credentials.passkeys).toEqual([]);
});

test("after deleting their account a person creates a new one only while the allowlist still admits them, and deleting lists nobody", async () => {
  const listed = JSON.stringify({ googleSubjects: [subjectDigest()] });
  const allowlistFile = await allowlist(JSON.parse(listed));
  const f = await fixture({ policy: "allowlist", allowlistFile });
  /** Connects the gateway by creating an account with Google, as far as the policy lets it. */
  const create = async () => {
    const op = await f.launched("create");
    const signIn = await f.google(op);
    if (!signIn.cookie) return (await f.session(op)).pending.denied as { reason: string };
    expect((await f.api("continue", op.query, `${op.cookie}; ${signIn.cookie}`)).status).toBe(200);
    await f.post("poll", op.redemption);
    expect((await f.post("link", op.redemption, await f.registerGateway())).status).toBe(200);
    return f.identities.federatedAccount("google", subjectDigest())!;
  };
  const first = (await create()) as string;
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(first);
  f.accounts.deleteAccount(first);
  expect(f.identities.snapshot().identityAccounts).toBe(0);
  // Deleting wrote nothing to the operator's list.
  expect(await readFile(allowlistFile, "utf8")).toBe(listed);

  // Still listed: the same person, from the same gateway, gets a brand-new account.
  const second = (await create()) as string;
  expect(second).toMatch(/^[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
  expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(second);
  f.accounts.deleteAccount(second);

  // Listing the account that no longer exists admits nobody, and neither does an empty list.
  for (const value of [{ accounts: [first, second] }, {}]) {
    await writeFile(allowlistFile, JSON.stringify(value));
    expect(await create()).toMatchObject({ reason: "not-allowed" });
    expect(f.identities.snapshot().identityAccounts).toBe(0);
    expect(f.accounts.snapshot().gatewayBindings).toBe(0);
  }
});

test("an unlisted Google sign-in creates nothing and shows the digest to send the operator", async () => {
  const f = await fixture({ policy: "allowlist", allowlistFile: await allowlist({}) });
  const op = await f.launched("create");
  const before = f.identities.snapshot().identityAccounts;
  const signIn = await f.google(op);
  expect(signIn.callback.status).toBe(303);
  expect(signIn.callback.headers.get("location")).toBe(`${origin}/_relay/account${op.query}`);
  expect(signIn.cookie).toBe("");
  expect(f.identities.snapshot().identityAccounts).toBe(before);
  expect(await f.session(op)).toMatchObject({
    authenticated: false,
    pending: { denied: { reason: "not-allowed", googleSubject: subjectDigest() } },
  });
  expect(await (await f.post("poll", op.redemption)).json()).toEqual({
    status: "denied",
    reason: "not-allowed",
  });
});

test("signing in to connect a gateway creates no account; choosing to create one does, records the consent and connects", async () => {
  for (const policy of ["open", "allowlist"] as const) {
    const f = await fixture(
      policy === "open"
        ? { policy }
        : { policy, allowlistFile: await allowlist({ googleSubjects: [subjectDigest()] }) },
    );
    // A gateway that names no intent, or an older one, opens the sign-in view.
    const op = await f.launched();
    const before = f.identities.snapshot();
    expect(await f.session(op)).toMatchObject({
      authenticated: false,
      canCreateAccount: false,
      pending: { purpose: "gateway-signup", needsProof: true, intent: "existing" },
    });
    const refused = await f.google(op);
    expect(refused.callback.status).toBe(303);
    expect(refused.callback.headers.get("location")).toBe(
      `${origin}/_relay/account?failed=no-account&signup=${op.id}`,
    );
    expect(refused.cookie).toBe("");
    expect(f.identities.snapshot()).toEqual(before);
    expect(f.identities.federatedAccount("google", subjectDigest())).toBeUndefined();
    expect(f.consents()).toEqual([]);
    // Having no account is not the operator's refusal, so the operation is still there.
    const still = await f.session(op);
    expect(still).toMatchObject({ authenticated: false, pending: { needsProof: true } });
    expect(still.pending).not.toHaveProperty("denied");
    expect(await (await f.post("poll", op.redemption)).json()).toMatchObject({
      status: "pending",
    });
    // Nor can a passkey create one from the sign-in view.
    const browser = fixtureBrowser();
    expect(
      (
        await f.api("passkeys/register/options", op.query, `${op.cookie}; ${browser}`, {
          createAccount: true,
        })
      ).status,
    ).toBe(403);
    expect(f.identities.snapshot()).toEqual(before);

    // The person chooses to create an account on the page.
    expect((await f.api("intent", op.query, "", { intent: "create" })).status).toBe(403);
    expect((await f.api("intent", op.query, op.cookie, { intent: "sign-in" })).status).toBe(400);
    expect((await f.api("intent", op.query, op.cookie, {})).status).toBe(400);
    const chosen = await f.api("intent", op.query, op.cookie, { intent: "create" });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({ ok: true });
    expect(await f.session(op)).toMatchObject({
      canCreateAccount: policy === "open",
      pending: { intent: "create" },
    });
    // And can change their mind, which withdraws the offer again.
    expect((await f.api("intent", op.query, op.cookie, { intent: "existing" })).status).toBe(200);
    expect(await f.session(op)).toMatchObject({
      canCreateAccount: false,
      pending: { intent: "existing" },
    });
    expect((await f.api("intent", op.query, op.cookie, { intent: "create" })).status).toBe(200);

    const signIn = await f.google(op);
    expect(signIn.callback.headers.get("location")).toBe(`${origin}/_relay/account${op.query}`);
    const created = f.identities.federatedAccount("google", subjectDigest())!;
    expect(created).toBeDefined();
    expect(f.identities.snapshot().identityAccounts).toBe(before.identityAccounts + 1);
    expect(f.consents()).toEqual([{ account_id: created, terms_version: ACCOUNT_TERMS_VERSION }]);
    const signedIn = `${op.cookie}; ${signIn.cookie}`;
    expect(await f.session(op, `; ${signIn.cookie}`)).toMatchObject({
      authenticated: true,
      pending: { needsProof: false },
    });
    // Once signed in there is nothing left to choose.
    expect((await f.api("continue", op.query, signedIn)).status).toBe(200);
    expect((await f.api("intent", op.query, signedIn, { intent: "existing" })).status).toBe(409);
    const polled = await (await f.post("poll", op.redemption)).json();
    expect(polled).toMatchObject({ status: "approved", accountId: created });
    const headers = await f.registerGateway();
    expect((await f.post("link", op.redemption, headers)).status).toBe(200);
    expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(created);
    // The same sign-in now simply signs in, on a sign-in view, without a second account or consent.
    const again = await f.launched("existing");
    expect((await f.google(again)).callback.headers.get("location")).toBe(
      `${origin}/_relay/account${again.query}`,
    );
    expect(f.identities.snapshot().identityAccounts).toBe(before.identityAccounts + 1);
    expect(f.consents()).toHaveLength(1);
  }
});

test("an unlisted Google sign-in on the sign-in view is told it has no account, not shown a digest", async () => {
  const f = await fixture({ policy: "allowlist", allowlistFile: await allowlist({}) });
  const op = await f.launched("existing");
  const signIn = await f.google(op);
  expect(signIn.callback.headers.get("location")).toBe(
    `${origin}/_relay/account?failed=no-account&signup=${op.id}`,
  );
  const described = await f.session(op);
  expect(described.pending).not.toHaveProperty("denied");
  expect(f.identities.snapshot().identityAccounts).toBe(0);
});

test("a gateway that left its account can start over with another sign-in, which removes the account no gateway uses", async () => {
  const f = await fixture({ policy: "open" }, 100, undefined, {
    maxConcurrent: 8,
    maxPerMinute: 600,
  });
  const other = { ...googleIdentity(), subject: "fictional-second-subject" },
    otherDigest = accountId(other);
  const sessionOf = async (cookie: string) =>
    (await fetch(`${f.url}/_relay/account/api/session`, { headers: { cookie } })).json();
  // The gateway creates an account and is linked to it.
  const first = await f.launched("create");
  const firstSignIn = await f.google(first);
  const firstAccount = f.identities.federatedAccount("google", subjectDigest())!;
  expect(
    (await f.api("continue", first.query, `${first.cookie}; ${firstSignIn.cookie}`)).status,
  ).toBe(200);
  const headers = await f.registerGateway();
  expect(await (await f.post("poll", first.redemption)).json()).toMatchObject({
    status: "approved",
  });
  expect((await f.post("link", first.redemption, headers)).status).toBe(200);
  expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(firstAccount);
  expect(await sessionOf(firstSignIn.cookie)).toMatchObject({ authenticated: true });
  expect(f.consents().map((row) => row.account_id)).toEqual([firstAccount]);

  // While that account has the gateway, another sign-in creates nothing from it.
  f.verify.mockResolvedValue(other);
  const blocked = await f.launched("create");
  expect(await f.session(blocked)).toMatchObject({ canCreateAccount: false });
  const blockedSignIn = await f.google(blocked);
  expect(blockedSignIn.cookie).toBe("");
  expect(blockedSignIn.callback.headers.get("location")).toBe(
    `/_relay/account?failed=google&signup=${blocked.id}`,
  );
  expect(f.identities.federatedAccount("google", otherDigest)).toBeUndefined();
  expect(
    (
      await f.api(
        "passkeys/register/options",
        blocked.query,
        `${blocked.cookie}; ${fixtureBrowser()}`,
        { createAccount: true },
      )
    ).status,
  ).toBe(403);
  expect(f.identities.snapshot().identityAccounts).toBe(1);
  expect(await sessionOf(firstSignIn.cookie)).toMatchObject({ authenticated: true });

  // The owner unlinks the gateway, and then creates an account with the other sign-in.
  expect(
    (
      await fetch(`${f.url}/_relay/v3/account-browser/unlink`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  // Disconnecting removes the gateway's registration and leaves the account as it is.
  expect(f.accounts.registered(f.ownerAccountId)).toBe(false);
  expect(await sessionOf(firstSignIn.cookie)).toMatchObject({ authenticated: true });
  const second = await f.launched("create");
  expect(await f.session(second)).toMatchObject({ canCreateAccount: true });
  const secondSignIn = await f.google(second);
  expect(secondSignIn.callback.headers.get("location")).toBe(
    `${origin}/_relay/account${second.query}`,
  );
  const secondAccount = f.identities.federatedAccount("google", otherDigest)!;
  expect(secondAccount).toBeDefined();
  expect(secondAccount).not.toBe(firstAccount);
  expect(
    (await f.api("continue", second.query, `${second.cookie}; ${secondSignIn.cookie}`)).status,
  ).toBe(200);
  expect(await (await f.post("poll", second.redemption)).json()).toMatchObject({
    status: "approved",
  });
  // Its old session belongs to a registration that is gone; it registers with the invitation.
  expect((await f.post("link", second.redemption, headers)).status).toBe(403);
  expect((await f.post("link", second.redemption, await f.registerGateway())).status).toBe(200);
  expect(f.identities.gatewayAccount(f.ownerAccountId)?.accountId).toBe(secondAccount);

  // The first account is gone: its session, its sign-in and its consent.
  expect(await sessionOf(firstSignIn.cookie)).toMatchObject({ authenticated: false });
  expect(await sessionOf(secondSignIn.cookie)).toMatchObject({ authenticated: true });
  expect(f.identities.federatedAccount("google", subjectDigest())).toBeUndefined();
  expect(f.identities.sessionVersion(firstAccount)).toBeUndefined();
  expect(f.identities.snapshot()).toMatchObject({
    identityAccounts: 1,
    identityFederatedCredentials: 1,
    identityGatewayLinks: 1,
  });
  expect(f.consents()).toEqual([
    { account_id: secondAccount, terms_version: ACCOUNT_TERMS_VERSION },
  ]);
  // The sign-in it used now has no account, and signing in does not bring one back.
  f.verify.mockResolvedValue(googleIdentity());
  const returning = await f.launched("existing");
  expect((await f.google(returning)).callback.headers.get("location")).toBe(
    `${origin}/_relay/account?failed=no-account&signup=${returning.id}`,
  );
  expect(f.identities.snapshot().identityAccounts).toBe(1);
});

test("a Google failure returns to the operation instead of losing it", async () => {
  const f = await fixture({ policy: "open" });
  const op = await f.launched();
  f.verify.mockRejectedValueOnce(new Error("fictional provider failure"));
  const signIn = await f.google(op);
  expect(signIn.callback.headers.get("location")).toBe(
    `/_relay/account?failed=google&signup=${op.id}`,
  );
  expect(await f.session(op)).toMatchObject({ pending: { needsProof: true } });
});

test("an existing account signs in with a passkey, subject to the policy", async () => {
  const listed = await fixture({ policy: "allowlist", allowlistFile: await allowlist({}) });
  const account = listed.identities.signInFederated("google", "a".repeat(64));
  const passkey = await registeredPasskey(listed.identities, { accountId: account, version: 1 });
  const denied = await listed.launched();
  expect(await signInOnOperation(listed.url, denied.query, denied.cookie, passkey)).toBe("");
  expect(await listed.session(denied)).toMatchObject({
    pending: { denied: { reason: "not-allowed", accountId: account } },
  });

  const allowed = await fixture({ policy: "allowlist", allowlistFile: await allowlist({}) });
  const linkedAccount = allowed.identities.signInFederated("google", "a".repeat(64));
  allowed.identities.linkGateway(
    linkedAccount,
    "e".repeat(64),
    allowed.sessions.sealAccountGatewayLink(origin, linkedAccount, "e".repeat(64)),
  );
  const keyed = await registeredPasskey(allowed.identities, {
    accountId: linkedAccount,
    version: 1,
  });
  const op = await allowed.launched();
  const cookie = await signInOnOperation(allowed.url, op.query, op.cookie, keyed);
  expect(cookie).toContain("__Host-omnesis-account=");
  expect((await allowed.api("continue", op.query, `${op.cookie}; ${cookie}`)).status).toBe(200);
  const polled = await (await allowed.post("poll", op.redemption)).json();
  expect(polled.signInProof.type).toBe("passkey");
  expect(polled.credentialPublicKey).toBe(polled.signInProof.credentialPublicKey);
  expect(polled.signInProof.credential.id).toBe(keyed.authenticator.id);
  expect(
    await verifier().verify(polled.signInProof, polled.unused ?? op.unsigned.nonce),
  ).toMatchObject({
    type: "passkey",
    id: keyed.authenticator.id,
  });
});

test("a session from one account cannot spend a proof from another", async () => {
  const f = await fixture({ policy: "open" });
  const first = f.identities.signInFederated("google", "a".repeat(64)),
    second = f.identities.signInFederated("google", "b".repeat(64));
  const passkey = await registeredPasskey(f.identities, { accountId: first, version: 1 });
  const session = await f.sessions.issueAccountSession(
    { accountId: second, version: 1 },
    "passkey",
    origin,
  );
  f.identities.registerSession(second, 1, session.sessionId, session.expiresAt);
  const op = await f.launched();
  const other = `__Host-omnesis-account=${session.token}`;
  // With no sign-in on the operation at all, the cookie alone doesn't count.
  expect((await f.api("continue", op.query, `${op.cookie}; ${other}`)).status).toBe(409);
  await signInOnOperation(f.url, op.query, op.cookie, passkey);
  expect((await f.api("continue", op.query, `${op.cookie}; ${other}`)).status).toBe(409);
  expect(await (await f.post("poll", op.redemption)).json()).toMatchObject({ status: "pending" });
});

test("a passkey ceremony made for one operation is refused on another", async () => {
  const f = await fixture({ policy: "open" });
  const account = f.identities.signInFederated("google", "a".repeat(64));
  const passkey = await registeredPasskey(f.identities, { accountId: account, version: 1 });
  const first = await f.launched(),
    second = await f.launched();
  const browser = fixtureBrowser();
  const begun = await (
    await f.api(
      "passkeys/authenticate/options",
      first.query,
      `${first.cookie}; ${second.cookie}; ${browser}`,
    )
  ).json();
  const crossed = await f.api(
    "passkeys/authenticate/complete",
    second.query,
    `${first.cookie}; ${second.cookie}; ${browser}`,
    {
      ceremonyId: begun.ceremonyId,
      credential: passkey.authenticator.authentication(begun.options.challenge, passkey.userHandle),
    },
  );
  expect(crossed.status).toBe(403);
  expect(crossed.headers.getSetCookie()).toEqual([]);
  expect(await f.session(second)).toMatchObject({ pending: { needsProof: true } });
  // A ceremony begun outside any operation doesn't count on one either.
  const plain = await (await f.api("passkeys/authenticate/options", "", browser)).json();
  expect(
    (
      await f.api("passkeys/authenticate/complete", first.query, `${first.cookie}; ${browser}`, {
        ceremonyId: plain.ceremonyId,
        credential: passkey.authenticator.authentication(
          plain.options.challenge,
          passkey.userHandle,
        ),
      })
    ).status,
  ).toBe(403);
});

test("a relay with a short connect address advertises it beside its own on both start routes", async () => {
  const desktopStart = (url: string) =>
    fetch(`${url}/_relay/v3/desktop/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "cli",
        name: "Fictional terminal",
        nonce: opaque(),
        challenge: opaque(),
      }),
    }).then((response) => response.json());
  const plain = await fixture({ policy: "open" });
  expect(await desktopStart(plain.url)).not.toHaveProperty("connectShortUrl");
  const f = await fixture({ policy: "open" }, 100, "https://front.example.test/connect");
  for (const started of [await (await f.start()).response.json(), await desktopStart(f.url)])
    expect(started).toMatchObject({
      connectUrl: `${origin}/_relay/connect`,
      connectShortUrl: "https://front.example.test/connect",
    });
  // The relay only names the address: it serves nothing there and never redirects to it.
  const page = await fetch(`${f.url}/_relay/connect`, { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(await page.text()).not.toContain("front.example.test");
});

test("a typed code launches the operation, and the same page shows it", async () => {
  const f = await fixture({ policy: "open" });
  const op = await f.start();
  const started = await op.response.json();
  expect(started.connectUrl).toBe(`${origin}/_relay/connect`);
  expect(started).not.toHaveProperty("connectShortUrl");
  const claimed = await fetch(`${f.url}/_relay/v3/connect/claim`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: started.code.toLowerCase() }),
  });
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toEqual({
    location: `/_relay/account?signup=${op.unsigned.operationId}`,
  });
  const cookie = claimed.headers.getSetCookie()[0]!.split(";")[0]!;
  const session = await fetch(
    `${f.url}/_relay/account/api/session?signup=${op.unsigned.operationId}`,
    { headers: { cookie } },
  );
  expect(await session.json()).toMatchObject({ pending: { code: started.code } });
});

test("an ignored sign-in link does not strand the request: the code and the link still open it", async () => {
  const f = await fixture({ policy: "open" });
  const op = await f.launched();
  const claim = (cookie: string) =>
    fetch(`${f.url}/_relay/v3/connect/claim`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: op.started.code }),
    });
  const first = await claim(op.cookie);
  expect(first.status).toBe(200);
  expect((await claim(op.cookie)).status).toBe(200);
  const target = new URL(op.started.authorizeUrl);
  const again = await fetch(f.url + target.pathname + target.search, {
    headers: { cookie: op.cookie },
    redirect: "manual",
  });
  expect(again.status).toBe(303);
  const cookie = again.headers.getSetCookie()[0]!.split(";")[0]!;
  // The same cookie name each time, so reopening does not fill the browser's allowance.
  expect(cookie.split("=")[0]).toBe(op.cookie.split("=")[0]);
  expect(await f.session({ ...op, cookie })).toMatchObject({
    pending: { code: op.started.code },
  });
  for (const stale of [op.cookie, first.headers.getSetCookie()[0]!.split(";")[0]!])
    expect(
      (
        await fetch(`${f.url}/_relay/account/api/session${op.query}`, {
          headers: { cookie: stale },
        })
      ).status,
    ).toBe(403);
});

test("capacity is refused at the start and at approval", async () => {
  const full = await fixture({ policy: "open" }, 1);
  full.accounts.registerAccount("a".repeat(64));
  const refused = await full.start();
  expect(refused.response.status).toBe(503);

  const f = await fixture({ policy: "open" }, 1);
  const op = await f.launched("create");
  const authenticator = passkeyAuthenticator(),
    browser = fixtureBrowser(),
    cookie = `${op.cookie}; ${browser}`;
  const options = await (
    await f.api("passkeys/register/options", op.query, cookie, { createAccount: true })
  ).json();
  const created = await f.api("passkeys/register/complete", op.query, cookie, {
    ceremonyId: options.ceremonyId,
    credential: authenticator.registration(options.options.challenge),
  });
  const session = created.headers.getSetCookie()[0]!.split(";")[0]!;
  f.accounts.registerAccount("b".repeat(64));
  expect((await f.api("continue", op.query, `${cookie}; ${session}`)).status).toBe(403);
  expect(await (await f.post("poll", op.redemption)).json()).toEqual({
    status: "denied",
    reason: "capacity",
  });
});

test("a gateway ID that already has another owner is refused", async () => {
  const f = await fixture({ policy: "open" });
  const other = generateKeyPairSync("ed25519").publicKey;
  const owner = gatewayKeyAccount({
    gatewayId: f.gatewayId,
    ownerPublicKey: other.export({ format: "pem", type: "spki" }).toString(),
  });
  f.accounts.registerKeyBinding(
    owner,
    {
      gatewayId: f.gatewayId,
      publicOrigin: "https://gateway.example.test",
      certificate,
      identityToken:
        KEY_BINDING_PREFIX + other.export({ type: "spki", format: "der" }).toString("base64url"),
    },
    true,
  );
  expect((await f.start()).response.status).toBe(409);
});

test("with the invitation policy every route says so clearly, and nothing else runs", async () => {
  for (const signup of [undefined, { policy: "invitation" as const }]) {
    const f = await fixture(signup);
    for (const path of ["start", "poll", "link", "cancel", "begin", "complete", "unknown"]) {
      const response = await f.post(path, {});
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({
        reason: "invitation-required",
        message: expect.stringContaining("invitation"),
      });
    }
    const config = await fetch(`${f.url}/_relay/v2/config?gatewayId=${f.gatewayId}`);
    expect(await config.json()).toMatchObject({ invitationRequired: true, signup: false });
  }
  const open = await fixture({ policy: "open" });
  const config = await fetch(`${open.url}/_relay/v2/config?gatewayId=${open.gatewayId}`);
  expect(await config.json()).toMatchObject({ invitationRequired: true, signup: true });
});

test("without the cloud opt-in none of these surfaces exist", async () => {
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  // This is the relay runtime when OMNESIS_CLOUD_RELAY_ENABLED is unset: no account services.
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    webLogin: {
      clientId: "fictional-web-client",
      clientSecret: "fictional-server-secret",
      publicOrigin: origin,
      identity: { verify: async () => googleIdentity() },
    },
  });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  for (const path of [
    "/_relay/web",
    "/_relay/web/start",
    "/_relay/account",
    "/_relay/connect",
    "/_relay/connect/script.js",
    "/_relay/v3/connect/claim",
    "/_relay/v3/signup/start",
    "/_relay/v3/signup/complete",
    "/_relay/v3/desktop/start",
    "/_relay/v3/native/start",
    "/_relay/v3/account-browser/credentials",
  ])
    expect((await fetch(url + path)).status, path).toBe(404);
  const config = await fetch(`${url}/_relay/v2/config?gatewayId=${randomUUID()}`);
  expect(await config.json()).toMatchObject({ signup: false });
});

test("the gateway boundary refuses browsers, query strings and malformed requests", async () => {
  const f = await fixture({ policy: "open" });
  for (const path of ["start", "poll", "link", "cancel"]) {
    expect((await fetch(`${f.url}/_relay/v3/signup/${path}`)).status).toBe(405);
    expect((await f.post(path, {}, { origin })).status).toBe(403);
    expect((await f.post(path, {}, { "sec-fetch-site": "same-origin" })).status).toBe(403);
    expect((await f.post(`${path}?extra=1`, {})).status).toBe(403);
    expect((await f.post(path, {}, { "content-type": "text/plain" })).status).toBe(415);
  }
  expect((await f.post("start", { padding: "x".repeat(8193) })).status).toBe(413);
  const invalid = await fetch(`${f.url}/_relay/v3/signup/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(invalid.status).toBe(400);
  expect((await f.post("start", {})).status).toBe(400);
  expect((await f.post("poll", {})).status).toBe(400);
  expect((await f.post("cancel", {})).status).toBe(400);
  expect((await f.post("unknown", {})).status).toBe(404);
  expect((await f.post("begin", {})).status).toBe(405);
  expect((await f.post("complete", {})).status).toBe(405);
  expect((await fetch(`${f.url}/_relay/v3/signup/complete?extra=1`)).status).toBe(400);
  expect((await fetch(`${f.url}/_relay/v3/signup/begin`)).status).toBe(400);
  expect((await fetch(`${f.url}/_relay/v3/signup/begin?operationId=bad&ticket=bad`)).status).toBe(
    400,
  );
  expect((await fetch(`${f.url}/_relay/v3/signup/begin?${"x".repeat(2049)}`)).status).toBe(414);
  const op = await f.start();
  expect((await f.post("cancel", op.redemption)).status).toBe(200);
  expect((await f.post("poll", op.redemption)).status).toBe(410);
});

test("the account page keeps signup requests distinct from other operations", async () => {
  const f = await fixture({ policy: "open" });
  const id = randomUUID();
  const session = (query: string) => fetch(`${f.url}/_relay/account/api/session${query}`);
  expect((await session(`?signup=${id}&desktop=${id}`)).status).toBe(400);
  expect((await session(`?signup=${id}&signup=${id}`)).status).toBe(400);
  expect((await session("?signup=invalid")).status).toBe(400);
  expect((await session(`?signup=${id}`)).status).toBe(410);
  // A signed-in person adds passkeys from their account page, not from an operation.
  const account = f.identities.signInFederated("google", "a".repeat(64));
  const signed = await f.sessions.issueAccountSession(
    { accountId: account, version: 1 },
    "passkey",
    origin,
  );
  f.identities.registerSession(account, 1, signed.sessionId, signed.expiresAt);
  const op = await f.launched();
  expect(
    (
      await f.api(
        "passkeys/register/options",
        op.query,
        `${op.cookie}; ${fixtureBrowser()}; __Host-omnesis-account=${signed.token}`,
      )
    ).status,
  ).toBe(409);
  // Adding a Google sign-in needs the account page too, so an operation never changes a credential.
  const link = await fetch(`${f.url}/_relay/web/start${op.query}&link=1`, {
    method: "POST",
    headers: { origin, cookie: `${op.cookie}; __Host-omnesis-account=${signed.token}` },
    redirect: "manual",
  });
  expect(link.status).toBe(400);
});

test("credentials are for a linked gateway's owner only", async () => {
  const f = await fixture({ policy: "open" });
  const path = `${f.url}/_relay/v3/account-browser/credentials`;
  expect((await fetch(path)).status).toBe(401);
  const headers = await f.registerGateway();
  expect((await fetch(path, { headers })).status).toBe(404);
  expect((await fetch(`${path}?extra=1`, { headers })).status).toBe(400);
  expect((await fetch(path, { method: "POST", headers })).status).toBe(405);
});

test("a relay without an account authority never advertises signup", async () => {
  const accounts = new RelayAccounts(":memory:"),
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      controlOrigin: origin,
      accountSignIn: { signup: { policy: "open" } },
    });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  expect(
    await (await fetch(`${url}/_relay/v2/config?gatewayId=${randomUUID()}`)).json(),
  ).toMatchObject({ signup: false });
  expect((await fetch(`${url}/_relay/v3/signup/start`, { method: "POST" })).status).toBe(404);
});

test("the gateway's own signup client drives start, poll and link against a running relay", async () => {
  const f = await fixture({
    policy: "allowlist",
    allowlistFile: await allowlist({ googleSubjects: [subjectDigest()] }),
  });
  const ownerKeyFile = join(directory, randomUUID(), "owner.pem"),
    key = await readOrCreateGatewayOwnerKey(ownerKeyFile),
    gatewayId = randomUUID();
  const publicKey = createPublicKey(key);
  const ownerPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString(),
    ownerAccountId = gatewayKeyAccount({ gatewayId, ownerPublicKey });
  const transport: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    expect(target.origin).toBe(origin);
    return fetch(f.url + target.pathname + target.search, init);
  };
  const client = new GatewaySignupClient({
    relayUrl: origin,
    gatewayId,
    ownerKeyFile,
    fetch: transport,
  });
  const signal = new AbortController().signal;
  const pending = await client.start(signal, "create");
  expect(pending.connectUrl).toBe(`${origin}/_relay/connect`);
  expect((await client.poll(pending, signal)).status).toBe("pending");

  // The person types the code on the connect page, then signs in with Google.
  const claimed = await fetch(`${f.url}/_relay/v3/connect/claim`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: pending.code }),
  });
  const operationCookie = claimed.headers.getSetCookie()[0]!.split(";")[0]!;
  const op = {
    query: `?signup=${pending.operationId}`,
    cookie: operationCookie,
  } as Parameters<typeof f.google>[0];
  const signIn = await f.google(op);
  expect((await f.api("continue", op.query, `${operationCookie}; ${signIn.cookie}`)).status).toBe(
    200,
  );

  const approved = await client.poll(pending, signal);
  if (approved.status !== "approved") throw new Error("Expected approval");
  committedNonce = signIn.nonce;
  expect(await verifier().verify(approved.signInProof, pending.nonce)).toMatchObject({
    type: "google",
    id: subjectDigest(),
  });
  const register = (async () => {
    f.accounts.registerKeyBinding(
      ownerAccountId,
      {
        gatewayId,
        publicOrigin: "https://gateway.example.test",
        certificate,
        identityToken:
          KEY_BINDING_PREFIX +
          publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      },
      true,
    );
    return f.sessions.issue(
      gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
    );
  }) as unknown as typeof registerGatewayKey;
  const linked = await client.link(
    pending,
    register,
    {} as Parameters<typeof registerGatewayKey>[0],
  );
  expect(linked).toBe(approved.accountId);
  expect(f.identities.gatewayAccount(ownerAccountId)?.accountId).toBe(approved.accountId);

  const cancelled = await client.start(signal);
  await client.cancel(cancelled);
  await expect(client.poll(cancelled, signal)).rejects.toThrow("410");
});

/** A group that admits one address and can be made to fail like Google can. */
const invitedEmail = "maya.reeves@example.com",
  joinUrl = "https://groups.example.com/g/testers";
function group() {
  const gate = {
    joinUrl,
    failing: false,
    asked: [] as string[],
    async isMember(email: string) {
      gate.asked.push(email);
      if (gate.failing) throw new Error("membership lookup failed with HTTP 503");
      return email === invitedEmail;
    },
  };
  return gate;
}

test("an invited google sign-in asks for the email, creates an account and connects", async () => {
  const gate = group();
  const f = await fixture({ policy: "allowlist", googleGroup: gate }, 100, undefined, undefined, {
    email: " Maya.Reeves@Example.com",
    email_verified: true,
  });
  // Any sign-in here asks for the address, but one with no account is never checked.
  const existing = await f.launched("existing");
  const plain = await f.google(existing);
  expect(plain.scope).toBe("openid email");
  expect(plain.callback.headers.get("location")).toContain("failed=no-account");
  expect(gate.asked).toEqual([]);

  const op = await f.launched("create");
  expect(await f.session(op)).toMatchObject({ canCreateAccount: false });
  const signIn = await f.google(op);
  expect(signIn.scope).toBe("openid email");
  expect(signIn.callback.headers.get("location")).toBe(`${origin}/_relay/account${op.query}`);
  expect(gate.asked).toEqual([invitedEmail]);
  expect((await f.api("continue", op.query, `${op.cookie}; ${signIn.cookie}`)).status).toBe(200);
  const polled = await (await f.post("poll", op.redemption)).json();
  expect(polled.status).toBe("approved");
  expect((await f.post("link", op.redemption, await f.registerGateway())).status).toBe(200);
  expect(f.identities.federatedAccount("google", subjectDigest())).toBe(polled.accountId);
  expect(gate.asked).toHaveLength(1);
});

test("a google sign-in outside the group creates nothing and is shown the join link", async () => {
  const gate = group();
  const f = await fixture({ policy: "allowlist", googleGroup: gate }, 100, undefined, undefined, {
    email: "jamie.lopez@example.com",
    email_verified: true,
  });
  const op = await f.launched("create");
  const signIn = await f.google(op);
  expect(signIn.cookie).toBe("");
  expect(signIn.callback.headers.get("location")).toBe(`${origin}/_relay/account${op.query}`);
  expect(f.identities.snapshot().identityAccounts).toBe(0);
  expect((await f.session(op)).pending.denied).toEqual({
    reason: "not-allowed",
    googleSubject: subjectDigest(),
    inviteOnly: true,
    joinUrl,
  });
  // The gateway learns no more than before.
  expect(await (await f.post("poll", op.redemption)).json()).toEqual({
    status: "denied",
    reason: "not-allowed",
  });
});

test("a google sign-in whose email google did not verify is refused without asking the group", async () => {
  const gate = group();
  const f = await fixture({ policy: "allowlist", googleGroup: gate }, 100, undefined, undefined, {
    email: invitedEmail,
    email_verified: false,
  });
  const op = await f.launched("create");
  expect((await f.google(op)).cookie).toBe("");
  expect((await f.session(op)).pending.denied).toMatchObject({ inviteOnly: true, joinUrl });
  expect(gate.asked).toEqual([]);
});

test("when google cannot answer, the sign-up is refused for now and the same request can be retried", async () => {
  const gate = group();
  gate.failing = true;
  const f = await fixture({ policy: "allowlist", googleGroup: gate }, 100, undefined, undefined, {
    email: invitedEmail,
    email_verified: true,
  });
  const op = await f.launched("create");
  const failed = await f.google(op);
  expect(failed.cookie).toBe("");
  expect(failed.callback.headers.get("location")).toBe(
    `${origin}/_relay/account?failed=invitation&signup=${op.id}`,
  );
  expect(f.identities.snapshot().identityAccounts).toBe(0);
  expect((await f.session(op)).pending).not.toHaveProperty("denied");
  expect(await (await f.post("poll", op.redemption)).json()).toMatchObject({ status: "pending" });
  gate.failing = false;
  const retried = await f.google(op);
  expect(retried.cookie).not.toBe("");
  expect((await f.api("continue", op.query, `${op.cookie}; ${retried.cookie}`)).status).toBe(200);
});
