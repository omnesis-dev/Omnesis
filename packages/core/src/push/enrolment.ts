// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const PUSH_RELAY_PROTOCOL_VERSION = 1;
export const PUSH_RELAY_PROTOCOL_MIN_VERSION = 1;
export const PUSH_RELAY_PROTOCOL_MAX_VERSION = 1;

export const relayEnrolRequestSchema = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("ios"),
      token: z.string().regex(/^[0-9a-f]{64}$/i),
      bundleId: z.string().min(1).max(255),
      environment: z.enum(["sandbox", "production"]),
    })
    .strict(),
  z
    .object({
      platform: z.literal("android"),
      token: z.string().min(1).max(4096),
      appId: z.string().min(1).max(255),
    })
    .strict(),
]);

const opaqueRelayValueSchema = z.string().min(1).max(4096);

export const relayEnrolResponseSchema = z.object({ challengeId: opaqueRelayValueSchema }).strict();
export const relayVerifyRequestSchema = z
  .object({ challengeId: opaqueRelayValueSchema, nonce: opaqueRelayValueSchema })
  .strict();
export const relayVerifyResponseSchema = z.object({ credential: opaqueRelayValueSchema }).strict();

export type RelayEnrolRequest = z.infer<typeof relayEnrolRequestSchema>;
export type RelayEnrolResponse = z.infer<typeof relayEnrolResponseSchema>;
export type RelayVerifyRequest = z.infer<typeof relayVerifyRequestSchema>;
export type RelayVerifyResponse = z.infer<typeof relayVerifyResponseSchema>;
