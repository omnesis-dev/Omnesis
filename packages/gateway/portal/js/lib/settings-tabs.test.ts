// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { settingsTabs } from "./settings-tabs.js";

test("relay and experimental settings have independent opt-ins", () => {
  expect(settingsTabs().some((tab: { key: string }) => tab.key === "account")).toBe(false);
  for (const experimental of [false, true]) {
    for (const cloudRelay of [false, true]) {
      const keys = settingsTabs({ experimental, cloudRelay }).map((tab: { key: string }) => tab.key);
      expect(keys.includes("account")).toBe(cloudRelay);
      expect(keys.includes("sweeps")).toBe(experimental);
      expect(keys.includes("devices")).toBe(true);
    }
  }
});
