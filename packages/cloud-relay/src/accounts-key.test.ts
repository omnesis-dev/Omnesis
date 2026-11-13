// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect, test } from "vitest";
import { tlsFiles } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { gatewayKeyAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import type { GatewayBinding } from "./gateway-binding.js";

let directory: string;
let certificate: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-key-account-"));
  certificate = await readFile(tlsFiles(directory, "gateway.example.test").certFile, "utf8");
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
function owner(gatewayId = randomUUID(), publicOrigin = "https://gateway.example.test") {
  const key = generateKeyPairSync("ed25519").publicKey;
  const value = {
    gatewayId,
    publicOrigin,
    certificate,
    ownerPublicKey: key.export({ type: "spki", format: "pem" }).toString(),
  };
  return {
    account: gatewayKeyAccount(value),
    binding: {
      gatewayId,
      publicOrigin,
      certificate,
      identityToken:
        KEY_BINDING_PREFIX + key.export({ type: "spki", format: "der" }).toString("base64url"),
    },
  };
}

test("one routing slot supports key enrollment, idempotent Google linking, unlinking and owner renewal", () => {
  const accounts = new RelayAccounts(":memory:", 1);
  const a = owner();
  try {
    expect(accounts.registerKeyBinding(a.account, a.binding, true)).toEqual({});
    accounts.linkGoogleAccount("google", a.account);
    accounts.linkGoogleAccount("google", a.account);
    accounts.registerAccount("google");
    expect(accounts.resolveAccount("google")).toBe(a.account);
    expect(accounts.googleAccountForOwner(a.account)).toBe("google");
    expect(accounts.gatewayBinding("google")).toBeUndefined();
    expect(() => accounts.registerAccount("unrelated")).toThrow("capacity");
    expect(accounts.keyEnrollmentExempt(a.account, a.binding)).toBe(true);
    accounts.registerKeyBinding(
      a.account,
      { ...a.binding, publicOrigin: "https://renewed.example.test" },
      false,
    );
    expect(accounts.accountForHostname("gateway.example.test")).toBeUndefined();
    expect(accounts.accountForHostname("renewed.example.test")).toBe(a.account);
    expect(accounts.unlinkGoogleAccount("different", a.account)).toBe(false);
    expect(accounts.unlinkGoogleAccount("google", a.account)).toBe(true);
    expect(accounts.resolveAccount("google")).toBe("google");
    expect(accounts.googleAccountForOwner(a.account)).toBeUndefined();
    accounts.linkGoogleAccount("new-google", a.account);
  } finally {
    accounts.close();
  }
});

test("an exact legacy TLS binding migrates atomically at capacity and remains discoverable through its old Google identity", () => {
  const accounts = new RelayAccounts(":memory:", 1);
  const a = owner();
  try {
    const legacy = {
      ...a.binding,
      gatewayId: a.binding.gatewayId.toUpperCase(),
      identityToken: "legacy-google-jwt",
    };
    accounts.registerBinding("google", legacy);
    // A Google-registered binding never passed the sign-up policy: only an invitation moves it.
    expect(accounts.keyEnrollmentExempt(a.account, a.binding)).toBe(false);
    expect(accounts.legacyTransfer(a.account, a.binding)).toBe(true);
    expect(accounts.legacyTransfer("google", a.binding)).toBe(false);
    expect(accounts.legacyTransfer(a.account, { ...a.binding, gatewayId: randomUUID() })).toBe(
      false,
    );
    expect(() => accounts.registerKeyBinding(a.account, a.binding, false)).toThrow("invitation");
    expect(accounts.accountForHostname("gateway.example.test")).toBe("google");
    expect(accounts.registerKeyBinding(a.account, a.binding, true)).toEqual({
      migratedAccountId: "google",
    });
    expect(accounts.keyEnrollmentExempt(a.account, a.binding)).toBe(true);
    expect(accounts.legacyTransfer(a.account, a.binding)).toBe(false);
    expect(accounts.resolveAccount("google")).toBe(a.account);
    expect(accounts.accountForHostname("gateway.example.test")).toBe(a.account);
    expect(accounts.gatewayBinding("google")).toBeUndefined();
    accounts.registerAccount("google");
    expect(() => accounts.registerAccount("other")).toThrow("capacity");
    accounts.registerKeyBinding(a.account, a.binding, false);
    const thief = owner(a.binding.gatewayId);
    expect(accounts.keyEnrollmentExempt(thief.account, thief.binding)).toBe(false);
    expect(() => accounts.registerKeyBinding(thief.account, thief.binding, true)).toThrow(
      "another owner",
    );
    expect(accounts.gatewayBinding(a.account)).toEqual(a.binding);
  } finally {
    accounts.close();
  }
});

test("rows a bare sign-in left behind are dropped on open and give their slot back", () => {
  const path = join(directory, "leftover.sqlite");
  const a = owner();
  let accounts = new RelayAccounts(path, 1);
  try {
    accounts.registerAccount("google-sign-in-only");
    accounts.bindGateway("google-sign-in-only", a.binding.gatewayId);
    expect(() => accounts.registerKeyBinding(a.account, a.binding, true)).toThrow("another owner");
    accounts.close();
    accounts = new RelayAccounts(path, 1);
    expect(accounts.snapshot().accounts).toBe(0);
    expect(accounts.ownerForGateway(a.binding.gatewayId)).toBeUndefined();
    expect(accounts.registerKeyBinding(a.account, a.binding, true)).toEqual({});
    accounts.close();
    accounts = new RelayAccounts(path, 1);
    expect(accounts.gatewayBinding(a.account)).toEqual(a.binding);
  } finally {
    accounts.close();
  }
});

test("failed new enrollment, host conflicts and invalid owner metadata never leak quota or reserve UUIDs", () => {
  const accounts = new RelayAccounts(":memory:", 2);
  const a = owner();
  const b = owner();
  try {
    expect(() => accounts.registerKeyBinding(a.account, a.binding, false)).toThrow("invitation");
    expect(() => accounts.registerKeyBinding("wrong-account", a.binding, true)).toThrow(
      "owner identity",
    );
    accounts.registerKeyBinding(a.account, a.binding, true);
    for (let i = 0; i < 3; i++) {
      const candidate = owner();
      expect(() => accounts.registerKeyBinding(candidate.account, candidate.binding, true)).toThrow(
        "Hostname",
      );
      expect(accounts.keyEnrollmentExempt(candidate.account, candidate.binding)).toBe(false);
      expect(accounts.gatewayBinding(candidate.account)).toBeUndefined();
    }
    accounts.registerKeyBinding(
      b.account,
      { ...b.binding, publicOrigin: "https://other.example.test" },
      true,
    );
    expect(() => accounts.registerAccount("excess")).toThrow("capacity");
    expect(accounts.accountForHostname("gateway.example.test")).toBe(a.account);
  } finally {
    accounts.close();
  }
});

test("legacy migration rejects origin, certificate and UUID substitutions without changing ownership", () => {
  for (const mutate of [
    (b: GatewayBinding) => ({ ...b, publicOrigin: "https://gateway.example.test:8443" }),
    (b: GatewayBinding) => ({ ...b, gatewayId: randomUUID() }),
    (b: GatewayBinding) => ({ ...b, certificate: certificate.replace("MI", "MJ") }),
  ]) {
    const accounts = new RelayAccounts(":memory:", 1);
    const a = owner();
    try {
      accounts.registerAccount("legacy");
      accounts.registerBinding("legacy", { ...a.binding, identityToken: "jwt" });
      const changed = mutate(a.binding);
      // A different UUID is fresh enrollment; an invalid/mismatched leaf never authorizes transfer.
      expect(() => accounts.registerKeyBinding(a.account, changed, false)).toThrow();
      expect(accounts.resolveAccount("legacy")).toBe("legacy");
      expect(accounts.accountForHostname("gateway.example.test")).toBe("legacy");
      expect(accounts.gatewayBinding(a.account)).toBeUndefined();
    } finally {
      accounts.close();
    }
  }
});

test("aliases reject chains, competing links and pre-existing gateway ownership without losing either account", () => {
  const accounts = new RelayAccounts(":memory:", 5);
  const a = owner();
  const b = owner(randomUUID(), "https://other.example.test");
  try {
    accounts.registerKeyBinding(a.account, a.binding, true);
    accounts.registerKeyBinding(b.account, b.binding, true);
    accounts.registerAccount("unbound-google");
    accounts.linkGoogleAccount("unbound-google", a.account);
    accounts.linkGoogleAccount("unbound-google", b.account);
    expect(accounts.gatewayAccounts("unbound-google")).toEqual([a.account, b.account].sort());
    expect(accounts.resolveAccount("unbound-google")).toBe("unbound-google");
    expect(() => accounts.linkGoogleAccount("other-google", a.account)).toThrow("conflicts");
    expect(() => accounts.linkGoogleAccount(a.account, a.account)).toThrow("conflict");
    expect(() => accounts.linkGoogleAccount("third", "unbound-google")).toThrow("conflict");
    expect(() => accounts.linkGoogleAccount(b.account, a.account)).toThrow("conflicts");
    expect(() => accounts.linkGoogleAccount("new", "missing")).toThrow("conflicts");
    accounts.unlinkGoogleAccount("unbound-google", a.account);
    expect(() => accounts.linkGoogleAccount(b.account, a.account)).toThrow("conflicts");
    expect(accounts.gatewayBinding(b.account)).toEqual(b.binding);
    accounts.linkGoogleAccount("replacement", a.account);
  } finally {
    accounts.close();
  }
});
