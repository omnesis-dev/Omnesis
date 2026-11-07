// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { createRecoveryAuthority, signRecoveryReceipt } from "./recovery-authority.js";
import { RelayAccounts } from "./accounts.js";
import { RelayRecovery } from "./relay-recovery.js";

let directory: string, accounts: RelayAccounts | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-recovery-"));
});
afterEach(async () => {
  accounts?.close();
  accounts = undefined;
  await rm(directory, { recursive: true, force: true });
});
test("current independently signed owner receipt authorizes registration and every stored binding lookup", async () => {
  const f = await recoveryFixture(directory);
  accounts = new RelayAccounts(":memory:");
  const service = new RelayRecovery(accounts, f.policy());
  expect(service.registration(f.receipt(), f.registration)).toEqual(f.receipt());
  expect(service.binding(f.account)).toBeUndefined();
  expect(service.accountForHostname("missing.example.test")).toBeUndefined();
  accounts.registerKeyBinding(f.account, f.binding, true, f.receipt());
  expect(service.binding(f.account)).toEqual(f.binding);
  expect(service.accountForHostname("gateway.example.test")).toBe(f.account);
});
test("expired, revoked, obsolete, mismatched and counterfeit receipts cannot register or revive persisted routes", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  const raw = new Database(path);
  try {
    const cases = [
      { receipt: undefined, policy: f.policy() },
      { receipt: f.receipt({ issuedAt: f.now - 100, expiresAt: f.now - 1 }), policy: f.policy() },
      { receipt: f.receipt({ recoveryEpoch: 1 }), policy: f.policy() },
      { receipt: f.receipt(), policy: f.policy({ revokedGatewayIds: [f.registration.gatewayId] }) },
      {
        receipt: f.receipt(),
        policy: f.policy({
          revokedOwnerSpkiFingerprints: [f.receipt().payload.ownerSpkiFingerprint],
        }),
      },
      { receipt: f.receipt({ publicOrigin: "https://other.example.test" }), policy: f.policy() },
      {
        receipt: signRecoveryReceipt(f.receipt().payload, createRecoveryAuthority().privateKey),
        policy: f.policy(),
      },
      { receipt: { ...f.receipt(), signature: "A".repeat(86) }, policy: f.policy() },
    ];
    for (const c of cases) {
      const service = new RelayRecovery(accounts, c.policy);
      expect(() => service.registration(c.receipt, f.registration)).toThrow("authorized current");
      accounts.registerKeyBinding(f.account, f.binding, true);
      raw
        .prepare("INSERT OR REPLACE INTO relay_gateway_recovery VALUES (?,?)")
        .run(f.account, JSON.stringify(c.receipt ?? null));
      expect(() => service.binding(f.account)).toThrow("authorization refused");
      expect(service.accountForHostname("gateway.example.test")).toBeUndefined();
    }
  } finally {
    raw.close();
  }
});
test("database replacement of owner metadata, account principal, JSON or receipt cannot manufacture routing authority", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  accounts.registerKeyBinding(f.account, f.binding, true, f.receipt());
  const service = new RelayRecovery(accounts, f.policy()),
    raw = new Database(path);
  try {
    for (const binding of [
      { ...f.binding, identityToken: "legacy-google-proof" },
      { ...f.binding, gatewayId: "00000000-0000-4000-8000-000000000001" },
      null,
    ]) {
      raw.prepare("UPDATE relay_gateway_bindings SET binding=?").run(JSON.stringify(binding));
      expect(() => service.binding(f.account)).toThrow("authorization refused");
      expect(service.accountForHostname("gateway.example.test")).toBeUndefined();
    }
    raw.prepare("UPDATE relay_gateway_bindings SET binding=?").run(JSON.stringify(f.binding));
    for (const receipt of ["{", "x".repeat(65537), "null"]) {
      raw.prepare("UPDATE relay_gateway_recovery SET receipt=?").run(receipt);
      expect(() => service.binding(f.account)).toThrow("authorization refused");
    }
  } finally {
    raw.close();
  }
});

test("tampering the denormalized hostname index cannot expand a valid receipt's SNI authorization", async () => {
  const f = await recoveryFixture(directory),
    path = join(directory, "relay.sqlite");
  accounts = new RelayAccounts(path);
  accounts.registerKeyBinding(f.account, f.binding, true, f.receipt());
  const service = new RelayRecovery(accounts, f.policy()),
    raw = new Database(path);
  try {
    raw.prepare("UPDATE relay_gateway_bindings SET hostname=?").run("alias.example.test");
    expect(accounts.accountForHostname("alias.example.test")).toBe(f.account);
    expect(service.binding(f.account)).toEqual(f.binding);
    expect(service.accountForHostname("alias.example.test")).toBeUndefined();
    raw.prepare("UPDATE relay_gateway_bindings SET hostname=?").run("gateway.example.test");
    expect(service.accountForHostname("gateway.example.test")).toBe(f.account);
  } finally {
    raw.close();
  }
});
