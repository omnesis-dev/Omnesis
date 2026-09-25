// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  canonicalizeInterval,
  intervalOverlapsWindow,
  isCalendarDay,
  toCanonicalInstant,
  toCanonicalWallClock,
  MAX_TIME_ZONE_SHIFT_MS,
} from "./temporal-interval.js";

const DAY_MS = 86_400_000;

describe("isCalendarDay", () => {
  it("recognizes a bare calendar day and nothing else", () => {
    expect(isCalendarDay("2026-03-04")).toBe(true);
    expect(isCalendarDay("2026-03-04T08:00:00.000Z")).toBe(false);
    expect(isCalendarDay(new Date("2026-03-04T00:00:00.000Z"))).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
    expect(isCalendarDay(20260304)).toBe(false);
  });
});

describe("canonicalizeInterval — precision inference", () => {
  it("infers day precision from a bare calendar day", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04" });
    expect(interval.precision).toBe("day");
    expect(interval.allDay).toBe(true);
    expect(interval.startCanonical).toBe("2026-03-04");
  });

  it("infers instant precision from an offset-bearing value", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04T08:00:00Z" });
    expect(interval.precision).toBe("instant");
    expect(interval.allDay).toBe(false);
    expect(interval.startCanonical).toBe("2026-03-04T08:00:00.000Z");
  });

  it("lets an explicit allDay flag override the value's shape", () => {
    const interval = canonicalizeInterval({
      start: "2026-03-04T08:00:00Z",
      end: "2026-03-06T09:00:00Z",
      allDay: true,
    });
    expect(interval.precision).toBe("day");
    expect(interval.startCanonical).toBe("2026-03-04");
    expect(interval.endCanonical).toBe("2026-03-06");
  });

  it("keeps an all-day flag over same-day timestamps a whole day wide", () => {
    const interval = canonicalizeInterval({
      start: "2026-03-04T00:00:00Z",
      end: "2026-03-04T23:59:59Z",
      allDay: true,
    });
    expect(interval.startCanonical).toBe("2026-03-04");
    expect(interval.endCanonical).toBe("2026-03-05");
    expect(interval.endExclusiveMs - interval.startMs).toBe(DAY_MS);
  });

  it("treats a calendar-day start as an instant when allDay is explicitly false", () => {
    expect(() => canonicalizeInterval({ start: "2026-03-04", allDay: false })).toThrow(
      /ISO instant/,
    );
  });
});

