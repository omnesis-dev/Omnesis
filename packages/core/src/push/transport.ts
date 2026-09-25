// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  NOTIFICATION_DELIVERY_HEALTH_STATES,
  PUSH_TRANSPORTS,
  type NotificationDeliveryHealth,
  type PushTransport,
} from "@omnesis/types/device";
import { DEFAULT_PUSH_RELAY_URL } from "@omnesis/config";
import { z } from "zod";

export { PUSH_TRANSPORTS, type PushTransport };

export const pushTransportSchema = z.enum(PUSH_TRANSPORTS);

export { NOTIFICATION_DELIVERY_HEALTH_STATES, type NotificationDeliveryHealth };

export const notificationDeliveryHealthSchema = z.enum(NOTIFICATION_DELIVERY_HEALTH_STATES);
export const notificationDeliveryHealthReportSchema = z
  .object({ status: notificationDeliveryHealthSchema })
  .strict();
export type NotificationDeliveryHealthReport = z.infer<
  typeof notificationDeliveryHealthReportSchema
>;

const relayUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  }, "relay URL must be HTTP(S) without userinfo or a fragment");

export const pushRegistrationSchema = z.discriminatedUnion("transport", [
  z
    .object({
      transport: z.literal("direct-apns"),
      deviceToken: z.string().regex(/^[0-9a-f]{64}$/i),
      environment: z.enum(["sandbox", "production"]),
      bundleId: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      transport: z.literal("direct-fcm"),
      registrationToken: z.string().trim().min(1).max(4096),
      projectId: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      transport: z.literal("relay"),
      relayUrl: relayUrlSchema,
      credential: z.string().trim().min(1).max(4096),
    })
    .strict(),
]);

export type PushRegistration = z.infer<typeof pushRegistrationSchema>;

const appIdentitySchema = z.string().trim().min(1).max(255);

export const pushPlanRequestSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("ios"), appId: appIdentitySchema }).strict(),
  z.object({ platform: z.literal("android"), appId: appIdentitySchema }).strict(),
]);

export const PUSH_PLAN_UNAVAILABLE_REASONS = [
  "relay-disabled",
  "relay-url-unavailable",
  "no-direct-credential",
] as const;
export type PushPlanUnavailableReason = (typeof PUSH_PLAN_UNAVAILABLE_REASONS)[number];
export const pushPlanUnavailableReasonSchema = z.enum(PUSH_PLAN_UNAVAILABLE_REASONS);

export const pushPlanSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("direct-apns") }).strict(),
  z.object({ transport: z.literal("direct-fcm") }).strict(),
  z.object({ transport: z.literal("relay"), relayUrl: relayUrlSchema }).strict(),
  z
    .object({
      transport: z.literal("unavailable"),
      reasonCode: pushPlanUnavailableReasonSchema,
      reason: z.string().min(1).max(512),
    })
    .strict(),
]);

export type PushPlanRequest = z.infer<typeof pushPlanRequestSchema>;
export type PushPlan = z.infer<typeof pushPlanSchema>;

/** Published relay address used as the gateway configuration default. */
export const PUBLISHED_PUSH_RELAY_URL = DEFAULT_PUSH_RELAY_URL;

/** Store-build identities eligible for the first-party relay. */
export const PUBLISHED_PUSH_APP_IDS = {
  ios: ["dev.omnesis.ios"],
  android: ["dev.omnesis.android"],
} as const satisfies Readonly<Record<"ios" | "android", readonly string[]>>;
