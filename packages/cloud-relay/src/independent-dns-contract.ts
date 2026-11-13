// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";
import { keyRegistrationSchema } from "./gateway-key-auth.js";
import { certificateFingerprint } from "./gateway-binding.js";
import { dnsChallengeValueSchema } from "./acme-dns.js";
import { recoveryReceiptSchema, recoveryReceiptTranscript } from "./recovery-contract.js";

export const independentDnsOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), value: dnsChallengeValueSchema }).strict(),
  z.object({ type: z.literal("remove"), leaseId: z.string().uuid() }).strict(),
]);
export const independentDnsRequestSchema = z
  .object({
    registration: keyRegistrationSchema,
    recoveryReceipt: recoveryReceiptSchema,
    operation: independentDnsOperationSchema,
  })
  .strict();
export const independentDnsChallengeSchema = z
  .object({
    protocol: z.literal("omnesis-independent-dns-v1"),
    brokerOrigin: z.string().min(1).max(2048),
    challengeId: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const signature = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/);
export const independentDnsCompletionSchema = z
  .object({
    challengeId: z.string().uuid(),
    ownerSignature: signature,
    tlsSignature: signature,
  })
  .strict();
export type IndependentDnsRequest = z.infer<typeof independentDnsRequestSchema>;
export type IndependentDnsChallenge = z.infer<typeof independentDnsChallengeSchema>;

/** The operation/value/lease and exact public identity cannot be swapped between challenge and completion. */
export function independentDnsRequestDigest(value: IndependentDnsRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-independent-dns-request-v1",
        value.registration.gatewayId,
        value.registration.publicOrigin,
        value.registration.ownerPublicKey,
        certificateFingerprint(value.registration.certificate),
        recoveryReceiptTranscript(value.recoveryReceipt.payload).toString("base64url"),
        value.recoveryReceipt.signature,
        value.operation.type,
        value.operation.type === "create" ? value.operation.value : value.operation.leaseId,
      ]),
    )
    .digest("hex");
}
export function independentDnsTranscript(
  challenge: IndependentDnsChallenge,
  purpose: "owner" | "tls",
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-independent-dns-proof-v1",
      purpose,
      challenge.protocol,
      challenge.brokerOrigin,
      challenge.challengeId,
      challenge.nonce,
      challenge.requestDigest,
      challenge.expiresAt,
    ]),
  );
}
