// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { testAccountAdmission } from "../test/account-admission.js";
import {
  ACCOUNT_TERMS_VERSION,
  OmnesisAccounts,
  type PasskeyRegistration,
} from "./omnesis-accounts.js";

const passkey = (id = "fixture"): PasskeyRegistration => ({
  credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
  deviceType: "multiDevice",
  backedUp: true,
  label: "Test passkey",
});
afterEach(() => vi.useRealTimers());
function fixture(capacity?: number) {
  const db = new Database(":memory:");
  const accounts = new OmnesisAccounts(db, capacity);
  return { db, accounts };
}

test("federated credentials are explicit replaceable proofs of a random permanent account", () => {
  const { db, accounts } = fixture();
  try {
    const google = "a".repeat(64),
      other = "b".repeat(64);
    expect(accounts.federatedAccount("google", google)).toBeUndefined();
    const account = accounts.signInFederated("google", google);
    expect(account).not.toBe(google);
    expect(accounts.signInFederated("google", google)).toBe(account);
    accounts.linkFederated(account, "google", google);
    accounts.linkFederated(account, "future-provider", other);
    expect(
      accounts
        .list(account)
        .federated.map((value) => value.provider)
        .sort(),
    ).toEqual(["future-provider", "google"]);
    const second = accounts.signInFederated("google", other);
    expect(() => accounts.linkFederated(second, "google", google)).toThrow("another Omnesis");
    accounts.unlinkFederated(account, "google", google, ["google", "future-provider"]);
    expect(accounts.sessionVersion(account)).toBe(2);
    expect(() => accounts.unlinkFederated(account, "future-provider", other, ["google"])).toThrow(
      "at least one",
    );
    expect(accounts.sessionVersion(second)).toBe(1);
    expect(() => accounts.list("c".repeat(64))).toThrow("sign-in required");
    expect(() => accounts.list("invalid")).toThrow();
  } finally {
    db.close();
  }
});

test("multiple public passkeys share one account and deletion invalidates existing account sessions", () => {
  const { db, accounts } = fixture();
  try {
    const account = OmnesisAccounts.newId();
    accounts.registerPasskey(account, passkey(), true);
    accounts.registerPasskey(
      account,
      {
        ...passkey("second"),
        credential: { ...passkey("second").credential, transports: ["internal"] },
      },
      false,
    );
    expect(accounts.list(account).passkeys).toHaveLength(2);
    expect(accounts.passkey("missing")).toBeUndefined();
    const stored = accounts.passkey("fixture")!;
    expect(stored.credential.transports).toEqual([]);
    accounts.recordAuthentication(stored, 0, "multiDevice", false);
    expect(accounts.passkey("fixture")!.revision).toBe(2);
    expect(accounts.list(account).passkeys.find((key) => key.id === "fixture")!.backedUp).toBe(
      false,
    );
    expect(() => accounts.recordAuthentication(stored, 0, "multiDevice", true)).toThrow("changed");
    for (const [counter, type, backup] of [
      [-1, "multiDevice", true],
      [1.5, "multiDevice", true],
      [1, "singleDevice", false],
      [1, "singleDevice", true],
    ] as const)
      expect(() => accounts.recordAuthentication(stored, counter, type, backup)).toThrow("refused");
    const current = accounts.passkey("fixture")!;
    accounts.recordAuthentication(current, 5, "multiDevice", true);
    expect(() =>
      accounts.recordAuthentication(accounts.passkey("fixture")!, 4, "multiDevice", true),
    ).toThrow("refused");
    expect(() => accounts.removePasskey(account, "missing", ["google"])).toThrow("not found");
    accounts.removePasskey(account, "fixture", ["google"]);
    expect(accounts.sessionVersion(account)).toBe(2);
    expect(() => accounts.recordAuthentication(current, 6, "multiDevice", true)).toThrow("changed");
    expect(() => accounts.removePasskey(account, "second", ["google"])).toThrow("at least one");
  } finally {
    db.close();
  }
});

