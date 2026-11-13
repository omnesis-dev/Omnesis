// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { ConnectCodes } from "./connect-codes.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import {
  GATEWAY_SIGNUP_PROTOCOL,
  gatewaySignupPollResult,
  gatewaySignupStarted,
  gatewaySignupTranscript,
  type GatewaySignupIntent,
} from "./gateway-signup-contract.js";
import { NoAccount } from "./account-admission.js";
import {
  GatewaySignup,
  SignupDenied,
  SignupUnavailable,
  type SignupConfiguration,
} from "./gateway-signup.js";
import { RelaySessions } from "./identity.js";
import { RelayError } from "./tunnels.js";

const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

function fixture(
  configuration: SignupConfiguration = { policy: "open" },
  limits: { maxOperations?: number; maxPerOwner?: number; connectShortUrl?: string } = {},
) {
  const state = {
    owners: new Map<string, string>(),
    linked: new Map<string, string>(),
    names: new Map<string, string>(),
    capacity: true,
    active: true,
    hasGateway: false,
    current: true,
  };
  const sessions = new RelaySessions(randomBytes(32)),
    codes = new ConnectCodes(),
    authority = new AccountEnrollmentAuthority(origin, generateKeyPairSync("ed25519").privateKey);
  const actor = { accountId: randomBytes(32).toString("hex"), version: 1, sessionId: randomUUID() };
  const signup = new GatewaySignup({
    origin,
    configuration,
    authority,
    sessions,
    codes,
    ...limits,
    gatewayOwner: (id) => state.owners.get(id),
    hasCapacity: () => state.capacity,
    hasLinkedGateway: () => state.hasGateway,
    assertAccount: () => {
      if (!state.active) throw new RelayError(401, "Account changed");
    },
    assertCurrent: () => {
      if (!state.current) throw new RelayError(503, "Coordination paused");
    },
    linkedAccount: (owner) => state.linked.get(owner),
    linkAccount: (account, owner) => state.linked.set(owner, account),
    setDisplayName: (owner, name) => state.names.set(owner, name),
  });
  cleanup.push(() => signup.close());
  const key = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    ownerPublicKey = key.publicKey.export({ format: "pem", type: "spki" }).toString(),
    ownerAccountId = gatewayKeyAccount({ gatewayId, ownerPublicKey });
  const owner = {
    ownerAccountId,
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    tlsSpkiFingerprint: "c".repeat(64),
    ownerPublicKey,
  };
  /** The intent rides beside the signed request: the owner key does not sign it. */
  const request = (overrides: Record<string, unknown> = {}, intent?: GatewaySignupIntent) => {
    const now = Math.floor(Date.now() / 1000),
      redemptionSecret = opaque();
    const unsigned = {
      protocol: GATEWAY_SIGNUP_PROTOCOL,
      operationId: randomUUID(),
      gatewayId,
      ownerPublicKey,
      nonce: opaque(),
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt: now,
      expiresAt: now + 120,
      ...overrides,
    } as Parameters<typeof gatewaySignupTranscript>[1];
    return {
      redemptionSecret,
      unsigned,
      signed: {
        ...unsigned,
        ownerSignature: sign(
          null,
          gatewaySignupTranscript(origin, unsigned),
          key.privateKey,
        ).toString("base64url"),
        ...(intent ? { intent } : {}),
      },
    };
  };
  const launched = (overrides: Record<string, unknown> = {}, intent?: GatewaySignupIntent) => {
    const value = request(overrides, intent),
      started = signup.start(value.signed);
    const launch = signup.launch(
      started.operationId,
      new URL(started.authorizeUrl).searchParams.get("ticket")!,
      "",
    );
    return {
      ...value,
      started,
      launch,
      id: started.operationId,
      cookie: launch.cookie.split(";")[0]!,
      redemption: { operationId: started.operationId, redemptionSecret: value.redemptionSecret },
    };
  };
  type Launched = ReturnType<typeof launched>;
  const signIn = (op: Launched, accountId = actor.accountId) =>
    signup.recordProof(op.id, op.cookie, {
      type: "google",
      accountId,
      idToken: "fictional-google-token",
      nonce: signup.googleProofNonce(op.id, op.cookie),
    });
  const approved = async (overrides: Record<string, unknown> = {}) => {
    const op = launched(overrides);
    signIn(op);
    await signup.confirm(op.id, op.cookie, actor);
    return op;
  };
  return {
    state,
    sessions,
    codes,
    authority,
    actor,
    signup,
    owner,
    gatewayId,
    ownerAccountId,
    request,
    launched,
    signIn,
    approved,
  };
}
async function allowlistFile(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-signup-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "allowlist.json");
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("a signed request gets one launch, one approval and one collection of the proof", async () => {
  const f = fixture(),
    op = f.launched({ displayName: "Fictional gateway" });
  expect(gatewaySignupStarted.parse(op.started)).toEqual(op.started);
  expect(op.started.connectUrl).toBe(origin + "/_relay/connect");
  expect(op.started).not.toHaveProperty("connectShortUrl");
  const short = fixture(undefined, { connectShortUrl: "https://front.example.test/connect" }),
    advertised = short.launched().started;
  expect(gatewaySignupStarted.parse(advertised)).toEqual(advertised);
  expect(advertised).toMatchObject({
    connectUrl: origin + "/_relay/connect",
    connectShortUrl: "https://front.example.test/connect",
  });
  expect(op.launch.location).toBe(`/_relay/account?signup=${op.id}`);
  expect(op.launch.cookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  expect(f.signup.describe(op.id, op.cookie)).toMatchObject({
    purpose: "gateway-signup",
    gatewayName: "Fictional gateway",
    code: op.started.code,
    needsProof: true,
  });
  expect(f.signup.poll(op.redemption)).toEqual({
    status: "pending",
    expiresAt: op.unsigned.expiresAt,
  });
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).rejects.toMatchObject({ status: 409 });
  f.signIn(op, "b".repeat(64));
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).rejects.toMatchObject({ status: 409 });
  f.signIn(op);
  expect(f.signup.proofCommitment(op.id, op.cookie).nonce).toBe(op.unsigned.nonce);
  const confirmed = await f.signup.confirm(op.id, op.cookie, f.actor);
  expect(confirmed.location).toBe(origin + "/_relay/v3/signup/complete");
  expect(confirmed.cookie).toContain("Max-Age=0");
  expect(() => f.signIn(op)).toThrow("no longer waiting");

  const result = f.signup.poll(op.redemption);
  expect(gatewaySignupPollResult.parse(result)).toEqual(result);
  if (result.status !== "approved") throw new Error("Expected approval");
  expect(result.accountId).toBe(f.actor.accountId);
  expect(result.signInProof).toMatchObject({ type: "google", idToken: "fictional-google-token" });
  await f.sessions.verifyEnrollmentInvitation(result.enrollmentToken, f.gatewayId, origin);
  expect(() => f.signup.poll(op.redemption)).toThrow("already collected");
  f.signup.cancel(op.redemption);
  expect(() => f.signup.poll(op.redemption)).toThrow("expired or was cancelled");
});

