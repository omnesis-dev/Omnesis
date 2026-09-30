// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { MENTION_MAX_SPAN_DAYS, isMessageHeaderDate, mentionDays } from "./mention-bounds.js";
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

  it("reads what the user addressed to the assistant loosely", () => {
    const addressed = { addressed: true };
    const week = date({
      kind: "range",
      resolvedStart: "2026-10-05",
      resolvedEnd: "2026-10-12",
      text: "next week",
      timex: "2026-W41",
      relative: true,
    });
    expect(mentionDays(week)).toBeNull();
    expect(mentionDays(week, addressed)).toEqual(days("2026-10-05", "2026-10-12"));

    const month = date({ resolvedStart: "2026-10", text: "in October", timex: "XXXX-10" });
    expect(mentionDays(month)).toBeNull();
    expect(mentionDays(month, addressed)).toEqual(days("2026-10-01", "2026-11-01"));

    const within = date({
      kind: "range",
      resolvedStart: "2026-10-01",
      resolvedEnd: "2026-10-11",
      text: "within 10 days",
      timex: "(2026-10-01,2026-10-11,P10D)",
    });
    expect(mentionDays(within, addressed)).toEqual(days("2026-10-01", "2026-10-12"));

    // Still not dates: a digit run, a year, a span past the cap.
    expect(
      mentionDays(
        date({ resolvedStart: "2048-01-05", text: "204815", timex: "2048-01-05" }),
        addressed,
      ),
    ).toBeNull();
    expect(
      mentionDays(date({ resolvedStart: "2027", text: "2027", timex: "2027" }), addressed),
    ).toBeNull();
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2027-04-01",
          text: "the next six months",
          timex: "(2026-10-01,2027-04-01,P6M)",
        }),
        addressed,
      ),
    ).toBeNull();
  });

  it("drops a duration counted from the document's date, unless the user addressed it", () => {
    const at = (text: string) =>
      date({ resolvedStart: "2026-10-21", text, timex: "2026-10-21", relative: true });
    for (const text of ["in 20 days", "72 hours", "a month ago", "next day", "30 jours"]) {
      expect(mentionDays(at(text)), text).toBeNull();
    }
    expect(mentionDays(at("in 20 days"), { addressed: true })).toEqual(
      days("2026-10-21", "2026-10-22"),
    );
    // Weekday and day words are not durations.
    expect(mentionDays(at("next Monday"))).toEqual(days("2026-10-21", "2026-10-22"));
    expect(mentionDays(at("today"))).toEqual(days("2026-10-21", "2026-10-22"));
  });

  it("drops a yearless day resolved more than six months past the document", () => {
    const yearless = (resolvedStart: string) =>
      date({ resolvedStart, text: "23 June", timex: "XXXX-06-23" });
    const reading = { anchorDay: "2026-09-30" };
    // Past the six months, the writer meant the one just gone.
    expect(mentionDays(yearless("2027-06-23"), reading)).toEqual(days("2026-06-23", "2026-06-24"));
    expect(mentionDays(yearless("2026-12-23"), reading)).toEqual(days("2026-12-23", "2026-12-24"));
    // With its year written, the day stands however far ahead it is.
    expect(
      mentionDays(
        date({ resolvedStart: "2027-06-23", text: "23 June 2027", timex: "2027-06-23" }),
        reading,
      ),
    ).toEqual(days("2027-06-23", "2027-06-24"));
    // A note's "23 June" is the one the user means.
    expect(mentionDays(yearless("2027-06-23"), { ...reading, addressed: true })).toEqual(
      days("2027-06-23", "2027-06-24"),
    );
  });

  it("drops implausible years, a few letters, tokens and runaway matches", () => {
    expect(
      mentionDays(date({ resolvedStart: "1107-06", text: "6-1107", timex: "1107-06" })),
    ).toBeNull();
    expect(
      mentionDays(date({ resolvedStart: "2026-10-12", text: " h", timex: "2026-10-12" })),
    ).toBeNull();
    expect(
      mentionDays(date({ resolvedStart: "2026-10-12", text: "> now", timex: "PRESENT_REF" })),
    ).toBeNull();
    expect(
      mentionDays(
        date({
          resolvedStart: "2026-10-12",
          text: "7LE1FXmcY1lBsUlJThIbq54 12 October",
          timex: "XXXX-10-12",
        }),
      ),
    ).toBeNull();
    expect(
      mentionDays(
        date({
          resolvedStart: "2026-10-12",
          text: "until the offer ends.\n\nOur partners have confirmed it will be 12 October",
          timex: "XXXX-10-12",
        }),
      ),
    ).toBeNull();
    // A short phrase with a digit is still a date.
    expect(
      mentionDays(date({ resolvedStart: "2026-10-12", text: "12/10", timex: "XXXX-10-12" })),
    ).toEqual(days("2026-10-12", "2026-10-13"));
  });

  it("drops the date of a message header or a reply's attribution", () => {
    const header = (content: string, phrase: string) => {
      const start = content.indexOf(phrase);
      return isMessageHeaderDate(content, start, start + phrase.length);
    };
    expect(
      header(
        "**From:** Maya Reeves <maya@example.com>\n**Date:** Tue, 29 Sep 2026 06:01:40\n---\nBody",
        "Tue, 29 Sep 2026",
      ),
    ).toBe(true);
    // Alone, a `Date:` line is an event's date.
    expect(
      header("Your tickets\nDate: Saturday 10 October 2026\nDoors 7pm", "Saturday 10 October 2026"),
    ).toBe(false);
    expect(
      header("> Sent: Monday, 5 October 2026 09:12\n> To: team", "Monday, 5 October 2026"),
    ).toBe(true);
    expect(
      header(
        "On Tue, 22 Sep 2026 at 18:43, Maya Reeves <maya@example.com> wrote:\n> hi",
        "Tue, 22 Sep 2026",
      ),
    ).toBe(true);
    // The attribution's "wrote:" can wrap onto a later line.
    expect(
      header(
        "On Mon, Oct 27, 2025 at 12:07 PM, Jamie Lopez <\njamie@example.org>\nwrote:",
        "Mon, Oct 27, 2025",
      ),
    ).toBe(true);
    expect(header("Le mar. 23 juin 2026, 16:33, David Lin a écrit :", "mar. 23 juin 2026")).toBe(
      true,
    );
    // A sentence that happens to start with "On" is not an attribution.
    expect(header("On 12 October we meet at the station.", "12 October")).toBe(false);
    expect(header("The delivery is on 12 October.", "12 October")).toBe(false);
    expect(
      mentionDays(date({ resolvedStart: "2026-09-22", text: "22 Sep", timex: "2026-09-22" }), {
        inMessageHeader: true,
      }),
    ).toBeNull();
  });

  it("names the month an open-ended phrase writes, not where its range begins", () => {
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          mod: "after",
          text: "after Sep, 2026",
          timex: "2026-09",
        }),
      ),
    ).toEqual(days("2026-09-01", "2026-10-01"));
  });

  it("reads a deadline from its word when the recognizer drops the modifier", () => {
    const point = (text: string) =>
      mentionDays(date({ resolvedStart: "2026-09-30", text, timex: "XXXX-09-30" }));
    expect(point("e before sept 30th")?.deadline).toBe(true);
    expect(point(" complete before sept 30th")?.deadline).toBe(true);
    expect(point("jusqu'au 30 septembre")?.deadline).toBe(true);
    expect(point("30 September")?.deadline).toBe(false);
    // "by" names a deadline only as the word before a date.
    expect(point("Standby 30 September")?.deadline).toBe(false);
  });

  it("keeps the dates the noise rules must not catch", () => {
    // A long invite phrase is one date, not a runaway match.
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-09-28",
          resolvedEnd: "2026-10-02",
          text: "from Monday 28 September 2026 at 9:00 am to Friday 2 October 2026 at 5:00 pm",
          timex: "(2026-09-28T09:00,2026-10-02T17:00,PT104H)",
        }),
      ),
    ).toEqual(days("2026-09-28", "2026-10-03"));
    // A short month name in a note is a month.
    expect(
      mentionDays(date({ resolvedStart: "2027-05", text: "May", timex: "XXXX-05" }), {
        addressed: true,
      }),
    ).toEqual(days("2027-05-01", "2027-06-01"));
    // A duration word beside a written date is anchored to that date.
    expect(
      mentionDays(
        date({
          resolvedStart: "2026-10-05",
          text: "the next day, 5 October 2026",
          timex: "2026-10-05",
        }),
      ),
    ).toEqual(days("2026-10-05", "2026-10-06"));
    // A closed range with "until" is a span, not a deadline.
    expect(
      mentionDays(
        date({
          kind: "range",
          resolvedStart: "2026-10-01",
          resolvedEnd: "2026-10-05",
          text: "from 1 Oct until 5 Oct 2026",
          timex: "(2026-10-01,2026-10-05,P4D)",
        }),
      )?.deadline,
    ).toBe(false);
    // A yearless open-ended month names that month, whichever side the bound falls.
    const open = (resolvedStart: string, timex: string, text: string) =>
      mentionDays(date({ kind: "range", resolvedStart, mod: "after", text, timex }), {
        addressed: true,
      });
    expect(open("2026-11-01", "XXXX-10", "after October")).toEqual(
      days("2026-10-01", "2026-11-01"),
    );
    expect(open("2027-01-01", "XXXX-12", "after December")).toEqual(
      days("2026-12-01", "2027-01-01"),
    );
  });

  it("does not read a body sentence above a quoted reply as its attribution", () => {
    const at = (content: string, phrase: string) => {
      const start = content.indexOf(phrase);
      return isMessageHeaderDate(content, start, start + phrase.length);
    };
    const reply =
      "On Friday 2 October we sign the lease.\n\nOn Tue, 22 Sep 2026 at 18:43, Maya Reeves <maya@example.com> wrote:\n> Great";
    expect(at(reply, "Friday 2 October")).toBe(false);
    expect(at(reply, "Tue, 22 Sep 2026")).toBe(true);
    const french =
      "Le 12 octobre 2026 on signe.\n\nLe mar. 22 sept. 2026, David Lin a écrit :\n> Parfait";
    expect(at(french, "12 octobre 2026")).toBe(false);
  });
});
