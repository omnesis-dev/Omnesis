// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import {
  AccountEnrollmentAuthority,
  AccountEnrollmentVerifier,
} from "./account-enrollment-proof.js";
import {
  enrollmentNonce,
  enrollmentSignatureTranscript,
  signDeviceTranscript,
} from "./device-enrollment.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import { GatewayDirectory } from "./gateway-directory.js";
import { KEY_BINDING_PREFIX, keyBindingOwnerAccount } from "./gateway-key-auth.js";
import { GatewaySignInVerifier } from "./gateway-sign-in-proof.js";
import { GooglePairingRequests } from "./google-pairing.js";
import { accountId, googleIdentityProvider } from "./identity.js";
import { PortalSignIn } from "./portal-sign-in.js";
import { RelayError } from "./tunnels.js";

const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url"),
  browserCookie = () => `__Host-omnesis-account-browser=${opaque()}`;
afterEach(() => {
  vi.useRealTimers();
});
function fixture(options: { maxPending?: number; authority?: boolean } = {}) {
  const owner = generateKeyPairSync("ed25519").publicKey;
  const binding = {
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    certificate: "synthetic-directory-certificate",
    identityToken:
      KEY_BINDING_PREFIX + owner.export({ type: "spki", format: "der" }).toString("base64url"),
  };
  const other = { ...binding, gatewayId: randomUUID() };
  const account = { accountId: "a".repeat(64), version: 1, sessionId: "fixture-session" };
  // The directory lists only this account's gateway; `other` belongs to someone else.
  const directory = new GatewayDirectory({
    accounts: (identity) => (identity === account.accountId ? ["owner"] : ["other"]),
    binding: (name) => (name === "owner" ? binding : other),
    name: () => undefined,
  });
  const assertCurrent = vi.fn(),
    assertAccount = vi.fn();
  const authority =
    options.authority === false
      ? undefined
      : new AccountEnrollmentAuthority(origin, generateKeyPairSync("ed25519").privateKey);
  const broker = new PortalSignIn({
    directory,
    authority,
    assertCurrent,
    assertAccount,
    maxPending: options.maxPending,
  });
  const start = () => {
    const cookie = browserCookie(),
      nonce = opaque(),
      started = broker.start({ nonce }, cookie);
    return { ...started, cookie, nonce };
  };
  /** The sign-in the account page records on the operation. */
  const signIn = (op: { operationId: string; cookie: string }, accountId = account.accountId) =>
    broker.recordProof(op.operationId, op.cookie, {
      type: "google",
      accountId,
      idToken: "fictional-google-token",
      nonce: broker.googleProofNonce(op.operationId, op.cookie),
    });
  return {
    broker,
    binding,
    other,
    account,
    authority,
    start,
    signIn,
    assertCurrent,
    assertAccount,
  };
}

test("a sign-in on the account page leaves once, for a gateway of the signed-in account", async () => {
  const f = fixture(),
    op = f.start();
  expect(op.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590);
  expect(f.broker.describe(op.operationId, op.cookie)).toEqual({ ready: false });
  expect(f.broker.proofCommitment(op.operationId, op.cookie)).toMatchObject({ nonce: op.nonce });
  f.signIn(op);
  expect(f.broker.describe(op.operationId, op.cookie)).toEqual({ ready: true });
  const handed = await f.broker.handoff(op.operationId, op.cookie, f.account, f.binding.gatewayId);
  expect(handed).toEqual({
    identityToken: expect.any(String),
    signInProof: { type: "google", idToken: "fictional-google-token", salt: expect.any(String) },
    publicOrigin: "https://gateway.example.test",
  });
  expect(decodeJwt(handed.identityToken)).toMatchObject({
    purpose: "account-enrollment-v3",
    sub: f.account.accountId,
    gatewayId: f.binding.gatewayId,
    ownerAccountId: keyBindingOwnerAccount(f.binding),
    nonce: op.nonce,
  });
  expect(f.assertAccount).toHaveBeenCalledWith(f.account);
  // The proof was taken with the operation, so nothing can ask for it again.
  await expect(
    f.broker.handoff(op.operationId, op.cookie, f.account, f.binding.gatewayId),
  ).rejects.toMatchObject({ status: 403 });
  expect(() => f.broker.describe(op.operationId, op.cookie)).toThrow("unavailable");
});