test("link binds the signed-in account to the registered owner and ends the operation", async () => {
  const f = fixture(),
    op = await f.approved({ displayName: "Fictional gateway" });
  await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("not ready");
  f.signup.poll(op.redemption);
  await expect(
    f.signup.link({ ...f.owner, ownerAccountId: "a".repeat(64) }, op.redemption),
  ).rejects.toThrow("another gateway");
  await expect(
    f.signup.link({ ...f.owner, gatewayId: randomUUID() }, op.redemption),
  ).rejects.toThrow("another gateway");
  f.state.linked.set(f.ownerAccountId, "d".repeat(64));
  await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("another Omnesis account");
  f.state.linked.delete(f.ownerAccountId);
  f.state.active = false;
  await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("Account changed");
  f.state.active = true;

  const linked = await f.signup.link(f.owner, op.redemption);
  expect(linked.accountId).toBe(f.actor.accountId);
  expect(linked.identityToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(f.state.linked.get(f.ownerAccountId)).toBe(f.actor.accountId);
  expect(f.state.names.get(f.ownerAccountId)).toBe("Fictional gateway");
  await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("expired or was cancelled");
});

test("a name is optional, and a failed link can be retried", async () => {
  const f = fixture(),
    op = await f.approved();
  expect(f.signup.describe(op.id, op.cookie)).toMatchObject({ gatewayName: "Your gateway" });
  f.signup.poll(op.redemption);
  vi.spyOn(f.authority, "issueGatewayLink").mockRejectedValueOnce(new Error("signing failure"));
  await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("signing failure");
  expect((await f.signup.link(f.owner, op.redemption)).accountId).toBe(f.actor.accountId);
  expect(f.state.names.size).toBe(0);
});

test("changes during link's signing refuse to bind", async () => {
  for (const attack of ["cancel", "account", "association", "close"] as const) {
    const f = fixture(),
      op = await f.approved();
    f.signup.poll(op.redemption);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.authority.issueGatewayLink.bind(f.authority);
    vi.spyOn(f.authority, "issueGatewayLink").mockImplementation(async (...args) => {
      await gate;
      return issue(...args);
    });
    const linking = f.signup.link(f.owner, op.redemption);
    await expect(f.signup.link(f.owner, op.redemption)).rejects.toThrow("not ready");
    expect(() => f.signup.poll(op.redemption)).toThrow("already collected");
    if (attack === "cancel") f.signup.cancel(op.redemption);
    if (attack === "account") f.state.active = false;
    if (attack === "association") f.state.linked.set(f.ownerAccountId, "d".repeat(64));
    if (attack === "close") f.signup.close();
    release();
    await expect(linking).rejects.toThrow();
    expect(f.state.linked.get(f.ownerAccountId)).not.toBe(f.actor.accountId);
  }
});

test("changes during approval's signing refuse to approve", async () => {
  for (const attack of ["cancel", "account", "close"] as const) {
    const f = fixture(),
      op = f.launched();
    f.signIn(op);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.sessions.issueEnrollmentInvitation.bind(f.sessions);
    vi.spyOn(f.sessions, "issueEnrollmentInvitation").mockImplementation(async (...args) => {
      await gate;
      return issue(...args);
    });
    const confirming = f.signup.confirm(op.id, op.cookie, f.actor);
    await vi.waitFor(() => expect(f.sessions.issueEnrollmentInvitation).toHaveBeenCalled());
    if (attack === "cancel") f.signup.cancel(op.redemption);
    if (attack === "account") f.state.active = false;
    if (attack === "close") f.signup.close();
    release();
    await expect(confirming).rejects.toThrow();
    if (attack === "account")
      expect(f.signup.describe(op.id, op.cookie)).toMatchObject({ needsProof: false });
  }
});

test("cancelling while the policy is being read refuses every kind of sign-in", async () => {
  const f = fixture({ policy: "allowlist", allowlistFile: await allowlistFile({}) }),
    subject = { subjectDigest: "e".repeat(64) };
  for (const signIn of [
    (id: string, cookie: string) => f.signup.authorizeGoogle(id, cookie, subject),
    (id: string, cookie: string) => f.signup.authorizeAccount(id, cookie, f.actor.accountId),
  ]) {
    const op = f.launched(),
      pending = signIn(op.id, op.cookie);
    f.signup.cancel(op.redemption);
    await expect(pending).rejects.toThrow();
  }
  const op = f.launched();
  f.signIn(op);
  const confirming = f.signup.confirm(op.id, op.cookie, f.actor);
  f.signup.cancel(op.redemption);
  await expect(confirming).rejects.toThrow("cancelled");
});

test("the allowlist is read afresh on every check and fails closed", async () => {
  const listed = "e".repeat(64),
    account = "a".repeat(64);
  const file = await allowlistFile({ accounts: [account], googleSubjects: [listed] });
  const f = fixture({ policy: "allowlist", allowlistFile: file }, { maxPerOwner: 32 });
  const check = (subjectDigest: string, known?: string) => {
    const op = f.launched({}, "create");
    return f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest, account: known });
  };
  await expect(check(listed)).resolves.toMatchObject({ gatewayId: f.gatewayId });
  await expect(check("f".repeat(64), account)).resolves.toMatchObject({ gatewayId: f.gatewayId });
  await expect(check("f".repeat(64))).rejects.toBeInstanceOf(SignupDenied);
  await expect(check("f".repeat(64), "b".repeat(64))).rejects.toBeInstanceOf(SignupDenied);
  f.state.hasGateway = true;
  await expect(check("f".repeat(64), "b".repeat(64))).resolves.toBeDefined();
  f.state.hasGateway = false;
  await writeFile(file, JSON.stringify({ googleSubjects: [] }));
  await expect(check(listed)).rejects.toBeInstanceOf(SignupDenied);
  await writeFile(file, "not json");
  await expect(check(listed)).rejects.toBeInstanceOf(SignupDenied);
  await writeFile(file, JSON.stringify({ googleSubjects: ["not-a-digest"] }));
  await expect(check(listed)).rejects.toBeInstanceOf(SignupDenied);
  await rm(file);
  await expect(check(listed)).rejects.toBeInstanceOf(SignupDenied);
});

