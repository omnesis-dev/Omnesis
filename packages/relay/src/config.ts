// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

const nonEmptyList = z.string().transform((value, ctx) => {
  const items = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (items.length === 0) {
    ctx.addIssue({ code: "custom", message: "must contain at least one app identity" });
    return z.NEVER;
  }
  return items;
});

const boundedCount = (maximum: number) => z.coerce.number().int().positive().max(maximum);
const boundedWindow = z.coerce
  .number()
  .int()
  .min(1_000)
  .max(24 * 60 * 60_000);

const envSchema = z
  .object({
    OMNESIS_RELAY_HOST: z.string().min(1).default("0.0.0.0"),
    OMNESIS_RELAY_PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
    OMNESIS_RELAY_METRICS_HOST: z.string().min(1).default("127.0.0.1"),
    OMNESIS_RELAY_METRICS_PORT: z.coerce.number().int().min(1024).max(65535).default(9090),
    OMNESIS_RELAY_DB_PATH: z.string().min(1).default("/var/lib/omnesis-relay/relay.db"),
    OMNESIS_RELAY_APNS_KEY_PATH: z.string().min(1),
    OMNESIS_RELAY_APNS_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/),
    OMNESIS_RELAY_APNS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/),
    OMNESIS_RELAY_APNS_APP_IDS: nonEmptyList,
    OMNESIS_RELAY_APNS_BASE_URL: z.string().url().optional(),
    OMNESIS_RELAY_FCM_SERVICE_ACCOUNT_PATH: z.string().min(1),
    OMNESIS_RELAY_FCM_APP_IDS: nonEmptyList,
    OMNESIS_RELAY_FCM_BASE_URL: z.string().url().optional(),
    OMNESIS_RELAY_ENROL_SOURCE_LIMIT: boundedCount(500).default(30),
    OMNESIS_RELAY_VERIFY_SOURCE_LIMIT: boundedCount(500).default(60),
    OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT: boundedCount(500).default(120),
    OMNESIS_RELAY_SOURCE_WINDOW_MS: boundedWindow.default(10 * 60_000),
    OMNESIS_RELAY_GLOBAL_ENROL_LIMIT: boundedCount(10_000).default(120),
    OMNESIS_RELAY_RENEWAL_ENROL_LIMIT: boundedCount(10_000).default(30),
    OMNESIS_RELAY_GLOBAL_ENROL_WINDOW_MS: boundedWindow.default(60_000),
    OMNESIS_RELAY_CARRIER_FAILURE_LIMIT: boundedCount(100).default(5),
    OMNESIS_RELAY_CARRIER_FAILURE_WINDOW_MS: boundedWindow.default(10 * 60_000),
    OMNESIS_RELAY_MAX_TRACKED_SOURCES: boundedCount(10_000).default(10_000),
    OMNESIS_RELAY_MAX_PENDING_CHALLENGES: boundedCount(100_000).default(1_000),
    OMNESIS_RELAY_CHALLENGE_TTL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10 * 60_000)
      .default(2 * 60_000),
  })
  .refine((value) => value.OMNESIS_RELAY_PORT !== value.OMNESIS_RELAY_METRICS_PORT, {
    message: "relay and metrics ports must be different",
  })
  .refine(
    (value) =>
      !["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"].includes(
        value.OMNESIS_RELAY_METRICS_HOST.toLowerCase(),
      ),
    { message: "metrics host must not be a wildcard address" },
  )
  .refine(
    (value) =>
      value.OMNESIS_RELAY_MAX_TRACKED_SOURCES *
        (value.OMNESIS_RELAY_ENROL_SOURCE_LIMIT +
          value.OMNESIS_RELAY_VERIFY_SOURCE_LIMIT +
          value.OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT +
          value.OMNESIS_RELAY_CARRIER_FAILURE_LIMIT) <=
      3_000_000,
    { message: "configured source counters exceed the in-memory safety bound" },
  );

export interface RelayConfig {
  host: string;
  port: number;
  metricsHost: string;
  metricsPort: number;
  dbPath: string;
  abuse: {
    enrolSourceLimit: number;
    verifySourceLimit: number;
    invalidWakeSourceLimit: number;
    sourceWindowMs: number;
    globalEnrolLimit: number;
    renewalEnrolLimit: number;
    globalEnrolWindowMs: number;
    carrierFailureLimit: number;
    carrierFailureWindowMs: number;
    maxTrackedSources: number;
    maxPendingChallenges: number;
    challengeTtlMs: number;
  };
  apns: {
    keyPath: string;
    keyId: string;
    teamId: string;
    appIds: string[];
    baseUrl?: string;
  };
  fcm: {
    serviceAccountPath: string;
    appIds: string[];
    baseUrl?: string;
  };
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = envSchema.parse(env);
  return {
    host: parsed.OMNESIS_RELAY_HOST,
    port: parsed.OMNESIS_RELAY_PORT,
    metricsHost: parsed.OMNESIS_RELAY_METRICS_HOST,
    metricsPort: parsed.OMNESIS_RELAY_METRICS_PORT,
    dbPath: parsed.OMNESIS_RELAY_DB_PATH,
    abuse: {
      enrolSourceLimit: parsed.OMNESIS_RELAY_ENROL_SOURCE_LIMIT,
      verifySourceLimit: parsed.OMNESIS_RELAY_VERIFY_SOURCE_LIMIT,
      invalidWakeSourceLimit: parsed.OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT,
      sourceWindowMs: parsed.OMNESIS_RELAY_SOURCE_WINDOW_MS,
      globalEnrolLimit: parsed.OMNESIS_RELAY_GLOBAL_ENROL_LIMIT,
      renewalEnrolLimit: parsed.OMNESIS_RELAY_RENEWAL_ENROL_LIMIT,
      globalEnrolWindowMs: parsed.OMNESIS_RELAY_GLOBAL_ENROL_WINDOW_MS,
      carrierFailureLimit: parsed.OMNESIS_RELAY_CARRIER_FAILURE_LIMIT,
      carrierFailureWindowMs: parsed.OMNESIS_RELAY_CARRIER_FAILURE_WINDOW_MS,
      maxTrackedSources: parsed.OMNESIS_RELAY_MAX_TRACKED_SOURCES,
      maxPendingChallenges: parsed.OMNESIS_RELAY_MAX_PENDING_CHALLENGES,
      challengeTtlMs: parsed.OMNESIS_RELAY_CHALLENGE_TTL_MS,
    },
    apns: {
      keyPath: parsed.OMNESIS_RELAY_APNS_KEY_PATH,
      keyId: parsed.OMNESIS_RELAY_APNS_KEY_ID,
      teamId: parsed.OMNESIS_RELAY_APNS_TEAM_ID,
      appIds: parsed.OMNESIS_RELAY_APNS_APP_IDS,
      ...(parsed.OMNESIS_RELAY_APNS_BASE_URL
        ? { baseUrl: parsed.OMNESIS_RELAY_APNS_BASE_URL }
        : {}),
    },
    fcm: {
      serviceAccountPath: parsed.OMNESIS_RELAY_FCM_SERVICE_ACCOUNT_PATH,
      appIds: parsed.OMNESIS_RELAY_FCM_APP_IDS,
      ...(parsed.OMNESIS_RELAY_FCM_BASE_URL ? { baseUrl: parsed.OMNESIS_RELAY_FCM_BASE_URL } : {}),
    },
  };
}