test("invalid, duplicate and over-capacity registrations roll back new accounts without stealing credentials", () => {
  const { db, accounts } = fixture(2);
  try {
    const first = OmnesisAccounts.newId();
    accounts.registerPasskey(first, passkey(), true);
    const invalid = [
      { ...passkey(""), label: "Valid" },
      { ...passkey(), credential: { ...passkey().credential, publicKey: new Uint8Array() } },
      { ...passkey(), credential: { ...passkey().credential, publicKey: new Uint8Array(4097) } },
      { ...passkey(), credential: { ...passkey().credential, counter: -1 } },
      { ...passkey(), credential: { ...passkey().credential, counter: 0.5 } },
      { ...passkey(), deviceType: "singleDevice" as const, backedUp: true },
      { ...passkey(), label: "\u0000invalid" },
      { ...passkey(), label: "" },
    ];
    for (const value of invalid) {
      const id = OmnesisAccounts.newId();
      expect(() => accounts.registerPasskey(id, value, true)).toThrow();
      expect(accounts.sessionVersion(id)).toBeUndefined();
    }
    const duplicate = OmnesisAccounts.newId();
    expect(() => accounts.registerPasskey(duplicate, passkey(), true)).toThrow(
      "already registered",
    );
    expect(accounts.sessionVersion(duplicate)).toBeUndefined();
    expect(() => accounts.registerPasskey(first, passkey("different"), true)).toThrow(
      "already exists",
    );
    accounts.registerPasskey(
      OmnesisAccounts.newId(),
      { ...passkey("single"), deviceType: "singleDevice", backedUp: false },
      true,
    );
    expect(() => accounts.signInFederated("google", "c".repeat(64))).toThrow("capacity");
    expect(() => accounts.registerPasskey(OmnesisAccounts.newId(), passkey("extra"), true)).toThrow(
      "capacity",
    );
  } finally {
    db.close();
  }
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    const db = new Database(":memory:");
    try {
      expect(() => new OmnesisAccounts(db, invalid)).toThrow("capacity");
    } finally {
      db.close();
    }
  }
});

test("credential limits include all providers and passkeys with isolated account scopes", () => {
  const { db, accounts } = fixture();
  try {
    const account = accounts.signInFederated("google", "a".repeat(64));
    for (let index = 0; index < 15; index++)
      accounts.registerPasskey(account, passkey(`fixture_${index}`), false);
    expect(() => accounts.registerPasskey(account, passkey("overflow"), false)).toThrow("limit");
    expect(() => accounts.linkFederated(account, "future-provider", "b".repeat(64))).toThrow(
      "limit",
    );
    accounts.linkFederated(account, "google", "a".repeat(64));
    const second = accounts.signInFederated("google", "c".repeat(64));
    accounts.registerPasskey(second, passkey("other"), false);
    expect(() => accounts.removePasskey(account, "other", ["google"])).toThrow("not found");
    expect(() => accounts.unlinkFederated(account, "google", "c".repeat(64), ["google"])).toThrow(
      "not found",
    );
    expect(accounts.passkey("other")!.accountId).toBe(second);
    const one = accounts.passkey("fixture_0")!;
    accounts.removePasskey(account, "fixture_0", ["google"]);
    expect(() => accounts.recordAuthentication(one, 0, "multiDevice", true)).toThrow("changed");
  } finally {
    db.close();
  }
});

test("disabled providers cannot justify removing the final usable passkey and stale revisions cannot delete credentials", () => {
  const { db, accounts } = fixture();
  try {
    const account = accounts.signInFederated("google", "d".repeat(64));
    accounts.registerPasskey(account, passkey(), false);
    expect(() => accounts.removePasskey(account, "fixture", [], 1)).toThrow("at least one");
    expect(accounts.passkey("fixture")).toBeDefined();
    accounts.registerPasskey(account, passkey("second"), false);
    accounts.removePasskey(account, "fixture", [], 1);
    expect(() => accounts.removePasskey(account, "second", ["google"], 1)).toThrow("changed");
    expect(accounts.passkey("second")).toBeDefined();
  } finally {
    db.close();
  }
});

