// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { loadRelayConfig } from "./config.js";

const required = {
  OMNESIS_RELAY_APNS_KEY_PATH: "/run/secrets/apns-key",
  OMNESIS_RELAY_APNS_KEY_ID: "KEYID12345",
  OMNESIS_RELAY_APNS_TEAM_ID: "TEAMID1234",
  OMNESIS_RELAY_APNS_APP_IDS: "dev.omnesis.ios",
  OMNESIS_RELAY_FCM_SERVICE_ACCOUNT_PATH: "/run/secrets/fcm-account",
  OMNESIS_RELAY_FCM_APP_IDS: "dev.omnesis.android",
};

describe("relay configuration", () => {
  it("uses an unprivileged plain-HTTP bind and persistent store defaults", () => {
    expect(loadRelayConfig(required)).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      metricsHost: "127.0.0.1",
      metricsPort: 9090,
      dbPath: "/var/lib/omnesis-relay/relay.db",
      abuse: {
        enrolSourceLimit: 30,
        verifySourceLimit: 60,
        invalidWakeSourceLimit: 120,
        sourceWindowMs: 600_000,
        globalEnrolLimit: 120,
        renewalEnrolLimit: 30,
        globalEnrolWindowMs: 60_000,
        carrierFailureLimit: 5,
        carrierFailureWindowMs: 600_000,
        maxTrackedSources: 10_000,
        maxPendingChallenges: 1_000,
        challengeTtlMs: 120_000,
      },
      apns: { keyPath: "/run/secrets/apns-key", appIds: ["dev.omnesis.ios"] },
      fcm: {
        serviceAccountPath: "/run/secrets/fcm-account",
        appIds: ["dev.omnesis.android"],
      },
    });
  });

  it("accepts abuse-limit overrides and rejects non-positive limits", () => {
    expect(
      loadRelayConfig({
        ...required,
        OMNESIS_RELAY_GLOBAL_ENROL_LIMIT: "250",
        OMNESIS_RELAY_MAX_PENDING_CHALLENGES: "2000",
      }).abuse,
    ).toMatchObject({ globalEnrolLimit: 250, maxPendingChallenges: 2_000 });
    for (const key of [
      "OMNESIS_RELAY_ENROL_SOURCE_LIMIT",
      "OMNESIS_RELAY_VERIFY_SOURCE_LIMIT",
      "OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT",
      "OMNESIS_RELAY_SOURCE_WINDOW_MS",
      "OMNESIS_RELAY_GLOBAL_ENROL_LIMIT",
      "OMNESIS_RELAY_RENEWAL_ENROL_LIMIT",
      "OMNESIS_RELAY_GLOBAL_ENROL_WINDOW_MS",
      "OMNESIS_RELAY_CARRIER_FAILURE_LIMIT",
      "OMNESIS_RELAY_CARRIER_FAILURE_WINDOW_MS",
      "OMNESIS_RELAY_MAX_TRACKED_SOURCES",
      "OMNESIS_RELAY_MAX_PENDING_CHALLENGES",
      "OMNESIS_RELAY_CHALLENGE_TTL_MS",
    ]) {
      expect(() => loadRelayConfig({ ...required, [key]: "0" })).toThrow();
    }
    expect(() =>
      loadRelayConfig({
        ...required,
        OMNESIS_RELAY_ENROL_SOURCE_LIMIT: "500",
        OMNESIS_RELAY_VERIFY_SOURCE_LIMIT: "500",
        OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT: "500",
        OMNESIS_RELAY_CARRIER_FAILURE_LIMIT: "100",
        OMNESIS_RELAY_MAX_TRACKED_SOURCES: "10000",
      }),
    ).toThrow("configured source counters exceed the in-memory safety bound");
  });

  it("normalizes and deduplicates app identity coverage", () => {
    const config = loadRelayConfig({
      ...required,
      OMNESIS_RELAY_APNS_APP_IDS: " dev.omnesis.ios,org.example.preview,dev.omnesis.ios ",
    });
    expect(config.apns.appIds).toEqual(["dev.omnesis.ios", "org.example.preview"]);
  });

  it("requires mounted credential paths and rejects privileged ports", () => {
    expect(() =>
      loadRelayConfig({ ...required, OMNESIS_RELAY_APNS_KEY_PATH: undefined }),
    ).toThrow();
    expect(() => loadRelayConfig({ ...required, OMNESIS_RELAY_PORT: "443" })).toThrow();
    expect(() => loadRelayConfig({ ...required, OMNESIS_RELAY_METRICS_PORT: "8080" })).toThrow(
      "relay and metrics ports must be different",
    );
    for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"]) {
      expect(() => loadRelayConfig({ ...required, OMNESIS_RELAY_METRICS_HOST: host })).toThrow(
        "metrics host must not be a wildcard address",
      );
    }
    expect(() => loadRelayConfig({ ...required, OMNESIS_RELAY_FCM_APP_IDS: " , " })).toThrow();
  });
});