describe("canonicalizeInterval — instants", () => {
  it("accepts a Date object, canonicalized as UTC", () => {
    const interval = canonicalizeInterval({ start: new Date(Date.UTC(2026, 2, 4, 8, 30)) });
    expect(interval.startCanonical).toBe("2026-03-04T08:30:00.000Z");
    expect(interval.startMs).toBe(Date.UTC(2026, 2, 4, 8, 30));
  });

  it("resolves a positive and a negative UTC offset to the same instant", () => {
    const ahead = canonicalizeInterval({ start: "2026-03-04T13:30:00+05:30" });
    const behind = canonicalizeInterval({ start: "2026-03-04T00:00:00-08:00" });
    expect(ahead.startCanonical).toBe("2026-03-04T08:00:00.000Z");
    expect(behind.startCanonical).toBe("2026-03-04T08:00:00.000Z");
    expect(ahead.startMs).toBe(behind.startMs);
  });

  it("accepts a minute-resolution instant and a fractional one", () => {
    expect(canonicalizeInterval({ start: "2026-03-04T08:00Z" }).startCanonical).toBe(
      "2026-03-04T08:00:00.000Z",
    );
    expect(canonicalizeInterval({ start: "2026-03-04T08:00:00.25Z" }).startCanonical).toBe(
      "2026-03-04T08:00:00.250Z",
    );
  });

  it("truncates sub-millisecond precision rather than rounding past the declared instant", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04T08:00:00.999999Z" });
    expect(interval.startCanonical).toBe("2026-03-04T08:00:00.999Z");
  });

  it("canonicalizes a pre-1970 instant to its negative epoch offset", () => {
    const interval = canonicalizeInterval({
      start: "1962-11-08T06:15:00Z",
      end: "1962-11-08T07:15:00Z",
    });
    expect(interval.startMs).toBe(Date.UTC(1962, 10, 8, 6, 15));
    expect(interval.startMs).toBeLessThan(0);
    expect(interval.startCanonical).toBe("1962-11-08T06:15:00.000Z");
    expect(interval.endExclusiveMs - interval.startMs).toBe(3_600_000);
  });

  it("canonicalizes a pre-1970 instant declared with an offset", () => {
    const interval = canonicalizeInterval({ start: "1962-11-08T01:15:00-05:00" });
    expect(interval.startCanonical).toBe("1962-11-08T06:15:00.000Z");
  });

  it("stores an endless fact as the empty interval at its start", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04T08:00:00Z" });
    expect(interval.endExclusiveMs).toBe(interval.startMs);
    expect(interval.endCanonical).toBe(interval.startCanonical);
  });

  it("keeps a real duration honest", () => {
    const interval = canonicalizeInterval({
      start: "2026-03-04T08:00:00Z",
      end: "2026-03-04T09:30:00Z",
    });
    expect(interval.endExclusiveMs - interval.startMs).toBe(90 * 60_000);
  });

  it("treats a null end the same as an absent one", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04T08:00:00Z", end: null });
    expect(interval.endExclusiveMs).toBe(interval.startMs);
  });

  it("rejects an end that precedes its start", () => {
    expect(() =>
      canonicalizeInterval({
        start: "2026-03-04T09:00:00Z",
        end: "2026-03-04T08:00:00Z",
      }),
    ).toThrow(/end must not precede start/);
  });

  it("prefixes errors with the caller's context", () => {
    expect(() =>
      canonicalizeInterval({ start: "not a date", context: "calendar_events key-1" }),
    ).toThrow(/calendar_events key-1: start/);
  });
});

describe("canonicalizeInterval — instant shape validation", () => {
  it("rejects an impossible calendar date instead of rolling it into the next month", () => {
    expect(() => canonicalizeInterval({ start: "2026-02-30T08:00:00Z" })).toThrow(
      /not a valid instant/,
    );
  });

  it("rejects out-of-range time and offset components", () => {
    for (const value of [
      "2026-03-04T24:00:00Z",
      "2026-03-04T08:60:00Z",
      "2026-03-04T08:00:60Z",
      "2026-03-04T13:00:00+24:00",
      "2026-03-04T13:00:00+05:60",
    ]) {
      expect(() => canonicalizeInterval({ start: value })).toThrow(/instant/);
    }
  });

  it("accepts a leap day in a leap year and rejects it in a common one", () => {
    expect(canonicalizeInterval({ start: "2024-02-29T08:00:00Z" }).startCanonical).toBe(
      "2024-02-29T08:00:00.000Z",
    );
    expect(() => canonicalizeInterval({ start: "2026-02-29T08:00:00Z" })).toThrow(
      /not a valid instant/,
    );
  });

  it("rejects a wall-clock value carrying no zone designator", () => {
    expect(() => canonicalizeInterval({ start: "2026-03-04T08:00:00" })).toThrow(
      /ISO instant with a UTC offset or Z/,
    );
  });

  it("rejects loose forms an implementation-defined date parser would accept", () => {
    for (const value of [
      "2026-03-04 08:00:00",
      "March 4, 2026 08:00:00 UTC",
      "2026-03-04T08:00:00Z extra",
      "1772668800000",
      1_772_668_800_000,
      "",
      null,
      undefined,
    ]) {
      expect(() => canonicalizeInterval({ start: value })).toThrow();
    }
  });

  it("rejects an invalid end with the same rigour as an invalid start", () => {
    expect(() =>
      canonicalizeInterval({ start: "2026-03-04T08:00:00Z", end: "2026-04-31T08:00:00Z" }),
    ).toThrow(/end is not a valid instant/);
  });
});

