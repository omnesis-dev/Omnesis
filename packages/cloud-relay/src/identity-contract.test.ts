// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { accountId, googleIdentityProvider } from "./identity.js";
import {
  gatewayBindingSchema,
  gatewayBindingNonce,
  verifyGatewayBinding,
} from "./gateway-binding.js";
import { googlePairingNonce, googlePairingVerificationCode } from "./google-pairing.js";

const raw = await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8");
const schema = z.object({
  clock: z.number(),
  clientIds: z.array(z.string()),
  gatewayClientIds: z.array(z.string()),
  accountId: z.string(),
  clientNonce: z.string(),
  gatewayNonce: z.string(),
  fingerprint: z.string(),
  verificationCode: z.string(),
  gateway: gatewayBindingSchema,
  request: z.object({
    requestId: z.string(),
    secret: z.string(),
    kind: z.literal("ios"),
    name: z.string(),
  }),
  nonceVectors: z.array(
    z.object({ kind: z.enum(["ios", "android"]), name: z.string(), nonce: z.string() }),
  ),
  tokens: z.record(z.string(), z.string()),
  jwks: z.object({ keys: z.array(z.object({ kty: z.string() }).passthrough()) }),
});
const vectors = schema.parse(JSON.parse(raw));
afterEach(() => vi.useRealTimers());

test("Node, iOS and Android verify identical public identity, key-binding and SAS protocol vectors", async () => {
  for (const path of [
    "../../../ios/Tests/OmnesisTests/Fixtures/cloud-identity-vectors.json",
    "../../../android/core-pairing/src/test/resources/cloud-identity-vectors.json",
  ])
    expect(JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))).toEqual(
      JSON.parse(raw),
    );
  vi.useFakeTimers({ now: vectors.clock * 1000 });
  const keys = createLocalJWKSet(vectors.jwks);
  const clients = googleIdentityProvider(vectors.clientIds, keys);
  const owner = await clients.verify(vectors.tokens.validClient!, vectors.clientNonce);
  expect(accountId(owner)).toBe(vectors.accountId);
  expect(googlePairingNonce(vectors.request)).toBe(vectors.clientNonce);
  for (const value of vectors.nonceVectors)
    expect(googlePairingNonce({ ...vectors.request, kind: value.kind, name: value.name })).toBe(
      value.nonce,
    );
  expect(gatewayBindingNonce(vectors.gateway)).toBe(vectors.gatewayNonce);
  expect(googlePairingVerificationCode(vectors.request, vectors.fingerprint)).toBe(
    vectors.verificationCode,
  );
  expect(
    (
      await verifyGatewayBinding(
        vectors.gateway,
        vectors.accountId,
        googleIdentityProvider(vectors.gatewayClientIds, keys),
      )
    ).fingerprint,
  ).toBe(vectors.fingerprint);
  await expect(verifyGatewayBinding(vectors.gateway, vectors.accountId, clients)).rejects.toThrow();
  for (const name of [
    "wrongIssuer",
    "wrongAudience",
    "wrongNonce",
    "expired",
    "futureIssued",
    "oldIssued",
    "missingSubject",
    "missingNonce",
    "unauthorizedParty",
  ])
    await expect(
      clients.verify(vectors.tokens[name]!, vectors.clientNonce),
      name,
    ).rejects.toThrow();
});

test("native strict key pins hash complete DER SPKI for RSA, EC and Ed25519", () => {
  const publicVectors = JSON.parse(raw) as {
    spkiVectors: { algorithm: string; certificate: string; spkiFingerprint: string }[];
  };
  expect(publicVectors.spkiVectors.map((v) => v.algorithm)).toEqual([
    "RSA-2048",
    "EC-P256",
    "EC-P384",
    "EC-P521",
    "Ed25519",
  ]);
  for (const vector of publicVectors.spkiVectors) {
    const spki = new X509Certificate(vector.certificate).publicKey.export({
      type: "spki",
      format: "der",
    });
    expect(createHash("sha256").update(spki).digest("hex"), vector.algorithm).toBe(
      vector.spkiFingerprint,
    );
  }
});

test("renewal vectors separate certificate replacement from key, hostname and validity changes", () => {
  const vector = (JSON.parse(raw) as { spkiVectors: Record<string, string>[] }).spkiVectors.find(
    (v) => v.algorithm === "EC-P256",
  )!;
  const base = new X509Certificate(vector.certificate!);
  const renewed = new X509Certificate(vector.renewedCertificate!);
  const digest = (cert: X509Certificate) =>
    createHash("sha256")
      .update(cert.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
  expect(renewed.raw.equals(base.raw)).toBe(false);
  expect(digest(base)).toBe(vector.spkiFingerprint);
  expect(digest(renewed)).toBe(vector.spkiFingerprint);
  expect(digest(new X509Certificate(vector.replacementCertificate!))).not.toBe(
    vector.spkiFingerprint,
  );
  expect(
    new X509Certificate(vector.wrongHostnameCertificate!).checkHost("gateway.example.test"),
  ).toBeUndefined();
  expect(Date.parse(new X509Certificate(vector.expiredCertificate!).validTo)).toBeLessThan(
    vectors.clock * 1000,
  );
});
