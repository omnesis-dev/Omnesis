// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { tlsFiles, malformedDateCertificate } from "../test/support.js";
import {
  bindingOrigin,
  certificateFingerprint,
  gatewayBindingNonce,
  publicLeafCertificate,
  verifyGatewayBinding,
} from "./gateway-binding.js";
import { accountId, googleIdentityProvider, localIdentityProvider } from "./identity.js";
import { verifyRoutingHostname } from "./hostname-proof.js";
import { RelayAccounts } from "./accounts.js";
import { hostedGatewayHostname } from "./hosted-name.js";

let directory: string;
let certificate: string;
const secret = randomBytes(32);
const gatewayId = randomUUID();
const publicOrigin = "https://gateway.example.test";
const owner = {
  issuer: "omnesis-local-test",
  subject: "fictional-owner",
  expiresAt: 4_000_000_000,
};
const identity = localIdentityProvider(secret, "127.0.0.1");
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-key-binding-"));
  const files = tlsFiles(directory, "gateway.example.test");
  certificate = await readFile(files.certFile, "utf8");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());
const binding = () => ({ gatewayId, publicOrigin, certificate });
async function token(nonce: string, sub = owner.subject): Promise<string> {
  return new SignJWT({ nonce })
    .setSubject(sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(owner.issuer)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

test("a client independently verifies the account's signed certificate binding", async () => {
  const value = { ...binding(), identityToken: await token(gatewayBindingNonce(binding())) };
  expect(await verifyGatewayBinding(value, accountId(owner), identity)).toEqual({
    ...value,
    fingerprint: certificateFingerprint(certificate),
  });
  expect(gatewayBindingNonce({ ...binding(), publicOrigin: publicOrigin + ":443/" })).toBe(
    gatewayBindingNonce(binding()),
  );
  expect(() => gatewayBindingNonce({ ...binding(), gatewayId: "invalid" })).toThrow();
});

test("native PEM line endings preserve the signed leaf identity without admitting extra material", () => {
  const lf = new X509Certificate(certificate).toString();
  const crlf = lf.replace(/\n/g, "\r\n");
  expect(publicLeafCertificate(crlf).raw).toEqual(publicLeafCertificate(lf).raw);
  expect(gatewayBindingNonce({ ...binding(), certificate: crlf })).toBe(
    gatewayBindingNonce({ ...binding(), certificate: lf }),
  );
  for (const invalid of [
    crlf + crlf,
    crlf + "\r\n-----BEGIN PRIVATE KEY-----\r\ninvented\r\n-----END PRIVATE KEY-----",
    "unexpected text\r\n" + crlf,
    lf.replace(/\n/g, "\r"),
  ])
    expect(() => publicLeafCertificate(invalid)).toThrow();
});

test("Google signs the nonce; possession of a directory or relay session cannot forge it", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "fixture" }] });
  const google = googleIdentityProvider("fictional-client-id", keys);
  const nonce = gatewayBindingNonce(binding());
  const googleToken = await new SignJWT({ nonce })
    .setSubject(owner.subject)
    .setIssuer("https://accounts.google.com")
    .setAudience("fictional-client-id")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(privateKey);
  const account = accountId({ ...owner, issuer: "https://accounts.google.com" });
  expect(
    (await verifyGatewayBinding({ ...binding(), identityToken: googleToken }, account, google))
      .fingerprint,
  ).toBe(certificateFingerprint(certificate));
  await expect(google.verify(googleToken, "another-gateway-key")).rejects.toThrow("nonce");
  await expect(
    verifyGatewayBinding(
      { ...binding(), identityToken: googleToken, publicOrigin: publicOrigin + ":8443" },
      account,
      google,
    ),
  ).rejects.toThrow("nonce");
});

test("rejects another account, substituted route or key, missing nonce and leaked private material", async () => {
  const value = { ...binding(), identityToken: await token(gatewayBindingNonce(binding())) };
  await expect(verifyGatewayBinding(value, "0".repeat(64), identity)).rejects.toThrow(
    "another account",
  );
  for (const change of [{ gatewayId: randomUUID() }, { publicOrigin: publicOrigin + ":8443" }])
    await expect(
      verifyGatewayBinding({ ...value, ...change }, accountId(owner), identity),
    ).rejects.toThrow("nonce");
  await expect(
    verifyGatewayBinding(
      { ...value, identityToken: await token("wrong") },
      accountId(owner),
      identity,
    ),
  ).rejects.toThrow("nonce");
  expect(() =>
    gatewayBindingNonce({ ...binding(), publicOrigin: "https://other.example.test" }),
  ).toThrow("cover");
  expect(() =>
    gatewayBindingNonce({ ...binding(), certificate: certificate + "\nPRIVATE KEY MATERIAL" }),
  ).toThrow("Only a public");
  expect(() => certificateFingerprint("invalid")).toThrow();
  await expect(
    verifyGatewayBinding(
      { ...value, privateKey: "must not be accepted" },
      accountId(owner),
      identity,
    ),
  ).rejects.toThrow();
});

