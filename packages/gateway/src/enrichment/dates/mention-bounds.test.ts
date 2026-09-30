// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { MENTION_MAX_SPAN_DAYS, mentionDays } from "./mention-bounds.js";
import type { ExtractedDate } from "@omnesis/types";

function date(overrides: Partial<ExtractedDate>): ExtractedDate {
  return {
    kind: "date",
    resolvedStart: null,
    resolvedEnd: null,
    relative: false,
    text: "",
    timex: "",
    charStart: 0,
    charEnd: 1,
    ...overrides,
  };
}

const days = (startDay: string, endDay: string, deadline = false) => ({
  startDay,
  endDay,
  deadline,
});

describe("mentionDays", () => {
  it("marks a phrase bounding its date from above as a deadline", () => {
    const open = (text: string, mod: string) =>
      mentionDays(
        date({ kind: "range", resolvedEnd: "2026-10-12", mod, text, timex: "XXXX-10-12" }),
      );
    expect(open("before 12 October", "before")).toEqual(days("2026-10-12", "2026-10-13", true));
    expect(open("by 12 October", "before")).toEqual(days("2026-10-12", "2026-10-13", true));
    expect(open("avant le 12 octobre", "before")).toEqual(days("2026-10-12", "2026-10-13", true));
    expect(open("cancel for free until 12 October", "before")).toEqual(
      days("2026-10-12", "2026-10-13", true),
    );
    expect(open("jusqu'au 12 octobre", "before")).toEqual(days("2026-10-12", "2026-10-13", true));
    expect(open("after 12 October", "after")).toEqual(days("2026-10-12", "2026-10-13"));
  });

  it("keeps a month only when the phrase writes its year", () => {
    const month = (text: string, timex: string, relative = false) =>
      mentionDays(date({ resolvedStart: "2026-11", text, timex, relative }));
    expect(month("November 2026", "2026-11")).toEqual(days("2026-11-01", "2026-12-01"));
    expect(month("2026年11月", "2026-11")).toEqual(days("2026-11-01", "2026-12-01"));
    expect(month("in 2 months", "2026-11")).toBeNull();
    expect(month("le mois prochain", "2026-11")).toBeNull();
    expect(month("November", "XXXX-11", true)).toBeNull();
  });

  it("reads a day as that day", () => {
    expect(
      mentionDays(date({ resolvedStart: "2026-10-12", text: "12 October", timex: "XXXX-10-12" })),
    ).toEqual(days("2026-10-12", "2026-10-13"));
    // Relative days count: "tomorrow" in a message names a real day.
    expect(
      mentionDays(
        date({
          resolvedStart: "2026-10-12",
          text: "tomorrow",
          timex: "2026-10-12",
          relative: true,
        }),
      ),
    ).toEqual(days("2026-10-12", "2026-10-13"));
  });

  it("drops a bare digit run the recognizer read as a date", () => {
    expect(
      mentionDays(date({ resolvedStart: "2048-01-05", text: "204815", timex: "2048-01-05" })),
    ).toBeNull();
    expect(
      mentionDays(date({ resolvedStart: "2048-01-05", text: "> 204815", timex: "2048-01-05" })),
    ).toBeNull();
    // A written date with separators stays.
    expect(
      mentionDays(date({ resolvedStart: "2026-09-30", text: "30/09/2026", timex: "2026-09-30" })),
    ).toEqual(days("2026-09-30", "2026-10-01"));
  });

  it("keeps a month the phrase names with its year, and drops one named without", () => {
    expect(
      mentionDays(date({ resolvedStart: "2026-10", text: "October 2026", timex: "2026-10" })),
    ).toEqual(days("2026-10-01", "2026-11-01"));
    expect(
      mentionDays(
        date({ resolvedStart: "2026-10", text: "October", timex: "XXXX-10", relative: true }),
      ),
    ).toBeNull();
    expect(
      mentionDays(
        date({ resolvedStart: "2026-10", text: "next month", timex: "2026-10", relative: true }),
      ),
    ).toBeNull();
    expect(
      mentionDays(date({ resolvedStart: "2026-12", text: "December 2026", timex: "2026-12" })),
    ).toEqual(days("2026-12-01", "2027-01-01"));
  });

  it("drops a year", () => {
    expect(mentionDays(date({ resolvedStart: "2026", text: "2026", timex: "2026" }))).toBeNull();
  });

  it("keeps a span the phrase lays out by day, closing a day-count span on its last day", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2026-10-03",
          text: "from 1 to 3 October",
          timex: "(XXXX-10-01,XXXX-10-03,P2D)",
        }),
      ),
    ).toEqual(days("2026-10-01", "2026-10-04"));
    // A named period the phrase dates by day keeps the recognizer's exclusive end.
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-09-28",
          resolvedEnd: "2026-10-05",
          text: "the week of 28 September",
          timex: "2026-W40",
        }),
      ),
    ).toEqual(days("2026-09-28", "2026-10-05"));
  });

  it("drops a span that names no day or counts days from the document's own date", () => {
    const span = (text: string, timex: string) =>
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2027-01-01",
          text,
          timex,
        }),
      );
    expect(span("Q4", "(XXXX-10-01,XXXX-01-01,P3M)")).toBeNull();
    expect(span("Q4 2026", "(2026-10-01,2027-01-01,P3M)")).toBeNull();
    expect(span("the next few weeks", "(2026-10-01,2026-10-22,P3W)")).toBeNull();
    expect(span("this week", "2026-W40")).toBeNull();
    expect(span("within the next 7 days", "(2026-10-01,2026-10-08,P7D)")).toBeNull();
    expect(span("mid-2022", "")).toBeNull();
  });

  it("reads clock times within one day as that day", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2026-10-01",
          text: "Thursday between 9 and 1pm",
          timex: "(2026-10-01T09,2026-10-01T13,PT4H)",
        }),
      ),
    ).toEqual(days("2026-10-01", "2026-10-02"));
  });

  it("closes an evening that runs past midnight on the day it ends", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2026-10-02",
          text: "1 October from 8pm to 2am",
          timex: "(2026-10-01T20,2026-10-02T02,PT6H)",
        }),
      ),
    ).toEqual(days("2026-10-01", "2026-10-03"));
  });

  it("reads an open-ended phrase at the precision its TIMEX gives", () => {
    const open = (overrides: Partial<ExtractedDate>) =>
      mentionDays(date({ kind: "range", ...overrides }));
    expect(
      open({ resolvedStart: "2022-01-01", mod: "since", text: "since 2022", timex: "2022" }),
    ).toBeNull();
    expect(
      open({
        resolvedEnd: "2026-10-01",
        mod: "before",
        text: "until October",
        timex: "XXXX-10",
        relative: true,
      }),
    ).toBeNull();
    expect(
      open({ resolvedStart: "2023-05-01", mod: "since", text: "since May 2023", timex: "2023-05" }),
    ).toEqual(days("2023-05-01", "2023-06-01"));
    expect(
      open({
        resolvedEnd: "2026-09-30",
        mod: "before",
        text: "before 30 September",
        timex: "XXXX-09-30",
      }),
    ).toEqual(days("2026-09-30", "2026-10-01", true));
  });

  it("drops a span past the cap and a malformed bound", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-01-01",
          resolvedEnd: "2026-12-31",
          text: "1 January to 31 December",
          timex: "(2026-01-01,2026-12-31,P364D)",
        }),
      ),
    ).toBeNull();
    expect(MENTION_MAX_SPAN_DAYS).toBe(92);
    expect(
      mentionDays(date({ resolvedStart: "2026-13-40", text: "13/40", timex: "2026-13-40" })),
    ).toBeNull();
  });

  it("reads a day number written the way Chinese writes dates", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2027-09-28",
          resolvedEnd: "2027-09-30",
          text: "2027年9月28日至30日",
          timex: "(2027-09-28,2027-09-30,P2D)",
        }),
      ),
    ).toEqual(days("2027-09-28", "2027-10-01"));
  });
});
