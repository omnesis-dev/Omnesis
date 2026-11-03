// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { resolveTemporalRange } from "./temporal-range.js";

describe("resolveTemporalRange", () => {
  it("expands a local day to a half-open DST-aware range", () => {
    const range = resolveTemporalRange({
      from: "2026-03-29",
      timeZone: "Europe/London",
    });
    expect(new Date(range.fromMs).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(new Date(range.toExclusiveMs).toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(range.toExclusiveMs - range.fromMs).toBe(23 * 60 * 60 * 1000);
  });

  it("treats an explicit date `to` as an exclusive local boundary", () => {
    const range = resolveTemporalRange({
      from: "2026-07-23",
      to: "2026-07-24",
      timeZone: "Europe/London",
    });
    expect(new Date(range.fromMs).toISOString()).toBe("2026-07-22T23:00:00.000Z");
    expect(new Date(range.toExclusiveMs).toISOString()).toBe("2026-07-23T23:00:00.000Z");
  });

  it("performs relative day arithmetic in the supplied zone", () => {
    const range = resolveTemporalRange({
      from: "2026-03-28T12:00:00Z",
      to: "+1d",
      timeZone: "Europe/London",
    });
    expect(new Date(range.toExclusiveMs).toISOString()).toBe("2026-03-29T11:00:00.000Z");
    expect(range.toExclusiveMs - range.fromMs).toBe(23 * 60 * 60 * 1000);
  });

  it("starts a day whose local midnight was skipped at its first real instant", () => {
    // Chile springs forward at midnight, so 2026-09-06 has no 00:00 there:
    // 23:59:59 on the 5th is followed by 01:00 on the 6th. Asking for that
    // day is an ordinary request from anyone living there, so it resolves to
    // the day's first instant that exists rather than being refused.
    const range = resolveTemporalRange({
      from: "2026-09-06",
      to: "2026-09-07",
      timeZone: "America/Santiago",
    });
    expect(new Date(range.fromMs).toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // 04:00Z is 01:00 local — inside the 6th. Resolving the other way would
    // land on 23:00 on the 5th and sweep the previous evening into the day.
    expect(new Date(range.fromMs).getTime()).toBeGreaterThan(
      Date.parse("2026-09-06T03:59:59.999Z"),
    );
  });

  it("requires offsets on instants and validates zones", () => {
    expect(() =>
      resolveTemporalRange({
        from: "2026-07-23T12:00:00",
        timeZone: "Europe/London",
      }),
    ).toThrow(/Invalid from/);
    expect(() => resolveTemporalRange({ from: "2026-07-23", timeZone: "Mars/Olympus" })).toThrow(
      /Invalid IANA/,
    );
  });

  it("resolves each zone the same however many zones it has resolved before", () => {
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 150);
    const first = zones.map((timeZone) => resolveTemporalRange({ from: "2026-10-25", timeZone }));
    // A second pass reads formatters the first pass cached, or rebuilt after
    // the cache was cleared; an invalid zone in between is never cached.
    expect(() => resolveTemporalRange({ from: "2026-10-25", timeZone: "Mars/Olympus" })).toThrow(
      /Invalid IANA/,
    );
    expect(zones.map((timeZone) => resolveTemporalRange({ from: "2026-10-25", timeZone }))).toEqual(
      first,
    );
    expect(() => resolveTemporalRange({ from: "2026-10-25", timeZone: "Mars/Olympus" })).toThrow(
      /Invalid IANA/,
    );
    expect(resolveTemporalRange({ from: "2026-10-25", timeZone: "Europe/London" })).toEqual({
      fromMs: Date.parse("2026-10-24T23:00:00Z"),
      toExclusiveMs: Date.parse("2026-10-26T00:00:00Z"),
    });
  });
});
