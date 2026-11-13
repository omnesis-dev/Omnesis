// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { RelayAccounts } from "./accounts.js";

let directory: string, accounts: RelayAccounts | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "recovery-accounts-"));
});
afterEach(async () => {
  accounts?.close();
  accounts = undefined;
  await rm(directory, { recursive: true, force: true });
});
test("binding and independent receipt persist together and restore without inventing Google aliases", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  accounts.registerKeyBinding(f.account, f.binding, true, f.receipt());
  accounts.close();
  accounts = new RelayAccounts(path);
  expect(accounts.gatewayBinding(f.account)).toEqual(f.binding);
  expect(accounts.gatewayRecoveryReceipt(f.account)).toEqual(f.receipt());
  expect(accounts.googleAccountForOwner(f.account)).toBeUndefined();
  expect(accounts.gatewayRecoveryReceipt("missing")).toBeUndefined();
});
test("failed receipt persistence rolls back account creation and binding publication", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  const raw = new Database(path);
  try {
    raw.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON relay_gateway_recovery BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;",
    );
    expect(() => accounts!.registerKeyBinding(f.account, f.binding, true, f.receipt())).toThrow(
      "fixture refusal",
    );
    expect(accounts.gatewayBinding(f.account)).toBeUndefined();
    expect(accounts.accountForHostname("gateway.example.test")).toBeUndefined();
    expect(raw.prepare("SELECT count(*) AS n FROM relay_accounts").get()).toEqual({ n: 0 });
  } finally {
    raw.close();
  }
});
test("exact TLS-proven legacy transfer moves its receipt atomically and rolls back on receipt failure", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite"),
    legacy = "a".repeat(64);
  accounts = new RelayAccounts(path);
  const legacyBinding = { ...f.binding, identityToken: "legacy-google-proof" };
  accounts.registerAccount(legacy);
  accounts.registerBinding(legacy, legacyBinding);
  const raw = new Database(path);
  try {
    raw
      .prepare("INSERT INTO relay_gateway_recovery VALUES (?,?)")
      .run(legacy, JSON.stringify(f.receipt()));
    raw.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON relay_gateway_recovery BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;",
    );
    expect(() => accounts!.registerKeyBinding(f.account, f.binding, true, f.receipt())).toThrow(
      "fixture refusal",
    );
    expect(accounts.gatewayBinding(legacy)).toEqual(legacyBinding);
    expect(accounts.gatewayRecoveryReceipt(legacy)).toEqual(f.receipt());
    expect(accounts.gatewayBinding(f.account)).toBeUndefined();
    raw.exec("DROP TRIGGER reject_receipt");
    expect(accounts.registerKeyBinding(f.account, f.binding, true, f.receipt())).toEqual({
      migratedAccountId: legacy,
    });
    expect(accounts.gatewayRecoveryReceipt(legacy)).toBeUndefined();
    expect(accounts.gatewayRecoveryReceipt(f.account)).toEqual(f.receipt());
    expect(accounts.resolveAccount(legacy)).toBe(f.account);
  } finally {
    raw.close();
  }
});
test("untrusted receipt rows are bounded and malformed JSON never becomes a valid document", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  accounts.registerKeyBinding(f.account, f.binding, true);
  const raw = new Database(path);
  try {
    for (const row of ["x".repeat(65537), Buffer.from("{}")]) {
      raw.prepare("INSERT OR REPLACE INTO relay_gateway_recovery VALUES (?,?)").run(f.account, row);
      expect(accounts.gatewayRecoveryReceipt(f.account)).toBeUndefined();
    }
    raw.prepare("UPDATE relay_gateway_recovery SET receipt=?").run("{");
    expect(() => accounts!.gatewayRecoveryReceipt(f.account)).toThrow();
  } finally {
    raw.close();
  }
});
