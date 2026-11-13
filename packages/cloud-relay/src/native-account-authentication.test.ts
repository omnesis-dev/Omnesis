// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { testPasskeyAuthorization } from "../test/account-admission.js";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { AccountAuthentication } from "./account-authentication.js";
import { NativeAccountAuthentication } from "./native-account-authentication.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { Passkeys } from "./passkeys.js";

const origin = "https://relay.example.test";
afterEach(() => vi.useRealTimers());
function fixture() {
  const db = new Database(":memory:"),
    accounts = new OmnesisAccounts(db);
  const sessions = new RelaySessions(randomBytes(32)),
    passkeys = new Passkeys(accounts, { origin });
  const verify = vi.fn(async () => ({
    issuer: "https://accounts.google.com",
    subject: "fictional-native-account",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));
  accounts.signInFederated(
    "google",
    accountId({
      issuer: "https://accounts.google.com",
      subject: "fictional-native-account",
      expiresAt: 0,
    }),
  );
  const authentication = new AccountAuthentication(origin, accounts, sessions, { verify });
  const native = new NativeAccountAuthentication({
    origin,
    accounts,
    sessions,
    passkeys,
    googleAuthentication: authentication,
  });
  const start = () => {
    const verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    return {
      verifier,
      nonce,
      ...native.start({
        nonce,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        kind: "android",
      }),
    };
  };
  return {
    db,
    accounts,
    sessions,
    passkeys,
    verify,
    authentication,
    native,
    start,
    close() {
      native.close();
      passkeys.close();
      db.close();
    },
  };
}

test("native Google account picking produces nonce-bound discovery and never leaves a management session", async () => {
  const f = fixture();
  try {
    const operation = f.start();
    const result = await f.native.google(
      operation.operationId,
      operation.ticket,
      operation.verifier,
      "fixture-google-token",
    );
    expect(f.verify).toHaveBeenCalledWith("fixture-google-token", operation.googleNonce);
    expect(await f.native.authenticate(result.discoveryToken)).toMatchObject({
      accountId: result.accountId,
      nonce: operation.nonce,
      version: 1,
    });
    await expect(f.authentication.authenticate(result.discoveryToken)).rejects.toThrow(
      "sign-in required",
    );
    await expect(f.sessions.verify(result.discoveryToken)).rejects.toThrow();
    expect(f.db.prepare("SELECT count(*) AS count FROM omnesis_account_sessions").get()).toEqual({
      count: 0,
    });
    await expect(
      f.native.google(operation.operationId, operation.ticket, operation.verifier, "replay"),
    ).rejects.toThrow("unavailable");
    await expect(f.native.authenticate("invalid")).rejects.toThrow("sign-in required");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
    await expect(f.native.authenticate(result.discoveryToken)).rejects.toThrow("sign-in required");
  } finally {
    f.close();
  }
});

test("a platform passkey authenticates the same account without granting native credential management", async () => {
  const f = fixture();
  try {
    const authenticator = passkeyAuthenticator(),
      browser = randomBytes(32).toString("base64url");
    const registration = await f.passkeys.beginRegistration(
      browser,
      undefined,
      "Passkey",
      testPasskeyAuthorization(f.accounts),
    );
    const account = await f.passkeys.finishRegistration(
      registration.ceremonyId,
      browser,
      authenticator.registration(registration.options.challenge),
    );
    if ("endorse" in account) throw new Error("Expected a new account's first passkey");
    const operation = f.start();
    const login = await f.native.passkeyOptions(operation.operationId, operation.ticket);
    const assertion = authenticator.authentication(
      login.options.challenge,
      registration.options.user.id,
    );
    const result = await f.native.passkey(
      operation.operationId,
      operation.ticket,
      operation.verifier,
      login.ceremonyId,
      assertion,
    );
    expect(await f.native.authenticate(result.discoveryToken)).toMatchObject({
      accountId: account.accountId,
      nonce: operation.nonce,
    });
    expect(f.verify).not.toHaveBeenCalled();
    await expect(f.authentication.authenticate(result.discoveryToken)).rejects.toThrow();
    f.accounts.registerPasskey(
      account.accountId,
      {
        credential: { id: "second-fixture", publicKey: new Uint8Array([1]), counter: 0 },
        label: "Spare",
        deviceType: "singleDevice",
        backedUp: false,
      },
      false,
    );
    f.accounts.removePasskey(account.accountId, "second-fixture", []);
    await expect(f.native.authenticate(result.discoveryToken)).rejects.toThrow("Account changed");
  } finally {
    f.close();
  }
});

test("cancelling native Google verification discards late discovery without creating a management session", async () => {
  const f = fixture();
  try {
    let release!: (value: Awaited<ReturnType<typeof f.verify>>) => void;
    f.verify.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const operation = f.start();
    const pending = f.native.google(
      operation.operationId,
      operation.ticket,
      operation.verifier,
      "fixture-google-token",
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.native.cancel(operation.operationId, operation.ticket);
    release({
      issuer: "https://accounts.google.com",
      subject: "fictional-native-account",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.db.prepare("SELECT count(*) AS count FROM omnesis_account_sessions").get()).toEqual({
      count: 0,
    });
  } finally {
    f.close();
  }
});

test("repeated native Google sign-ins cannot evict browser account-management sessions", async () => {
  const f = fixture();
  try {
    const browser = await f.authentication.googleSignIn(
      "fixture-google-token",
      "fixture-browser-nonce",
    );
    for (let index = 0; index < 33; index++) {
      const operation = f.start();
      await f.native.google(
        operation.operationId,
        operation.ticket,
        operation.verifier,
        "fixture-google-token",
      );
    }
    expect((await f.authentication.authenticate(browser.token)).accountId).toBe(browser.accountId);
    expect(f.db.prepare("SELECT count(*) AS count FROM omnesis_account_sessions").get()).toEqual({
      count: 1,
    });
  } finally {
    f.close();
  }
});

test("credential revocation between passkey verification and discovery issuance refuses a stale result", async () => {
  const f = fixture();
  try {
    const authenticator = passkeyAuthenticator(),
      browser = randomBytes(32).toString("base64url");
    const registration = await f.passkeys.beginRegistration(
      browser,
      undefined,
      "Passkey",
      testPasskeyAuthorization(f.accounts),
    );
    const account = await f.passkeys.finishRegistration(
      registration.ceremonyId,
      browser,
      authenticator.registration(registration.options.challenge),
    );
    if ("endorse" in account) throw new Error("Expected a new account's first passkey");
    f.accounts.registerPasskey(
      account.accountId,
      {
        credential: { id: "spare-fixture", publicKey: new Uint8Array([1]), counter: 0 },
        label: "Spare",
        deviceType: "singleDevice",
        backedUp: false,
      },
      false,
    );
    const verify = f.passkeys.finishAuthentication.bind(f.passkeys);
    vi.spyOn(f.passkeys, "finishAuthentication").mockImplementation(async (...args) => {
      const result = await verify(...args);
      f.accounts.removePasskey(account.accountId, "spare-fixture", []);
      return result;
    });
    const operation = f.start(),
      login = await f.native.passkeyOptions(operation.operationId, operation.ticket);
    await expect(
      f.native.passkey(
        operation.operationId,
        operation.ticket,
        operation.verifier,
        login.ceremonyId,
        authenticator.authentication(login.options.challenge, registration.options.user.id),
      ),
    ).rejects.toThrow("Account changed");
  } finally {
    f.close();
  }
});
