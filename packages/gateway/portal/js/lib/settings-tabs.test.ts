// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { SETTINGS_TAB_KEYS, settingsTabAvailable, settingsTabParent, settingsTabs } from "./settings-tabs.js";

const keys = (options: Record<string, boolean> = {}) =>
  (settingsTabs(options) as Array<{ key: string }>).map((tab) => tab.key);

test("experimental settings follow experimental mode; Connectivity and Devices are always there", () => {
  for (const experimental of [false, true]) {
    const shown = keys({ experimental });
    expect(shown.includes("connectivity")).toBe(true);
    expect(shown.includes("sweeps")).toBe(experimental);
    expect(shown.includes("devices")).toBe(true);
  }
});

test("Lab availability and Brain opt-in remain independent", () => {
  for (const experimental of [false, true]) {
    for (const labAvailable of [false, true]) {
      for (const brain of [false, true]) {
        const shown = keys({ experimental, labAvailable, brain });
        expect(shown.includes("lab")).toBe(experimental && labAvailable);
        if (experimental && labAvailable) expect(shown.slice(0, 2)).toEqual(["config", "lab"]);
        expect(shown.includes("sweeps")).toBe(experimental && brain);
        expect(shown.includes("connectivity")).toBe(true);
      }
    }
  }
});

test("one Connectivity tab, last, on every gateway whatever its optional features", () => {
  for (const experimental of [false, true]) {
    for (const tailscaleEmbed of [false, true]) {
      const tabs = settingsTabs({ experimental, tailscaleEmbed }) as Array<{ key: string; label: string }>;
      const shown = tabs.map((tab) => tab.key);
      // Every page behind Connectivity is a detail page, never a tab.
      for (const detail of ["account", "relay", "tailscale", "host-tailscale", "own-address", "mcp"]) {
        expect(shown).not.toContain(detail);
      }
      expect(tabs.at(-1)).toEqual({ key: "connectivity", label: "Connectivity" });
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

test("only the Tailscale device's page depends on an optional feature", () => {
  for (const tailscaleEmbed of [false, true]) {
    const flags = { tailscaleEmbed };
    expect(settingsTabAvailable("connectivity", flags)).toBe(true);
    expect(settingsTabAvailable("host-tailscale", flags)).toBe(true);
    expect(settingsTabAvailable("own-address", flags)).toBe(true);
    expect(settingsTabAvailable("mcp", flags)).toBe(true);
    expect(settingsTabAvailable("account", flags)).toBe(true);
    expect(settingsTabAvailable("relay", flags)).toBe(true);
    expect(settingsTabAvailable("tailscale", flags)).toBe(tailscaleEmbed);
    expect(settingsTabAvailable("devices", flags)).toBe(true);
  }
  expect(settingsTabAvailable("account")).toBe(true);
  expect(settingsTabAvailable("tailscale")).toBe(false);
  expect(settingsTabAvailable("missing", { tailscaleEmbed: true })).toBe(false);
});