test("signing in never creates an account: an unknown Google sign-in is refused until the person chooses to create one", async () => {
  const unknown = "e".repeat(64),
    known = "a".repeat(64);
  for (const configuration of [
    { policy: "open" as const },
    {
      policy: "allowlist" as const,
      allowlistFile: await allowlistFile({ googleSubjects: [unknown], accounts: [known] }),
    },
  ]) {
    const f = fixture(configuration);
    // A request that says nothing signs in to an existing account, as does one that says so.
    for (const op of [f.launched(), f.launched({}, "existing")]) {
      expect(f.signup.describe(op.id, op.cookie)).toMatchObject({ intent: "existing" });
      expect(f.signup.creationAdmission(op.id, op.cookie)).toBeUndefined();
      await expect(
        f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest: unknown }),
      ).rejects.toBeInstanceOf(NoAccount);
      // Having no account is not a refusal by the operator: the operation goes on.
      expect(f.signup.describe(op.id, op.cookie)).not.toHaveProperty("denied");
      expect(f.signup.poll(op.redemption)).toMatchObject({ status: "pending" });
      // An account that exists signs in whichever view is showing.
      await expect(
        f.signup.authorizeGoogle(op.id, op.cookie, {
          subjectDigest: "f".repeat(64),
          account: known,
        }),
      ).resolves.toMatchObject({ gatewayId: f.gatewayId });
      // Only the browser holding the operation can switch it.
      expect(() => f.signup.setIntent(op.id, "", "create")).toThrow();
      expect(f.signup.describe(op.id, op.cookie)).toMatchObject({ intent: "existing" });
      f.signup.setIntent(op.id, op.cookie, "create");
      expect(f.signup.describe(op.id, op.cookie)).toMatchObject({ intent: "create" });
      expect(f.signup.creationAdmission(op.id, op.cookie) !== undefined).toBe(
        configuration.policy === "open",
      );
      await expect(
        f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest: unknown }),
      ).resolves.toMatchObject({ gatewayId: f.gatewayId, ownerAccountId: f.ownerAccountId });
      // And back: the offer to create is withdrawn.
      f.signup.setIntent(op.id, op.cookie, "existing");
      expect(f.signup.creationAdmission(op.id, op.cookie)).toBeUndefined();
      await expect(
        f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest: unknown }),
      ).rejects.toBeInstanceOf(NoAccount);
    }
  }
});

