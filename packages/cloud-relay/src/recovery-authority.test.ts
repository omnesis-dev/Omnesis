// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, createPublicKey, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tlsFiles } from "../test/support.js";
import { gatewayKeyAccount, publicKeyFingerprint } from "./gateway-key-auth.js";
import {
  createRecoveryAuthority,
  signRecoveryReceipt,
  signRecoveryPolicy,
} from "./recovery-authority.js";
import {
  MAX_RECOVERY_POLICY_SECONDS,
  MAX_RECOVERY_RECEIPT_SECONDS,
  recoveryReceiptPayloadSchema,
  recoveryPolicyPayloadSchema,
  recoveryReceiptSchema,
  recoveryPolicySchema,
  recoveryPolicyDigest,
  recoveryReceiptTranscript,
  recoveryPolicyTranscript,
  type RecoveryReceiptPayload,
  type RecoveryPolicyPayload,
} from "./recovery-contract.js";
import {
  loadTrustedRecoveryPolicy,
  verifyRecoveryReceipt,
  verifyRecoveryBindingReceipt,
  assertRecoveryIdentityAllowed,
  assertRecoveryPolicyCurrent,
  type RecoveryTrust,
  type TrustedRecoveryPolicy,
} from "./recovery-verifier.js";
import { runRecoveryAuthorityTool } from "./recovery-tool.js";

const now = Math.floor(Date.now() / 1000);
const authority = createRecoveryAuthority(),
  owner = createRecoveryAuthority();
const gatewayId = "a4026ab0-c281-4df6-b30f-bf4d22a794ee";
const context = {
  keyId: "independent-offline-2026",
  relayOrigin: "https://control.example.test",
  relayDomain: "relay.example.test",
  issuedAt: now - 10,
  expiresAt: now + 3600,
};
const registration = {
  gatewayId,
  publicOrigin: "https://gateway.example.test",
  ownerPublicKey: owner.publicKey,
  certificate: "",
};
const receipt: RecoveryReceiptPayload = {
  ...context,
  protocol: "omnesis-relay-recovery",
  version: 1,
  gatewayId,
  publicOrigin: registration.publicOrigin,
  ownerPublicKey: owner.publicKey,
  ownerSpkiFingerprint: publicKeyFingerprint(createPublicKey(owner.publicKey)),
  accountId: gatewayKeyAccount(registration),
  recoveryEpoch: 4,
};
const policy: RecoveryPolicyPayload = {
  ...context,
  protocol: "omnesis-relay-recovery-policy",
  version: 1,
  epoch: 4,
  minimumReceiptEpoch: 1,
  minimumReceiptVersion: 1,
  revokedGatewayIds: [],
  revokedOwnerSpkiFingerprints: [],
};
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-authority-"));
  const tls = tlsFiles(directory, "gateway.example.test");
  registration.certificate = await readFile(tls.certFile, "utf8");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function trusted(rules: RecoveryPolicyPayload = policy, time = now) {
  const document = signRecoveryPolicy(rules, authority.privateKey);
  const trust: RecoveryTrust = {
    publicKey: authority.publicKey,
    keyId: context.keyId,
    relayOrigin: context.relayOrigin,
    relayDomain: context.relayDomain,
    policySha256: recoveryPolicyDigest(document),
    minimumPolicyEpoch: 4,
  };
  return { document, trust, handle: loadTrustedRecoveryPolicy(document, trust, time) };
}
const forgedSignature = Buffer.alloc(64).toString("base64url");

