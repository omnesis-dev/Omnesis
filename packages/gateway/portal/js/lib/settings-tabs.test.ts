// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { SETTINGS_TAB_KEYS, settingsTabAvailable, settingsTabParent, settingsTabs } from "./settings-tabs.js";

const keys = (options: Record<string, boolean> = {}) =>
  (settingsTabs(options) as Array<{ key: string }>).map((tab) => tab.key);

test("relay and experimental settings have independent opt-ins", () => {
  expect(keys()).not.toContain("remote-access");
  for (const experimental of [false, true]) {
    for (const cloudRelay of [false, true]) {
      const shown = keys({ experimental, cloudRelay });
      expect(shown.includes("remote-access")).toBe(cloudRelay);
      expect(shown.includes("sweeps")).toBe(experimental);
      expect(shown.includes("devices")).toBe(true);
    }
  }
});

test("Lab availability, Brain opt-in, and cloud account availability remain independent", () => {
  for (const experimental of [false, true]) {
    for (const labAvailable of [false, true]) {
      for (const brain of [false, true]) {
        for (const cloudRelay of [false, true]) {
          const shown = keys({ experimental, labAvailable, brain, cloudRelay });
          expect(shown.includes("lab")).toBe(experimental && labAvailable);
          if (experimental && labAvailable) expect(shown.slice(0, 2)).toEqual(["config", "lab"]);
          expect(shown.includes("sweeps")).toBe(experimental && brain);
          expect(shown.includes("remote-access")).toBe(cloudRelay);
        }
      }
    }
  }
});

test("one Remote access tab, last, exists with the relay, the Tailscale device or both", () => {
  for (const experimental of [false, true]) {
    for (const cloudRelay of [false, true]) {
      for (const tailscaleEmbed of [false, true]) {
        const tabs = settingsTabs({ experimental, cloudRelay, tailscaleEmbed }) as Array<{ key: string; label: string }>;
        const shown = tabs.map((tab) => tab.key);
        // The account and the Tailscale device are detail pages of Remote access, never tabs.
        expect(shown).not.toContain("account");
        expect(shown).not.toContain("tailscale");
        expect(shown.includes("remote-access")).toBe(cloudRelay || tailscaleEmbed);
        if (cloudRelay || tailscaleEmbed) expect(tabs.at(-1)).toEqual({ key: "remote-access", label: "Remote access" });
      }
    }
  }
});

test("the detail pages keep their paths and name Remote access as their tab", () => {
  expect(SETTINGS_TAB_KEYS).toEqual(expect.arrayContaining(["remote-access", "account", "tailscale"]));
  expect(settingsTabParent("account")).toBe("remote-access");
  expect(settingsTabParent("tailscale")).toBe("remote-access");
  expect(settingsTabParent("remote-access")).toBeNull();
  expect(settingsTabParent("devices")).toBeNull();
  expect(settingsTabParent("missing")).toBeNull();
});

test("each page exists only with the feature it belongs to", () => {
  for (const cloudRelay of [false, true]) {
    for (const tailscaleEmbed of [false, true]) {
      const flags = { cloudRelay, tailscaleEmbed };
      expect(settingsTabAvailable("remote-access", flags)).toBe(cloudRelay || tailscaleEmbed);
      expect(settingsTabAvailable("account", flags)).toBe(cloudRelay);
      expect(settingsTabAvailable("tailscale", flags)).toBe(tailscaleEmbed);
      expect(settingsTabAvailable("devices", flags)).toBe(true);
    }
  }
  expect(settingsTabAvailable("account")).toBe(false);
  expect(settingsTabAvailable("missing", { cloudRelay: true })).toBe(false);
});
