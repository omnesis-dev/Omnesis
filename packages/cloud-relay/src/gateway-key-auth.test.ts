// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import {
  GatewayKeyAuthentication,
  gatewayKeyAccount,
  gatewayKeyIdentity,
  KEY_BINDING_PREFIX,
  keyAuthenticationTranscript,
  keyBindingOwnerAccount,
  tlsKeySignatureAlgorithm,
  validateKeyRegistration,
  type KeyRegistration,
  type KeyChallenge,
} from "./gateway-key-auth.js";
import { accountId } from "./identity.js";

let directory: string;
let certificate: string;
let privatePem: string;
let alternateCertificate: string;
let tls: ReturnType<typeof createPrivateKey>;
const owner = generateKeyPairSync("ed25519");
const ownerPublicKey = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
const relayOrigin = "https://relay.example.test";
const gatewayId = randomUUID();
const registration = (): KeyRegistration => ({
  gatewayId,
  publicOrigin: "https://gateway.example.test",
  certificate,
  ownerPublicKey,
});
const auth = (extra: Partial<ConstructorParameters<typeof GatewayKeyAuthentication>[0]> = {}) =>
  new GatewayKeyAuthentication({ relayOrigin, ...extra });
const challenge = (service: GatewayKeyAuthentication, value = registration()) =>
  service.challenge({ ...value, relayOrigin });
function proof(
  value: KeyRegistration,
  request: KeyChallenge,
  key = tls,
  identity = owner.privateKey,
) {
  return {
    challengeId: request.challengeId,
    ownerSignature: sign(
      null,
      keyAuthenticationTranscript(value, request, "owner"),
      identity,
    ).toString("base64url"),
    tlsSignature: sign(
      tlsKeySignatureAlgorithm(key),
      keyAuthenticationTranscript(value, request, "tls"),
      key,
    ).toString("base64url"),
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-owner-proof-"));
  const files = tlsFiles(directory, "gateway.example.test");
  certificate = await readFile(files.certFile, "utf8");
  privatePem = await readFile(files.keyFile, "utf8");
  tls = createPrivateKey(privatePem);
  const alternate = join(directory, "alternate");
  await mkdir(alternate);
  alternateCertificate = await readFile(
    tlsFiles(alternate, "gateway.example.test").certFile,
    "utf8",
  );
});
afterEach(() => vi.useRealTimers());
afterAll(async () => rm(directory, { recursive: true, force: true }));

