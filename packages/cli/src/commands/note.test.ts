// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { formatNoteTime, noteLocalDay, notesDayPath } from "./note.js";

describe("note capture clock presentation", () => {
  test("uses the frozen capture offset across a midnight boundary", () => {
    const capturedAt = "2026-08-14T23:30:00.000Z";
    expect(formatNoteTime(capturedAt, 7_200, "en-GB")).toBe("01:30");
    expect(formatNoteTime(capturedAt, -18_000, "en-GB")).toBe("18:30");
  });

  test("falls back to the current process timezone for legacy entries", () => {
    const capturedAt = "2026-08-14T23:30:00.000Z";
    expect(formatNoteTime(capturedAt, null, "en-GB")).toBe(
      new Date(capturedAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });
});

describe("note list day routing", () => {
  const nearMidnight = new Date("2026-08-14T23:30:00.000Z");

  test("derives the CLI-local day rather than the remote gateway day", () => {
    expect(noteLocalDay(nearMidnight, 7_200)).toBe("2026-08-15");
    expect(noteLocalDay(nearMidnight, -18_000)).toBe("2026-08-14");
  });

  test("always sends an explicit local day when --day is omitted", () => {
    expect(notesDayPath(undefined, nearMidnight, 7_200)).toBe("/notes?day=2026-08-15");
  });

  test("preserves an explicit --day", () => {
    expect(notesDayPath("2026-07-02", nearMidnight, 7_200)).toBe("/notes?day=2026-07-02");
  });
});