test.each([
  "http://gateway.example.test",
  "https://user@gateway.example.test",
  "https://gateway.example.test/path",
  "https://gateway.example.test?query",
  "https://gateway.example.test#fragment",
  "https://localhost",
  "https://127.0.0.1",
  "https://bad_.example.test",
  "https://bad..test",
  "not-a-url",
])("refuses unsafe public origin %s", (value) => {
  expect(() => bindingOrigin(value)).toThrow();
});

test("rejects certificates before their validity interval and after expiry", async () => {
  const cert = new X509Certificate(certificate);
  for (const time of [Date.parse(cert.validFrom) - 1000, Date.parse(cert.validTo) + 1000]) {
    vi.useFakeTimers({ now: time });
    await expect(
      verifyGatewayBinding(
        { ...binding(), identityToken: await token(gatewayBindingNonce(binding())) },
        accountId(owner),
        identity,
      ),
    ).rejects.toThrow("validity");
    vi.useRealTimers();
  }
});

test("hosted names are gateway-scoped and custom names prove DNS ownership", async () => {
  const hosted = hostedGatewayHostname(gatewayId, "relay.example.test");
  const lookup = vi.fn(async () => [
    ["unrelated"],
    [`omnesis-relay-v2:${accountId(owner)}:`, gatewayId],
  ]);
  expect(
    await verifyRoutingHostname(hosted, accountId(owner), gatewayId, "relay.example.test", lookup),
  ).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  expect(
    await verifyRoutingHostname(
      "custom.example.test",
      accountId(owner),
      gatewayId,
      undefined,
      lookup,
    ),
  ).toBe(true);
  expect(lookup).toHaveBeenCalledWith("_omnesis-gateway.custom.example.test");
  expect(
    await verifyRoutingHostname(
      "custom.example.test",
      "other-account",
      gatewayId,
      undefined,
      lookup,
    ),
  ).toBe(false);
  expect(
    await verifyRoutingHostname("custom.example.test", "a", gatewayId, undefined, async () => {
      throw new Error("DNS unavailable");
    }),
  ).toBe(false);
});

test("durable directory binding refuses hostname theft and survives reopen", async () => {
  const file = join(directory, "directory.sqlite");
  const a = accountId(owner);
  const b = "b".repeat(64);
  const value = { ...binding(), identityToken: await token(gatewayBindingNonce(binding())) };
  let accounts = new RelayAccounts(file);
  try {
    accounts.registerAccount(a);
    accounts.registerAccount(b);
    expect(accounts.gatewayBinding(a)).toBeUndefined();
    expect(accounts.accountForHostname("unknown.example.test")).toBeUndefined();
    accounts.registerBinding(a, value);
    accounts.registerBinding(a, value);
    expect(() => accounts.registerBinding(b, { ...value, gatewayId: randomUUID() })).toThrow(
      "Hostname",
    );
    expect(() =>
      accounts.registerBinding(a, {
        ...value,
        gatewayId: randomUUID(),
        publicOrigin: "https://different.example.test",
      }),
    ).toThrow("conflict");
    accounts.close();
    accounts = new RelayAccounts(file);
    expect(accounts.gatewayBinding(a)).toEqual(value);
    expect(accounts.accountForHostname("gateway.example.test")).toBe(a);
  } finally {
    accounts.close();
  }
});

test("malformed ASN.1 validity times are rejected even when OpenSSL parses the public certificate", async () => {
  for (const which of ["from", "to"] as const) {
    const malformed = malformedDateCertificate(certificate, which);
    const leaf = new X509Certificate(malformed);
    expect(which === "from" ? leaf.validFrom : leaf.validTo).toBe("Bad time value");
    const value = { ...binding(), certificate: malformed };
    await expect(
      verifyGatewayBinding(
        { ...value, identityToken: await token(gatewayBindingNonce(value)) },
        accountId(owner),
        identity,
      ),
    ).rejects.toThrow("validity interval");
  }
});
