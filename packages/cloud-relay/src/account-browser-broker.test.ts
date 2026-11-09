// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { AccountBrowserBroker } from "./account-browser-broker.js";
import {
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserTranscript,
  type AccountBrowserPurpose,
} from "./account-browser-contract.js";
import {
  AccountEnrollmentAuthority,
  AccountEnrollmentVerifier,
  AccountGatewayLinkVerifier,
} from "./account-enrollment-proof.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { RelayError } from "./tunnels.js";

const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
afterEach(() => vi.useRealTimers());
function fixture(limits: { maxOperations?: number; maxPerOwner?: number } = {}) {
  const key = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID();
  const ownerPublicKey = key.publicKey.export({ format: "pem", type: "spki" }).toString();
  const owner = {
    ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    tlsSpkiFingerprint: "c".repeat(64),
    ownerPublicKey,
  };
  const actor = { accountId: randomBytes(32).toString("hex"), version: 1, sessionId: randomUUID() };
  const linked = new Map<string, string>();
  let current: typeof owner | undefined = { ...owner },
    active = true;
  const authority = new AccountEnrollmentAuthority(
    origin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const broker = new AccountBrowserBroker({
    origin,
    authority,
    ...limits,
    currentOwner: (id) => (id === current?.ownerAccountId ? current : undefined),
    assertAccount: (account) => {
      if (!active || account.sessionId !== actor.sessionId || account.version !== actor.version)
        throw new RelayError(401, "Account session changed");
    },
    linkedAccount: (id) => linked.get(id),
    linkAccount: (account, id) => {
      const old = linked.get(id);
      if (old && old !== account) throw new RelayError(409, "Account association changed");
      linked.set(id, account);
    },
    unlinkAccount: (id) => {
      linked.delete(id);
    },
    accountCredentials: () => ({
      google: ["d".repeat(64)],
      passkeys: [{ id: "fictional-passkey", publicKey: "fictional-key" }],
    }),
  });
  const make = (purpose: AccountBrowserPurpose = "owner-link") => {
    const redemptionSecret = opaque(),
      now = Math.floor(Date.now() / 1000);
    return {
      redemptionSecret,
      unsigned: {
        protocol: ACCOUNT_BROWSER_PROTOCOL,
        operationId: randomUUID(),
        purpose,
        nonce: opaque(),
        callbackUrl: `https://gateway.example.test${purpose === "owner-link" ? "/admin/cloud-relay/account/callback" : "/devices/account/callback"}`,
        browserState: opaque(),
        redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
        issuedAt: now,
        expiresAt: now + 120,
      },
    };
  };
  const signed = (unsigned: ReturnType<typeof make>["unsigned"]) => ({
    ...unsigned,
    ownerSignature: sign(
      null,
      accountBrowserTranscript(origin, owner, unsigned),
      key.privateKey,
    ).toString("base64url"),
  });
  const authorizedOwner = () => ({
    ...owner,
    sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const signIn = (id: string, cookie: string, accountId = actor.accountId) =>
    broker.recordProof(id, cookie, {
      type: "google",
      accountId,
      idToken: "fictional-google-token",
      nonce: broker.googleProofNonce(id, cookie),
    });
  const launched = (purpose: AccountBrowserPurpose = "owner-link") => {
    const value = make(purpose),
      request = signed(value.unsigned),
      start = broker.start(authorizedOwner(), request);
    const launch = broker.launch(
      start.operationId,
      new URL(start.authorizeUrl).searchParams.get("ticket")!,
    );
    return { ...value, request, start, launch, cookie: launch.cookie.split(";")[0]! };
  };
  const begin = (purpose: AccountBrowserPurpose = "owner-link") => {
    const value = launched(purpose);
    signIn(value.start.operationId, value.cookie);
    return value;
  };
  return {
    broker,
    authority,
    owner,
    actor,
    linked,
    make,
    signed,
    authorizedOwner,
    begin,
    launched,
    signIn,
    current: (value: typeof owner | undefined) => {
      current = value;
    },
    active: (value: boolean) => {
      active = value;
    },
  };
}

test("explicit account confirmation links an owner-signed gateway and redeems only a one-time scoped attestation", async () => {
  const f = fixture(),
    value = f.begin();
  expect(f.linked.size).toBe(0);
  expect(f.broker.describe(value.start.operationId, value.cookie)).toMatchObject({
    purpose: "owner-link",
    hostname: "gateway.example.test",
  });
  expect(value.launch.cookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  expect(value.launch.cookie).not.toContain("Domain=");
  expect(value.launch.location).toBe(`/_relay/account?operation=${value.start.operationId}`);
  const result = await f.broker.confirm(value.start.operationId, value.cookie, f.actor);
  expect(f.linked.get(f.owner.ownerAccountId)).toBe(f.actor.accountId);
  expect(result.cookie).toContain("Max-Age=0");
  const callback = new URL(result.location);
  expect(callback.pathname).toBe("/admin/cloud-relay/account/callback");
  expect(callback.searchParams.get("state")).toBe(value.unsigned.browserState);
  expect(callback.searchParams.get("result")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callback.searchParams.size).toBe(3);
  const redeem = {
    operationId: value.start.operationId,
    result: callback.searchParams.get("result")!,
    redemptionSecret: value.redemptionSecret,
  };
  for (const wrong of [
    { ...redeem, result: opaque() },
    { ...redeem, redemptionSecret: opaque() },
  ])
    expect(() => f.broker.redeem(f.owner, wrong)).toThrow("refused");
  expect(() => f.broker.redeem({ ...f.owner, gatewayId: randomUUID() }, redeem)).toThrow("refused");
  expect(() => f.broker.redeem(f.owner, {})).toThrow("Invalid");
  const redeemed = f.broker.redeem(f.owner, redeem);
  expect(redeemed.accountId).toBe(f.actor.accountId);
  expect(redeemed.signInProof).toEqual({
    type: "google",
    idToken: "fictional-google-token",
    salt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  const keys = createLocalJWKSet(f.authority.jwks());
  const link = new AccountGatewayLinkVerifier(
    origin,
    keys,
    f.owner.gatewayId,
    f.owner.ownerAccountId,
  );
  expect(await link.verify(redeemed.identityToken, value.unsigned.nonce)).toMatchObject({
    subject: f.actor.accountId,
  });
  await expect(
    new AccountEnrollmentVerifier(
      origin,
      keys,
      f.owner.gatewayId,
      f.owner.ownerAccountId,
      f.actor.accountId,
    ).verify(redeemed.identityToken, value.unsigned.nonce),
  ).rejects.toThrow();
  expect(() => f.broker.redeem(f.owner, redeem)).toThrow("expired");
  f.broker.close();
});

test("browser device enrollment attests only the account already linked to the gateway", async () => {
  const f = fixture(),
    value = f.begin("device-enrollment");
  await expect(f.broker.confirm(value.start.operationId, value.cookie, f.actor)).rejects.toThrow(
    "another Omnesis account",
  );
  f.linked.set(f.owner.ownerAccountId, randomBytes(32).toString("hex"));
  await expect(f.broker.confirm(value.start.operationId, value.cookie, f.actor)).rejects.toThrow(
    "another Omnesis account",
  );
  f.linked.set(f.owner.ownerAccountId, f.actor.accountId);
  const result = await f.broker.confirm(value.start.operationId, value.cookie, f.actor),
    callback = new URL(result.location);
  const proof = f.broker.redeem(f.owner, {
    operationId: value.start.operationId,
    result: callback.searchParams.get("result"),
    redemptionSecret: value.redemptionSecret,
  });
  const keys = createLocalJWKSet(f.authority.jwks());
  expect(
    await new AccountEnrollmentVerifier(
      origin,
      keys,
      f.owner.gatewayId,
      f.owner.ownerAccountId,
      f.actor.accountId,
    ).verify(proof.identityToken, value.unsigned.nonce),
  ).toMatchObject({ subject: f.actor.accountId });
  await expect(
    new AccountGatewayLinkVerifier(origin, keys, f.owner.gatewayId, f.owner.ownerAccountId).verify(
      proof.identityToken,
      value.unsigned.nonce,
    ),
  ).rejects.toThrow();
  expect(f.linked.size).toBe(1);
  f.broker.close();
});

test("unbound browsers, replayed launch tickets and mismatched owner signatures cannot select an account", async () => {
  const f = fixture(),
    value = f.make(),
    request = f.signed(value.unsigned);
  expect(() => f.broker.start(f.authorizedOwner(), { ...request, nonce: opaque() })).toThrow(
    "signature",
  );
  expect(() => f.broker.start(f.authorizedOwner(), {})).toThrow("Invalid");
  const started = f.broker.start(f.authorizedOwner(), request),
    ticket = new URL(started.authorizeUrl).searchParams.get("ticket")!;
  expect(() => f.broker.start(f.authorizedOwner(), request)).toThrow("already exists");
  expect(() => f.broker.launch(started.operationId, "bad")).toThrow("refused");
  expect(() => f.broker.launch(started.operationId, opaque())).toThrow("refused");
  expect(() => f.broker.describe(started.operationId, "")).toThrow("binding");
  // Opening the link again binds the new browser and drops the one before it.
  const stale = f.broker.launch(started.operationId, ticket).cookie.split(";")[0]!;
  const launch = f.broker.launch(started.operationId, ticket),
    cookie = launch.cookie.split(";")[0]!;
  expect(f.broker.describe(started.operationId, cookie)).toMatchObject({ needsProof: true });
  for (const header of [
    stale,
    "",
    cookie + ";" + cookie,
    cookie.slice(0, cookie.indexOf("=") + 1) + "bad",
    cookie.slice(0, cookie.indexOf("=") + 1) + opaque(),
  ])
    expect(() => f.broker.describe(started.operationId, header)).toThrow("binding");
  expect(() =>
    f.broker.redeem(f.owner, {
      operationId: started.operationId,
      result: opaque(),
      redemptionSecret: value.redemptionSecret,
    }),
  ).toThrow("refused");
  expect(() =>
    f.broker.cancel({ ...f.owner, ownerAccountId: "a".repeat(64) }, started.operationId),
  ).toThrow("refused");
  f.broker.cancel(f.owner, started.operationId);
  expect(() => f.broker.describe(started.operationId, cookie)).toThrow("cancelled");
  f.broker.close();
});

test("revocation, expiry, replacement and cancellation during signature issuance cannot complete or link an account", async () => {
  for (const attack of [
    "account",
    "owner",
    "association",
    "cancel",
    "close",
    "replace",
    "expiry",
    "unlink",
  ] as const) {
    const f = fixture(),
      value = f.begin();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.authority.issueGatewayLink.bind(f.authority);
    vi.spyOn(f.authority, "issueGatewayLink").mockImplementation(async (...args) => {
      const result = await issue(...args);
      await gate;
      return result;
    });
    const pending = f.broker.confirm(value.start.operationId, value.cookie, f.actor);
    await expect(f.broker.confirm(value.start.operationId, value.cookie, f.actor)).rejects.toThrow(
      "in progress",
    );
    if (attack === "account") f.active(false);
    if (attack === "owner") f.current({ ...f.owner, tlsSpkiFingerprint: "d".repeat(64) });
    if (attack === "association") f.linked.set(f.owner.ownerAccountId, "f".repeat(64));
    if (attack === "cancel" || attack === "replace")
      f.broker.cancel(f.owner, value.start.operationId);
    if (attack === "unlink") f.broker.unlink(f.owner);
    if (attack === "replace") f.broker.start(f.authorizedOwner(), value.request);
    if (attack === "close") f.broker.close();
    if (attack === "expiry") vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 121_000 });
    release();
    await expect(pending).rejects.toThrow();
    expect(f.linked.get(f.owner.ownerAccountId)).not.toBe(f.actor.accountId);
    f.broker.close();
    vi.useRealTimers();
  }
});

test("the gateway owner can unlink discovery and cancel pending handoffs without transferring another gateway", () => {
  const f = fixture(),
    value = f.begin();
  f.linked.set(f.owner.ownerAccountId, f.actor.accountId);
  expect(() => f.broker.unlink({ ...f.owner, gatewayId: randomUUID() })).toThrow(
    "authorization changed",
  );
  expect(f.linked.size).toBe(1);
  f.broker.unlink(f.owner);
  expect(f.linked.size).toBe(0);
  expect(() => f.broker.describe(value.start.operationId, value.cookie)).toThrow("cancelled");
  f.broker.close();
  expect(() => f.broker.unlink(f.owner)).toThrow("unavailable");
});

test("bounded capacity, deadlines and failed signers remain recoverable", async () => {
  for (const limits of [{ maxOperations: 0 }, { maxPerOwner: 0 }, { maxOperations: 4097 }])
    expect(() => fixture(limits)).toThrow("limits");
  for (const limits of [{ maxOperations: 1 }, { maxOperations: 2, maxPerOwner: 1 }]) {
    const f = fixture(limits),
      first = f.begin(),
      second = f.make();
    expect(() => f.broker.start(f.authorizedOwner(), f.signed(second.unsigned))).toThrow(
      "capacity",
    );
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 121_000 });
    const fresh = f.make();
    expect(f.broker.start(f.authorizedOwner(), f.signed(fresh.unsigned)).operationId).toBe(
      fresh.unsigned.operationId,
    );
    expect(() => f.broker.describe(first.start.operationId, first.cookie)).toThrow("expired");
    f.broker.close();
    expect(() => f.broker.start(f.authorizedOwner(), f.signed(fresh.unsigned))).toThrow(
      "unavailable",
    );
    vi.useRealTimers();
  }
  const f = fixture(),
    value = f.begin();
  vi.spyOn(f.authority, "issueGatewayLink").mockRejectedValueOnce(
    new Error("synthetic signing failure"),
  );
  await expect(f.broker.confirm(value.start.operationId, value.cookie, f.actor)).rejects.toThrow(
    "signing failure",
  );
  expect(f.linked.size).toBe(0);
  expect(
    (await f.broker.confirm(value.start.operationId, value.cookie, f.actor)).location,
  ).toContain("result=");
  f.broker.close();
});

test("expired owner sessions and requests outside their authorized time window cannot start a handoff", () => {
  const f = fixture(),
    value = f.make(),
    now = Math.floor(Date.now() / 1000);
  expect(() =>
    f.broker.start({ ...f.authorizedOwner(), sessionExpiresAt: now }, f.signed(value.unsigned)),
  ).toThrow("session expired");
  expect(() =>
    f.broker.start(
      { ...f.authorizedOwner(), sessionExpiresAt: now + 60 },
      f.signed(value.unsigned),
    ),
  ).toThrow("request expired");
  expect(() =>
    f.broker.start(
      f.authorizedOwner(),
      f.signed({ ...value.unsigned, issuedAt: now + 31, expiresAt: now + 150 }),
    ),
  ).toThrow("request expired");
  expect(() =>
    f.broker.start(
      f.authorizedOwner(),
      f.signed({ ...value.unsigned, issuedAt: now - 120, expiresAt: now }),
    ),
  ).toThrow("request expired");
  f.broker.close();
});

test("unlink cancels only that gateway's pending browser requests while preserving another gateway's handoff", () => {
  const first = fixture(),
    second = fixture(),
    own = first.begin();
  first.current(second.owner);
  const pending = second.make();
  const other = first.broker.start(
    { ...second.owner, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
    second.signed(pending.unsigned),
  );
  first.current(first.owner);
  first.broker.unlink(first.owner);
  expect(() => first.broker.describe(own.start.operationId, own.cookie)).toThrow();
  first.current(second.owner);
  expect(
    first.broker.launch(other.operationId, new URL(other.authorizeUrl).searchParams.get("ticket")!)
      .location,
  ).toContain(other.operationId);
  first.broker.close();
  second.broker.close();
});

test("signup admission is limited to an active unlinked owner operation in create mode and retains browser and owner binding", async () => {
  const f = fixture(),
    pending = f.begin();
  // Linking starts as a sign-in to an existing account, which can create nothing.
  expect(f.broker.describe(pending.start.operationId, pending.cookie)).toMatchObject({
    intent: "existing",
  });
  expect(f.broker.signupAdmission(pending.start.operationId, pending.cookie)).toBeUndefined();
  expect(() => f.broker.setIntent(pending.start.operationId, "", "create")).toThrow();
  f.broker.setIntent(pending.start.operationId, pending.cookie, "create");
  expect(f.broker.describe(pending.start.operationId, pending.cookie)).toMatchObject({
    intent: "create",
  });
  const admission = f.broker.signupAdmission(pending.start.operationId, pending.cookie)!;
  expect(admission.gatewayId).toBe(f.owner.gatewayId);
  expect(() => f.broker.signupAdmission(pending.start.operationId, "")).toThrow();
  f.linked.set(f.owner.ownerAccountId, f.actor.accountId);
  expect(f.broker.signupAdmission(pending.start.operationId, pending.cookie)).toBeUndefined();
  expect(() => admission.assertCurrent()).toThrow("existing account");
  const device = f.begin("device-enrollment");
  expect(f.broker.signupAdmission(device.start.operationId, device.cookie)).toBeUndefined();
  // Pairing a device never creates an account, whatever the page was told.
  expect(f.broker.describe(device.start.operationId, device.cookie)).not.toHaveProperty("intent");
  for (const intent of ["create", "existing"] as const)
    expect(() => f.broker.setIntent(device.start.operationId, device.cookie, intent)).toThrow(
      expect.objectContaining({ status: 400, message: "Nothing here can create an account" }),
    );
  expect(f.broker.signupAdmission(device.start.operationId, device.cookie)).toBeUndefined();
  expect(f.broker.describe(device.start.operationId, device.cookie)).not.toHaveProperty("intent");
  // Switching back withdraws the offer to create.
  f.linked.clear();
  f.broker.setIntent(pending.start.operationId, pending.cookie, "existing");
  expect(f.broker.signupAdmission(pending.start.operationId, pending.cookie)).toBeUndefined();
  // An operation that is past its sign-in has nothing left to choose.
  const confirmed = f.begin();
  await f.broker.confirm(confirmed.start.operationId, confirmed.cookie, f.actor);
  expect(() => f.broker.setIntent(confirmed.start.operationId, confirmed.cookie, "create")).toThrow(
    "no longer waiting",
  );
  f.linked.clear();
  f.linked.clear();
  f.current({ ...f.owner, ownerPublicKey: "changed" });
  expect(() => admission.assertCurrent()).toThrow();
  f.broker.close();
});

test("a session cookie cannot stand in for a sign-in on this operation, and the proof must name the same account", async () => {
  const f = fixture(),
    value = f.launched(),
    id = value.start.operationId;
  expect(f.broker.describe(id, value.cookie)).toMatchObject({ needsProof: true });
  await expect(f.broker.confirm(id, value.cookie, f.actor)).rejects.toThrow("Sign in");
  f.signIn(id, value.cookie, randomBytes(32).toString("hex"));
  expect(f.broker.describe(id, value.cookie)).toMatchObject({ needsProof: false });
  // With a sign-in on the operation, the link no longer hands it to another browser.
  expect(() =>
    f.broker.launch(id, new URL(value.start.authorizeUrl).searchParams.get("ticket")!),
  ).toThrow("refused");
  await expect(f.broker.confirm(id, value.cookie, f.actor)).rejects.toMatchObject({ status: 409 });
  expect(f.linked.size).toBe(0);
  f.signIn(id, value.cookie);
  const confirming = f.broker.confirm(id, value.cookie, f.actor);
  // Once confirming, a later sign-in cannot replace the proof it was checked against.
  expect(() => f.signIn(id, value.cookie, randomBytes(32).toString("hex"))).toThrow(
    "no longer waiting",
  );
  await confirming;
  expect(() => f.broker.proofCommitment(id, value.cookie)).toThrow("no longer waiting");
  f.broker.close();
});

test("a sign-in made for one operation is refused on another", () => {
  const f = fixture(),
    first = f.launched(),
    second = f.launched();
  const nonce = f.broker.googleProofNonce(first.start.operationId, first.cookie);
  expect(nonce).not.toBe(f.broker.googleProofNonce(second.start.operationId, second.cookie));
  expect(() =>
    f.broker.recordProof(second.start.operationId, second.cookie, {
      type: "google",
      accountId: f.actor.accountId,
      idToken: "fictional-google-token",
      nonce,
    }),
  ).toThrow("another request");
  expect(f.broker.describe(second.start.operationId, second.cookie)).toMatchObject({
    needsProof: true,
  });
  f.broker.close();
});

test("gateway owners read the current credentials of their linked account only", () => {
  const f = fixture();
  expect(() => f.broker.credentials(f.owner)).toThrow("not linked");
  f.linked.set(f.owner.ownerAccountId, f.actor.accountId);
  expect(f.broker.credentials(f.owner)).toEqual({
    accountId: f.actor.accountId,
    google: ["d".repeat(64)],
    passkeys: [{ id: "fictional-passkey", publicKey: "fictional-key" }],
  });
  expect(() => f.broker.credentials({ ...f.owner, gatewayId: randomUUID() })).toThrow(
    "authorization changed",
  );
  f.broker.close();
  expect(() => f.broker.credentials(f.owner)).toThrow("unavailable");
});
