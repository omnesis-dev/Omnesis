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
  /**
   * The invite that may create the account, as the person pasted it. Like the intent it is not
   * signed: the relay checks the invite's own signature, and it can only ever create one account.
   */
  invite: z.string().min(1).max(2048).optional(),
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
/**
 * A gateway that understands `accountCreated` asks for it with this header on its poll. Gateways
 * that predate it parse the approval strictly, so the relay adds the field only when asked.
 */
export const GATEWAY_SIGNUP_FEATURES_HEADER = "omnesis-signup-features";
export const GATEWAY_SIGNUP_ACCOUNT_CREATED = "account-created";
export const gatewaySignupPollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), expiresAt: seconds }).strict(),
  z
    .object({
      status: z.literal("approved"),
      enrollmentToken: z.string().min(1).max(4096),
      accountId: account,
      signInProof: signInProofSchema,
      credentialPublicKey: z.string().min(1).max(4096).optional(),
      /**
       * Whether this sign-in created the account, rather than signing in to one it already had.
       * Absent from a relay that predates it, and sent only when the gateway asks.
       */
      accountCreated: z.boolean().optional(),
    })
    .strict(),
  z.object({ status: z.literal("denied"), reason: gatewaySignupDenialReason }).strict(),
]);
export const gatewaySignupLinked = z
  .object({ identityToken: z.string().min(1).max(16_384), accountId: account })
  .strict();
export type GatewaySignupDenialReason = z.infer<typeof gatewaySignupDenialReason>;

/**
 * Public and unauthenticated: `{ signup: GatewaySignupAccess }` on an invite-only relay, `{}`
 * otherwise. A separate path, so gateways that read `/_relay/v2/config` strictly keep working.
 */
export const GATEWAY_SIGNUP_ACCESS_PATH = `${GATEWAY_SIGNUP_PATH}/access`;
export interface GatewaySignupAccess {
  /** New accounts here need an invite. */
  inviteOnly: true;
}

/**
 * Public: whether an invite can still create an account here. Gateways ask before they start
 * connecting, and the relay's invite page asks to show the person whether their link works.
 */
export const GATEWAY_SIGNUP_INVITE_PATH = `${GATEWAY_SIGNUP_PATH}/invite`;
export const gatewaySignupInviteCheck = z.object({ invite: z.string().min(1).max(2048) }).strict();
export const gatewaySignupInviteStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), expiresAt: seconds }).strict(),
  z.object({ status: z.enum(["invalid", "expired", "used"]) }).strict(),
]);
export type GatewaySignupInviteStatus = z.infer<typeof gatewaySignupInviteStatus>;
/** The gateway's reading of the relay's answer. Fields it does not know are ignored. */
export function gatewaySignupAccess(value: unknown): GatewaySignupAccess | undefined {
  const signup = value && typeof value === "object" && "signup" in value ? value.signup : undefined;
  return signup &&
    typeof signup === "object" &&
    "inviteOnly" in signup &&
    signup.inviteOnly === true
    ? { inviteOnly: true }
    : undefined;
}

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
