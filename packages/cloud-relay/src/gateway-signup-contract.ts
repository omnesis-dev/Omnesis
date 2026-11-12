// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { signInProofSchema } from "./device-enrollment.js";
import { bindingOrigin } from "./gateway-binding.js";
import { connectShortUrlSchema } from "./connect-short-url.js";

export const GATEWAY_SIGNUP_PROTOCOL = "omnesis-gateway-signup-v3" as const;
export const GATEWAY_SIGNUP_PATH = "/_relay/v3/signup";
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const account = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().positive().safe();

export const gatewaySignupUnsigned = z
  .object({
    protocol: z.literal(GATEWAY_SIGNUP_PROTOCOL),
    operationId: z.string().uuid(),
    gatewayId: z.string().uuid(),
    ownerPublicKey: z.string().min(1).max(1024),
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .optional(),
    nonce: opaque,
    redemptionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: seconds,
    expiresAt: seconds,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 300)
      context.addIssue({ code: "custom", message: "Invalid gateway signup lifetime" });
  });
/** Which page the person sees first. They can switch there, so the owner key does not sign it. */
export const gatewaySignupIntent = z.enum(["create", "existing"]);
export type GatewaySignupIntent = z.infer<typeof gatewaySignupIntent>;
export const gatewaySignupStart = gatewaySignupUnsigned.safeExtend({
  ownerSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  intent: gatewaySignupIntent.default("existing"),
});
export const gatewaySignupStarted = z
  .object({
    protocol: z.literal(GATEWAY_SIGNUP_PROTOCOL),
    operationId: z.string().uuid(),
    authorizeUrl: z.string().min(1).max(4096),
    connectUrl: z.string().min(1).max(2048),
    connectShortUrl: connectShortUrlSchema.optional(),
    code: z.string().regex(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/),
    expiresAt: seconds,
  })
  .strict();
/** Poll, link and cancel all prove they started the operation the same way. */
export const gatewaySignupRedemption = z
  .object({ operationId: z.string().uuid(), redemptionSecret: opaque })
  .strict();
export const gatewaySignupDenialReason = z.enum(["not-allowed", "capacity"]);
export const gatewaySignupPollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), expiresAt: seconds }).strict(),
  z
    .object({
      status: z.literal("approved"),
      enrollmentToken: z.string().min(1).max(4096),
      accountId: account,
      signInProof: signInProofSchema,
      credentialPublicKey: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ status: z.literal("denied"), reason: gatewaySignupDenialReason }).strict(),
]);
export const gatewaySignupLinked = z
  .object({ identityToken: z.string().min(1).max(16_384), accountId: account })
  .strict();
export type GatewaySignupDenialReason = z.infer<typeof gatewaySignupDenialReason>;

/** The owner key signs the exact request, so a relay cannot reuse it for another gateway or nonce. */
export function gatewaySignupTranscript(
  origin: string,
  input: z.infer<typeof gatewaySignupUnsigned>,
): Buffer {
  const request = gatewaySignupUnsigned.parse(input);
  return Buffer.from(
    JSON.stringify([
      "omnesis-gateway-signup-start-v3",
      bindingOrigin(origin).origin,
      request.protocol,
      request.operationId,
      request.gatewayId.toLowerCase(),
      request.ownerPublicKey,
      request.displayName ?? null,
      request.nonce,
      request.redemptionSha256,
      request.issuedAt,
      request.expiresAt,
    ]),
  );
}
