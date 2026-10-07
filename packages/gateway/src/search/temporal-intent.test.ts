// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseTemporalIntent, type TemporalIntentOptions } from "./temporal-intent.js";

// Wednesday 7 October 2026, evening in London.
const NOW = Date.parse("2026-10-07T19:00:00Z");
const LONDON: TemporalIntentOptions = {
  nowMs: NOW,
  timeZone: "Europe/London",
  numericDateOrder: "day-first",
};

function read(text: string, opts: TemporalIntentOptions = LONDON) {
  const intent = parseTemporalIntent(text, opts);
  return intent
    ? {
        windows: intent.windows.map((w) => [w.startDay, w.endDay]),
        stripped: intent.strippedText,
        culture: intent.culture,
      }
    : null;
}

describe("parseTemporalIntent", () => {
  it("reads relative calendar phrases against now, in the asker's zone", () => {
    expect(read("bakery order today")).toEqual({
      windows: [["2026-10-07", "2026-10-08"]],
      stripped: "bakery order",
      culture: "en-*",
    });
    expect(read("what is on tomorrow")?.windows).toEqual([["2026-10-08", "2026-10-09"]]);
    expect(read("emails from Maya last week")?.windows).toEqual([["2026-09-28", "2026-10-05"]]);
    expect(read("team call this week")?.windows).toEqual([["2026-10-05", "2026-10-12"]]);
    expect(read("dentist next month")?.windows).toEqual([["2026-11-01", "2026-12-01"]]);
    expect(read("the last 2 days")?.windows).toEqual([["2026-10-05", "2026-10-08"]]);
  });

  it("turns the window into instants at the zone's midnights", () => {
    const intent = parseTemporalIntent("receipts today", LONDON)!;
    // London is on BST (UTC+1) in October.
    expect(new Date(intent.windows[0]!.startMs).toISOString()).toBe("2026-10-06T23:00:00.000Z");
    expect(new Date(intent.windows[0]!.endExclusiveMs).toISOString()).toBe(
      "2026-10-07T23:00:00.000Z",
    );
    const tokyo = parseTemporalIntent("receipts today", { ...LONDON, timeZone: "Asia/Tokyo" })!;
    // At that instant it is already Thursday 8 October in Tokyo.
    expect(tokyo.windows[0]!.startDay).toBe("2026-10-08");
  });

  it("reads explicit dates, months, quarters and years", () => {
    expect(read("pottery class 20 September 2026")?.windows).toEqual([
      ["2026-09-20", "2026-09-21"],
    ]);
    expect(read("parking permit February 2026")?.windows).toEqual([["2026-02-01", "2026-03-01"]]);
    expect(read("Q3 2025 report")?.windows).toEqual([["2025-07-01", "2025-10-01"]]);
    expect(read("Oslo conference 2018")).toEqual({
      windows: [["2018-01-01", "2019-01-01"]],
      stripped: "Oslo conference",
      culture: "en-*",
    });
    expect(read("garden photos 2016 2017")?.windows).toEqual([
      ["2016-01-01", "2017-01-01"],
      ["2017-01-01", "2018-01-01"],
    ]);
  });

  it("chooses the nearer reading of a year-less date, charging the future double", () => {
    // 10 October is three days ahead; last year's is a year back.
    expect(read("Saturday 10 October")?.windows).toEqual([["2026-10-10", "2026-10-11"]]);
    // 15 July: 84 days back beats 281 days ahead.
    expect(read("plumber visit 15 July")?.windows).toEqual([["2026-07-15", "2026-07-16"]]);
    // A month without a year keeps both occurrences: the lane ranks within each.
    expect(read("invoice from March")?.windows).toEqual([
      ["2026-03-01", "2026-04-01"],
      ["2027-03-01", "2027-04-01"],
    ]);
    // A weekday a few days either side is both "Monday"s.
    expect(read("team meeting Monday")?.windows).toEqual([
      ["2026-10-05", "2026-10-06"],
      ["2026-10-12", "2026-10-13"],
    ]);
  });

  it("follows the direction the query's words name", () => {
    expect(read("next March conference")?.windows).toEqual([["2027-03-01", "2027-04-01"]]);
    expect(read("upcoming trip in July")?.windows).toEqual([["2027-07-01", "2027-08-01"]]);
    expect(read("what did we pay in November")?.windows).toEqual([["2025-11-01", "2025-12-01"]]);
  });

  it("reads seasons, with or without a year", () => {
    expect(read("summer 2025 holiday")?.windows).toEqual([["2025-06-01", "2025-09-01"]]);
    // The most recent summer that has ended.
    expect(read("photos from last summer")?.windows).toEqual([["2026-06-01", "2026-09-01"]]);
    expect(read("summer photos")?.windows).toEqual([["2026-06-01", "2026-09-01"]]);
  });

  it("reads open spans only up to now", () => {
    expect(read("since March 2026")?.windows).toEqual([["2026-03-01", "2026-10-08"]]);
    expect(read("before 10 June")).toBeNull();
  });

  it("drops what names no window", () => {
    expect(read("recent invoices")).toBeNull();
    expect(read("renew in 2 weeks")).toBeNull();
    expect(read("order 20481")).toBeNull();
    expect(read("invoice 3021")).toBeNull();
    expect(read("")).toBeNull();
  });

  it("needs context for month names that are ordinary words", () => {
    expect(read("may I see the invoice")).toBeNull();
    expect(read("march protest photos")).toBeNull();
    expect(read("second hand bike")).toBeNull();
    expect(read("tickets in May")?.windows).toEqual([
      ["2026-05-01", "2026-06-01"],
      ["2027-05-01", "2027-06-01"],
    ]);
  });

  it("runs French or Spanish only on their own date words", () => {
    expect(read("devis Northstar mars 2026 PDF")).toEqual({
      windows: [["2026-03-01", "2026-04-01"]],
      stripped: "devis Northstar PDF",
      culture: "fr-fr",
    });
    expect(read("atelier 15 juillet")?.windows).toEqual([["2026-07-15", "2026-07-16"]]);
    expect(read("la semaine dernière")?.windows).toEqual([["2026-09-28", "2026-10-05"]]);
    // "Sam" is samedi in French and "ago" agosto in Spanish; neither runs here.
    expect(read("lunch with Sam")).toBeNull();
    expect(read("a few days ago")?.culture).toBe("en-*");
  });

  it("reads every ISO day, including adjacent ones the recognizer merges", () => {
    expect(read("calendar event 2026-07-08 2026-07-29")).toEqual({
      windows: [
        ["2026-07-08", "2026-07-09"],
        ["2026-07-29", "2026-07-30"],
      ],
      stripped: "calendar event",
      culture: "en-*",
    });
  });

  it("reads a quoted date, but not a date inside a quoted phrase", () => {
    expect(read('"22 May 2026" concert')?.windows).toEqual([["2026-05-22", "2026-05-23"]]);
    expect(read('"Northstar quarterly notes 15 July 2026" Brightmoor')).toBeNull();
    expect(read('"summary for March 2025" and receipts in May 2025')?.windows).toEqual([
      ["2025-05-01", "2025-06-01"],
    ]);
  });

  it("keeps week numbers as labels", () => {
    expect(read("week 3 notes")).toBeNull();
  });

  it("strips the phrase and the preposition introducing it", () => {
    expect(read("receipts from last week for the studio")?.stripped).toBe(
      "receipts for the studio",
    );
    expect(read("tickets in May")?.stripped).toBe("tickets");
  });

  it("reads numeric dates in the configured order", () => {
    expect(read("booking 10/07/2026")?.windows).toEqual([["2026-07-10", "2026-07-11"]]);
    expect(
      read("booking 10/07/2026", { ...LONDON, numericDateOrder: "month-first" })?.windows,
    ).toEqual([["2026-10-07", "2026-10-08"]]);
  });
});
