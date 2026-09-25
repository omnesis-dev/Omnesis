// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The off-peak window's arithmetic. Local wall-clock, so every case here is
 * built from a Date constructed in the host's own zone rather than a UTC
 * literal — the window means what the operator's clock says, which is the
 * whole point of expressing it as HH:MM.
 */

import { describe, expect, test } from "vitest";

import { bootstrapWindowOpen, bootstrapWindowOpensAt } from "./bootstrap-window.js";

/** An instant today at a local wall-clock time. */
function at(hh: number, mm = 0): number {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

describe("no window", () => {
  test("means always open, not a window with wide bounds", () => {
    expect(bootstrapWindowOpen(undefined, at(3))).toBe(true);
    expect(bootstrapWindowOpen(undefined, at(15))).toBe(true);
    expect(bootstrapWindowOpensAt(undefined, at(15))).toBeNull();
  });
});

describe("a window inside one day", () => {
  const w = { from: "01:00", to: "07:00" };

  test("opens at its start and closes at its end", () => {
    expect(bootstrapWindowOpen(w, at(0, 59))).toBe(false);
    expect(bootstrapWindowOpen(w, at(1, 0))).toBe(true);
    expect(bootstrapWindowOpen(w, at(6, 59))).toBe(true);
    // Half-open at the top, so a window and its neighbour never both claim
    // the same minute.
    expect(bootstrapWindowOpen(w, at(7, 0))).toBe(false);
  });

  test("reports when it next opens", () => {
    expect(bootstrapWindowOpensAt(w, at(0, 30))).toBe(at(1));
    // Past today's opening, the answer is tomorrow's — never a time already
    // gone, which would render as a window that opened in the past.
    expect(bootstrapWindowOpensAt(w, at(9))).toBe(at(1) + 86_400_000);
  });
});

describe("a window that wraps midnight", () => {
  const w = { from: "22:00", to: "06:00" };

  test("is open on both sides of midnight and shut in between", () => {
    // The case an operator most likely wants, and the one a naive
    // start <= now < end comparison gets exactly backwards.
    expect(bootstrapWindowOpen(w, at(23))).toBe(true);
    expect(bootstrapWindowOpen(w, at(2))).toBe(true);
    expect(bootstrapWindowOpen(w, at(12))).toBe(false);
    expect(bootstrapWindowOpen(w, at(21, 59))).toBe(false);
    expect(bootstrapWindowOpen(w, at(6, 0))).toBe(false);
  });
});

describe("a malformed window", () => {
  test("leaves the lane open rather than stopping it forever", () => {
    // The schema rejects these at the boundary; this is the belt to that
    // braces. A typo must not silently halt the backfill with nothing but a
    // validation error nobody re-reads.
    expect(bootstrapWindowOpen({ from: "25:00", to: "07:00" }, at(3))).toBe(true);
    expect(bootstrapWindowOpen({ from: "1am", to: "7am" }, at(3))).toBe(true);
    expect(bootstrapWindowOpensAt({ from: "nonsense", to: "07:00" }, at(3))).toBeNull();
  });
});
