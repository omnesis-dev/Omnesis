// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { testAccountAdmission } from "../test/account-admission.js";
import { NoAccount } from "./account-admission.js";
import {
  AccountAuthentication,
  accountCredentialsRequireSignIn,
} from "./account-authentication.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { accountId, RelaySessions } from "./identity.js";

afterEach(() => vi.useRealTimers());
const origin = "https://relay.example.test";
const google = () => ({
  issuer: "https://accounts.google.com",
  subject: "fictional-subject",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

test("provider issuer variants establish one opaque account with a session distinct from tunnel authority", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    const provider = { verify: vi.fn(async () => google()) },
      migrated = vi.fn();
    const service = new AccountAuthentication(origin, accounts, sessions, provider, migrated);
    const first = await service.googleSignIn(
      "fixture-token",
      "fixture-nonce",
      undefined,
      testAccountAdmission(),
    );
    expect(provider.verify).toHaveBeenCalledWith("fixture-token", "fixture-nonce");
    expect(await service.authenticate(first.token)).toMatchObject({
      accountId: first.accountId,
      version: 1,
      method: "google",
    });
    await expect(sessions.verify(first.token)).rejects.toThrow();
    const aliases = migrated.mock.calls[0]![1] as string[];
    expect(aliases).toHaveLength(2);
    for (const alias of aliases) expect(accounts.legacyGoogleAccount(alias)).toBe(first.accountId);
    provider.verify.mockResolvedValue({ ...google(), issuer: "accounts.google.com" });
    expect((await service.googleSignIn("other-proof", "other-nonce")).accountId).toBe(
      first.accountId,
    );
    const passkey = await service.issuePasskeySession({ accountId: first.accountId, version: 1 });
    expect(await service.authenticate(passkey.token)).toMatchObject({
      accountId: first.accountId,
      method: "passkey",
    });
    expect(accounts.list(first.accountId).federated).toHaveLength(1);
    const routing = await sessions.issue(google());
    await expect(service.authenticate(routing.token)).rejects.toThrow("sign-in required");
    await expect(service.authenticate("invalid")).rejects.toThrow("sign-in required");
    await expect(service.authenticate("invalid", true)).rejects.toThrow("Sign in again");
    await expect(
      new AccountAuthentication(origin, accounts, sessions).googleSignIn(
        "proof",
        "nonce",
        undefined,
        testAccountAdmission(),
      ),
    ).rejects.toThrow("not configured");
  } finally {
    db.close();
  }
});

test("credential linking requires fresh sign-in and cannot move an existing credential between accounts", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    const provider = { verify: vi.fn(async () => google()) },
      service = new AccountAuthentication(origin, accounts, sessions, provider);
    const first = await service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    provider.verify.mockResolvedValue({ ...google(), subject: "fictional-other-subject" });
    const second = await service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    await expect(service.googleSignIn("proof", "nonce", first.token)).rejects.toThrow(
      "another Omnesis account",
    );
    provider.verify.mockResolvedValue({ ...google(), subject: "fictional-new-provider-subject" });
    const linked = await service.googleSignIn("proof", "nonce", first.token);
    expect(linked.accountId).toBe(first.accountId);
    expect(accounts.list(first.accountId).federated).toHaveLength(2);
    expect(accounts.list(second.accountId).federated).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
    expect((await service.authenticate(first.token)).accountId).toBe(first.accountId);
    await expect(service.authenticate(first.token, true)).rejects.toThrow("Sign in again");
    await expect(service.googleSignIn("proof", "nonce", first.token)).rejects.toThrow(
      "Sign in again",
    );
  } finally {
    db.close();
  }
});

test("revoked account sessions cannot link a credential after asynchronous provider verification", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    let release!: (value: ReturnType<typeof google>) => void;
    const provider = { verify: vi.fn(async () => google()) },
      service = new AccountAuthentication(origin, accounts, sessions, provider);
    const first = await service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    accounts.registerPasskey(
      first.accountId,
      {
        credential: { id: "fixture", publicKey: new Uint8Array([1]), counter: 0 },
        label: "Test",
        deviceType: "singleDevice",
        backedUp: false,
      },
      false,
    );
    provider.verify.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.googleSignIn("proof", "nonce", first.token);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    accounts.removePasskey(first.accountId, "fixture", ["google"]);
    release({ ...google(), subject: "fictional-new-subject" });
    await expect(pending).rejects.toThrow("Sign in again");
    await expect(
      service.issuePasskeySession({ accountId: first.accountId, version: 1 }),
    ).rejects.toThrow("changed");
    await expect(service.authenticate(first.token)).rejects.toThrow("sign-in required");
  } finally {
    db.close();
  }
});

