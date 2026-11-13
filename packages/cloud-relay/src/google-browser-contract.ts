// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";

export const GOOGLE_BROWSER_PROTOCOL = "omnesis-google-browser-v1" as const;
export const GOOGLE_BROWSER_PATH = "/_relay/v2/google/browser";
export const googleBrowserPurposeSchema = z.enum(["owner-link", "device-enrollment"]);
export type GoogleBrowserPurpose = z.infer<typeof googleBrowserPurposeSchema>;
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const clientId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+$/);
export const googleBrowserConfigSchema = z
  .object({
    protocol: z.literal(GOOGLE_BROWSER_PROTOCOL),
    ownerLinkClientId: clientId.optional(),
    deviceEnrollmentClientId: clientId.optional(),
    deviceClientIds: z.array(clientId).max(16),
    deviceAuthorizedParties: z.array(clientId).max(16),
  })
  .strict();
export type GoogleBrowserConfig = z.infer<typeof googleBrowserConfigSchema>;

export function googleBrowserCallbackPath(purpose: GoogleBrowserPurpose): string {
  return purpose === "owner-link"
    ? "/admin/cloud-relay/google/callback"
    : "/devices/google/callback";
}

/** Application handoffs may return to an owner-authorized LAN origin; Google uses the central callback. */
export function googleBrowserCallbackUrl(value: string, purpose: GoogleBrowserPurpose): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== googleBrowserCallbackPath(purpose) ||
    url.href !== value ||
    url.port === "0"
  )
    throw new Error("An exact HTTPS gateway Google callback is required");
  return url;
}

export const googleBrowserUnsignedStartSchema = z
  .object({
    protocol: z.literal(GOOGLE_BROWSER_PROTOCOL),
    operationId: z.string().uuid(),
    purpose: googleBrowserPurposeSchema,
    nonce: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    callbackUrl: z.string().min(1).max(2048),
    browserState: opaque,
    redemptionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      googleBrowserCallbackUrl(value.callbackUrl, value.purpose);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid gateway callback" });
    }
    if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 300)
      context.addIssue({ code: "custom", message: "Invalid browser operation lifetime" });
  });
export type GoogleBrowserUnsignedStart = z.infer<typeof googleBrowserUnsignedStartSchema>;
export const googleBrowserStartSchema = googleBrowserUnsignedStartSchema.safeExtend({
  ownerSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type GoogleBrowserStart = z.infer<typeof googleBrowserStartSchema>;
export const googleBrowserStartResultSchema = z
  .object({
    protocol: z.literal(GOOGLE_BROWSER_PROTOCOL),
    operationId: z.string().uuid(),
    authorizeUrl: z.string().min(1).max(4096),
    expiresAt: z.number().int().positive().safe(),
    clientId,
  })
  .strict();
export type GoogleBrowserStartResult = z.infer<typeof googleBrowserStartResultSchema>;
export const googleBrowserRedeemSchema = z
  .object({
    operationId: z.string().uuid(),
    result: opaque,
    redemptionSecret: opaque,
  })
  .strict();
export const googleBrowserRedeemResultSchema = z
  .object({
    idToken: z.string().min(1).max(16_384),
    clientId,
  })
  .strict();

export interface GoogleBrowserStartContext {
  relayOrigin: string;
  accountId: string;
  gatewayId: string;
  publicOrigin: string;
  tlsSpkiFingerprint: string;
}

/** A relay HMAC alone cannot authorize a new callback, nonce, purpose or redemption capability. */
export function googleBrowserStartTranscript(
  context: GoogleBrowserStartContext,
  input: GoogleBrowserUnsignedStart,
): Buffer {
  const value = googleBrowserUnsignedStartSchema.parse(input);
  const account = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(context.accountId);
  const gateway = z.string().uuid().parse(context.gatewayId).toLowerCase();
  return Buffer.from(
    JSON.stringify([
      "omnesis-google-browser-start-v1",
      relayOrigin(context.relayOrigin).origin,
      account,
      gateway,
      bindingOrigin(context.publicOrigin).origin,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(context.tlsSpkiFingerprint),
      value.protocol,
      value.operationId,
      value.purpose,
      value.nonce,
      value.callbackUrl,
      value.browserState,
      value.redemptionSha256,
      value.issuedAt,
      value.expiresAt,
    ]),
  );
}
