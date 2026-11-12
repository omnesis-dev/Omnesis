// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { signInProofSchema } from "./device-enrollment.js";
import { bindingOrigin } from "./gateway-binding.js";

export const ACCOUNT_BROWSER_PROTOCOL = "omnesis-account-browser-v3" as const;
export const ACCOUNT_BROWSER_PATH = "/_relay/v3/account-browser";
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const accountBrowserPurpose = z.enum(["owner-link", "device-enrollment"]);
export type AccountBrowserPurpose = z.infer<typeof accountBrowserPurpose>;

export function accountBrowserCallback(value: string, purpose: AccountBrowserPurpose): URL {
  const url = new URL(value);
  const path =
    purpose === "owner-link" ? "/admin/cloud-relay/account/callback" : "/devices/account/callback";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0" ||
    url.pathname !== path ||
    url.href !== value
  )
    throw new Error("An exact HTTPS gateway account callback is required");
  return url;
}

export const accountBrowserUnsigned = z
  .object({
    protocol: z.literal(ACCOUNT_BROWSER_PROTOCOL),
    operationId: z.string().uuid(),
    purpose: accountBrowserPurpose,
    nonce: opaque,
    callbackUrl: z.string().min(1).max(2048),
    browserState: opaque,
    redemptionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      accountBrowserCallback(value.callbackUrl, value.purpose);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid account browser callback" });
    }
    if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 300)
      context.addIssue({ code: "custom", message: "Invalid account browser lifetime" });
  });
export const accountBrowserStart = accountBrowserUnsigned.safeExtend({
  ownerSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type AccountBrowserRequest = z.infer<typeof accountBrowserStart>;
export const accountBrowserStarted = z
  .object({
    protocol: z.literal(ACCOUNT_BROWSER_PROTOCOL),
    operationId: z.string().uuid(),
    authorizeUrl: z.string().min(1).max(4096),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export const accountBrowserRedemption = z
  .object({ operationId: z.string().uuid(), result: opaque, redemptionSecret: opaque })
  .strict();
export const accountBrowserRedeemed = z
  .object({
    identityToken: z.string().min(1).max(16_384),
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    signInProof: signInProofSchema,
    credentialPublicKey: z.string().min(1).max(4096).optional(),
  })
  .strict();
export interface AccountBrowserOwner {
  ownerAccountId: string;
  gatewayId: string;
  publicOrigin: string;
  tlsSpkiFingerprint: string;
  ownerPublicKey: string;
}

/** An owner signature authorizes the exact account operation and callback, independently of relay sessions. */
export function accountBrowserTranscript(
  origin: string,
  owner: AccountBrowserOwner,
  input: z.infer<typeof accountBrowserUnsigned>,
): Buffer {
  const request = accountBrowserUnsigned.parse(input);
  return Buffer.from(
    JSON.stringify([
      "omnesis-account-browser-start-v3",
      bindingOrigin(origin).origin,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(owner.ownerAccountId),
      z.string().uuid().parse(owner.gatewayId).toLowerCase(),
      bindingOrigin(owner.publicOrigin).origin,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(owner.tlsSpkiFingerprint),
      request.protocol,
      request.operationId,
      request.purpose,
      request.nonce,
      request.callbackUrl,
      request.browserState,
      request.redemptionSha256,
      request.issuedAt,
      request.expiresAt,
    ]),
  );
}