test("the choice to create can't be made on an operation that is refused, approved or cancelled", async () => {
  const f = fixture({ policy: "allowlist", allowlistFile: await allowlistFile({}) });
  const denied = f.launched({}, "create");
  await expect(
    f.signup.authorizeGoogle(denied.id, denied.cookie, { subjectDigest: "e".repeat(64) }),
  ).rejects.toBeInstanceOf(SignupDenied);
  expect(() => f.signup.setIntent(denied.id, denied.cookie, "existing")).toThrow(
    "no longer waiting",
  );
  const open = fixture();
  const approved = await open.approved();
  expect(() => open.signup.setIntent(approved.id, approved.cookie, "create")).toThrow(
    "no longer waiting",
  );
  const cancelled = open.launched();
  open.signup.cancel(cancelled.redemption);
  expect(() => open.signup.setIntent(cancelled.id, cancelled.cookie, "create")).toThrow();
  expect(() => open.signup.start(open.request({}, "neither" as never).signed)).toThrow();
});

test("the owner signature does not cover the intent, so the same request starts in either view", () => {
  const f = fixture(),
    value = f.request();
  const started = f.signup.start({ ...value.signed, intent: "create" });
  const launch = f.signup.launch(
    started.operationId,
    new URL(started.authorizeUrl).searchParams.get("ticket")!,
    "",
  );
  expect(f.signup.describe(started.operationId, launch.cookie.split(";")[0]!)).toMatchObject({
    intent: "create",
  });
});

test("a refusal shows who to list, ends the operation and reaches the gateway", async () => {
  const f = fixture({ policy: "allowlist", allowlistFile: await allowlistFile({}) });
  const google = f.launched({}, "create"),
    subjectDigest = "e".repeat(64);
  await expect(
    f.signup.authorizeGoogle(google.id, google.cookie, { subjectDigest }),
  ).rejects.toBeInstanceOf(SignupDenied);
  expect(f.signup.describe(google.id, google.cookie)).toMatchObject({
    denied: { reason: "not-allowed", googleSubject: subjectDigest },
  });
  expect(f.signup.poll(google.redemption)).toEqual({ status: "denied", reason: "not-allowed" });
  expect(() => f.signup.proofCommitment(google.id, google.cookie)).toThrow("no longer waiting");
  expect(f.signup.creationAdmission(google.id, google.cookie)).toBeUndefined();
  await expect(f.signup.confirm(google.id, google.cookie, f.actor)).rejects.toThrow(
    "no longer waiting",
  );

  const passkey = f.launched();
  expect(await f.signup.authorizeAccount(passkey.id, passkey.cookie, f.actor.accountId)).toBe(
    false,
  );
  expect(f.signup.describe(passkey.id, passkey.cookie)).toMatchObject({
    denied: { reason: "not-allowed", accountId: f.actor.accountId },
  });
});

test("an allowed account passes, and only an open relay admits a new passkey account", async () => {
  const closed = fixture({
    policy: "allowlist",
    allowlistFile: await allowlistFile({ accounts: ["a".repeat(64)] }),
  });
  const op = closed.launched({}, "create");
  expect(closed.signup.creationAdmission(op.id, op.cookie)).toBeUndefined();
  expect(await closed.signup.authorizeAccount(op.id, op.cookie, "a".repeat(64))).toBe(true);

  const open = fixture(),
    fresh = open.launched({}, "create"),
    admission = open.signup.creationAdmission(fresh.id, fresh.cookie)!;
  expect(admission).toMatchObject({
    gatewayId: open.gatewayId,
    ownerAccountId: open.ownerAccountId,
  });
  admission.assertCurrent();
  open.state.owners.set(open.gatewayId, "d".repeat(64));
  expect(() => admission.assertCurrent()).toThrow("another owner");
  open.state.owners.clear();
  open.signup.cancel(fresh.redemption);
  expect(() => admission.assertCurrent()).toThrow();
});

test("an admission from an earlier launch of the same ID cannot admit a later one", async () => {
  const f = fixture(),
    op = f.launched({}, "create"),
    admission = f.signup.creationAdmission(op.id, op.cookie)!;
  f.signup.cancel(op.redemption);
  const replay = f.signup.start(op.signed);
  const cookie = f.signup
    .launch(replay.operationId, new URL(replay.authorizeUrl).searchParams.get("ticket")!, "")
    .cookie.split(";")[0]!;
  expect(() => admission.assertCurrent()).toThrow();
  expect(f.signup.creationAdmission(replay.operationId, cookie)).toBeDefined();
});

test("the policy is checked again at approval, including for capacity", async () => {
  const listed = "a".repeat(64),
    file = await allowlistFile({ accounts: [listed] });
  const f = fixture({ policy: "allowlist", allowlistFile: file }, { maxPerOwner: 32 });
  const account = { ...f.actor, accountId: listed };
  const op = f.launched();
  f.signIn(op, listed);
  await writeFile(file, JSON.stringify({ accounts: [] }));
  await expect(f.signup.confirm(op.id, op.cookie, account)).rejects.toBeInstanceOf(SignupDenied);
  expect(f.signup.poll(op.redemption)).toEqual({ status: "denied", reason: "not-allowed" });

  await writeFile(file, JSON.stringify({ accounts: [listed] }));
  const full = f.launched();
  f.signIn(full, listed);
  f.state.capacity = false;
  await expect(f.signup.confirm(full.id, full.cookie, account)).rejects.toBeInstanceOf(
    SignupDenied,
  );
  expect(f.signup.poll(full.redemption)).toEqual({ status: "denied", reason: "capacity" });
  f.state.capacity = true;

  const google = f.launched({}, "create"),
    subjectDigest = "e".repeat(64);
  await writeFile(file, JSON.stringify({ googleSubjects: [subjectDigest] }));
  await f.signup.authorizeGoogle(google.id, google.cookie, { subjectDigest });
  f.signIn(google, listed);
  await expect(f.signup.confirm(google.id, google.cookie, account)).resolves.toBeDefined();
});

