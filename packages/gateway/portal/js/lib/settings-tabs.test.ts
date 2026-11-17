// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { SETTINGS_TAB_KEYS, settingsTabAvailable, settingsTabParent, settingsTabs } from "./settings-tabs.js";

const keys = (options: Record<string, boolean> = {}) =>
  (settingsTabs(options) as Array<{ key: string }>).map((tab) => tab.key);

test("relay and experimental settings have independent opt-ins", () => {
  for (const experimental of [false, true]) {
    for (const cloudRelay of [false, true]) {
      const shown = keys({ experimental, cloudRelay });
      expect(shown.includes("connectivity")).toBe(true);
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
          expect(shown.includes("connectivity")).toBe(true);
        }
      }
    }
  }
});

test("one Connectivity tab, last, on every gateway whatever its optional features", () => {
  for (const experimental of [false, true]) {
    for (const cloudRelay of [false, true]) {
      for (const tailscaleEmbed of [false, true]) {
        const tabs = settingsTabs({ experimental, cloudRelay, tailscaleEmbed }) as Array<{ key: string; label: string }>;
        const shown = tabs.map((tab) => tab.key);
        // Every page behind Connectivity is a detail page, never a tab.
        for (const detail of ["account", "relay", "tailscale", "host-tailscale", "own-address", "mcp"]) {
          expect(shown).not.toContain(detail);
        }
        expect(tabs.at(-1)).toEqual({ key: "connectivity", label: "Connectivity" });
      }
    }
  }
});

test("the detail pages keep their paths and name Connectivity as their tab", () => {
  const details = ["account", "relay", "tailscale", "host-tailscale", "own-address", "mcp"];
  expect(SETTINGS_TAB_KEYS).toEqual(expect.arrayContaining(["connectivity", ...details]));
  for (const detail of details) expect(settingsTabParent(detail)).toBe("connectivity");
  expect(settingsTabParent("connectivity")).toBeNull();
  expect(settingsTabParent("devices")).toBeNull();
  expect(settingsTabParent("missing")).toBeNull();
});

test("each page exists only with the feature it belongs to", () => {
  for (const cloudRelay of [false, true]) {
    for (const tailscaleEmbed of [false, true]) {
      const flags = { cloudRelay, tailscaleEmbed };
      expect(settingsTabAvailable("connectivity", flags)).toBe(true);
      expect(settingsTabAvailable("host-tailscale", flags)).toBe(true);
      expect(settingsTabAvailable("own-address", flags)).toBe(true);
      expect(settingsTabAvailable("mcp", flags)).toBe(true);
      expect(settingsTabAvailable("account", flags)).toBe(cloudRelay);
      expect(settingsTabAvailable("relay", flags)).toBe(cloudRelay);
      expect(settingsTabAvailable("tailscale", flags)).toBe(tailscaleEmbed);
      expect(settingsTabAvailable("devices", flags)).toBe(true);
    }
  }
  expect(settingsTabAvailable("account")).toBe(false);
  expect(settingsTabAvailable("missing", { cloudRelay: true })).toBe(false);
});
