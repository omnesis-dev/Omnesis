// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { resolveDateEnrichmentSettings, resolveNumericDateOrder } from "./config.js";

describe("resolveNumericDateOrder", () => {
  it("honours an explicit order wherever the gateway runs", () => {
    expect(resolveNumericDateOrder("day-first", "America/Chicago")).toBe("day-first");
    expect(resolveNumericDateOrder("month-first", "Europe/Paris")).toBe("month-first");
  });

  it.each([
    ["America/New_York", "month-first"],
    ["America/Indiana/Indianapolis", "month-first"],
    ["US/Pacific", "month-first"],
    ["Pacific/Honolulu", "month-first"],
    ["Asia/Manila", "month-first"],
    ["America/Sao_Paulo", "day-first"],
    ["America/Bogota", "day-first"],
    ["America/Toronto", "day-first"],
    ["Europe/London", "day-first"],
    ["UTC", "day-first"],
  ] as const)("reads auto in %s as %s", (zone, order) => {
    expect(resolveNumericDateOrder("auto", zone)).toBe(order);
  });

  it("defaults the setting to auto", () => {
    expect(resolveDateEnrichmentSettings(undefined).numericDateOrder).toBe("auto");
    expect(
      resolveDateEnrichmentSettings({ dates: { numericDateOrder: "month-first" } })
        .numericDateOrder,
    ).toBe("month-first");
  });
});
