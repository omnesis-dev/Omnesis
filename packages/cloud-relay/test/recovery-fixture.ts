// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createRecoveryAuthority,
  signRecoveryPolicy,
  signRecoveryReceipt,
} from "../src/recovery-authority.js";
import {
  recoveryPolicyDigest,
  type RecoveryPolicyPayload,
  type RecoveryReceiptPayload,
} from "../src/recovery-contract.js";
import { loadTrustedRecoveryPolicy } from "../src/recovery-verifier.js";
import {
  gatewayKeyAccount,
  KEY_BINDING_PREFIX,
  publicKeyFingerprint,
} from "../src/gateway-key-auth.js";
import { tlsFiles } from "./support.js";

/** Synthetic independent signer and gateway keys; no authority key is installed on the relay. */
export async function recoveryFixture(
  directory: string,
  relayOrigin = "https://control.example.test",
  publicOrigin = "https://gateway.example.test",
) {
  const now = Math.floor(Date.now() / 1000);
  const authority = createRecoveryAuthority(),
    owner = createRecoveryAuthority();
  const files = tlsFiles(directory, new URL(publicOrigin).hostname);
  const registration = {
    gatewayId: randomUUID(),
    publicOrigin,
    ownerPublicKey: owner.publicKey,
    certificate: await readFile(files.certFile, "utf8"),
  };
  const account = gatewayKeyAccount(registration);
  const binding = {
    gatewayId: registration.gatewayId,
    publicOrigin: registration.publicOrigin,
    certificate: registration.certificate,
    identityToken:
      KEY_BINDING_PREFIX +
      createPublicKey(owner.publicKey)
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
  };
  const context = {
    version: 1 as const,
    keyId: "offline-fixture",
    relayOrigin,
    relayDomain: "relay.example.test",
    issuedAt: now - 10,
    expiresAt: now + 3600,
  };
  const receiptPayload: RecoveryReceiptPayload = {
    ...context,
    protocol: "omnesis-relay-recovery",
    gatewayId: registration.gatewayId,
    publicOrigin: registration.publicOrigin,
    ownerPublicKey: owner.publicKey,
    ownerSpkiFingerprint: publicKeyFingerprint(createPublicKey(owner.publicKey)),
    accountId: account,
    recoveryEpoch: 4,
  };
  // Receipts attest stable ownership, not a rotating leaf certificate.
  const receipt = (overrides: Partial<RecoveryReceiptPayload> = {}) =>
    signRecoveryReceipt({ ...receiptPayload, ...overrides }, authority.privateKey);
  const policy = (overrides: Partial<RecoveryPolicyPayload> = {}) => {
    const document = signRecoveryPolicy(
      {
        ...context,
        protocol: "omnesis-relay-recovery-policy",
        epoch: 4,
        minimumReceiptEpoch: 2,
        minimumReceiptVersion: 1,
        revokedGatewayIds: [],
        revokedOwnerSpkiFingerprints: [],
        ...overrides,
      },
      authority.privateKey,
    );
    return loadTrustedRecoveryPolicy(document, {
      publicKey: authority.publicKey,
      keyId: context.keyId,
      relayOrigin,
      relayDomain: context.relayDomain,
      policySha256: recoveryPolicyDigest(document),
      minimumPolicyEpoch: 4,
    });
  };
  return { now, authority, owner, files, registration, account, binding, receipt, policy };
}
