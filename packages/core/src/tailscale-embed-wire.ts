// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The HTTP shapes of the gateway's own Tailscale device, shared by the gateway
 * that answers and the CLI that reads them. Present only with
 * OMNESIS_TAILSCALE_EMBED_ENABLED=1.
 */

import { z } from "zod";

/** What happens when one of the owner's own Tailscale devices asks to join. */
export const TAILSCALE_JOIN_POLICIES = ["ask", "automatic", "off"] as const;
export const tailscaleJoinPolicySchema = z.enum(TAILSCALE_JOIN_POLICIES);
export type TailscaleJoinPolicy = z.infer<typeof tailscaleJoinPolicySchema>;

/**
 * The identity a collector proves by joining through the gateway's tailnet
 * device: its stable Tailscale node id. It is stored where a sign-in join
 * keeps its device key, so revocation sticks to the machine the same way.
 */
export function tailscaleNodeIdentity(stableNodeId: string): string {
  return `tailscale-node:${stableNodeId}`;
}

/** Whether a stored device identity is a Tailscale node rather than a device key. */
export function isTailscaleNodeIdentity(identity: string): boolean {
  return identity.startsWith("tailscale-node:");
}

/** The device name the gateway's tailnet device takes unless its owner chose another. */
export const DEFAULT_TAILSCALE_DEVICE_NAME = "omnesis";

/** A collector waiting for its owner's approval, as the owner sees it. */
export const tailscaleJoinRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.literal("collector"),
  machine: z.string(),
  os: z.string().optional(),
  login: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
});
export type TailscaleJoinRequest = z.infer<typeof tailscaleJoinRequestSchema>;

export const tailscaleCertificateSchema = z.object({
  source: z.enum(["tailscale", "gateway"]),
  reason: z.enum(["https-disabled", "magicdns-disabled", "pending", "failed"]).optional(),
  error: z.string().optional(),
});

export const tailscalePublicSchema = z.object({
  state: z.enum(["off", "starting", "on", "needs-enable", "unavailable"]),
  url: z.string().optional(),
  enableUrl: z.string().optional(),
  reason: z.string().optional(),
});

/** Everything the Tailscale page and `omnesis tailscale status` show. */
export const tailscaleAdminStateSchema = z.object({
  /** The owner turned the gateway's own device on. */
  enabled: z.boolean(),
  deviceName: z.string(),
  joinPolicy: tailscaleJoinPolicySchema,
  helper: z.object({
    state: z.enum(["off", "unavailable", "starting", "running", "restarting"]),
    reason: z.string().optional(),
  }),
  /** Tailscale's own state for the device, once the helper reports it. */
  connection: z.enum([
    "off",
    "starting",
    "needs-sign-in",
    "needs-approval",
    "connected",
    "stopped",
  ]),
  signInUrl: z.string().nullable(),
  /** The gateway's HTTPS address on the tailnet, once connected. */
  url: z.string().nullable(),
  node: z
    .object({ dnsName: z.string(), tailnet: z.string().optional(), ips: z.array(z.string()) })
    .nullable(),
  owner: z.object({ login: z.string(), displayName: z.string().optional() }).nullable(),
  certificate: tailscaleCertificateSchema.nullable(),
  public: tailscalePublicSchema.extend({ wanted: z.boolean() }),
  joinRequests: z.array(tailscaleJoinRequestSchema),
});
export type TailscaleAdminState = z.infer<typeof tailscaleAdminStateSchema>;

/** The credentials a joined collector receives, as a pairing redemption gives them. */
export const tailscaleJoinCredentialsSchema = z.object({
  device: z.object({ id: z.string(), name: z.string(), kind: z.literal("collector") }),
  tokenId: z.string(),
  token: z.string().min(1),
  scopes: z.array(z.string()),
});

/** Every answer `POST /tailscale/join` and its poll can give. */
export const tailscaleJoinAnswerSchema = z.discriminatedUnion("status", [
  tailscaleJoinCredentialsSchema.extend({ status: z.literal("joined") }),
  z.object({
    status: z.literal("pending"),
    requestId: z.string().optional(),
    secret: z.string().optional(),
    expiresAt: z.string(),
  }),
  z.object({ status: z.enum(["denied", "gone", "failed"]), error: z.string() }),
]);
export type TailscaleJoinAnswer = z.infer<typeof tailscaleJoinAnswerSchema>;