test("only the browser that started an operation can use it, and only before it is signed in", () => {
  const f = fixture(),
    op = f.start();
  for (const cookie of [
    "",
    browserCookie(),
    `${op.cookie}; ${op.cookie}`,
    "__Host-omnesis-account-browser=short",
  ]) {
    expect(() => f.broker.describe(op.operationId, cookie)).toThrow("unavailable");
    expect(() => f.broker.proofCommitment(op.operationId, cookie)).toThrow("unavailable");
    expect(() => f.broker.googleProofNonce(op.operationId, cookie)).toThrow("unavailable");
  }
  expect(() => f.broker.describe(randomUUID(), op.cookie)).toThrow("unavailable");
  expect(() =>
    f.broker.recordProof(op.operationId, op.cookie, {
      type: "google",
      accountId: f.account.accountId,
      idToken: "fictional-google-token",
      nonce: "made-for-something-else",
    }),
  ).toThrow("another request");
  f.signIn(op);
  // One sign-in per operation: a second one cannot replace the recorded proof.
  expect(() => f.broker.proofCommitment(op.operationId, op.cookie)).toThrow("no longer waiting");
  expect(() => f.broker.googleProofNonce(op.operationId, op.cookie)).toThrow("no longer waiting");
  expect(() => f.signIn(op)).toThrow("no longer waiting");
  expect(() => f.broker.confirm()).toThrow("nothing to confirm");
});

