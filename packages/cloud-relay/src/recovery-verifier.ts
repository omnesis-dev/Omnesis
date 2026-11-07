// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { accountId } from "./identity.js";
import {
  KEY_AUTH_ISSUER,
  gatewayKeyAccount,
  validateKeyRegistration,
  type KeyRegistration,
} from "./gateway-key-auth.js";
import {
  recoveryKeyIdSchema,
  recoveryDomainSchema,
  recoveryFingerprintSchema,
  recoveryGatewayIdSchema,
  recoveryPublicKeySchema,
  recoveryPolicySchema,
  recoveryReceiptSchema,
  recoveryPolicyDigest,
  recoveryPolicyTranscript,
  recoveryReceiptTranscript,
  type RecoveryPolicyPayload,
  type RecoveryReceipt,
} from "./recovery-contract.js";
import { relayOrigin } from "./network.js";
import { bindingOrigin } from "./gateway-binding.js";

const trustSchema = z
  .object({
    publicKey: recoveryPublicKeySchema,
    keyId: recoveryKeyIdSchema,
    relayOrigin: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          return relayOrigin(value).origin === value;
        } catch {
          return false;
        }
      }),
    relayDomain: recoveryDomainSchema,
    policySha256: recoveryFingerprintSchema,
    minimumPolicyEpoch: z.number().int().positive().max(2_147_483_647),
  })
  .strict();
export type RecoveryTrust = z.infer<typeof trustSchema>;
export interface TrustedRecoveryPolicy {
  readonly epoch: number;
  readonly expiresAt: number;
}
interface VerifiedState {
  policy: RecoveryPolicyPayload;
  trust: RecoveryTrust;
  key: KeyObject;
}
const verified = new WeakMap<TrustedRecoveryPolicy, VerifiedState>();

function current(value: { issuedAt: number; expiresAt: number }, now: number): void {
  if (!Number.isSafeInteger(now) || value.issuedAt > now || value.expiresAt <= now)
    throw new Error("Recovery authority document is not current");
}
function context(
  value: { keyId: string; relayOrigin: string; relayDomain: string },
  trust: RecoveryTrust,
): void {
  if (
    value.keyId !== trust.keyId ||
    value.relayOrigin !== trust.relayOrigin ||
    value.relayDomain !== trust.relayDomain
  )
    throw new Error("Recovery authority context does not match");
}
function state(policy: TrustedRecoveryPolicy, now: number): VerifiedState {
  const found = verified.get(policy);
  if (!found) throw new Error("An independently verified recovery policy is required");
  current(found.policy, now);
  return found;
}

/** Exact independently retained policy digest and minimum epoch prevent rollback after a complete DB loss. */
export function loadTrustedRecoveryPolicy(
  input: unknown,
  inputTrust: RecoveryTrust,
  now = Math.floor(Date.now() / 1000),
): TrustedRecoveryPolicy {
  const trust = trustSchema.parse(inputTrust);
  const document = recoveryPolicySchema.parse(input);
  context(document.payload, trust);
  current(document.payload, now);
  const key = createPublicKey(trust.publicKey);
  if (
    document.payload.epoch < trust.minimumPolicyEpoch ||
    recoveryPolicyDigest(document) !== trust.policySha256 ||
    !verify(
      null,
      recoveryPolicyTranscript(document.payload),
      key,
      Buffer.from(document.signature, "base64url"),
    )
  )
    throw new Error("Recovery policy authority or current-policy anchor was refused");
  // Retain fresh parsed copies privately: neither caller-owned arrays nor the public handle can change authority.
  const handle = Object.freeze({
    epoch: document.payload.epoch,
    expiresAt: document.payload.expiresAt,
  });
  verified.set(handle, { policy: document.payload, trust, key });
  return handle;
}

/** Health/operations may check current authority without inventing a gateway identity. */
export function assertRecoveryPolicyCurrent(
  policy: TrustedRecoveryPolicy,
  now = Math.floor(Date.now() / 1000),
): void {
  state(policy, now);
}

/** Database rows and valid relay HMACs cannot override independent gateway/owner revocations. */
export function assertRecoveryIdentityAllowed(
  policy: TrustedRecoveryPolicy,
  identity: { gatewayId: string; accountId: string },
  now = Math.floor(Date.now() / 1000),
): void {
  const { policy: value } = state(policy, now);
  const gatewayId = recoveryGatewayIdSchema.parse(identity.gatewayId);
  const owner = recoveryFingerprintSchema.parse(identity.accountId);
  if (
    value.revokedGatewayIds.includes(gatewayId) ||
    value.revokedOwnerSpkiFingerprints.some(
      (fingerprint) =>
        accountId({
          issuer: KEY_AUTH_ISSUER,
          subject: JSON.stringify([gatewayId, fingerprint]),
          expiresAt: 1,
        }) === owner,
    )
  )
    throw new Error("Recovery policy revokes this gateway or owner");
}

/** Validate persisted metadata without trusting its database or claiming a fresh TLS/owner proof. */
export function verifyRecoveryBindingReceipt(
  input: unknown,
  policy: TrustedRecoveryPolicy,
  expected: Pick<KeyRegistration, "gatewayId" | "publicOrigin" | "ownerPublicKey">,
  now = Math.floor(Date.now() / 1000),
): RecoveryReceipt {
  const { policy: rules, trust, key } = state(policy, now);
  const receipt = recoveryReceiptSchema.parse(input);
  const value = receipt.payload;
  context(value, trust);
  current(value, now);
  if (
    value.version < rules.minimumReceiptVersion ||
    value.recoveryEpoch < rules.minimumReceiptEpoch ||
    value.recoveryEpoch > rules.epoch
  )
    throw new Error("Recovery receipt epoch or version was refused");
  if (
    !verify(
      null,
      recoveryReceiptTranscript(value),
      key,
      Buffer.from(receipt.signature, "base64url"),
    )
  )
    throw new Error("Recovery receipt authority signature was refused");
  const gatewayId = recoveryGatewayIdSchema.parse(expected.gatewayId);
  const ownerPublicKey = recoveryPublicKeySchema.parse(expected.ownerPublicKey);
  if (
    value.gatewayId !== gatewayId ||
    value.publicOrigin !== bindingOrigin(expected.publicOrigin).origin ||
    value.ownerPublicKey !== ownerPublicKey ||
    value.accountId !== gatewayKeyAccount({ gatewayId, ownerPublicKey })
  )
    throw new Error("Recovery receipt does not match the gateway identity");
  assertRecoveryIdentityAllowed(policy, value, now);
  return receipt;
}

/** Invoke only after completing the existing fresh dual-key challenge. Receipts never replace possession proofs. */
export function verifyRecoveryReceipt(
  input: unknown,
  policy: TrustedRecoveryPolicy,
  freshRegistration: KeyRegistration,
  now = Math.floor(Date.now() / 1000),
): RecoveryReceipt {
  return verifyRecoveryBindingReceipt(
    input,
    policy,
    validateKeyRegistration(freshRegistration),
    now,
  );
}
