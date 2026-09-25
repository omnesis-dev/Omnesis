// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it.each([
    ["3 days", { amount: 3, unit: "days" }],
    ["1 day", { amount: 1, unit: "days" }],
    ["90 minutes", { amount: 90, unit: "minutes" }],
    ["5 business_days", { amount: 5, unit: "business_days" }],
    ["1 business_day", { amount: 1, unit: "business_days" }],
    ["2 weeks", { amount: 2, unit: "weeks" }],
    ["1.5 hours", { amount: 1.5, unit: "hours" }],
  ])("parses %s", (text, expected) => {
    expect(parseDuration(text)).toEqual(expected);
  });

  it.each([
    ["3days", "no separator"],
    ["days", "no amount"],
    ["0 days", "zero is not a duration"],
    ["-2 days", "negative"],
    ["3 fortnights", "unknown unit"],
    ["1.5 business_days", "calendar units advance whole days"],
    ["", "empty"],
  ])("rejects '%s' (%s)", (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});