describe("independent recovery authority and canonical wire contracts", () => {
  test("signs exact owner-bound receipts, with distinct signature domains and stable policy digests", () => {
    expect(createPublicKey(authority.publicKey).asymmetricKeyType).toBe("ed25519");
    const r = signRecoveryReceipt(receipt, authority.privateKey);
    expect(recoveryReceiptSchema.parse(r)).toEqual(r);
    const p = signRecoveryPolicy(policy, authority.privateKey);
    expect(recoveryPolicySchema.parse(p)).toEqual(p);
    expect(recoveryPolicyDigest(JSON.parse(JSON.stringify(p)))).toBe(recoveryPolicyDigest(p));
    expect(recoveryPolicyTranscript(policy)).not.toEqual(recoveryReceiptTranscript(receipt));
    const ordered = {
      ...policy,
      revokedGatewayIds: [gatewayId, "b4026ab0-c281-4df6-b30f-bf4d22a794ee"],
      revokedOwnerSpkiFingerprints: ["f".repeat(64), "a".repeat(64)],
    };
    expect(recoveryPolicyTranscript(ordered)).toEqual(
      recoveryPolicyTranscript({
        ...ordered,
        revokedGatewayIds: [...ordered.revokedGatewayIds].reverse(),
        revokedOwnerSpkiFingerprints: [...ordered.revokedOwnerSpkiFingerprints].reverse(),
      }),
    );
    expect(() =>
      signRecoveryReceipt(
        receipt,
        generateKeyPairSync("ec", { namedCurve: "prime256v1" })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      ),
    ).toThrow("Ed25519");
  });
  test("strict schemas reject unknown, ambiguous, malformed and inconsistent receipt authority fields", () => {
    for (const change of [
      { unknown: true },
      { protocol: "other" },
      { version: 2 },
      { keyId: "bad key" },
      { relayOrigin: "http://remote.example.test" },
      { relayOrigin: "https://control.example.test/" },
      { relayOrigin: "invalid" },
      { relayDomain: "127.0.0.1" },
      { relayDomain: "relay.example.test/path" },
      { relayDomain: "UPPER.example.test" },
      { publicOrigin: "https://gateway.example.test/" },
      { publicOrigin: "invalid" },
      { publicOrigin: "http://gateway.example.test" },
      { gatewayId: gatewayId.toUpperCase() },
      { gatewayId: "invalid" },
      { ownerPublicKey: "invalid" },
      { ownerPublicKey: owner.privateKey },
      { ownerPublicKey: owner.publicKey.trim() },
      {
        ownerPublicKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      },
      { ownerSpkiFingerprint: "a".repeat(64) },
      { accountId: "a".repeat(64) },
      { recoveryEpoch: 0 },
      { issuedAt: 0 },
      { expiresAt: receipt.issuedAt },
      { expiresAt: receipt.issuedAt + MAX_RECOVERY_RECEIPT_SECONDS + 1 },
    ])
      expect(
        recoveryReceiptPayloadSchema.safeParse({ ...receipt, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    expect(
      recoveryReceiptPayloadSchema.parse({
        ...receipt,
        expiresAt: receipt.issuedAt + MAX_RECOVERY_RECEIPT_SECONDS,
      }),
    ).toBeDefined();
  });
  test("policy schemas bound freshness, epochs, revocation volume, and duplicate entries", () => {
    for (const change of [
      { unknown: true },
      { version: 2 },
      { protocol: "other" },
      { epoch: 0 },
      { minimumReceiptEpoch: 5 },
      { minimumReceiptVersion: 0 },
      { expiresAt: policy.issuedAt },
      { expiresAt: policy.issuedAt + MAX_RECOVERY_POLICY_SECONDS + 1 },
      { revokedGatewayIds: [gatewayId, gatewayId] },
      { revokedOwnerSpkiFingerprints: ["a".repeat(64), "a".repeat(64)] },
      { revokedGatewayIds: Array(513).fill(gatewayId) },
      { revokedOwnerSpkiFingerprints: ["bad"] },
    ])
      expect(recoveryPolicyPayloadSchema.safeParse({ ...policy, ...change }).success).toBe(false);
    expect(
      recoveryPolicyPayloadSchema.parse({
        ...policy,
        expiresAt: policy.issuedAt + MAX_RECOVERY_POLICY_SECONDS,
      }),
    ).toBeDefined();
    for (const signature of ["bad", "=".repeat(86), forgedSignature.slice(0, -1) + "B"])
      expect(recoveryReceiptSchema.safeParse({ payload: receipt, signature }).success).toBe(false);
    expect(
      recoveryPolicySchema.safeParse({
        ...signRecoveryPolicy(policy, authority.privateKey),
        extra: "no",
      }).success,
    ).toBe(false);
  });
});

describe("fresh policy, independent rollback anchor and revocations", () => {
  test("validates a fresh receipt after dual-key proof and validates persisted metadata without trusting the database", () => {
    const f = trusted();
    const signed = signRecoveryReceipt(receipt, authority.privateKey);
    expect(verifyRecoveryReceipt(signed, f.handle, registration, now)).toEqual(signed);
    expect(verifyRecoveryBindingReceipt(signed, f.handle, registration, now)).toEqual(signed);
    expect(() => assertRecoveryIdentityAllowed(f.handle, receipt, now)).not.toThrow();
    expect(Object.isFrozen(f.handle)).toBe(true);
    expect(() => assertRecoveryPolicyCurrent(f.handle, now)).not.toThrow();
    expect(() => assertRecoveryPolicyCurrent(f.handle)).not.toThrow();
    expect(() => assertRecoveryPolicyCurrent(f.handle, policy.expiresAt)).toThrow("current");
    // Default clocks are production clocks, never caller-controlled wire fields.
    expect(loadTrustedRecoveryPolicy(f.document, f.trust).epoch).toBe(4);
    expect(verifyRecoveryReceipt(signed, f.handle, registration).payload.gatewayId).toBe(gatewayId);
    expect(verifyRecoveryBindingReceipt(signed, f.handle, registration).payload.accountId).toBe(
      receipt.accountId,
    );
    expect(() => assertRecoveryIdentityAllowed(f.handle, receipt)).not.toThrow();
  });
  test("fails closed without an exact independently anchored current policy, trusted issuer and Ed25519 authority", () => {
    const f = trusted();
    for (const patch of [
      { keyId: "other" },
      { relayOrigin: "https://other.example.test" },
      { relayDomain: "other.example.test" },
      { policySha256: "0".repeat(64) },
      { minimumPolicyEpoch: 5 },
      { publicKey: createRecoveryAuthority().publicKey },
      { relayOrigin: "invalid" },
      { relayOrigin: "https://control.example.test/" },
      { minimumPolicyEpoch: 0 },
      { policySha256: "bad" },
      { publicKey: "bad" },
    ])
      expect(() => loadTrustedRecoveryPolicy(f.document, { ...f.trust, ...patch }, now)).toThrow();
    expect(() => loadTrustedRecoveryPolicy(undefined, f.trust, now)).toThrow();
    expect(() =>
      loadTrustedRecoveryPolicy(
        { ...f.document, signature: forgedSignature },
        {
          ...f.trust,
          policySha256: recoveryPolicyDigest({ ...f.document, signature: forgedSignature }),
        },
        now,
      ),
    ).toThrow("authority");
    const old = signRecoveryPolicy({ ...policy, epoch: 3 }, authority.privateKey);
    expect(() => loadTrustedRecoveryPolicy(old, f.trust, now)).toThrow();
    for (const time of [now - 11, policy.expiresAt, NaN, 0.5])
      expect(() => loadTrustedRecoveryPolicy(f.document, f.trust, time)).toThrow("current");
    expect(() =>
      assertRecoveryIdentityAllowed(
        { epoch: 4, expiresAt: now + 100 } as TrustedRecoveryPolicy,
        receipt,
        now,
      ),
    ).toThrow("verified");
    expect(() => assertRecoveryIdentityAllowed(f.handle, receipt, policy.expiresAt)).toThrow(
      "current",
    );
  });
  test("neither a tampered receipt nor a valid receipt for another logical relay, gateway, origin or owner is usable", () => {
    const f = trusted();
    const signed = signRecoveryReceipt(receipt, authority.privateKey);
    expect(() =>
      verifyRecoveryBindingReceipt(
        { ...signed, signature: forgedSignature },
        f.handle,
        registration,
        now,
      ),
    ).toThrow("signature");
    for (const change of [
      { keyId: "other" },
      { relayOrigin: "https://other.example.test" },
      { relayDomain: "other.example.test" },
    ])
      expect(() =>
        verifyRecoveryBindingReceipt(
          signRecoveryReceipt({ ...receipt, ...change }, authority.privateKey),
          f.handle,
          registration,
          now,
        ),
      ).toThrow("context");
    for (const time of [now - 11, receipt.expiresAt])
      expect(() => verifyRecoveryBindingReceipt(signed, f.handle, registration, time)).toThrow(
        "current",
      );
    for (const change of [
      { gatewayId: "b4026ab0-c281-4df6-b30f-bf4d22a794ee" },
      { publicOrigin: "https://other.example.test" },
      { ownerPublicKey: createRecoveryAuthority().publicKey },
    ])
      expect(() =>
        verifyRecoveryBindingReceipt(signed, f.handle, { ...registration, ...change }, now),
      ).toThrow("match");
    expect(() =>
      verifyRecoveryReceipt(
        signed,
        f.handle,
        { ...registration, certificate: "not a certificate" },
        now,
      ),
    ).toThrow();
  });
  test("revoked gateways and owners cannot resurrect using a signed historical receipt or valid relay session", () => {
    const signed = signRecoveryReceipt(receipt, authority.privateKey);
    for (const rules of [
      { ...policy, revokedGatewayIds: [gatewayId] },
      { ...policy, revokedOwnerSpkiFingerprints: [receipt.ownerSpkiFingerprint] },
    ]) {
      const f = trusted(rules);
      expect(() => verifyRecoveryBindingReceipt(signed, f.handle, registration, now)).toThrow(
        "revokes",
      );
      expect(() => assertRecoveryIdentityAllowed(f.handle, receipt, now)).toThrow("revokes");
    }
    const elsewhere = trusted({ ...policy, revokedOwnerSpkiFingerprints: ["0".repeat(64)] });
    expect(() => assertRecoveryIdentityAllowed(elsewhere.handle, receipt, now)).not.toThrow();
    for (const rules of [
      { ...policy, minimumReceiptVersion: 2 },
      { ...policy, minimumReceiptEpoch: 4 },
    ]) {
      const f = trusted(rules);
      const old = signRecoveryReceipt({ ...receipt, recoveryEpoch: 3 }, authority.privateKey);
      expect(() => verifyRecoveryBindingReceipt(old, f.handle, registration, now)).toThrow(
        "epoch or version",
      );
    }
    const future = signRecoveryReceipt({ ...receipt, recoveryEpoch: 5 }, authority.privateKey);
    expect(() => verifyRecoveryBindingReceipt(future, trusted().handle, registration, now)).toThrow(
      "epoch or version",
    );
  });
  test("caller mutations cannot erase revocations after policy loading", () => {
    const f = trusted({ ...policy, revokedGatewayIds: [gatewayId] });
    f.document.payload.revokedGatewayIds.length = 0;
    f.trust.policySha256 = "0".repeat(64);
    expect(() => assertRecoveryIdentityAllowed(f.handle, receipt, now)).toThrow("revokes");
  });
});

describe("offline authority tool", () => {
  test("creates an exclusive private authority and signs receipt/policy files without network or secret output", async () => {
    const root = join(directory, "offline");
    const paths = {
      privateKeyFile: join(root, "authority.key"),
      publicKeyFile: join(root, "authority.pem"),
      inputFile: join(root, "input.json"),
      outputFile: join(root, "signed.json"),
    };
    const created = await runRecoveryAuthorityTool("create", paths);
    expect(created.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(JSON.stringify(created)).not.toContain("PRIVATE KEY");
    expect((await stat(paths.privateKeyFile)).mode & 0o777).toBe(0o600);
    await expect(runRecoveryAuthorityTool("create", paths)).rejects.toThrow();
    await writeFile(paths.inputFile, JSON.stringify(receipt));
    expect(await runRecoveryAuthorityTool("receipt", paths)).toEqual({});
    expect(
      recoveryReceiptSchema.parse(JSON.parse(await readFile(paths.outputFile, "utf8"))).payload,
    ).toEqual(receipt);
    expect((await stat(paths.outputFile)).mode & 0o777).toBe(0o600);
    await writeFile(paths.inputFile, JSON.stringify(policy));
    const result = await runRecoveryAuthorityTool("policy", paths);
    expect(result.policySha256).toBe(
      recoveryPolicyDigest(JSON.parse(await readFile(paths.outputFile, "utf8"))),
    );
    expect(
      await runRecoveryAuthorityTool("digest", { ...paths, inputFile: paths.outputFile }),
    ).toEqual(result);
    const f = trusted();
    const toolPolicy = JSON.parse(await readFile(paths.outputFile, "utf8"));
    expect(
      loadTrustedRecoveryPolicy(
        toolPolicy,
        { ...f.trust, publicKey: created.publicKey!, policySha256: result.policySha256! },
        now,
      ).epoch,
    ).toBe(4);
  });
  test("does not replace an existing authority public file or publish a signature from invalid inputs", async () => {
    const privateKeyFile = join(directory, "unpublished-authority.key"),
      publicKeyFile = join(directory, "existing-public.pem");
    await writeFile(publicKeyFile, "preserved");
    await expect(
      runRecoveryAuthorityTool("create", { privateKeyFile, publicKeyFile }),
    ).rejects.toThrow();
    expect(await readFile(publicKeyFile, "utf8")).toBe("preserved");
    await expect(readFile(privateKeyFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runRecoveryAuthorityTool("create", { privateKeyFile })).rejects.toThrow();
    const inputFile = join(directory, "invalid-payload.json"),
      outputFile = join(directory, "never-signed.json");
    await writeFile(inputFile, "{}");
    await writeFile(privateKeyFile, authority.privateKey);
    await expect(
      runRecoveryAuthorityTool("receipt", { privateKeyFile, inputFile, outputFile }),
    ).rejects.toThrow();
    await writeFile(inputFile, JSON.stringify(receipt));
    await expect(
      runRecoveryAuthorityTool("receipt", {
        privateKeyFile,
        inputFile,
        outputFile: privateKeyFile,
      }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(privateKeyFile, "utf8")).toBe(authority.privateKey);
    await writeFile(privateKeyFile, "x".repeat(4097));
    await expect(
      runRecoveryAuthorityTool("receipt", { privateKeyFile, inputFile, outputFile }),
    ).rejects.toThrow("too large");
    await expect(readFile(outputFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