test("account JWTs enforce their audience, purpose, version, method and bounded lifetime", async () => {
  const root = randomBytes(32),
    sessions = new RelaySessions(root);
  const accountId = OmnesisAccounts.newId(),
    now = Math.floor(Date.now() / 1000);
  const signed = (claims: Record<string, unknown>) =>
    new SignJWT({
      purpose: "omnesis-account-v3",
      sessionVersion: 1,
      method: "passkey",
      authTime: now,
      ...claims,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(origin)
      .setAudience("omnesis-account-v3")
      .setSubject(accountId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 86400)
      .sign(root);
  for (const claims of [
    { purpose: "relay-routing-v1" },
    { sessionVersion: 0 },
    { method: "untrusted" },
    { authTime: now - 1 },
  ])
    await expect(sessions.verifyAccountSession(await signed(claims), origin)).rejects.toThrow();
  const tooLong = await new SignJWT({
    purpose: "omnesis-account-v3",
    sessionVersion: 1,
    method: "google",
    authTime: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(origin)
    .setAudience("omnesis-account-v3")
    .setSubject(accountId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 30 * 86400 + 1)
    .sign(root);
  await expect(sessions.verifyAccountSession(tooLong, origin)).rejects.toThrow("lifetime");
  for (const account of [
    { accountId: "invalid", version: 1 },
    { accountId, version: 0 },
  ])
    await expect(sessions.issueAccountSession(account, "passkey", origin)).rejects.toThrow();
});

test("a provider contract cannot substitute a gateway owner or an expired identity for Google", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    for (const identity of [
      { ...google(), issuer: "omnesis-gateway-owner-key-v2" },
      { ...google(), expiresAt: 1 },
    ]) {
      const service = new AccountAuthentication(origin, accounts, sessions, {
        verify: async () => identity,
      });
      await expect(
        service.googleSignIn("proof", "nonce", undefined, testAccountAdmission()),
      ).rejects.toThrow("refused");
    }
  } finally {
    db.close();
  }
});

test("logout revokes only its own session and cannot revoke another account", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    const service = new AccountAuthentication(origin, accounts, sessions, {
      verify: async () => google(),
    });
    const first = await service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    const second = await service.issuePasskeySession({ accountId: first.accountId, version: 1 });
    const unrelated = accounts.signInFederated("google", "f".repeat(64));
    accounts.revokeSession(unrelated, first.sessionId);
    expect((await service.authenticate(first.token)).accountId).toBe(first.accountId);
    await service.logout(first.token);
    await service.logout(first.token);
    await service.logout("invalid");
    await expect(service.authenticate(first.token)).rejects.toThrow("sign-in required");
    expect((await service.authenticate(second.token)).accountId).toBe(first.accountId);
  } finally {
    db.close();
  }
});

test("storage failures cannot be mistaken for a successful sign-out", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    const service = new AccountAuthentication(origin, accounts, sessions, {
      verify: async () => google(),
    });
    const session = await service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    vi.spyOn(accounts, "revokeSession").mockImplementation(() => {
      throw new Error("synthetic storage failure");
    });
    await expect(service.logout(session.token)).rejects.toThrow("storage failure");
    expect((await service.authenticate(session.token)).accountId).toBe(session.accountId);
  } finally {
    db.close();
  }
});

test("shutdown refuses late provider results and session issuance without touching a closed registry", async () => {
  for (const operation of ["google", "issue", "authenticate"] as const) {
    const db = new Database(":memory:"),
      accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AccountAuthentication(origin, accounts, sessions, {
      verify: async () => {
        await gate;
        return google();
      },
    });
    const accountId = accounts.signInFederated("google", "a".repeat(64));
    let pending: Promise<unknown>;
    if (operation === "google")
      pending = service.googleSignIn("proof", "nonce", undefined, testAccountAdmission());
    else if (operation === "issue")
      pending = service.issuePasskeySession({ accountId, version: 1 });
    else {
      const session = await service.issuePasskeySession({ accountId, version: 1 });
      pending = service.authenticate(session.token);
    }
    service.close();
    db.close();
    release();
    await expect(pending).rejects.toThrow("unavailable");
    await expect(service.googleAccount("proof", "nonce")).rejects.toThrow("unavailable");
    await expect(service.issuePasskeySession({ accountId, version: 1 })).rejects.toThrow(
      "unavailable",
    );
  }
});

test("a verified Google sign-in that no account uses is refused as having no account, and creates none", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db);
    const service = new AccountAuthentication(
      origin,
      accounts,
      new RelaySessions(randomBytes(32)),
      { verify: async () => google() },
    );
    await expect(service.googleSignIn("proof", "nonce")).rejects.toBeInstanceOf(NoAccount);
    await expect(service.googleSignIn("proof", "nonce")).rejects.toMatchObject({
      status: 403,
      message: "There is no Omnesis account for this sign-in",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM omnesis_accounts").get()).toEqual({
      count: 0,
    });
    service.close();
  } finally {
    db.close();
  }
});

