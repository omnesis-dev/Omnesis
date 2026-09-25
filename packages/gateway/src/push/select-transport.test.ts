// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DeviceId } from "@omnesis/types";
import { buildPushPlan, selectPushTransport } from "./select-transport.js";
import type { DeviceRecord } from "@omnesis/types";

function device(patch: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: DeviceId("00000000-0000-4000-8000-000000000001"),
    name: "Fictional phone",
    kind: "ios",
    capabilities: {},
    pairedAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    installId: null,
    version: null,
    versionSeenAt: null,
    protocolVersion: null,
    desiredVersion: null,
    updateState: null,
    updateDetail: null,
    updateStateAt: null,
    selfEmails: [],
    selfPhones: [],
    accessLevelId: null,
    apnsRegistration: null,
    fcmRegistration: null,
    pushTransport: null,
    relayUrl: null,
    relayCredential: null,
    ...patch,
  };
}

describe("selectPushTransport", () => {
  test("a live socket short-circuits the stored carrier", () => {
    expect(
      selectPushTransport(device({ pushTransport: "relay" }), {
        socketConnected: true,
      }),
    ).toEqual({ transport: "socket" });
  });

  test("selects direct APNs, direct FCM, and relay from complete stored registrations", () => {
    expect(
      selectPushTransport(
        device({
          pushTransport: "direct-apns",
          apnsRegistration: {
            deviceToken: "a".repeat(64),
            environment: "production",
            bundleId: "dev.example.app",
            updatedAt: 1,
          },
        }),
        { socketConnected: false },
      ).transport,
    ).toBe("direct-apns");
    expect(
      selectPushTransport(
        device({
          kind: "android",
          pushTransport: "direct-fcm",
          fcmRegistration: { registrationToken: "token", updatedAt: 1 },
        }),
        { socketConnected: false },
      ).transport,
    ).toBe("direct-fcm");
    expect(
      selectPushTransport(
        device({
          pushTransport: "relay",
          relayUrl: "https://relay.example",
          relayCredential: "c",
          relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
        }),
        { socketConnected: false },
      ).transport,
    ).toBe("relay");
  });

  test("a live socket takes precedence over stored carrier registration", () => {
    expect(
      selectPushTransport(
        device({
          apnsRegistration: {
            deviceToken: "a".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
        { socketConnected: true },
      ).transport,
    ).toBe("socket");
  });

  test("does not infer a transport from unclaimed carrier-address columns", () => {
    expect(
      selectPushTransport(
        device({
          apnsRegistration: {
            deviceToken: "a".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
        { socketConnected: false },
      ),
    ).toEqual({ transport: "unavailable", reason: "push is not registered" });
  });

  test("does not use an unconsented or incomplete relay", () => {
    const registered = device({
      pushTransport: "relay",
      relayUrl: "https://relay.example",
      relayCredential: "credential",
    });
    expect(selectPushTransport(registered, { socketConnected: false }).transport).toBe(
      "unavailable",
    );
    expect(
      selectPushTransport(
        device({
          pushTransport: "relay",
          relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
        }),
        {
          socketConnected: false,
        },
      ).transport,
    ).toBe("unavailable");
  });

  test("rejects a relay registration for a stale configured endpoint", () => {
    const registered = device({
      pushTransport: "relay",
      relayUrl: "https://relay-old.example",
      relayCredential: "credential",
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
    });
    expect(
      selectPushTransport(registered, {
        socketConnected: false,
        relayUrl: "https://relay-current.example",
      }),
    ).toEqual({
      transport: "unavailable",
      reason: "relay registration does not match the configured endpoint",
    });
  });
});

describe("buildPushPlan", () => {
  const relay = { relayUrl: "https://relay.example" };

  test("matches only the exact configured direct identity", () => {
    expect(
      buildPushPlan(
        { platform: "ios", appId: "dev.example.self-build" },
        { ...relay, apnsBundleId: "dev.example.self-build" },
      ),
    ).toEqual({ transport: "direct-apns" });
    expect(
      buildPushPlan(
        {
          platform: "android",
          appId: "dev.example.self-build",
        },
        {
          ...relay,
          fcmAppId: "dev.example.self-build",
          relayConsentAppId: "dev.omnesis.android",
        },
      ),
    ).toEqual({ transport: "direct-fcm" });
  });

  test("does not confuse one Android package id with another", () => {
    expect(
      buildPushPlan(
        {
          platform: "android",
          appId: "dev.omnesis.android",
        },
        {
          ...relay,
          fcmAppId: "dev.example.self-build",
          relayConsentAppId: "dev.omnesis.android",
        },
      ),
    ).toEqual({ transport: "relay", relayUrl: "https://relay.example" });
  });

  test("a stale credential for another identity cannot capture the published app", () => {
    expect(
      buildPushPlan(
        { platform: "ios", appId: "dev.omnesis.ios" },
        {
          ...relay,
          apnsBundleId: "dev.example.stale",
          relayConsentAppId: "dev.omnesis.ios",
        },
      ),
    ).toEqual({ transport: "relay", relayUrl: "https://relay.example" });
  });

  test("an unknown self-build without matching credentials is unavailable", () => {
    expect(
      buildPushPlan(
        { platform: "ios", appId: "dev.example.unknown" },
        { ...relay, apnsBundleId: "dev.example.other" },
      ).transport,
    ).toBe("unavailable");
  });

  test("the published app needs consent for its exact identity", () => {
    expect(buildPushPlan({ platform: "ios", appId: "dev.omnesis.ios" }, relay)).toEqual({
      transport: "unavailable",
      reasonCode: "relay-disabled",
      reason: "relay notifications are not authorized for this device",
    });
    expect(
      buildPushPlan(
        { platform: "ios", appId: "dev.omnesis.ios" },
        { ...relay, relayConsentAppId: "dev.omnesis.android" },
      ),
    ).toEqual({
      transport: "unavailable",
      reasonCode: "relay-disabled",
      reason: "relay notifications are not authorized for this device",
    });
  });
});
