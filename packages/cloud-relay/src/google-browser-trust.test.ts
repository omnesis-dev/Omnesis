// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  DEFAULT_GOOGLE_BROWSER_TRUST,
  googleBrowserTrust,
  trustedGoogleBrowserConfiguration,
} from "./google-browser-trust.js";

const env = {
  OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "owner-browser",
  OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "device-browser",
  OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS:
    "ios-native, desktop-native,ios-native",
  OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "android-presenter,ios-native",
};
const config = {
  protocol: "omnesis-google-browser-v1" as const,
  ownerLinkClientId: "owner-browser",
  deviceEnrollmentClientId: "device-browser",
  deviceClientIds: ["device-browser", "ios-native"],
  deviceAuthorizedParties: ["device-browser", "android-presenter"],
};

test("managed trust starts disabled and operator public audiences stay immutable and purpose separated", () => {
  expect(googleBrowserTrust({})).toEqual({ deviceClientIds: [], deviceAuthorizedParties: [] });
  expect(Object.isFrozen(DEFAULT_GOOGLE_BROWSER_TRUST)).toBe(true);
  const trust = googleBrowserTrust(env);
  expect(trust).toEqual({
    ownerLinkClientId: "owner-browser",
    deviceEnrollmentClientId: "device-browser",
    deviceClientIds: ["ios-native", "desktop-native", "device-browser"],
    deviceAuthorizedParties: [
      "ios-native",
      "desktop-native",
      "device-browser",
      "android-presenter",
    ],
  });
  expect(Object.isFrozen(trust)).toBe(true);
  expect(Object.isFrozen(trust.deviceClientIds)).toBe(true);
  expect(Object.isFrozen(trust.deviceAuthorizedParties)).toBe(true);
  expect(Reflect.set(trust.deviceClientIds, "0", "attacker-client")).toBe(false);
  expect(
    googleBrowserTrust({ OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "owner-only" }),
  ).toMatchObject({ ownerLinkClientId: "owner-only", deviceClientIds: [] });
  expect(
    googleBrowserTrust({
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "native-only",
    }),
  ).toEqual({ deviceClientIds: ["native-only"], deviceAuthorizedParties: ["native-only"] });
});

test("role overlap, malformed and oversized operator configuration fail without exposing supplied values", () => {
  for (const patch of [
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "owner-browser" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "owner-browser" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "owner-browser" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "private/value" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "private/value" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "native," },
    { OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "x".repeat(8193) },
    {
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: Array.from(
        { length: 17 },
        (_, index) => `native-${index}`,
      ).join(","),
    },
  ])
    expect(() => googleBrowserTrust({ ...env, ...patch })).toThrow(
      "audience trust configuration is invalid",
    );
});

test("discovery can only narrow independently trusted purposes, audiences and presenters", () => {
  const trust = googleBrowserTrust(env);
  expect(trustedGoogleBrowserConfiguration(config, trust)).toEqual(config);
  expect(
    trustedGoogleBrowserConfiguration(
      { protocol: config.protocol, deviceClientIds: [], deviceAuthorizedParties: [] },
      trust,
    ),
  ).toEqual({ protocol: config.protocol, deviceClientIds: [], deviceAuthorizedParties: [] });
  for (const mutation of [
    { ownerLinkClientId: "attacker-owner" },
    { deviceEnrollmentClientId: "attacker-device" },
    { deviceClientIds: ["attacker-native"] },
    { deviceAuthorizedParties: ["attacker-presenter"] },
    { deviceClientIds: ["ios-native"] },
    { deviceAuthorizedParties: ["ios-native"] },
    { protocol: "untrusted-protocol" },
  ])
    expect(() => trustedGoogleBrowserConfiguration({ ...config, ...mutation }, trust)).toThrow(
      "discovery does not match trusted deployment audiences",
    );
  expect(() => trustedGoogleBrowserConfiguration(config, googleBrowserTrust({}))).toThrow(
    "trusted deployment audiences",
  );
});