test("Google aliases and gateway associations preserve account ownership through relinking and removal", () => {
  const { db, accounts } = fixture();
  try {
    const firstDigest = "a".repeat(64),
      secondDigest = "b".repeat(64),
      alias = "c".repeat(64),
      owner = "d".repeat(64);
    expect(() => accounts.bindGoogleAliases(firstDigest, [alias])).toThrow("not linked");
    const first = accounts.signInFederated("google", firstDigest),
      second = accounts.signInFederated("google", secondDigest);
    accounts.bindGoogleAliases(firstDigest, [firstDigest, alias]);
    accounts.bindGoogleAliases(firstDigest, [alias]);
    expect(accounts.legacyGoogleAccount(alias)).toBe(first);
    expect(accounts.legacyGoogleAccount("e".repeat(64))).toBeUndefined();
    expect(() => accounts.bindGoogleAliases(secondDigest, [alias])).toThrow("conflicts");
    expect(accounts.federatedDigests(first, "google")).toEqual([firstDigest]);
    expect(accounts.gatewayLinks(first)).toEqual([]);
    expect(accounts.gatewayAccount(owner)).toBeUndefined();
    expect(() => accounts.linkGateway(first, owner, "invalid")).toThrow("Invalid");
    accounts.linkGateway(first, owner, "a".repeat(43));
    accounts.linkGateway(first, owner, "b".repeat(43));
    expect(accounts.gatewayLinks(first)).toEqual([{ ownerAccount: owner, seal: "b".repeat(43) }]);
    expect(() => accounts.linkGateway(second, owner, "a".repeat(43))).toThrow(
      "another Omnesis account",
    );
    accounts.unlinkGateway(second, owner);
    expect(accounts.gatewayAccount(owner)?.accountId).toBe(first);
    accounts.unlinkGateway(first, owner);
    expect(accounts.gatewayAccount(owner)).toBeUndefined();
    accounts.linkGateway(second, owner, "c".repeat(43));
    expect(accounts.gatewayAccount(owner)?.accountId).toBe(second);
    expect(() => accounts.linkGateway(first, owner, "d".repeat(43), () => false)).toThrow(
      "another Omnesis account",
    );
    accounts.linkGateway(
      first,
      owner,
      "d".repeat(43),
      (old) => old.accountId === second && old.seal === "c".repeat(43),
    );
    expect(accounts.gatewayAccount(owner)).toEqual({ accountId: first, seal: "d".repeat(43) });
  } finally {
    db.close();
  }
});

test("account session budgets evict the oldest sessions, prune expiry and never revoke another account", () => {
  const { db, accounts } = fixture(),
    baseline = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: baseline });
  try {
    const account = accounts.signInFederated("google", "a".repeat(64)),
      other = accounts.signInFederated("google", "b".repeat(64));
    const expiresAt = Math.floor(baseline / 1000) + 3600;
    for (const expiry of [0, Math.floor(baseline / 1000), expiresAt + 31 * 86400, 1.5])
      expect(() => accounts.registerSession(account, 1, randomUUID(), expiry)).toThrow("expiry");
    const ids = Array.from({ length: 35 }, () => randomUUID());
    for (const [index, id] of ids.entries()) {
      vi.setSystemTime(baseline + index);
      accounts.registerSession(account, 1, id, expiresAt);
    }
    expect(db.prepare("SELECT count(*) AS count FROM omnesis_account_sessions").get()).toEqual({
      count: 32,
    });
    expect(accounts.activeSession(account, 1, ids[0]!)).toBe(false);
    expect(accounts.activeSession(account, 1, ids.at(-1)!)).toBe(true);
    accounts.revokeSession(other, ids.at(-1)!);
    expect(accounts.activeSession(account, 1, ids.at(-1)!)).toBe(true);
    accounts.revokeSession(account, ids.at(-1)!);
    expect(accounts.activeSession(account, 1, ids.at(-1)!)).toBe(false);
    vi.setSystemTime(baseline + 3601_000);
    const current = randomUUID();
    accounts.registerSession(account, 1, current, Math.floor(Date.now() / 1000) + 3600);
    expect(db.prepare("SELECT count(*) AS count FROM omnesis_account_sessions").get()).toEqual({
      count: 1,
    });
    expect(accounts.activeSession(account, 1, current)).toBe(true);
    expect(accounts.activeSession(account, 2, current)).toBe(false);
  } finally {
    db.close();
  }
});

test("single-device passkeys cannot acquire a synced backup state", () => {
  const { db, accounts } = fixture();
  try {
    const account = OmnesisAccounts.newId();
    accounts.registerPasskey(
      account,
      { ...passkey(), deviceType: "singleDevice", backedUp: false },
      true,
    );
    const credential = accounts.passkey("fixture")!;
    expect(() => accounts.recordAuthentication(credential, 1, "singleDevice", true)).toThrow(
      "refused",
    );
    expect(accounts.passkey("fixture")!.revision).toBe(1);
  } finally {
    db.close();
  }
});

