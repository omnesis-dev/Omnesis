// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import {
  AccountEnrollmentAuthority,
  AccountEnrollmentVerifier,
} from "./account-enrollment-proof.js";
import { RelaySessions } from "./identity.js";

const origin = "https://relay.example.test";
afterEach(() => vi.useRealTimers());
test("an actual Ed25519 account proof binds account, gateway owner, gateway UUID, nonce and authority", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const authority = new AccountEnrollmentAuthority(origin, privateKey);
  expect(
    new AccountEnrollmentAuthority(
      origin,
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ).kid,
  ).toBe(authority.kid);
  const scope = {
    accountId: randomBytes(32).toString("hex"),
    gatewayId: randomUUID(),
    ownerAccountId: randomBytes(32).toString("hex"),
    nonce: randomBytes(32).toString("base64url"),
  };
  const keys = createLocalJWKSet(authority.jwks());
  const verifier = new AccountEnrollmentVerifier(
    origin,
    keys,
    scope.gatewayId,
    scope.ownerAccountId,
    scope.accountId,
  );
  const proof = await authority.issue(scope);
  expect(await verifier.verify(proof, scope.nonce)).toMatchObject({
    issuer: origin + "/_relay/account",
    subject: scope.accountId,
  });
  for (const change of [
    { accountId: "a".repeat(64) },
    { gatewayId: randomUUID() },
    { ownerAccountId: "b".repeat(64) },
    { nonce: randomBytes(32).toString("base64url") },
  ])
    await expect(
      verifier.verify(await authority.issue({ ...scope, ...change }), scope.nonce),
    ).rejects.toThrow();
  await expect(verifier.verify(proof)).rejects.toThrow();
  await expect(
    new AccountEnrollmentVerifier(
      "https://other.example.test",
      keys,
      scope.gatewayId,
      scope.ownerAccountId,
      scope.accountId,
    ).verify(proof, scope.nonce),
  ).rejects.toThrow();
  const other = new AccountEnrollmentAuthority(origin, generateKeyPairSync("ed25519").privateKey);
  await expect(verifier.verify(await other.issue(scope), scope.nonce)).rejects.toThrow();
  await expect(new RelaySessions(randomBytes(32)).verify(proof)).rejects.toThrow();
  expect(JSON.stringify(authority.jwks())).not.toContain('"d"');
  for (const expiresAt of [0, Math.floor(Date.now() / 1000) + 301, Number.NaN])
    await expect(authority.issue(scope, expiresAt)).rejects.toThrow("lifetime");
  expect(
    () =>
      new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
      ),
  ).toThrow("Ed25519");
  expect(
    () => new AccountEnrollmentAuthority(origin, generateKeyPairSync("ed25519").publicKey),
  ).toThrow("private key");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  await expect(verifier.verify(proof, scope.nonce)).rejects.toThrow();
});

test("proofs cannot expand their lifetime or substitute another signed purpose", async () => {
  const { privateKey } = generateKeyPairSync("ed25519"),
    authority = new AccountEnrollmentAuthority(origin, privateKey);
  const scope = {
    accountId: "a".repeat(64),
    gatewayId: randomUUID(),
    ownerAccountId: "b".repeat(64),
    nonce: randomBytes(32).toString("base64url"),
  };
  const verifier = new AccountEnrollmentVerifier(
      origin,
      createLocalJWKSet(authority.jwks()),
      scope.gatewayId,
      scope.ownerAccountId,
      scope.accountId,
    ),
    now = Math.floor(Date.now() / 1000);
  for (const [purpose, issued, expires] of [
    ["gateway-control", now, now + 60],
    ["account-enrollment-v3", now, now + 301],
    ["account-enrollment-v3", now + 60, now + 120],
  ] as const) {
    const proof = await new SignJWT({
      purpose,
      gatewayId: scope.gatewayId,
      ownerAccountId: scope.ownerAccountId,
      nonce: scope.nonce,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: authority.kid })
      .setIssuer(origin)
      .setAudience("omnesis-gateway-account-enrollment-v3")
      .setSubject(scope.accountId)
      .setIssuedAt(issued)
      .setExpirationTime(expires)
      .sign(privateKey);
    await expect(verifier.verify(proof, scope.nonce)).rejects.toThrow();
  }
});
