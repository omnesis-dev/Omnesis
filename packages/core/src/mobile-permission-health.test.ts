// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { aggregateMobilePermissionState } from "@omnesis/types/mobile-permission-health";
import { mobilePermissionHealthReportSchema } from "./mobile-permission-health.js";

describe("mobile permission health contract", () => {
  test("accepts an empty healthy snapshot and rejects duplicate capabilities", () => {
    expect(
      mobilePermissionHealthReportSchema.parse({
        checkedAt: 1,
        validForMs: 60_000,
        capabilities: [],
      }),
    ).toMatchObject({ capabilities: [] });
    const capability = {
      id: "camera",
      label: "Camera",
      state: "healthy",
      requirement: "optional",
      repairAction: "none",
    };
    expect(() =>
      mobilePermissionHealthReportSchema.parse({
        checkedAt: 1,
        validForMs: 60_000,
        capabilities: [capability, capability],
      }),
    ).toThrow();
  });

  test("requires source-owned impact and remediation for actionable loss", () => {
    expect(() =>
      mobilePermissionHealthReportSchema.parse({
        checkedAt: 1,
        validForMs: 60_000,
        capabilities: [
          {
            id: "background",
            label: "Background access",
            state: "background-access-missing",
            requirement: "required",
            repairAction: "open-system-settings",
          },
        ],
      }),
    ).toThrow();
  });

  test("an optional actionable loss outranks a required unknown capability", () => {
    expect(
      aggregateMobilePermissionState([
        {
          id: "required-check",
          label: "Required check",
          state: "unknown",
          requirement: "required",
          repairAction: "none",
        },
        {
          id: "optional-enrichment",
          label: "Optional enrichment",
          state: "unavailable",
          requirement: "optional",
          impact: "Enrichment stops.",
          remediation: "Restore access.",
          repairAction: "open-source-settings",
        },
      ]),
    ).toBe("unavailable");
  });
});
