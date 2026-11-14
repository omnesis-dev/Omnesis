// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { brokerOwner } from "../test/dns-broker-owner.js";
import { hostedGatewayLabel } from "./hosted-name.js";
import {
  accountBoundCaaValue,
  base64url,
  brokerRequestDigest,
  fromBase64url,
  hostedLabel,
  ownerPublicKeySchema,
  sha256Hex,
  verifyOwnerSignature,
  type BrokerChallenge,
} from "./dns-broker-contract.js";

test("the label computed with the platform's digest is the gateway's hosted label", async () => {
  for (let count = 0; count < 200; count++) {
    const id = count % 2 ? randomUUID() : randomUUID().toUpperCase();
    expect(await hostedLabel(id)).toBe(hostedGatewayLabel(id));
  }
});

test("base64url is canonical and unpadded", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  expect(fromBase64url(base64url(bytes))).toEqual(bytes);
  for (const text of ["a", "ab=", "a+b/", "AR"]) expect(() => fromBase64url(text)).toThrow();
});

test("owner keys are Ed25519 public keys only", () => {
  const der = (type: "ed25519" | "x25519") =>
    generateKeyPairSync(type as "ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url");
  expect(ownerPublicKeySchema.safeParse(der("ed25519")).success).toBe(true);
  expect(ownerPublicKeySchema.safeParse(der("x25519")).success).toBe(false);
  expect(ownerPublicKeySchema.safeParse("!".repeat(59)).success).toBe(false);
  expect(ownerPublicKeySchema.safeParse("A".repeat(60)).success).toBe(false);
});

test("the request digest covers every operation's value", async () => {
  const owner = brokerOwner();
  const digests = await Promise.all(
    [
      { type: "claim" },
      { type: "release" },
      { type: "txt-create", value: "a".repeat(43) },
      { type: "txt-create", value: "b".repeat(43) },
      { type: "txt-remove", leaseId: randomUUID() },
      { type: "caa", accountUri: "https://ca.example.test/acct/1" },
      { type: "caa", accountUri: "https://ca.example.test/acct/2" },
    ].map((operation) => brokerRequestDigest(owner.request(operation as never))),
  );
  expect(new Set(digests).size).toBe(digests.length);
  expect(await sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("signatures verify only for the owner key over the exact challenge", async () => {
  const owner = brokerOwner();
  const challenge: BrokerChallenge = {
    protocol: "omnesis-dns-broker-v2",
    brokerOrigin: "https://dns.example.test",
    challengeId: randomUUID(),
    nonce: "0".repeat(64),
    requestDigest: "1".repeat(64),
    expiresAt: 1,
  };
  const signature = owner.sign(challenge);
  expect(await verifyOwnerSignature(owner.ownerPublicKey, challenge, signature)).toBe(true);
  expect(
    await verifyOwnerSignature(owner.ownerPublicKey, { ...challenge, expiresAt: 2 }, signature),
  ).toBe(false);
  expect(await verifyOwnerSignature(brokerOwner().ownerPublicKey, challenge, signature)).toBe(
    false,
  );
  expect(await verifyOwnerSignature(owner.ownerPublicKey, challenge, "*")).toBe(false);
});

test("the CAA value can't carry a second parameter", () => {
  expect(accountBoundCaaValue("letsencrypt.org", "https://ca.example.test/acct/7")).toBe(
    "letsencrypt.org; validationmethods=dns-01; accounturi=https://ca.example.test/acct/7",
  );
  for (const uri of [
    "https://ca.example.test/acct/7; validationmethods=http-01",
    'https://ca.example.test/acct/7"',
    "http://ca.example.test/acct/7",
  ])
    expect(() => accountBoundCaaValue("letsencrypt.org", uri)).toThrow();
});