test("operator snapshots aggregate credentials and exclude expired or invalidated sessions", () => {
  const { db, accounts } = fixture();
  vi.useFakeTimers({ toFake: ["Date"], now: 1800000000000 });
  try {
    expect(accounts.snapshot()).toEqual({
      identityAccounts: 0,
      identityPasskeys: 0,
      identityFederatedCredentials: 0,
      identityGatewayLinks: 0,
      identityActiveSessions: 0,
    });
    const account = accounts.signInFederated("google", "a".repeat(64));
    accounts.registerPasskey(account, passkey(), false);
    accounts.linkGateway(account, "b".repeat(64), "c".repeat(43));
    accounts.registerSession(account, 1, randomUUID(), 1800000010);
    expect(accounts.snapshot()).toEqual({
      identityAccounts: 1,
      identityPasskeys: 1,
      identityFederatedCredentials: 1,
      identityGatewayLinks: 1,
      identityActiveSessions: 1,
    });
    vi.setSystemTime(1800000011000);
    expect(accounts.snapshot().identityActiveSessions).toBe(0);
    accounts.registerSession(account, 1, randomUUID(), 1800000020);
    db.prepare("UPDATE omnesis_accounts SET session_version=session_version+1").run();
    expect(accounts.snapshot().identityActiveSessions).toBe(0);
  } finally {
    db.close();
  }
});

test("gateway signup allocations are durable, atomic and independent of owner key changes while the gateway is linked to its account", () => {
  const { db, accounts } = fixture();
  try {
    const admission = testAccountAdmission();
    const first = accounts.signInFederated("google", "e".repeat(64), admission);
    accounts.linkGateway(first, admission.ownerAccountId, "c".repeat(43));
    expect(accounts.canAdmitGateway(admission.gatewayId)).toBe(false);
    expect(accounts.signInFederated("google", "e".repeat(64))).toBe(first);
    expect(() =>
      accounts.signInFederated("google", "f".repeat(64), {
        ...admission,
        ownerAccountId: "a".repeat(64),
      }),
    ).toThrow("already allocated");
    expect(accounts.federatedAccount("google", "f".repeat(64))).toBeUndefined();
    const reopened = new OmnesisAccounts(db);
    expect(reopened.canAdmitGateway(admission.gatewayId)).toBe(false);
    expect(() => accounts.canAdmitGateway("not-a-gateway")).toThrow();
    const retry = testAccountAdmission(),
      failed = OmnesisAccounts.newId();
    accounts.registerPasskey(first, passkey("reserved"), false);
    expect(() =>
      accounts.registerPasskey(failed, passkey("reserved"), true, undefined, retry),
    ).toThrow("already registered");
    expect(accounts.canAdmitGateway(retry.gatewayId)).toBe(true);
    expect(accounts.sessionVersion(failed)).toBeUndefined();
    accounts.registerPasskey(failed, passkey("fresh"), true, undefined, retry);
    accounts.linkGateway(failed, retry.ownerAccountId, "d".repeat(43));
    expect(accounts.canAdmitGateway(retry.gatewayId)).toBe(false);
  } finally {
    db.close();
  }
});

const consents = (db: Database.Database) =>
  db
    .prepare("SELECT account_id, terms_version, accepted_at FROM omnesis_account_consents")
    .all() as { account_id: string; terms_version: string; accepted_at: number }[];

test("creating an account records what it agreed to and when", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const { db, accounts } = fixture();
  try {
    expect(consents(db)).toEqual([]);
    const google = accounts.signInFederated("google", "a".repeat(64), testAccountAdmission());
    vi.setSystemTime(1800000005000);
    const withPasskey = OmnesisAccounts.newId();
    accounts.registerPasskey(withPasskey, passkey(), true, undefined, testAccountAdmission());
    expect(ACCOUNT_TERMS_VERSION).toBe("none");
    expect(consents(db)).toEqual([
      { account_id: google, terms_version: ACCOUNT_TERMS_VERSION, accepted_at: 1800000000000 },
      { account_id: withPasskey, terms_version: ACCOUNT_TERMS_VERSION, accepted_at: 1800000005000 },
    ]);
    // Signing in again, or adding a sign-in method, is not another agreement.
    vi.setSystemTime(1800000009000);
    accounts.signInFederated("google", "a".repeat(64));
    accounts.registerPasskey(google, passkey("second"), false);
    expect(consents(db)).toHaveLength(2);
    expect(consents(db)[0]!.accepted_at).toBe(1800000000000);
    // A creation that fails leaves no consent behind.
    expect(() =>
      accounts.registerPasskey(
        OmnesisAccounts.newId(),
        passkey("second"),
        true,
        undefined,
        testAccountAdmission(),
      ),
    ).toThrow("already registered");
    expect(consents(db)).toHaveLength(2);
  } finally {
    db.close();
  }
});