test("owner and TLS key possession issue a distinct stable routing identity without Google or private material", () => {
  const service = auth();
  const request = challenge(service);
  expect(request).toMatchObject({
    relayOrigin,
    challengeId: expect.any(String),
    nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const result = service.complete(proof(registration(), request));
  expect(accountId(result.identity)).toBe(gatewayKeyAccount(registration()));
  expect(result.binding.identityToken).toBe(
    KEY_BINDING_PREFIX +
      owner.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  );
  expect(result.identity.expiresAt).toBeGreaterThan(Date.now() / 1000);
  expect(gatewayKeyAccount({ ...registration(), gatewayId: gatewayId.toUpperCase() })).toBe(
    gatewayKeyAccount(registration()),
  );
  expect(gatewayKeyAccount({ ...registration(), gatewayId: randomUUID() })).not.toBe(
    gatewayKeyAccount(registration()),
  );
  expect(
    gatewayKeyAccount({
      ...registration(),
      ownerPublicKey: generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    }),
  ).not.toBe(gatewayKeyAccount(registration()));
  expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(result)).not.toContain(privatePem);
  expect(() => service.complete(proof(registration(), request))).toThrow("missing or expired");
});

test("all recipient, routing, key and challenge fields are bound against substitution and purpose confusion", () => {
  const alternateOwner = generateKeyPairSync("ed25519");
  const replacements: Array<
    (value: KeyRegistration, request: KeyChallenge) => [KeyRegistration, KeyChallenge]
  > = [
    (value, request) => [{ ...value, gatewayId: randomUUID() }, request],
    (value, request) => [{ ...value, publicOrigin: "https://gateway.example.test:8443" }, request],
    (value, request) => [{ ...value, certificate: alternateCertificate }, request],
    (value, request) => [
      {
        ...value,
        ownerPublicKey: alternateOwner.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      request,
    ],
    (value, request) => [value, { ...request, nonce: "a".repeat(64) }],
    (value, request) => [value, { ...request, challengeId: randomUUID() }],
    (value, request) => [value, { ...request, expiresAt: request.expiresAt + 1 }],
    (value, request) => [value, { ...request, relayOrigin: "https://another-relay.example.test" }],
  ];
  for (const replace of replacements) {
    const service = auth();
    const request = challenge(service);
    const [value, changed] = replace(registration(), request);
    const forged = proof(value, changed);
    forged.challengeId = request.challengeId;
    expect(() => service.complete(forged)).toThrow("not proven");
    expect(() => service.complete(proof(registration(), request))).toThrow("missing or expired");
  }
  for (const phase of ["owner", "tls", "purpose"]) {
    const service = auth();
    const request = challenge(service);
    const value = proof(registration(), request);
    if (phase === "purpose")
      value.ownerSignature = sign(
        null,
        keyAuthenticationTranscript(registration(), request, "tls"),
        owner.privateKey,
      ).toString("base64url");
    else if (phase === "owner")
      value.ownerSignature = sign(
        null,
        keyAuthenticationTranscript(registration(), request, "owner"),
        alternateOwner.privateKey,
      ).toString("base64url");
    else value.tlsSignature = value.ownerSignature;
    expect(() => service.complete(value)).toThrow("not proven");
  }
  expect(() =>
    auth().challenge({ ...registration(), relayOrigin: "https://another-relay.example.test" }),
  ).toThrow("recipient");
});

test("challenges expire, reserve bounded capacity and cannot outlive the registered leaf", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  const service = auth({ ttlMs: 100, maxPending: 1 });
  const request = challenge(service);
  expect(() => challenge(service)).toThrow("capacity");
  vi.setSystemTime(Date.now() + 101);
  expect(() => service.complete(proof(registration(), request))).toThrow("missing or expired");
  expect(challenge(service).challengeId).not.toBe(request.challengeId);
  const expiry = Date.parse(new X509Certificate(certificate).validTo);
  vi.setSystemTime(expiry - 100);
  const atExpiry = auth();
  const pending = challenge(atExpiry);
  vi.setSystemTime(expiry + 1);
  expect(() => atExpiry.complete(proof(registration(), pending))).toThrow("validity interval");
});

test("rejects unsafe keys, certificates, private-key publication and malformed request/proof fields", () => {
  const value = registration();
  for (const patch of [
    { certificate: certificate + certificate },
    { certificate: certificate + privatePem },
    { certificate: "invalid" },
    { publicOrigin: "http://gateway.example.test" },
    { publicOrigin: "https://wrong.example.test" },
    { ownerPublicKey: owner.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    { ownerPublicKey: createPublicKey(tls).export({ type: "spki", format: "pem" }).toString() },
    { gatewayId: "invalid" },
    { unexpected: true },
  ])
    expect(() => validateKeyRegistration({ ...value, ...patch })).toThrow();
  const service = auth({ relayOrigin: () => relayOrigin });
  expect(challenge(service)).toHaveProperty("nonce");
  expect(() =>
    service.complete({
      challengeId: randomUUID(),
      ownerSignature: "invalid=",
      tlsSignature: "invalid",
    }),
  ).toThrow();
  const leaf = new X509Certificate(certificate);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(leaf.validFrom) - 1 });
  expect(() => validateKeyRegistration(value)).toThrow("validity interval");
});

