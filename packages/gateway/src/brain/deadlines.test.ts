// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { deadlineDueDay } from "./deadlines.js";

describe("deadlineDueDay", () => {
  test("reads the recommended shape's date — bare day or full ISO date-time", () => {
    expect(deadlineDueDay({ type: "by", date: "2026-06-20" })).toBe("2026-06-20");
    expect(deadlineDueDay({ type: "on_day", date: "2026-06-20" })).toBe("2026-06-20");
    // A full ISO date-time converts to the LOCAL day of that instant.
    const instant = new Date(2026, 5, 20, 15, 30, 0, 0);
    expect(deadlineDueDay({ type: "by", date: instant.toISOString() })).toBe("2026-06-20");
  });

  test("tolerates a bare-string deadline that parses as a date", () => {
    expect(deadlineDueDay("2026-06-20")).toBe("2026-06-20");
  });

  test("never invents a day: undated types, prose, and junk yield null", () => {
    expect(deadlineDueDay(null)).toBeNull();
    expect(deadlineDueDay(undefined)).toBeNull();
    expect(deadlineDueDay({ type: "any_time" })).toBeNull();
    expect(deadlineDueDay({ type: "approximate", note: "sometime in spring" })).toBeNull();
    expect(deadlineDueDay({ date: 20260620 })).toBeNull();
    expect(deadlineDueDay("whenever works")).toBeNull();
    expect(deadlineDueDay(42)).toBeNull();
    expect(deadlineDueDay([{ date: "2026-06-20" }])).toBeNull();
  });
});