test("a passkey after an allowed Google sign-in is judged on its own", async () => {
  const subjectDigest = "e".repeat(64),
    f = fixture({
      policy: "allowlist",
      allowlistFile: await allowlistFile({ googleSubjects: [subjectDigest] }),
    }),
    op = f.launched({}, "create");
  await f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest });
  const proof = (await import("./device-enrollment.js")).passkeyProofChallenge;
  const { salt, issuedAt, nonce } = f.signup.proofCommitment(op.id, op.cookie);
  const { passkeyAuthenticator } = await import("../test/passkey-authenticator.js");
  f.signup.recordProof(op.id, op.cookie, {
    type: "passkey",
    accountId: f.actor.accountId,
    challenge: proof(salt, issuedAt, nonce),
    credential: passkeyAuthenticator().authentication(proof(salt, issuedAt, nonce), opaque()),
    credentialPublicKey: "ZmljdGlvbmFs",
  });
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).rejects.toBeInstanceOf(SignupDenied);
  expect(f.signup.describe(op.id, op.cookie)).toMatchObject({
    denied: { reason: "not-allowed", accountId: f.actor.accountId },
  });
});

test("an existing gateway with another owner is refused, and its own owner may continue", async () => {
  const f = fixture();
  f.state.owners.set(f.gatewayId, "d".repeat(64));
  expect(() => f.signup.start(f.request().signed)).toThrow("another owner");
  f.state.owners.set(f.gatewayId, f.ownerAccountId);
  const op = f.launched();
  f.signIn(op);
  f.state.owners.set(f.gatewayId, "d".repeat(64));
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).rejects.toThrow("another owner");
  f.state.owners.set(f.gatewayId, f.ownerAccountId);
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).resolves.toBeDefined();
});

test("requests are checked against their signature, lifetime, capacity and replay", () => {
  const f = fixture({ policy: "open" }, { maxPerOwner: 1 }),
    now = Math.floor(Date.now() / 1000);
  expect(() => f.signup.start({})).toThrow("Invalid");
  expect(() => f.signup.start(f.request({ issuedAt: now, expiresAt: now + 301 }).signed)).toThrow(
    "Invalid",
  );
  expect(() => f.signup.start(f.request({ issuedAt: now, expiresAt: now }).signed)).toThrow(
    "Invalid",
  );
  expect(() =>
    f.signup.start(f.request({ issuedAt: now + 31, expiresAt: now + 120 }).signed),
  ).toThrow("expired");
  expect(() => f.signup.start(f.request({ issuedAt: now - 120, expiresAt: now }).signed)).toThrow(
    "expired",
  );
  const value = f.request();
  expect(() => f.signup.start({ ...value.signed, nonce: opaque() })).toThrow("signature");
  expect(() =>
    f.signup.start({
      ...value.signed,
      ownerSignature: value.signed.ownerSignature.replace(/.$/, "B"),
    }),
  ).toThrow("signature");
  expect(() =>
    f.signup.start({
      ...value.signed,
      ownerSignature: value.signed.ownerSignature.replace(/.$/, "_"),
    }),
  ).toThrow("signature");
  expect(() => f.signup.start({ ...value.signed, ownerPublicKey: "not a key" })).toThrow(
    "signature",
  );
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ec = f.request({
    ownerPublicKey: other.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  expect(() => f.signup.start(ec.signed)).toThrow("signature");
  f.state.capacity = false;
  expect(() => f.signup.start(value.signed)).toThrow("no room");
  f.state.capacity = true;
  f.signup.start(value.signed);
  expect(() => f.signup.start(value.signed)).toThrow("already exists");
  expect(() => f.signup.start(f.request().signed)).toThrow("capacity");
});

test("limits are validated and the global bound holds across owners", () => {
  for (const limits of [{ maxOperations: 0 }, { maxPerOwner: 0 }, { maxOperations: 4097 }])
    expect(() => fixture({ policy: "open" }, limits)).toThrow("limits");
  const f = fixture({ policy: "open" }, { maxOperations: 1 });
  f.signup.start(f.request().signed);
  expect(() => f.signup.start(f.request().signed)).toThrow("capacity");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 121_000 });
  expect(f.signup.start(f.request().signed).operationId).toBeDefined();
});

test("a launch needs the ticket or the code, and a crowded browser is refused", () => {
  const f = fixture(),
    value = f.request(),
    started = f.signup.start(value.signed),
    ticket = new URL(started.authorizeUrl).searchParams.get("ticket")!;
  expect(() => f.signup.launch(started.operationId, "bad", "")).toThrow("refused");
  expect(() => f.signup.launch(started.operationId, opaque(), "")).toThrow("refused");
  const crowded = Array.from(
    { length: 8 },
    (_, index) => `__Host-omnesis-signup-${index}=opaque`,
  ).join("; ");
  expect(() => f.signup.launch(started.operationId, ticket, crowded)).toThrow("Too many");
  expect(() => f.codes.claim(started.code, crowded)).toThrow("Too many");
  const claimed = f.codes.claim(started.code, "");
  expect(claimed.location).toBe(`/_relay/account?signup=${started.operationId}`);
});