test("a gateway that starts over with another sign-in gets a new account, and the one it left is gone with its sessions", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    let subject = "fictional-first-subject";
    const service = new AccountAuthentication(origin, accounts, sessions, {
      verify: async () => ({ ...google(), subject }),
    });
    const gateway = testAccountAdmission();
    const consented = () =>
      (
        db.prepare("SELECT account_id FROM omnesis_account_consents ORDER BY rowid").all() as {
          account_id: string;
        }[]
      ).map((row) => row.account_id);
    const first = await service.googleSignIn("proof", "nonce", undefined, gateway);
    const passkey = await service.issuePasskeySession({ accountId: first.accountId, version: 1 });
    const aliases = [
      accountId({ ...google(), subject }),
      accountId({ ...google(), subject, issuer: "accounts.google.com" }),
    ];
    expect(accounts.legacyGoogleAccount(aliases[1]!)).toBe(first.accountId);
    accounts.linkGateway(first.accountId, gateway.ownerAccountId, "c".repeat(43));
    expect(consented()).toEqual([first.accountId]);

    // While the gateway is linked to the account it created, it creates nothing.
    subject = "fictional-second-subject";
    const second = accountId({ ...google(), subject });
    await expect(service.googleSignIn("proof", "nonce", undefined, gateway)).rejects.toThrow(
      "already allocated",
    );
    // And without having chosen to create, the second sign-in simply has no account.
    await expect(service.googleSignIn("proof", "nonce")).rejects.toBeInstanceOf(NoAccount);
    expect(accounts.federatedAccount("google", second)).toBeUndefined();
    expect(await service.authenticate(first.token)).toMatchObject({ accountId: first.accountId });
    expect(consented()).toEqual([first.accountId]);

    accounts.unlinkGateway(first.accountId, gateway.ownerAccountId);
    const created = await service.googleSignIn("proof", "nonce", undefined, gateway);
    expect(created.accountId).not.toBe(first.accountId);
    expect(accounts.federatedAccount("google", second)).toBe(created.accountId);
    expect(consented()).toEqual([created.accountId]);
    expect(accounts.snapshot()).toMatchObject({
      identityAccounts: 1,
      identityFederatedCredentials: 1,
      identityActiveSessions: 1,
    });
    // Every session of the account that made way is refused, however it signed in.
    for (const token of [first.token, passkey.token]) {
      await expect(service.authenticate(token)).rejects.toThrow("sign-in required");
      await expect(service.authenticate(token, true)).rejects.toThrow("Sign in again");
      await expect(service.googleSignIn("proof", "nonce", token)).rejects.toThrow("Sign in again");
    }
    await expect(
      service.issuePasskeySession({ accountId: first.accountId, version: 1 }),
    ).rejects.toThrow("Account changed");
    expect(await service.authenticate(created.token)).toMatchObject({
      accountId: created.accountId,
    });
    // The first sign-in is unknown again: it signs in to nothing and creates nothing.
    subject = "fictional-first-subject";
    for (const alias of aliases) expect(accounts.legacyGoogleAccount(alias)).toBeUndefined();
    await expect(service.googleSignIn("proof", "nonce")).rejects.toBeInstanceOf(NoAccount);
    expect(accounts.federatedAccount("google", aliases[0]!)).toBeUndefined();
    expect(accounts.snapshot().identityAccounts).toBe(1);
    service.close();
  } finally {
    db.close();
  }
});

test("a gateway that starts over leaves an account another gateway still uses signed in and whole", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      sessions = new RelaySessions(randomBytes(32));
    let subject = "fictional-first-subject";
    const service = new AccountAuthentication(origin, accounts, sessions, {
      verify: async () => ({ ...google(), subject }),
    });
    const gateway = testAccountAdmission(),
      otherGateway = "9".repeat(64);
    const first = await service.googleSignIn("proof", "nonce", undefined, gateway);
    accounts.linkGateway(first.accountId, gateway.ownerAccountId, "c".repeat(43));
    accounts.linkGateway(first.accountId, otherGateway, "d".repeat(43));
    accounts.unlinkGateway(first.accountId, gateway.ownerAccountId);
    subject = "fictional-second-subject";
    const created = await service.googleSignIn("proof", "nonce", undefined, gateway);
    expect(created.accountId).not.toBe(first.accountId);
    // The first account's session still works, and its sign-in still signs in to it.
    expect(await service.authenticate(first.token)).toMatchObject({ accountId: first.accountId });
    expect(await service.authenticate(first.token, true)).toMatchObject({
      accountId: first.accountId,
    });
    subject = "fictional-first-subject";
    expect((await service.googleSignIn("proof", "nonce")).accountId).toBe(first.accountId);
    expect(accounts.gatewayAccount(otherGateway)?.accountId).toBe(first.accountId);
    expect(accounts.snapshot()).toMatchObject({
      identityAccounts: 2,
      identityFederatedCredentials: 2,
      identityGatewayLinks: 1,
    });
    service.close();
  } finally {
    db.close();
  }
});

test("credential management stays available through the exact five-minute authentication boundary", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2028-01-01T00:10:00Z"));
  const now = Math.floor(Date.now() / 1000);
  expect(accountCredentialsRequireSignIn(now)).toBe(false);
  expect(accountCredentialsRequireSignIn(now - 300)).toBe(false);
  expect(accountCredentialsRequireSignIn(now - 301)).toBe(true);
});
