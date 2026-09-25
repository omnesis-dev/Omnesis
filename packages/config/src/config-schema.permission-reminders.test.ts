// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { omnesisConfigSchema } from "./config-schema.js";

describe("reminder timing config", () => {
  test.each([
    ["reauthReminders", "initialDelay"],
    ["reauthReminders", "maxDelay"],
    ["reauthReminders", "reservationTtl"],
    ["mobilePermissionReminders", "initialDelay"],
    ["mobilePermissionReminders", "maxDelay"],
    ["mobilePermissionReminders", "reservationTtl"],
    ["mobilePermissionReminders", "scanInterval"],
  ] as const)("rejects zero gateway.%s.%s", (section, field) => {
    expect(
      omnesisConfigSchema.safeParse({ gateway: { [section]: { [field]: "0ms" } } }).success,
    ).toBe(false);
  });

  test("accepts positive sub-second reminder timings", () => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: {
          reauthReminders: { initialDelay: "1ms", maxDelay: "1ms", reservationTtl: "1ms" },
          mobilePermissionReminders: {
            initialDelay: "1ms",
            maxDelay: "1ms",
            reservationTtl: "1ms",
            scanInterval: "1ms",
            maxStaleNotifications: 1,
          },
        },
      }).success,
    ).toBe(true);
  });

  test.each([0, -1, 1.5])("rejects maxStaleNotifications=%s", (value) => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: { mobilePermissionReminders: { maxStaleNotifications: value } },
      }).success,
    ).toBe(false);
  });
});