test("the link and the code reopen a request until somebody signs in, each time for a new browser", async () => {
  const f = fixture();
  const ticketOf = (op: { started: { authorizeUrl: string } }) =>
    new URL(op.started.authorizeUrl).searchParams.get("ticket")!;
  const cookieOf = (launch: { cookie: string }) => launch.cookie.split(";")[0]!;

  // The link, then the code, then the code again, then the link again.
  const op = f.launched(),
    ticket = ticketOf(op);
  const typed = cookieOf(f.codes.claim(op.started.code, op.cookie));
  expect(() => f.signup.describe(op.id, op.cookie)).toThrow("browser binding");
  expect(f.signup.describe(op.id, typed)).toMatchObject({ code: op.started.code });
  const retyped = cookieOf(f.codes.claim(op.started.code, typed));
  expect(() => f.signup.describe(op.id, typed)).toThrow("browser binding");
  const reopened = cookieOf(f.signup.launch(op.id, ticket, retyped));
  expect(() => f.signup.describe(op.id, retyped)).toThrow("browser binding");
  // Only the last browser can sign in and finish.
  expect(() => f.signIn(op)).toThrow("browser binding");
  const last = { ...op, cookie: reopened };
  f.signIn(last);
  expect(() => f.signup.launch(op.id, ticket, "")).toThrow("refused");
  expect(() => f.codes.claim(op.started.code, "")).toThrow("refused");
  expect(f.signup.describe(op.id, reopened)).toMatchObject({ needsProof: false });
  await f.signup.confirm(op.id, reopened, f.actor);
  expect(() => f.signup.launch(op.id, ticket, "")).toThrow("refused");
  expect(() => f.codes.claim(op.started.code, "")).toThrow("refused");
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "approved" });
  expect(() => f.signup.launch(op.id, ticket, "")).toThrow("refused");

  // The code first, then the link.
  const value = f.request(),
    started = f.signup.start(value.signed);
  const first = cookieOf(f.codes.claim(started.code, ""));
  const linked = cookieOf(f.signup.launch(started.operationId, ticketOf({ started }), first));
  expect(() => f.signup.describe(started.operationId, first)).toThrow("browser binding");
  expect(f.signup.describe(started.operationId, linked)).toMatchObject({ needsProof: true });

  // A Google identity accepted for this request already ties it to the browser that gave it.
  const google = f.launched({}, "create");
  await f.signup.authorizeGoogle(google.id, google.cookie, { subjectDigest: "e".repeat(64) });
  expect(() => f.signup.launch(google.id, ticketOf(google), "")).toThrow("refused");
  expect(() => f.codes.claim(google.started.code, "")).toThrow("refused");
  expect(f.signup.describe(google.id, google.cookie)).toMatchObject({ needsProof: true });
});

test("a refused, cancelled or replaced request cannot be reopened", async () => {
  const listed = fixture({
    policy: "allowlist",
    allowlistFile: await allowlistFile({ accounts: [] }),
  });
  const denied = listed.launched({}, "create"),
    ticket = new URL(denied.started.authorizeUrl).searchParams.get("ticket")!;
  await expect(
    listed.signup.authorizeGoogle(denied.id, denied.cookie, { subjectDigest: "e".repeat(64) }),
  ).rejects.toBeInstanceOf(SignupDenied);
  expect(() => listed.signup.launch(denied.id, ticket, "")).toThrow("refused");
  expect(() => listed.codes.claim(denied.started.code, "")).toThrow("refused");
  expect(listed.signup.describe(denied.id, denied.cookie)).toMatchObject({
    denied: { reason: "not-allowed" },
  });

  const f = fixture(),
    op = f.launched();
  f.signup.cancel(op.redemption);
  expect(() => f.codes.claim(op.started.code, "")).toThrow("expired or was cancelled");
  // The same signed request started again is a new operation with a new code.
  const replacement = f.signup.start(op.signed);
  expect(replacement.code).not.toBe(op.started.code);
  expect(() => f.codes.claim(op.started.code, "")).toThrow("refused");
  expect(f.codes.claim(replacement.code, "").location).toBe(`/_relay/account?signup=${op.id}`);
});

test("every browser action needs that operation's cookie, and every gateway action its secret", () => {
  const f = fixture(),
    op = f.launched();
  for (const header of [
    "",
    `${op.cookie}; ${op.cookie}`,
    op.cookie.replace(/=.+/, "=short"),
    op.cookie.replace(/=.+/, `=${opaque()}`),
  ])
    expect(() => f.signup.describe(op.id, header)).toThrow("browser binding");
  const before = f.request(),
    unlaunched = f.signup.start(before.signed);
  expect(() =>
    f.signup.describe(
      unlaunched.operationId,
      `__Host-omnesis-signup-${unlaunched.operationId}=${opaque()}`,
    ),
  ).toThrow("browser binding");
  expect(() => f.signup.poll({})).toThrow("Invalid");
  expect(() => f.signup.poll({ ...op.redemption, redemptionSecret: opaque() })).toThrow("refused");
  expect(() => f.signup.cancel({ ...op.redemption, redemptionSecret: opaque() })).toThrow(
    "refused",
  );
  expect(() => f.signup.poll({ ...op.redemption, operationId: randomUUID() })).toThrow("expired");
});

