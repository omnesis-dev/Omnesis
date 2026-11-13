// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { cloudRelayEnabled } from "./cloud-relay-enabled.js";

afterEach(() => vi.unstubAllEnvs());
test("only the independent explicit opt-in enables cloud connectivity", () => {
  for (const experimental of [undefined, "0", "1"]) {
    for (const synthetic of [undefined, "0", "1"]) {
      for (const enabled of [undefined, "", "0", "true", "on", " 1", "1 ", "1"]) {
        expect(
          cloudRelayEnabled({
            OMNESIS_EXPERIMENTAL: experimental,
            OMNESIS_SYNTHETIC: synthetic,
            OMNESIS_CLOUD_RELAY_ENABLED: enabled,
          }),
        ).toBe(enabled === "1");
      }
    }
  }
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  expect(cloudRelayEnabled()).toBe(true);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  expect(cloudRelayEnabled()).toBe(false);
});