/** Everything the store holds about one account, to tell an untouched account from a removed one. */
const held = (db: Database.Database, account: string) =>
  Object.fromEntries(
    [
      "omnesis_accounts",
      "omnesis_passkeys",
      "omnesis_federated_credentials",
      "omnesis_account_sessions",
      "omnesis_account_consents",
      "omnesis_account_admissions",
      "omnesis_gateway_links",
    ].map((table) => [
      table,
      (
        db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id=?`).get(account) as {
          count: number;
        }
      ).count,
    ]),
  );
const admissions = (db: Database.Database) =>
  db
    .prepare("SELECT gateway_id, owner_account_id, account_id FROM omnesis_account_admissions")
    .all() as { gateway_id: string; owner_account_id: string; account_id: string }[];
const vouched = (db: Database.Database) =>
  (
    db.prepare("SELECT credential_id FROM omnesis_passkey_endorsements").all() as {
      credential_id: string;
    }[]
  )
    .map((row) => row.credential_id)
    .sort();
const endorsement = {
  type: "google" as const,
  idToken: "fictional-google-token",
  salt: "c".repeat(43),
};

test("a gateway creates another account only after leaving the one it created, which is removed when no gateway uses it", () => {
  const { db, accounts } = fixture();
  try {
    const gateway = testAccountAdmission(),
      googleA = "a".repeat(64),
      googleB = "b".repeat(64);
    const first = accounts.signInFederated("google", googleA, gateway);
    accounts.registerPasskey(first, passkey("first-passkey"), false);
    accounts.registerPasskey(first, passkey("vouched"), false, 1, undefined, endorsement);
    const session = randomUUID();
    accounts.registerSession(first, 1, session, Math.floor(Date.now() / 1000) + 300);
    accounts.linkGateway(first, gateway.ownerAccountId, "c".repeat(43));
    // A bystander account, which nothing below may touch.
    const bystander = accounts.signInFederated("google", "f".repeat(64), testAccountAdmission());
    accounts.registerPasskey(bystander, passkey("bystander"), false, 1, undefined, endorsement);
    const bystanderSession = randomUUID();
    accounts.registerSession(bystander, 1, bystanderSession, Math.floor(Date.now() / 1000) + 300);
    const bystanderHeld = held(db, bystander);

    // While the gateway is still linked to the account it created, it creates nothing.
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(false);
    expect(() => accounts.signInFederated("google", googleB, gateway)).toThrow("already allocated");
    expect(() =>
      accounts.registerPasskey(OmnesisAccounts.newId(), passkey("new"), true, undefined, gateway),
    ).toThrow("already allocated");
    expect(accounts.federatedAccount("google", googleB)).toBeUndefined();
    expect(accounts.passkey("new")).toBeUndefined();
    expect(accounts.activeSession(first, 1, session)).toBe(true);

    // Being allowed to create is not creating: the first account stays until another is made.
    accounts.unlinkGateway(first, gateway.ownerAccountId);
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(true);
    expect(accounts.sessionVersion(first)).toBe(1);
    expect(accounts.signInFederated("google", googleA)).toBe(first);
    // A creation that fails keeps it too.
    expect(() =>
      accounts.registerPasskey(
        OmnesisAccounts.newId(),
        passkey("bystander"),
        true,
        undefined,
        gateway,
      ),
    ).toThrow("already registered");
    expect(accounts.sessionVersion(first)).toBe(1);
    expect(accounts.passkey("vouched")?.accountId).toBe(first);
    expect(vouched(db)).toEqual(["bystander", "vouched"]);
    expect(admissions(db)).toContainEqual({
      gateway_id: gateway.gatewayId,
      owner_account_id: gateway.ownerAccountId,
      account_id: first,
    });

    const second = accounts.signInFederated("google", googleB, gateway);
    expect(second).not.toBe(first);
    expect(accounts.sessionVersion(first)).toBeUndefined();
    expect(accounts.federatedAccount("google", googleA)).toBeUndefined();
    expect(accounts.passkey("first-passkey")).toBeUndefined();
    expect(accounts.passkey("vouched")).toBeUndefined();
    expect(accounts.activeSession(first, 1, session)).toBe(false);
    expect(() => accounts.list(first)).toThrow("sign-in required");
    expect(Object.values(held(db, first))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(vouched(db)).toEqual(["bystander"]);
    expect(
      consents(db)
        .map((row) => row.account_id)
        .sort(),
    ).toEqual([bystander, second].sort());
    expect(admissions(db).filter((row) => row.gateway_id === gateway.gatewayId)).toEqual([
      {
        gateway_id: gateway.gatewayId,
        owner_account_id: gateway.ownerAccountId,
        account_id: second,
      },
    ]);
    // The bystander is whole.
    expect(held(db, bystander)).toEqual(bystanderHeld);
    expect(accounts.passkey("bystander")?.accountId).toBe(bystander);
    expect(accounts.activeSession(bystander, 1, bystanderSession)).toBe(true);
    expect(accounts.snapshot()).toMatchObject({ identityAccounts: 2, identityPasskeys: 1 });
    // Linked to the new account, the gateway holds that one; the first identity is unknown again.
    accounts.linkGateway(second, gateway.ownerAccountId, "c".repeat(43));
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(false);
    expect(() => accounts.signInFederated("google", googleA, gateway)).toThrow("already allocated");
    expect(accounts.federatedAccount("google", googleA)).toBeUndefined();
  } finally {
    db.close();
  }
});

test("an account another gateway still uses is kept whole when the gateway that created it starts over", () => {
  const { db, accounts } = fixture();
  try {
    const gateway = testAccountAdmission(),
      otherGateway = "9".repeat(64),
      thirdGateway = "8".repeat(64),
      googleA = "a".repeat(64),
      googleB = "b".repeat(64),
      googleC = "c".repeat(64);
    const first = accounts.signInFederated("google", googleA, gateway);
    accounts.registerPasskey(first, passkey("first-passkey"), false);
    accounts.registerPasskey(first, passkey("vouched"), false, 1, undefined, endorsement);
    const session = randomUUID();
    accounts.registerSession(first, 1, session, Math.floor(Date.now() / 1000) + 300);
    accounts.linkGateway(first, gateway.ownerAccountId, "c".repeat(43));
    accounts.linkGateway(first, otherGateway, "d".repeat(43));
    // Another gateway on the account changes nothing while this one is still linked to it.
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(false);
    expect(() => accounts.signInFederated("google", googleB, gateway)).toThrow("already allocated");
    // Nor does the other gateway leaving: what counts is this gateway's own link.
    accounts.unlinkGateway(first, otherGateway);
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(false);
    accounts.linkGateway(first, otherGateway, "d".repeat(43));

    accounts.unlinkGateway(first, gateway.ownerAccountId);
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(true);
    const before = held(db, first);
    const second = accounts.signInFederated("google", googleB, gateway);
    expect(second).not.toBe(first);
    // The first account lost only the admission, which now names the new account.
    expect(held(db, first)).toEqual({ ...before, omnesis_account_admissions: 0 });
    expect(admissions(db)).toEqual([
      {
        gateway_id: gateway.gatewayId,
        owner_account_id: gateway.ownerAccountId,
        account_id: second,
      },
    ]);
    expect(accounts.signInFederated("google", googleA)).toBe(first);
    expect(accounts.activeSession(first, 1, session)).toBe(true);
    expect(accounts.passkey("first-passkey")?.accountId).toBe(first);
    expect(accounts.passkeyKeys(first)).toEqual([
      { id: "first-passkey", publicKey: "AQID" },
      { id: "vouched", publicKey: "AQID", endorsement },
    ]);
    expect(accounts.gatewayLinks(first)).toEqual([
      { ownerAccount: otherGateway, seal: "d".repeat(43) },
    ]);
    expect(accounts.gatewayAccount(otherGateway)?.accountId).toBe(first);
    expect(consents(db).map((row) => row.account_id)).toEqual([first, second]);
    expect(accounts.snapshot()).toMatchObject({ identityAccounts: 2, identityPasskeys: 2 });

    // Starting over once more: the second account goes only if no gateway uses it.
    accounts.linkGateway(second, gateway.ownerAccountId, "c".repeat(43));
    accounts.linkGateway(second, thirdGateway, "e".repeat(43));
    expect(accounts.canAdmitGateway(gateway.gatewayId)).toBe(false);
    accounts.unlinkGateway(second, gateway.ownerAccountId);
    const kept = OmnesisAccounts.newId();
    accounts.registerPasskey(kept, passkey("third"), true, undefined, gateway);
    expect(accounts.sessionVersion(second)).toBe(1);
    expect(accounts.federatedAccount("google", googleB)).toBe(second);
    expect(admissions(db)).toEqual([
      { gateway_id: gateway.gatewayId, owner_account_id: gateway.ownerAccountId, account_id: kept },
    ]);
    // And this time nothing else uses the account the gateway leaves, so it is removed.
    accounts.linkGateway(kept, gateway.ownerAccountId, "c".repeat(43));
    accounts.unlinkGateway(kept, gateway.ownerAccountId);
    const last = accounts.signInFederated("google", googleC, gateway);
    expect(accounts.sessionVersion(kept)).toBeUndefined();
    expect(accounts.passkey("third")).toBeUndefined();
    expect(Object.values(held(db, kept))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(admissions(db)).toEqual([
      { gateway_id: gateway.gatewayId, owner_account_id: gateway.ownerAccountId, account_id: last },
    ]);
    // The two accounts other gateways use are untouched throughout.
    expect(accounts.sessionVersion(first)).toBe(1);
    expect(accounts.sessionVersion(second)).toBe(1);
    expect(accounts.snapshot().identityAccounts).toBe(3);
  } finally {
    db.close();
  }
});

test("a passkey keeps the sign-in that vouched for it until the passkey is removed", () => {
  const { db, accounts } = fixture();
  try {
    const account = accounts.signInFederated("google", "e".repeat(64)),
      other = accounts.signInFederated("google", "f".repeat(64));
    const endorsement = {
      type: "google" as const,
      idToken: "fictional-google-token",
      salt: "c".repeat(43),
    };
    const kept = () =>
      (
        db.prepare("SELECT credential_id FROM omnesis_passkey_endorsements").all() as {
          credential_id: string;
        }[]
      ).map((row) => row.credential_id);
    accounts.registerPasskey(account, passkey("first"), false);
    accounts.registerPasskey(account, passkey("vouched"), false, 1, undefined, endorsement);
    expect(accounts.passkeyKeys(account)).toEqual([
      { id: "first", publicKey: "AQID" },
      { id: "vouched", publicKey: "AQID", endorsement },
    ]);
    // Only a sign-in proof is kept; anything else stores neither it nor the passkey.
    expect(() =>
      accounts.registerPasskey(account, passkey("refused"), false, 1, undefined, {
        type: "relay-says-so",
      } as never),
    ).toThrow();
    expect(accounts.passkey("refused")).toBeUndefined();
    expect(kept()).toEqual(["vouched"]);
    // A refused removal keeps the passkey and its vouching together, whoever asked.
    expect(() => accounts.removePasskey(other, "vouched", ["google"])).toThrow("not found");
    expect(() => accounts.removePasskey(account, "vouched", ["google"], 7)).toThrow("changed");
    expect(kept()).toEqual(["vouched"]);
    expect(accounts.passkeyKeys(account)[1]).toEqual({
      id: "vouched",
      publicKey: "AQID",
      endorsement,
    });
    accounts.removePasskey(account, "first", [], 1);
    expect(() => accounts.removePasskey(account, "vouched", [], 2)).toThrow("at least one");
    expect(kept()).toEqual(["vouched"]);
    accounts.removePasskey(account, "vouched", ["google"], 2);
    expect(kept()).toEqual([]);
    expect(accounts.passkeyKeys(account)).toEqual([]);
    // The same credential added again starts with whatever vouches for it then.
    accounts.registerPasskey(account, passkey("vouched"), false);
    expect(accounts.passkeyKeys(account)).toEqual([{ id: "vouched", publicKey: "AQID" }]);
  } finally {
    db.close();
  }
});