test("the link window outlasts the browser's five minutes, and then the operation expires", async () => {
  const f = fixture(),
    op = await f.approved();
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 600_000 });
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "approved" });
  vi.setSystemTime(Date.now() + 400_000);
  expect(() => f.signup.poll(op.redemption)).toThrow("expired");
});

test("a sign-out before collection refuses the proof and leaves the operation approved", async () => {
  const f = fixture(),
    op = await f.approved();
  f.state.active = false;
  expect(() => f.signup.poll(op.redemption)).toThrow("Account changed");
  f.state.active = true;
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "approved" });
});

test("closed or paused coordination stops every path", () => {
  const f = fixture(),
    op = f.launched();
  f.state.current = false;
  expect(() => f.signup.start(f.request().signed)).toThrow("paused");
  expect(() => f.signup.describe(op.id, op.cookie)).toThrow("paused");
  f.state.current = true;
  f.signup.close();
  expect(() => f.signup.start(f.request().signed)).toThrow("unavailable");
  expect(() => f.signup.poll(op.redemption)).toThrow("unavailable");
});

test("only a relay that opted in has signup enabled", () => {
  expect(fixture({ policy: "invitation" }).signup.enabled()).toBe(false);
  expect(fixture({ policy: "allowlist", allowlistFile: "/unused" }).signup.enabled()).toBe(true);
  expect(fixture({ policy: "open" }).signup.enabled()).toBe(true);
});

test("the owner signature covers the relay, the gateway and the optional name", () => {
  const f = fixture(),
    { unsigned } = f.request();
  const base = gatewaySignupTranscript(origin, unsigned);
  expect(gatewaySignupTranscript(origin, { ...unsigned, displayName: "Named" })).not.toEqual(base);
  expect(gatewaySignupTranscript("https://other.example.test", unsigned)).not.toEqual(base);
  expect(
    gatewaySignupTranscript(origin, { ...unsigned, gatewayId: unsigned.gatewayId.toUpperCase() }),
  ).toEqual(base);
  expect(() =>
    gatewaySignupTranscript(origin, { ...unsigned, displayName: "bad\nname" }),
  ).toThrow();
});

test("a cancelled and restarted request never receives the earlier sign-in's result", async () => {
  const f = fixture(),
    op = f.launched();
  f.signIn(op);
  const confirming = f.signup.confirm(op.id, op.cookie, f.actor);
  f.signup.cancel(op.redemption);
  f.signup.start(op.signed);
  await expect(confirming).rejects.toThrow("replaced");
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "pending" });
});

/** A group that knows its members, or fails as Google can, and counts what it was asked. */
function group(members: string[] = [], joinUrl?: string) {
  const gate = {
    joinUrl,
    failing: false,
    asked: [] as string[],
    async isMember(email: string) {
      gate.asked.push(email);
      if (gate.failing) throw new Error("membership lookup failed with HTTP 503");
      return members.includes(email);
    },
  };
  return gate;
}
const invitedEmail = "maya.reeves@example.com";
const joinUrl = "https://groups.example.com/g/testers";

test("a google sign-in whose verified email is in the group creates an account and is approved", async () => {
  const gate = group([invitedEmail], joinUrl);
  const f = fixture({
    policy: "allowlist",
    allowlistFile: await allowlistFile({}),
    googleGroup: gate,
  });
  const op = f.launched({}, "create"),
    subjectDigest = "e".repeat(64);
  expect(f.signup.requestsEmail(op.id, op.cookie)).toBe(true);
  // A group decides about Google sign-ins only; a new passkey account still needs `open`.
  expect(f.signup.creationAdmission(op.id, op.cookie)).toBeUndefined();
  await expect(
    f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest, email: () => invitedEmail }),
  ).resolves.toMatchObject({ gatewayId: f.gatewayId });
  expect(gate.asked).toEqual([invitedEmail]);
  f.signIn(op);
  // Approval honours the invitation it just checked, without asking Google again.
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).resolves.toBeDefined();
  expect(gate.asked).toHaveLength(1);
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "approved" });
});

test("a google sign-in not in the group is refused with the join link, and the gateway sees only the usual refusal", async () => {
  const gate = group([], joinUrl);
  const f = fixture({
    policy: "allowlist",
    allowlistFile: await allowlistFile({}),
    googleGroup: gate,
  });
  const op = f.launched({}, "create"),
    subjectDigest = "e".repeat(64);
  await expect(
    f.signup.authorizeGoogle(op.id, op.cookie, { subjectDigest, email: () => "jamie@example.com" }),
  ).rejects.toBeInstanceOf(SignupDenied);
  expect(f.signup.describe(op.id, op.cookie).denied).toEqual({
    reason: "not-allowed",
    googleSubject: subjectDigest,
    inviteOnly: true,
    joinUrl,
  });
  expect(f.signup.poll(op.redemption)).toEqual({ status: "denied", reason: "not-allowed" });

  // Without a join link the refusal is still invite-only, with no link to show.
  const quiet = fixture({ policy: "allowlist", googleGroup: group() });
  const other = quiet.launched({}, "create");
  await expect(
    quiet.signup.authorizeGoogle(other.id, other.cookie, {
      subjectDigest,
      email: () => "jamie@example.com",
    }),
  ).rejects.toBeInstanceOf(SignupDenied);
  expect(quiet.signup.describe(other.id, other.cookie).denied).toEqual({
    reason: "not-allowed",
    googleSubject: subjectDigest,
    inviteOnly: true,
  });
});