test("a refused handoff issues nothing and leaves the operation usable", async () => {
  const f = fixture(),
    op = f.start();
  const handoff = (
    account = f.account,
    gatewayId: string = f.binding.gatewayId,
    cookie = op.cookie,
  ) => f.broker.handoff(op.operationId, cookie, account, gatewayId);
  // No sign-in yet, then a sign-in by another account than the session's.
  await expect(handoff()).rejects.toMatchObject({ status: 409 });
  f.signIn(op);
  await expect(handoff({ ...f.account, accountId: "b".repeat(64) })).rejects.toMatchObject({
    status: 409,
  });
  await expect(handoff(f.account, f.binding.gatewayId, browserCookie())).rejects.toMatchObject({
    status: 403,
  });
  // A gateway of another account, an unknown one and a malformed identifier are all refused.
  await expect(handoff(f.account, f.other.gatewayId)).rejects.toMatchObject({ status: 404 });
  await expect(handoff(f.account, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(handoff(f.account, "not-a-gateway")).rejects.toMatchObject({ status: 400 });
  f.assertAccount.mockImplementationOnce(() => {
    throw new RelayError(401, "Account revoked");
  });
  await expect(handoff()).rejects.toMatchObject({ status: 401 });
  const legacy = f.binding.identityToken;
  f.binding.identityToken = "synthetic-legacy-google-identity";
  await expect(handoff()).rejects.toMatchObject({ status: 409 });
  f.binding.identityToken = legacy;
  expect(f.broker.describe(op.operationId, op.cookie)).toEqual({ ready: true });
  expect(await handoff()).toMatchObject({ publicOrigin: f.binding.publicOrigin });

  const unconfigured = fixture({ authority: false }),
    pending = unconfigured.start();
  unconfigured.signIn(pending);
  await expect(
    unconfigured.broker.handoff(
      pending.operationId,
      pending.cookie,
      unconfigured.account,
      unconfigured.binding.gatewayId,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(unconfigured.broker.describe(pending.operationId, pending.cookie)).toEqual({
    ready: true,
  });
});

test("two handoffs racing for one operation yield one proof, and a closed broker none", async () => {
  const f = fixture(),
    op = f.start();
  f.signIn(op);
  const results = await Promise.allSettled([
    f.broker.handoff(op.operationId, op.cookie, f.account, f.binding.gatewayId),
    f.broker.handoff(op.operationId, op.cookie, f.account, f.binding.gatewayId),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);

  const closing = f.start();
  f.signIn(closing);
  const late = f.broker.handoff(
    closing.operationId,
    closing.cookie,
    f.account,
    f.binding.gatewayId,
  );
  f.broker.close();
  await expect(late).rejects.toMatchObject({ status: 403 });
  expect(() => f.start()).toThrow("unavailable");
  expect(() => f.broker.describe(closing.operationId, closing.cookie)).toThrow("unavailable");
});

test("requests are validated, capped and expire after ten minutes", async () => {
  expect(() => fixture({ maxPending: 0 })).toThrow("Invalid portal sign-in limits");
  expect(() => fixture({ maxPending: 4097 })).toThrow("Invalid portal sign-in limits");
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 5, 12) });
  const f = fixture({ maxPending: 2 }),
    cookie = browserCookie();
  for (const input of [{}, { nonce: "short" }, { nonce: opaque(), extra: true }, null])
    expect(() => f.broker.start(input, cookie)).toThrow("Invalid portal sign-in request");
  expect(() => f.broker.start({ nonce: opaque() }, "")).toThrow("Invalid portal sign-in request");
  const first = f.start();
  vi.advanceTimersByTime(1_000);
  const second = f.start();
  expect(() => f.start()).toThrow("Too many portal sign-in requests");
  f.signIn(second);
  vi.advanceTimersByTime(599_000);
  // The first has expired and made room; the second lives one more second.
  expect(() => f.broker.describe(first.operationId, first.cookie)).toThrow("unavailable");
  f.start();
  // Close to its end, the attestation lasts no longer than the operation.
  const handed = await f.broker.handoff(
    second.operationId,
    second.cookie,
    f.account,
    f.binding.gatewayId,
  );
  expect(decodeJwt(handed.identityToken).exp).toBe(second.expiresAt);
  f.assertCurrent.mockImplementation(() => {
    throw new RelayError(503, "Recovery policy unavailable");
  });
  expect(() => f.start()).toThrow("Recovery policy");
});

test("a gateway accepts the handed-over attestation and proof for the portal's own request", async () => {
  const audience = "client.example.apps.googleusercontent.com",
    spki = "a".repeat(64),
    subject = "fictional-google-subject";
  const google = await generateKeyPair("RS256", { extractable: true }),
    googleKeys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(google.publicKey)), kid: "1", alg: "RS256" }],
    });
  for (const policy of ["automatic", "ask"] as const) {
    const f = fixture();
    // The account page: a device key, the request it names, and a Google sign-in bound to both.
    const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
      devicePublicKey = device.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url");
    const request = {
      requestId: randomUUID(),
      kind: "portal" as const,
      name: "Portal 1a2b3c4d",
      secret: randomBytes(32).toString("hex"),
    };
    const cookie = browserCookie(),
      op = f.broker.start({ nonce: enrollmentNonce({ ...request, devicePublicKey }) }, cookie),
      googleNonce = f.broker.googleProofNonce(op.operationId, cookie);
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: googleNonce })
      .setProtectedHeader({ alg: "RS256", kid: "1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(google.privateKey);
    f.broker.recordProof(op.operationId, cookie, {
      type: "google",
      accountId: f.account.accountId,
      idToken,
      nonce: googleNonce,
    });
    const handed = await f.broker.handoff(op.operationId, cookie, f.account, f.binding.gatewayId);

    // The gateway: its own verifiers, with that Google sign-in trusted.
    const verifier = new GatewaySignInVerifier({
      google: () => googleIdentityProvider(audience, googleKeys, { authorizedParties: [audience] }),
      relayOrigin: () => origin,
      passkeyOrigins: () => [],
      trusted: () => [
        {
          type: "google",
          id: accountId({ issuer: "https://accounts.google.com", subject, expiresAt: 1 }),
          addedAt: 1,
          source: "link-page",
        },
      ],
    });
    const requests = new GooglePairingRequests({
      identity: new AccountEnrollmentVerifier(
        origin,
        createLocalJWKSet(f.authority!.jwks()),
        f.binding.gatewayId,
        keyBindingOwnerAccount(f.binding)!,
        f.account.accountId,
      ),
      ownerAccountId: accountId({
        issuer: `${origin}/_relay/account`,
        subject: f.account.accountId,
        expiresAt: 1,
      }),
      gatewayFingerprint: () => "d".repeat(64),
      enrollment: {
        policy: () => policy,
        spkiFingerprint: () => spki,
        challenges: new EnrollmentChallenges(),
        verifyProof: (proof, nonce, key) => verifier.verify(proof, "device-enrollment", nonce, key),
        canTrust: async () => false,
        trustSignIn: async () => {},
      },
      createPairing: async (pairing) => ({
        pairingCode: "fictional-pairing-code",
        expiresAt: pairing.expiresAt,
      }),
    });
    // The portal signs the gateway's challenge with the handed-over key and sends everything inline.
    const { challenge } = requests.issueChallenge();
    const result = await requests.start({
      ...request,
      identityToken: handed.identityToken,
      proof: handed.signInProof,
      deviceKey: {
        publicKey: devicePublicKey,
        challenge,
        signature: signDeviceTranscript(
          device.privateKey,
          enrollmentSignatureTranscript({
            ...request,
            gatewaySpkiFingerprint: spki,
            challenge,
            devicePublicKey,
          }),
        ),
      },
    });
    expect(result.status).toBe(policy === "automatic" ? "approved" : "pending");
  }
});
