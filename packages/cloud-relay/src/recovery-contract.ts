// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";
import { gatewayKeyAccount, publicKeyFingerprint } from "./gateway-key-auth.js";

export const MAX_RECOVERY_RECEIPT_SECONDS = 315_576_000;
export const MAX_RECOVERY_POLICY_SECONDS = 2_592_000;
const positive = z.number().int().positive().max(2_147_483_647);
const timestamp = z.number().int().positive().max(8_640_000_000_000);
export const recoveryFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryGatewayIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const recoveryKeyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
export const recoveryPublicKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      const key = createPublicKey(value);
      return (
        key.asymmetricKeyType === "ed25519" &&
        key.export({ type: "spki", format: "pem" }).toString() === value
      );
    } catch {
      return false;
    }
  }, "A canonical public Ed25519 key is required");
export const recoveryDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .refine((value) => {
    try {
      return bindingOrigin(`https://${value}`).hostname === value;
    } catch {
      return false;
    }
  });
const logicalOrigin = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      return relayOrigin(value).origin === value;
    } catch {
      return false;
    }
  });
const gatewayOrigin = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      return bindingOrigin(value).origin === value;
    } catch {
      return false;
    }
  });
const signature = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/)
  .refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
const authorityContext = {
  version: z.literal(1),
  keyId: recoveryKeyIdSchema,
  relayOrigin: logicalOrigin,
  relayDomain: recoveryDomainSchema,
  issuedAt: timestamp,
  expiresAt: timestamp,
};
export const recoveryReceiptPayloadSchema = z
  .object({
    ...authorityContext,
    protocol: z.literal("omnesis-relay-recovery"),
    gatewayId: recoveryGatewayIdSchema,
    publicOrigin: gatewayOrigin,
    ownerPublicKey: recoveryPublicKeySchema,
    ownerSpkiFingerprint: recoveryFingerprintSchema,
    accountId: recoveryFingerprintSchema,
    recoveryEpoch: positive,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > MAX_RECOVERY_RECEIPT_SECONDS
    )
      context.addIssue({ code: "custom", message: "Invalid recovery receipt lifetime" });
    // Invalid PEMs already produce schema issues; never pass them into crypto again.
    if (!recoveryPublicKeySchema.safeParse(value.ownerPublicKey).success) return;
    if (
      publicKeyFingerprint(createPublicKey(value.ownerPublicKey)) !== value.ownerSpkiFingerprint ||
      gatewayKeyAccount(value) !== value.accountId
    )
      context.addIssue({ code: "custom", message: "Recovery owner identity does not match" });
  });
const revokedGateways = z
  .array(recoveryGatewayIdSchema)
  .max(512)
  .refine((values) => new Set(values).size === values.length);
const revokedOwners = z
  .array(recoveryFingerprintSchema)
  .max(512)
  .refine((values) => new Set(values).size === values.length);
export const recoveryPolicyPayloadSchema = z
  .object({
    ...authorityContext,
    protocol: z.literal("omnesis-relay-recovery-policy"),
    epoch: positive,
    minimumReceiptEpoch: positive,
    minimumReceiptVersion: positive,
    revokedGatewayIds: revokedGateways,
    revokedOwnerSpkiFingerprints: revokedOwners,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > MAX_RECOVERY_POLICY_SECONDS ||
      value.minimumReceiptEpoch > value.epoch
    )
      context.addIssue({ code: "custom", message: "Invalid recovery policy lifetime or epoch" });
  });
export const recoveryReceiptSchema = z
  .object({ payload: recoveryReceiptPayloadSchema, signature })
  .strict();
export const recoveryPolicySchema = z
  .object({ payload: recoveryPolicyPayloadSchema, signature })
  .strict();
export type RecoveryReceiptPayload = z.infer<typeof recoveryReceiptPayloadSchema>;
export type RecoveryPolicyPayload = z.infer<typeof recoveryPolicyPayloadSchema>;
export type RecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;
export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;

/** Ordered, domain-separated transcripts have no JSON property-order ambiguity. */
export function recoveryReceiptTranscript(value: RecoveryReceiptPayload): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-relay-recovery-receipt-signature-v1",
      value.protocol,
      value.version,
      value.keyId,
      value.relayOrigin,
      value.relayDomain,
      value.gatewayId,
      value.publicOrigin,
      value.ownerPublicKey,
      value.ownerSpkiFingerprint,
      value.accountId,
      value.recoveryEpoch,
      value.issuedAt,
      value.expiresAt,
    ]),
  );
}
export function recoveryPolicyTranscript(value: RecoveryPolicyPayload): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-relay-recovery-policy-signature-v1",
      value.protocol,
      value.version,
      value.keyId,
      value.relayOrigin,
      value.relayDomain,
      value.epoch,
      value.minimumReceiptEpoch,
      value.minimumReceiptVersion,
      value.issuedAt,
      value.expiresAt,
      [...value.revokedGatewayIds].sort(),
      [...value.revokedOwnerSpkiFingerprints].sort(),
    ]),
  );
}

/** Pin this canonical signed-policy digest independently of relay storage, never a relay-provided digest. */
export function recoveryPolicyDigest(input: unknown): string {
  const policy = recoveryPolicySchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-relay-recovery-policy-anchor-v1",
        recoveryPolicyTranscript(policy.payload).toString("base64url"),
        policy.signature,
      ]),
    )
    .digest("hex");
}