test("a group check google cannot answer refuses the sign-up for now and leaves the operation to retry", async () => {
  const gate = group([invitedEmail], joinUrl);
  const f = fixture({ policy: "allowlist", googleGroup: gate });
  const op = f.launched({}, "create"),
    google = { subjectDigest: "e".repeat(64), email: () => invitedEmail };
  gate.failing = true;
  const error = await f.signup.authorizeGoogle(op.id, op.cookie, google).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignupUnavailable);
  expect((error as RelayError).message).toBe(
    "We couldn't check your invitation right now. Try again in a few minutes.",
  );
  // Nothing was decided: no refusal, no sign-in, and the gateway keeps waiting.
  expect(f.signup.describe(op.id, op.cookie)).not.toHaveProperty("denied");
  expect(f.signup.poll(op.redemption)).toMatchObject({ status: "pending" });
  gate.failing = false;
  await expect(f.signup.authorizeGoogle(op.id, op.cookie, google)).resolves.toBeDefined();
});

test("an unverified or missing email is refused as not invited without asking google", async () => {
  const gate = group([invitedEmail], joinUrl);
  const f = fixture({ policy: "allowlist", googleGroup: gate }, { maxPerOwner: 32 });
  for (const email of [undefined, () => undefined]) {
    const op = f.launched({}, "create");
    await expect(
      f.signup.authorizeGoogle(op.id, op.cookie, {
        subjectDigest: "e".repeat(64),
        ...(email ? { email } : {}),
      }),
    ).rejects.toBeInstanceOf(SignupDenied);
    expect(f.signup.describe(op.id, op.cookie).denied).toMatchObject({ inviteOnly: true, joinUrl });
  }
  expect(gate.asked).toEqual([]);
});

test("the allowlist answers first, and an existing account is never checked against the group", async () => {
  const listed = "e".repeat(64),
    known = "a".repeat(64);
  const gate = group([], joinUrl);
  const email = vi.fn(() => invitedEmail);
  const f = fixture(
    {
      policy: "allowlist",
      allowlistFile: await allowlistFile({ googleSubjects: [listed], accounts: [known] }),
      googleGroup: gate,
    },
    { maxPerOwner: 32 },
  );
  const creating = f.launched({}, "create");
  await expect(
    f.signup.authorizeGoogle(creating.id, creating.cookie, { subjectDigest: listed, email }),
  ).resolves.toBeDefined();
  for (const intent of ["create", "existing"] as const) {
    const op = f.launched({}, intent);
    await expect(
      f.signup.authorizeGoogle(op.id, op.cookie, {
        subjectDigest: "f".repeat(64),
        account: known,
        email,
      }),
    ).resolves.toBeDefined();
    // An existing account the allowlist does not name is refused as before, with no link.
    const refused = f.launched({}, intent);
    await expect(
      f.signup.authorizeGoogle(refused.id, refused.cookie, {
        subjectDigest: "f".repeat(64),
        account: "b".repeat(64),
        email,
      }),
    ).rejects.toBeInstanceOf(SignupDenied);
    expect(f.signup.describe(refused.id, refused.cookie).denied).not.toHaveProperty("inviteOnly");
  }
  // Signing in without choosing to create is told there is no account, as before.
  const existing = f.launched({}, "existing");
  expect(f.signup.requestsEmail(existing.id, existing.cookie)).toBe(false);
  await expect(
    f.signup.authorizeGoogle(existing.id, existing.cookie, {
      subjectDigest: "f".repeat(64),
      email,
    }),
  ).rejects.toBeInstanceOf(NoAccount);
  expect(gate.asked).toEqual([]);
  expect(email).not.toHaveBeenCalled();
});

test("an invitation holds only for the google sign-in it was checked for", async () => {
  const gate = group([invitedEmail]);
  const f = fixture({ policy: "allowlist", googleGroup: gate });
  const op = f.launched({}, "create");
  await f.signup.authorizeGoogle(op.id, op.cookie, {
    subjectDigest: "e".repeat(64),
    email: () => invitedEmail,
  });
  // A passkey proof replaces the Google sign-in, and with it the invitation.
  const proof = (await import("./device-enrollment.js")).passkeyProofChallenge;
  const { salt, issuedAt, nonce } = f.signup.proofCommitment(op.id, op.cookie);
  const { passkeyAuthenticator } = await import("../test/passkey-authenticator.js");
  f.signup.recordProof(op.id, op.cookie, {
    type: "passkey",
    accountId: f.actor.accountId,
    challenge: proof(salt, issuedAt, nonce),
    credential: passkeyAuthenticator().authentication(proof(salt, issuedAt, nonce), opaque()),
    credentialPublicKey: "ZmljdGlvbmFs",
  });
  await expect(f.signup.confirm(op.id, op.cookie, f.actor)).rejects.toBeInstanceOf(SignupDenied);
  // A relay without a group never asks Google for the address.
  const plain = fixture({ policy: "open" }),
    creating = plain.launched({}, "create");
  expect(plain.signup.requestsEmail(creating.id, creating.cookie)).toBe(false);
});
