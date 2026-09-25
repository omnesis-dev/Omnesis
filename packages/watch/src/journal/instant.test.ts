// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The journal's canonical instant, and the spellings that reach it.
 *
 * A document event's times are copied from corpus columns, and a source is free
 * to have stored a perfectly good instant in a form that is not ISO-8601. One
 * did: `2026-07-31 15:09:00+01`, a space where the separator belongs and a
 * two-digit offset. The schema refused it, the reader skipped the event, and
 * every document that source produced was invisible to every watch — with no
 * error, because a skipped event is not an error.
 *
 * So the canonical form stays strict and the mapping onto it is explicit. What
 * this file pins is both halves: the spellings that must be accepted, and the
 * values that must still be refused, because a normalizer that accepts anything
 * is a schema that checks nothing.
 */

import { describe, expect, it } from "vitest";

import { journalEventSchema, toJournalInstant } from "./event.js";

describe("a timestamp the journal can take", () => {
  it("accepts the canonical form unchanged", () => {
    for (const value of [
      "2026-07-31T15:09:00Z",
      "2026-07-31T15:09:00.123Z",
      "2026-07-31T15:09Z",
      "2026-07-31T15:09:00+01:00",
      "2026-07-31T15:09:00-05:00",
    ]) {
      expect(toJournalInstant(value), value).toBe(value);
    }
  });

  it("maps the spelling that made a live source invisible", () => {
    // The exact value read out of the journal on the install where this was
    // found, on six events across three days.
    expect(toJournalInstant("2026-07-31 15:09:00+01")).toBe("2026-07-31T15:09:00+01:00");
  });

  it("maps a space separator and a compact offset independently", () => {
    expect(toJournalInstant("2026-07-31 15:09:00Z")).toBe("2026-07-31T15:09:00Z");
    expect(toJournalInstant("2026-07-31T15:09:00+0100")).toBe("2026-07-31T15:09:00+01:00");
    expect(toJournalInstant("2026-07-31T15:09:00-05")).toBe("2026-07-31T15:09:00-05:00");
  });

  it("preserves the offset rather than shifting to UTC", () => {
    // The zone carries meaning — a watch's civil-day boundaries are evaluated
    // against it — so normalizing the spelling must not normalize the instant.
    expect(toJournalInstant("2026-07-31 15:09:00+01")).toContain("+01:00");
  });
});

describe("a timestamp the journal must refuse", () => {
  it("refuses a value with no zone at all", () => {
    // The whole point of the explicit-zone rule: an instant without one is
    // ambiguous by exactly the offset nobody wrote down.
    expect(toJournalInstant("2026-07-31 15:09:00")).toBeNull();
    expect(toJournalInstant("2026-07-31T15:09:00")).toBeNull();
  });

  it("refuses a date with no time", () => {
    expect(toJournalInstant("2026-07-31")).toBeNull();
  });

  it("refuses an impossible calendar date that matches the shape", () => {
    // The reason the schema pairs a pattern with a parse check: this matches
    // the regex and parses to NaN, and every ordering comparison against a NaN
    // is false — so it would switch the journal's monotonicity checks off
    // rather than fail them.
    expect(toJournalInstant("2026-99-99T00:00:00Z")).toBeNull();
  });

  it("refuses text that is not a timestamp", () => {
    for (const value of ["", "not a date", "1785950632084", "yesterday"]) {
      expect(toJournalInstant(value), value).toBeNull();
    }
  });
});

describe("an event carrying the non-canonical spelling", () => {
  /** The shape the live journal held, with corpus values replaced by invented ones. */
  function stravaLikeEvent(at: string): Record<string, unknown> {
    return {
      seq: 765,
      kind: "doc.event",
      occurredAt: at,
      observedAt: "2026-08-05T15:06:19.033Z",
      payload: {
        op: "updated",
        docId: "aaaaaaaa-0000-4000-8000-000000000001",
        sourceId: "strava-activities:12345678",
        providerId: "strava:12345678",
        documentType: "activity",
        title: "an activity",
        semanticTime: at,
        changedFields: ["title", "distance", "movingTime"],
        contentChanged: false,
        metadata: {},
        people: [
          { personId: "bbbbbbbb-0000-4000-8000-000000000002", role: "athlete", isSelf: true },
        ],
      },
    };
  }

  it("is refused before normalizing, and accepted after", () => {
    const raw = "2026-07-31 15:09:00+01";
    expect(
      journalEventSchema.safeParse(stravaLikeEvent(raw)).success,
      "the schema accepted a non-canonical instant — it is meant to be strict",
    ).toBe(false);

    const normalized = toJournalInstant(raw)!;
    const parsed = journalEventSchema.safeParse(stravaLikeEvent(normalized));
    expect(parsed.success, "a normalized instant was still refused").toBe(true);
  });

  it("names the field and the code when it is refused", () => {
    // What the reader logs. Paths and codes are safe to print; the values are
    // corpus content and must never reach a log line.
    const parsed = journalEventSchema.safeParse(stravaLikeEvent("2026-07-31 15:09:00+01"));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const reported = parsed.error.issues.map((i) => `${i.path.join("/")}:${i.code}`);
    expect(reported).toContain("occurredAt:invalid_format");
    expect(reported).toContain("payload/semanticTime:invalid_format");
  });
});