describe("canonicalizeInterval — days", () => {
  it("gives a day with no declared end its full 24 hours", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04" });
    expect(interval.startCanonical).toBe("2026-03-04");
    expect(interval.endCanonical).toBe("2026-03-05");
    expect(interval.endExclusiveMs - interval.startMs).toBe(DAY_MS);
  });

  it("reads a declared end day as exclusive", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04", end: "2026-03-07" });
    expect(interval.endCanonical).toBe("2026-03-07");
    expect(interval.endExclusiveMs - interval.startMs).toBe(3 * DAY_MS);
  });

  it("widens an end equal to its start into the one day the fact names", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04", end: "2026-03-04" });
    expect(interval.endCanonical).toBe("2026-03-05");
    expect(interval.endExclusiveMs).toBeGreaterThan(interval.startMs);
    expect(interval.endExclusiveMs - interval.startMs).toBe(DAY_MS);
  });

  it("never produces a day-precision interval a reader would see as a point", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04", end: "2026-03-04" });
    // 18:00 on the named day: inside the span, hours away from its opening midnight.
    const afternoon = Date.parse("2026-03-04T18:00:00.000Z");
    expect(
      intervalOverlapsWindow(interval, {
        fromMs: afternoon,
        toExclusiveMs: afternoon + 3_600_000,
      }),
    ).toBe(true);
  });

  it("spans a month boundary and a leap day", () => {
    const interval = canonicalizeInterval({ start: "2024-02-28", end: "2024-03-01" });
    expect(interval.endExclusiveMs - interval.startMs).toBe(2 * DAY_MS);
  });

  it("canonicalizes a pre-1970 day", () => {
    const interval = canonicalizeInterval({ start: "1962-11-08" });
    expect(interval.startMs).toBe(Date.UTC(1962, 10, 8));
    expect(interval.endCanonical).toBe("1962-11-09");
  });

  it("rejects an end day that precedes its start", () => {
    expect(() => canonicalizeInterval({ start: "2026-03-04", end: "2026-03-03" })).toThrow(
      /end must not precede start/,
    );
  });

  it("rejects an impossible calendar day", () => {
    expect(() => canonicalizeInterval({ start: "2026-02-30" })).toThrow(/not a valid date/);
    expect(() => canonicalizeInterval({ start: "2026-03-04", end: "2026-02-30" })).toThrow(
      /end is not a valid date/,
    );
  });

  it("rejects a value carrying no ISO date at all", () => {
    expect(() => canonicalizeInterval({ start: "sometime in March", allDay: true })).toThrow(
      /must contain an ISO date/,
    );
  });
});

describe("intervalOverlapsWindow", () => {
  const window = {
    fromMs: Date.parse("2026-03-04T00:00:00.000Z"),
    toExclusiveMs: Date.parse("2026-03-05T00:00:00.000Z"),
  };
  const point = (iso: string) => {
    const ms = Date.parse(iso);
    return { startMs: ms, endExclusiveMs: ms };
  };

  it("matches an empty interval sitting exactly on the window's start", () => {
    expect(intervalOverlapsWindow(point("2026-03-04T00:00:00.000Z"), window)).toBe(true);
  });

  it("excludes an empty interval sitting on the window's exclusive end", () => {
    expect(intervalOverlapsWindow(point("2026-03-05T00:00:00.000Z"), window)).toBe(false);
  });

  it("excludes an empty interval one millisecond before the window", () => {
    expect(intervalOverlapsWindow(point("2026-03-03T23:59:59.999Z"), window)).toBe(false);
  });

  it("matches a non-empty interval that ends one millisecond into the window", () => {
    expect(
      intervalOverlapsWindow(
        {
          startMs: Date.parse("2026-03-03T12:00:00.000Z"),
          endExclusiveMs: window.fromMs + 1,
        },
        window,
      ),
    ).toBe(true);
  });

  it("excludes a non-empty interval whose exclusive end is the window's start", () => {
    expect(
      intervalOverlapsWindow(
        {
          startMs: Date.parse("2026-03-03T12:00:00.000Z"),
          endExclusiveMs: window.fromMs,
        },
        window,
      ),
    ).toBe(false);
  });

  it("matches a non-empty interval starting on the window's last millisecond", () => {
    expect(
      intervalOverlapsWindow(
        {
          startMs: window.toExclusiveMs - 1,
          endExclusiveMs: window.toExclusiveMs + DAY_MS,
        },
        window,
      ),
    ).toBe(true);
  });

  it("excludes a non-empty interval starting on the window's exclusive end", () => {
    expect(
      intervalOverlapsWindow(
        {
          startMs: window.toExclusiveMs,
          endExclusiveMs: window.toExclusiveMs + DAY_MS,
        },
        window,
      ),
    ).toBe(false);
  });

  it("matches an interval that strictly contains the window", () => {
    expect(
      intervalOverlapsWindow(
        {
          startMs: window.fromMs - DAY_MS,
          endExclusiveMs: window.toExclusiveMs + DAY_MS,
        },
        window,
      ),
    ).toBe(true);
  });

  it("matches every hour of a canonicalized calendar day", () => {
    const interval = canonicalizeInterval({ start: "2026-03-04" });
    for (let hour = 0; hour < 24; hour += 1) {
      const fromMs = interval.startMs + hour * 3_600_000;
      expect(intervalOverlapsWindow(interval, { fromMs, toExclusiveMs: fromMs + 1 })).toBe(true);
    }
    expect(
      intervalOverlapsWindow(interval, {
        fromMs: interval.endExclusiveMs,
        toExclusiveMs: interval.endExclusiveMs + 1,
      }),
    ).toBe(false);
  });
});

