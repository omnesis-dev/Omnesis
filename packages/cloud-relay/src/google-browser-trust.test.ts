// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  OFFICIAL_GOOGLE_BROWSER_TRUST,
  googleBrowserTrust,
  trustedGoogleBrowserConfiguration,
} from "./google-browser-trust.js";

const registry = {
  ownerLinkClientId: "owner-browser",
  deviceEnrollmentClientId: "device-browser",
  deviceClientIds: ["ios-native", "desktop-native", "ios-native"],
  deviceAuthorizedParties: ["android-presenter", "ios-native"],
};
const config = {
  protocol: "omnesis-google-browser-v1" as const,
  ownerLinkClientId: "owner-browser",
  deviceEnrollmentClientId: "device-browser",
  deviceClientIds: ["device-browser", "ios-native"],
  deviceAuthorizedParties: ["device-browser", "android-presenter"],
};

const official = (id: string) => `69746762909-${id}.apps.googleusercontent.com`;

test("the official google clients are compiled in and trusted without any configuration", () => {
  expect(Object.isFrozen(OFFICIAL_GOOGLE_BROWSER_TRUST)).toBe(true);
  const trust = googleBrowserTrust();
  expect(trust).toEqual({
    ownerLinkClientId: official("7vc7i6efbbig530e20gtaa83076q02l2"),
    deviceEnrollmentClientId: official("e65hukbm0nqrntk71qc0prslr9eg6gik"),
    deviceClientIds: [
      official("e65hukbm0nqrntk71qc0prslr9eg6gik"),
      official("luas0k1rpi7nvn2ee0bogfu2vfha34si"),
      official("071jh21ngi85ne01k4oe5krfng2frmhr"),
      official("qc4prr14sagtienhn36lhmp7rthno16a"),
      official("3lnneuvft93ud5ssdppe19tc7fol4aku"),
    ],
    deviceAuthorizedParties: [
      official("e65hukbm0nqrntk71qc0prslr9eg6gik"),
      official("luas0k1rpi7nvn2ee0bogfu2vfha34si"),
      official("071jh21ngi85ne01k4oe5krfng2frmhr"),
      official("qc4prr14sagtienhn36lhmp7rthno16a"),
      official("3lnneuvft93ud5ssdppe19tc7fol4aku"),
      official("sb5de515284geor9ui6vg7hsl4qsrg53"),
    ],
  });
  expect(trust.deviceClientIds).not.toContain(trust.ownerLinkClientId);
  expect(trust.deviceAuthorizedParties).not.toContain(trust.ownerLinkClientId);
  expect(Object.isFrozen(trust)).toBe(true);
  expect(Reflect.set(trust.deviceClientIds, "0", "attacker-client")).toBe(false);
});

test("the trusted clients do not depend on the environment or the selected relay", async () => {
  const source = await readFile(new URL("./google-browser-trust.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/process\.env|OMNESIS_/);
});

test("a registry is normalized so purposes stay separated and the result is immutable", () => {
  const trust = googleBrowserTrust(registry);
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
  expect(
    googleBrowserTrust({
      ownerLinkClientId: "owner-only",
      deviceClientIds: [],
      deviceAuthorizedParties: [],
    }),
  ).toMatchObject({ ownerLinkClientId: "owner-only", deviceClientIds: [] });
  expect(
    googleBrowserTrust({ deviceClientIds: ["native-only"], deviceAuthorizedParties: [] }),
  ).toEqual({ deviceClientIds: ["native-only"], deviceAuthorizedParties: ["native-only"] });
});

test("role overlap, malformed and oversized registries fail without exposing supplied values", () => {
  for (const patch of [
    { deviceEnrollmentClientId: "owner-browser" },
    { deviceClientIds: ["owner-browser"] },
    { deviceAuthorizedParties: ["owner-browser"] },
    { ownerLinkClientId: "private/value" },
    { deviceEnrollmentClientId: "private/value" },
    { deviceClientIds: [""] },
    { deviceAuthorizedParties: ["native", ""] },
    { deviceClientIds: Array.from({ length: 17 }, (_, index) => `native-${index}`) },
  ])
    expect(() => googleBrowserTrust({ ...registry, ...patch })).toThrow(
      "audience trust configuration is invalid",
    );
});

test("discovery can only narrow independently trusted purposes, audiences and presenters", () => {
  const trust = googleBrowserTrust(registry);
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
  expect(() =>
    trustedGoogleBrowserConfiguration(
      config,
      googleBrowserTrust({ deviceClientIds: [], deviceAuthorizedParties: [] }),
    ),
  ).toThrow("trusted deployment audiences");
  // A relay advertising its own client IDs is refused against the compiled-in official registry.
  expect(() => trustedGoogleBrowserConfiguration(config, googleBrowserTrust())).toThrow(
    "trusted deployment audiences",
  );
  const official = googleBrowserTrust();
  expect(
    trustedGoogleBrowserConfiguration(
      {
        protocol: config.protocol,
        ownerLinkClientId: official.ownerLinkClientId,
        deviceEnrollmentClientId: official.deviceEnrollmentClientId,
        deviceClientIds: [official.deviceEnrollmentClientId],
        deviceAuthorizedParties: [official.deviceEnrollmentClientId],
      },
      official,
    ).ownerLinkClientId,
  ).toBe(official.ownerLinkClientId);
  expect(() =>
    trustedGoogleBrowserConfiguration(
      {
        protocol: config.protocol,
        deviceClientIds: [
          ...official.deviceClientIds,
          "69746762909-extra.apps.googleusercontent.com",
        ],
        deviceAuthorizedParties: [],
      },
      official,
    ),
  ).toThrow("trusted deployment audiences");
});
