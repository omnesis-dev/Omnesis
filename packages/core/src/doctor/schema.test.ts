// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { doctorReportSchema, MAX_DOCTOR_CHECKS } from "./schema.js";

describe("doctorReportSchema", () => {
  test("accepts a self-consistent report including N/A checks", () => {
    const report = {
      ok: true,
      summary: { errors: 0, warnings: 0 },
      checks: [
        {
          id: "storage.db",
          section: "Storage",
          status: "not-applicable" as const,
          message: "Gateway database size is evaluated only on the gateway host",
        },
      ],
    };

    expect(doctorReportSchema.safeParse(report).success).toBe(true);
  });

  test("rejects unknown fields and inconsistent summaries", () => {
    const check = {
      id: "auth.token",
      section: "Auth & device",
      status: "fail",
      message: "Token rejected",
    };
    expect(
      doctorReportSchema.safeParse({
        ok: true,
        summary: { errors: 0, warnings: 0 },
        checks: [check],
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ok: false,
        summary: { errors: 1, warnings: 0 },
        checks: [{ ...check, unexpected: true }],
      }).success,
    ).toBe(false);
  });

  test("bounds check count and externally supplied text", () => {
    const pass = {
      id: "fixture.pass",
      section: "Fixture",
      status: "pass" as const,
      message: "Healthy",
    };
    expect(
      doctorReportSchema.safeParse({
        ok: true,
        summary: { errors: 0, warnings: 0 },
        checks: Array.from({ length: MAX_DOCTOR_CHECKS + 1 }, () => pass),
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ok: true,
        summary: { errors: 0, warnings: 0 },
        checks: [{ ...pass, message: "x".repeat(1_025) }],
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ok: true,
        summary: { errors: 0, warnings: 0 },
        checks: [{ ...pass, message: "Healthy\nforged terminal line" }],
      }).success,
    ).toBe(false);
    for (const unsafe of ["\u2028", "\u2029", "\u061c", "\u200e", "\u200f"]) {
      expect(
        doctorReportSchema.safeParse({
          ok: true,
          summary: { errors: 0, warnings: 0 },
          checks: [{ ...pass, message: `Healthy${unsafe}forged terminal line` }],
        }).success,
      ).toBe(false);
    }
  });
});