describe("MAX_TIME_ZONE_SHIFT_MS", () => {
  it("covers the widest real UTC offset in either direction", () => {
    // Real zones span -12:00 to +14:00; the widening must clear both.
    expect(MAX_TIME_ZONE_SHIFT_MS).toBeGreaterThanOrEqual(14 * 3_600_000);
    expect(MAX_TIME_ZONE_SHIFT_MS).toBe(DAY_MS);
  });
});

describe("toCanonicalInstant", () => {
  it("collapses the spellings one instant is rendered in", () => {
    // Written as UTC, read back from the store in the reader's offset. Same
    // clock reading, two strings.
    const written = toCanonicalInstant("2026-07-31T14:09:00Z");
    const readBack = toCanonicalInstant("2026-07-31 15:09:00+01");
    expect(written).toBe("2026-07-31T14:09:00.000Z");
    expect(readBack).toBe(written);
    // And the offset forms a store may pick between.
    expect(toCanonicalInstant("2026-07-31 15:09:00+0100")).toBe(written);
    expect(toCanonicalInstant("2026-07-31T15:09:00+01:00")).toBe(written);
  });

  it("gets the sign and the minutes of an offset right, not just its shape", () => {
    // Every offset above is `+01`-shaped, and a reshaping that is subtly wrong
    // about sign or minutes would still collapse those to one string. These
    // are the arithmetic, in the three spellings a store can hand back.
    const noon = "2026-07-31T14:09:00.000Z";
    expect(toCanonicalInstant("2026-07-31 09:09:00-05")).toBe(noon);
    expect(toCanonicalInstant("2026-07-31 09:09:00-0500")).toBe(noon);
    expect(toCanonicalInstant("2026-07-31 09:09:00-05:00")).toBe(noon);
    // Half-hour zones exist, and a reshaping that drops the minutes is a
    // thirty-minute error that reads as no error at all.
    expect(toCanonicalInstant("2026-07-31 19:39:00+0530")).toBe(noon);
    expect(toCanonicalInstant("2026-07-31 10:39:00-0330")).toBe(noon);

    // And the direction of each: a mirrored offset must not land on the same
    // string, or a real ten-hour change would be invisible.
    expect(toCanonicalInstant("2026-07-31 09:09:00-05:00")).not.toBe(
      toCanonicalInstant("2026-07-31 09:09:00+05:00"),
    );
    expect(toCanonicalInstant("2026-07-31 19:39:00+0530")).not.toBe(
      toCanonicalInstant("2026-07-31 19:39:00+0500"),
    );
  });

  it("carries fractional seconds through, at millisecond resolution", () => {
    expect(toCanonicalInstant("2026-07-31 15:09:00.123456+01")).toBe("2026-07-31T14:09:00.123Z");
    expect(toCanonicalInstant("2026-07-31T14:09:00.500Z")).not.toBe(
      toCanonicalInstant("2026-07-31T14:09:00.000Z"),
    );
  });

  it("keeps a genuinely different instant different", () => {
    // The guard that matters: collapsing spellings must not collapse clocks.
    expect(toCanonicalInstant("2026-07-31 15:09:00+01")).not.toBe(
      toCanonicalInstant("2026-07-31 15:09:00+02"),
    );
    expect(toCanonicalInstant("2026-07-31T14:09:00Z")).not.toBe(
      toCanonicalInstant("2026-07-31T14:09:01Z"),
    );
  });

  it("refuses a value with no zone, rather than guessing one", () => {
    // A wall clock names a different instant in every zone; picking the
    // gateway's would anchor the fact to wherever the process happens to run.
    expect(toCanonicalInstant("2026-07-31 14:09:00")).toBeNull();
    expect(toCanonicalInstant("2026-07-31")).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    // Callers normalize a stream from sources they do not control; one bad
    // value must cost that value, not the batch. An invalid Date is the case
    // that matters: rendering one throws, so a caller doing `new Date(field)`
    // on a malformed field would lose the whole record rather than the field.
    expect(toCanonicalInstant(new Date("garbage"))).toBeNull();
    expect(toCanonicalWallClock(new Date(Number.NaN))).toBeNull();
    // And no coercion: a one-element array is not the string inside it.
    expect(toCanonicalInstant(["2026-07-31T14:09:00Z"])).toBeNull();
    expect(toCanonicalInstant("not a time")).toBeNull();
    expect(toCanonicalInstant(undefined)).toBeNull();
    expect(toCanonicalInstant("2026-02-30T08:00:00Z")).toBeNull();
    expect(toCanonicalInstant("2026-07-31T14:09:00+99:00")).toBeNull();
  });

  it("accepts a Date and agrees with the string spelling of it", () => {
    expect(toCanonicalInstant(new Date("2026-07-31T14:09:00Z"))).toBe(
      toCanonicalInstant("2026-07-31 15:09:00+01"),
    );
  });
});

