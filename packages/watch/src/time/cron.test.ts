// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { nextCronOccurrence, parseCron } from "./cron.js";

/** 2026-08-03T00:00Z — a Monday. */
const MONDAY = Date.UTC(2026, 7, 3);

function next(expression: string, from = MONDAY, offsetMinutes = 0): string | null {
  const cron = parseCron(expression);
  expect(cron).not.toBeNull();
  const instant = nextCronOccurrence(cron!, from, offsetMinutes);
  return instant === null ? null : new Date(instant).toISOString();
}

describe("parseCron", () => {
  it.each([
    "0 9 * * *",
    "0 18 * * *",
    "0 20 * * SUN",
    "*/15 * * * *",
    "0 9 1-5 * MON-FRI",
    "30 8,12,18 * * *",
  ])("accepts %s", (expression) => {
    expect(parseCron(expression)).not.toBeNull();
  });

  it.each([
    ["0 9 * *", "four fields"],
    ["0 9 * * * *", "six fields"],
    ["60 9 * * *", "minute out of range"],
    ["0 24 * * *", "hour out of range"],
    ["0 9 * * FUNDAY", "unknown day name"],
    ["0 9 * * 5-1", "inverted range"],
    ["0 9 * * */0", "zero step"],
    ["@daily", "macros are not supported"],
  ])("rejects '%s' (%s)", (expression) => {
    expect(parseCron(expression)).toBeNull();
  });

  it("treats 7 as Sunday", () => {
    expect(next("0 20 * * 7")).toBe("2026-08-09T20:00:00.000Z");
    expect(next("0 20 * * SUN")).toBe("2026-08-09T20:00:00.000Z");
  });
});

describe("nextCronOccurrence", () => {
  it("finds the next daily boundary strictly after the given instant", () => {
    expect(next("0 9 * * *")).toBe("2026-08-03T09:00:00.000Z");
    expect(next("0 9 * * *", Date.UTC(2026, 7, 3, 9, 0, 0))).toBe("2026-08-04T09:00:00.000Z");
  });

  it("honours the evaluation timezone", () => {
    // 09:00 local at UTC+2 is 07:00Z.
    expect(next("0 9 * * *", MONDAY, 120)).toBe("2026-08-03T07:00:00.000Z");
  });

  it("walks a weekly schedule", () => {
    const sunday = next("0 20 * * SUN")!;
    expect(sunday).toBe("2026-08-09T20:00:00.000Z");
    expect(next("0 20 * * SUN", Date.parse(sunday))).toBe("2026-08-16T20:00:00.000Z");
  });

  it("ORs the two day fields when both are restricted, as cron always has", () => {
    // The 1st of the month OR any Friday.
    expect(next("0 9 1 * FRI")).toBe("2026-08-07T09:00:00.000Z");
    expect(next("0 9 1 * FRI", Date.UTC(2026, 7, 8))).toBe("2026-08-14T09:00:00.000Z");
  });

  it("treats a stepped day field as unrestricted, so the OR rule stays off", () => {
    // `*/1` spans the whole range; only a genuinely narrowed day field opts
    // into cron's day-of-month OR day-of-week rule.
    expect(next("0 9 */1 * MON")).toBe("2026-08-03T09:00:00.000Z");
    expect(next("0 9 */1 * MON", Date.UTC(2026, 7, 3, 9))).toBe("2026-08-10T09:00:00.000Z");
  });

  it("finds a February 29th across a century non-leap year", () => {
    // 2100 is not a leap year, so the gap from 2096 runs to 2104.
    expect(next("0 0 29 2 *", Date.UTC(2096, 2, 1))).toBe("2104-02-29T00:00:00.000Z");
  });

  it("returns null for a schedule that can never fire", () => {
    expect(next("0 0 30 2 *")).toBeNull();
  });

  it("advances by the step on a stepped schedule", () => {
    expect(next("*/15 * * * *")).toBe("2026-08-03T00:15:00.000Z");
  });
});