test.each(["ec", "ed25519", "ed448"])(
  "valid %s TLS keys prove possession and renewal preserves owner identity",
  async (algorithm) => {
    const dir = join(directory, algorithm);
    await mkdir(dir);
    const keyFile = join(dir, "tls.key"),
      certFile = join(dir, "tls.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        algorithm,
        ...(algorithm === "ec" ? ["-pkeyopt", "ec_paramgen_curve:prime256v1"] : []),
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=gateway.example.test",
        "-addext",
        "subjectAltName=DNS:gateway.example.test",
      ],
      { stdio: "ignore" },
    );
    const key = createPrivateKey(await readFile(keyFile, "utf8"));
    const value = { ...registration(), certificate: await readFile(certFile, "utf8") };
    const service = auth();
    const request = challenge(service, value);
    const completed = service.complete(proof(value, request, key));
    expect(accountId(completed.identity)).toBe(gatewayKeyAccount(registration()));
    expect(completed.binding.certificate).not.toBe(certificate);
    if (algorithm === "ed25519")
      expect(() =>
        validateKeyRegistration({
          ...value,
          ownerPublicKey: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
        }),
      ).toThrow("distinct");
  },
);

test("signature policy admits mainstream strong keys and rejects unsupported algorithms and limits", () => {
  expect(
    tlsKeySignatureAlgorithm({
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength: 2048 },
    }),
  ).toBe("sha256");
  expect(
    tlsKeySignatureAlgorithm({
      asymmetricKeyType: "rsa-pss",
      asymmetricKeyDetails: { modulusLength: 3072, hashAlgorithm: "sha384" },
    }),
  ).toBe("sha384");
  for (const modulusLength of [1024, 16384])
    expect(() =>
      tlsKeySignatureAlgorithm({
        asymmetricKeyType: "rsa",
        asymmetricKeyDetails: { modulusLength },
      }),
    ).toThrow("strength");
  expect(() =>
    tlsKeySignatureAlgorithm({
      asymmetricKeyType: "rsa-pss",
      asymmetricKeyDetails: { modulusLength: 2048, hashAlgorithm: "sha1" },
    }),
  ).toThrow("strength");
  expect(() =>
    tlsKeySignatureAlgorithm({ asymmetricKeyType: "rsa", asymmetricKeyDetails: undefined }),
  ).toThrow("strength");
  expect(() =>
    tlsKeySignatureAlgorithm({
      asymmetricKeyType: "ec",
      asymmetricKeyDetails: { namedCurve: "secp256k1" },
    }),
  ).toThrow("curve");
  expect(() =>
    tlsKeySignatureAlgorithm({ asymmetricKeyType: "ec", asymmetricKeyDetails: undefined }),
  ).toThrow("curve");
  expect(() =>
    tlsKeySignatureAlgorithm({ asymmetricKeyType: "dsa", asymmetricKeyDetails: undefined }),
  ).toThrow("signing key");
  for (const ttlMs of [0, -1, NaN, 60_001, 1.5]) expect(() => auth({ ttlMs })).toThrow("limits");
  for (const maxPending of [0, -1, NaN, 33, 1.5])
    expect(() => auth({ maxPending })).toThrow("limits");
  expect(gatewayKeyIdentity(registration(), 100).expiresAt).toBe(100);
});

test("malformed owner markers cannot classify legacy metadata as a key-owner binding", () => {
  const binding = { gatewayId, publicOrigin: "https://gateway.example.test", certificate };
  for (const encoded of [
    "invalid",
    createPublicKey(tls).export({ type: "spki", format: "der" }).toString("base64url"),
    owner.publicKey.export({ type: "spki", format: "der" }).toString("base64url") + "=",
  ])
    expect(
      keyBindingOwnerAccount({ ...binding, identityToken: KEY_BINDING_PREFIX + encoded }),
    ).toBeUndefined();
  expect(() =>
    tlsKeySignatureAlgorithm({ asymmetricKeyType: "rsa", asymmetricKeyDetails: {} }),
  ).toThrow("strength");
});