describe("toCanonicalWallClock", () => {
  it("collapses the spellings one wall-clock reading is rendered in", () => {
    // A local stamp rendered once with a spurious `Z` and once bare. The
    // digits are the reading; both must land on one string.
    const withZ = toCanonicalWallClock("2026-07-31T14:09:00Z");
    const bare = toCanonicalWallClock("2026-07-31 14:09:00");
    expect(withZ).toBe("2026-07-31T14:09:00.000");
    expect(bare).toBe(withZ);
  });

  it("drops the designator without moving the digits", () => {
    // The failure this rules out: honouring a designator on a zoneless column
    // shifts a wall-clock reading to a different wall clock.
    expect(toCanonicalWallClock("2026-07-31 14:09:00+01")).toBe("2026-07-31T14:09:00.000");
    expect(toCanonicalWallClock("2026-07-31 14:09:00-05:00")).toBe("2026-07-31T14:09:00.000");
  });

  it("normalizes fractional seconds to one width", () => {
    // Otherwise one reading has two canonical spellings and the module
    // reintroduces the churn it exists to remove.
    expect(toCanonicalWallClock("2026-07-31 14:09:00.5")).toBe("2026-07-31T14:09:00.500");
    expect(toCanonicalWallClock("2026-07-31 14:09:00.5")).toBe(
      toCanonicalWallClock("2026-07-31 14:09:00.500"),
    );
    // Seconds are optional in the renderings a store emits.
    expect(toCanonicalWallClock("2026-07-31 14:09")).toBe("2026-07-31T14:09:00.000");
  });

  it("keeps a different reading different, and refuses junk", () => {
    expect(toCanonicalWallClock("2026-07-31 14:09:00")).not.toBe(
      toCanonicalWallClock("2026-07-31 14:10:00"),
    );
    expect(toCanonicalWallClock("2026-02-30 08:00:00")).toBeNull();
    expect(toCanonicalWallClock("not a time")).toBeNull();
    expect(toCanonicalWallClock(null)).toBeNull();
  });
});
