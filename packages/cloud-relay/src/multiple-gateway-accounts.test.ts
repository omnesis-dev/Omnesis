// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { RelayRecovery } from "./relay-recovery.js";

const origin = "https://relay.example.test";
test("link seals bind the identity, gateway owner, relay and current session key", () => {
  const sessions = new RelaySessions(randomBytes(32));
  const seal = sessions.sealGoogleLink(origin, "google", "owner");
  expect(sessions.verifyGoogleLinkSeal(origin, "google", "owner", seal)).toBe(true);
  for (const invalid of [undefined, "short", "a".repeat(44), "a".repeat(43)])
    expect(sessions.verifyGoogleLinkSeal(origin, "google", "owner", invalid)).toBe(false);
  expect(sessions.verifyGoogleLinkSeal(origin, "different", "owner", seal)).toBe(false);
  expect(sessions.verifyGoogleLinkSeal(origin, "google", "different", seal)).toBe(false);
  expect(sessions.verifyGoogleLinkSeal("https://other.example.test", "google", "owner", seal)).toBe(
    false,
  );
  expect(
    new RelaySessions(randomBytes(32)).verifyGoogleLinkSeal(origin, "google", "owner", seal),
  ).toBe(false);
});

test("the old single-gateway alias schema migrates without replacing registered identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multi-alias-migration-"));
  const path = join(directory, "relay.db");
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE relay_identity_aliases(identity_account_id TEXT PRIMARY KEY, routing_account_id TEXT UNIQUE NOT NULL);
      INSERT INTO relay_identity_aliases VALUES ('google', 'owner');`);
    old.close();
    const accounts = new RelayAccounts(path);
    expect(accounts.googleGatewayLinks("google")).toEqual([{ ownerAccount: "owner" }]);
    expect(accounts.resolveAccount("google")).toBe("owner");
    expect(accounts.gatewayDisplayName("missing")).toBeUndefined();
    expect(() => accounts.setGatewayDisplayName("missing", "Test gateway")).toThrow(
      "not registered",
    );
    expect(() => accounts.setGatewayDisplayName("missing", "bad\nname")).toThrow();
    accounts.close();
    const reopened = new RelayAccounts(path);
    expect(reopened.googleGatewayLinks("google")).toEqual([{ ownerAccount: "owner" }]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealed associations survive ordinary restarts and fail closed after key rotation or tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multi-sealed-restart-"));
  const path = join(directory, "relay.db");
  const sessions = new RelaySessions(randomBytes(32));
  const seals = {
    seal: (google: string, owner: string) => sessions.sealGoogleLink(origin, google, owner),
    verify: (google: string, owner: string, seal: string | undefined) =>
      sessions.verifyGoogleLinkSeal(origin, google, owner, seal),
  };
  let accounts: RelayAccounts | undefined;
  try {
    const fixture = await recoveryFixture(directory);
    accounts = new RelayAccounts(path);
    accounts.registerKeyBinding(fixture.account, fixture.binding, true, fixture.receipt());
    accounts.setGatewayDisplayName(fixture.account, " Test gateway ");
    expect(accounts.gatewayDisplayName(fixture.account)).toBe("Test gateway");
    const first = new RelayRecovery(accounts, fixture.policy(), seals);
    first.linkGoogleAccount("google", fixture.account);
    expect(first.resolveAccount("google")).toBe(fixture.account);
    expect(first.googleAccountForOwner(fixture.account)).toBe("google");
    expect(first.gatewayAccounts("google")).toEqual([fixture.account]);
    expect(first.gatewayAccounts(fixture.account)).toEqual([fixture.account]);
    accounts.close();
    accounts = new RelayAccounts(path);
    const restarted = new RelayRecovery(accounts, fixture.policy(), seals);
    expect(restarted.resolveAccount("google")).toBe(fixture.account);
    expect(restarted.googleAccountForOwner(fixture.account)).toBe("google");
    const rotated = new RelaySessions(randomBytes(32));
    const untrusted = new RelayRecovery(accounts, fixture.policy(), {
      seal: seals.seal,
      verify: (google, owner, seal) => rotated.verifyGoogleLinkSeal(origin, google, owner, seal),
    });
    expect(untrusted.resolveAccount("google")).toBe("google");
    expect(untrusted.googleAccountForOwner(fixture.account)).toBeUndefined();
    restarted.unlinkGoogleAccount(fixture.account);
    expect(restarted.gatewayAccounts("google")).toEqual([]);
    expect(restarted.googleAccountForOwner(fixture.account)).toBeUndefined();
  } finally {
    accounts?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
