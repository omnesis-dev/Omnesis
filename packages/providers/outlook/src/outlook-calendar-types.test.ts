// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { validateOutlookCalendarCursor } from "./outlook-calendar-types.js";

/**
 * The cursor decides which calendar is read next, which link is followed, and
 * whether the cycle publishes a whole-source snapshot — and the gateway deletes
 * whatever a snapshot omits. A malformed cursor that survives validation
 * therefore reaches code that reconciles the corpus against it, so every field
 * is checked here rather than trusted.
 */
describe("validateOutlookCalendarCursor", () => {
  test("accepts an absent cursor, so a first sync starts a clean cycle", () => {
    expect(validateOutlookCalendarCursor(null)).toBeNull();
    expect(validateOutlookCalendarCursor(undefined)).toBeNull();
  });

  test("accepts the shape the source writes", () => {
    const cursor = {
      calendarLinks: { "cal-1": "https://graph.microsoft.com/v1.0/delta?token=a" },
      pendingCalendars: ["cal-1", "cal-2"],
      resumeLink: "https://graph.microsoft.com/v1.0/delta?$skiptoken=b",
      windowStart: "2024-01-01T00:00:00.000Z",
      windowRefreshAfter: "2024-02-01T00:00:00.000Z",
      snapshotCalendars: ["cal-1", "cal-2"],
      snapshot: { ids: { "cal-1": ["cal-1:evt-1"] }, covered: ["cal-1"] },
      knownMasters: ["cal-1:series-1"],
      enumeratedMasters: ["cal-1:series-1"],
    };
    expect(validateOutlookCalendarCursor(cursor)).toEqual(cursor);
  });

  test("keeps a cursor mid-enumeration under the old accumulator, minus the accumulator", () => {
    // Its ids cannot be attributed to a calendar, so that enumeration is
    // abandoned — but refusing the whole cursor would discard `windowStart`,
    // the fixed past edge the enumerated range is anchored on. Recomputed, the
    // edge jumps forward to a year ago and every event before it falls out of
    // the range, out of the next snapshot, and is deleted. The stale key is
    // simply ignored; every return rebuilds the cursor, so it is gone after one
    // page.
    const cursor = {
      calendarLinks: { "cal-1": "https://graph.microsoft.com/v1.0/delta?token=a" },
      pendingCalendars: ["cal-1"],
      windowStart: "2024-01-01T00:00:00.000Z",
      windowRefreshAfter: "2024-02-01T00:00:00.000Z",
      snapshotPresentIds: ["cal-1:evt-1"],
    };
    expect(validateOutlookCalendarCursor(cursor)).toEqual(cursor);
  });

  test("rejects the single-calendar format, whose keys are bare event ids", () => {
    // `phase`/`link` identify a cursor written when the source read one
    // calendar and keyed events on the bare Graph id. Those keys do not match
    // what this source emits, so resuming would leave the old documents
    // unreferenced and unreconciled. Starting clean is what retires them.
    expect(
      validateOutlookCalendarCursor({ phase: "incremental", link: "https://graph/x" }),
    ).toBeNull();
    expect(validateOutlookCalendarCursor({ phase: "bootstrap" })).toBeNull();
    expect(validateOutlookCalendarCursor({ link: "https://graph/x" })).toBeNull();
    // Including when it carries fields this format also uses — a partial
    // match must not be enough to resume.
    expect(
      validateOutlookCalendarCursor({
        phase: "incremental",
        link: "https://graph/x",
        knownMasters: ["series-1"],
        windowStart: "2024-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("rejects a calendarLinks that is not a record of strings", () => {
    // An array would yield its indices as calendar ids and its entries as
    // links, so the source would follow a URL under a calendar that does not
    // exist and file the result against the wrong stream.
    expect(validateOutlookCalendarCursor({ calendarLinks: ["https://graph/x"] })).toBeNull();
    expect(validateOutlookCalendarCursor({ calendarLinks: "https://graph/x" })).toBeNull();
    expect(validateOutlookCalendarCursor({ calendarLinks: null })).toBeNull();
    expect(validateOutlookCalendarCursor({ calendarLinks: { "cal-1": 7 } })).toBeNull();
  });

  test("rejects a queue or an id set that is not an array of strings", () => {
    expect(validateOutlookCalendarCursor({ pendingCalendars: "cal-1" })).toBeNull();
    expect(validateOutlookCalendarCursor({ pendingCalendars: [1, 2] })).toBeNull();
    // The snapshot decides what survives reconciliation; non-string entries
    // would silently name nothing and delete everything they failed to name.
    expect(validateOutlookCalendarCursor({ snapshotCalendars: [null] })).toBeNull();
    // A ledger the resume would iterate and throw on, rather than refuse.
    expect(validateOutlookCalendarCursor({ snapshot: { ids: { "cal-1": 42 } } })).toBeNull();
    expect(validateOutlookCalendarCursor({ knownMasters: { "cal-1": true } })).toBeNull();
    expect(validateOutlookCalendarCursor({ enumeratedMasters: "cal-1:series-1" })).toBeNull();
  });

  test("rejects a non-string resumeLink", () => {
    expect(validateOutlookCalendarCursor({ resumeLink: 42 })).toBeNull();
  });

  test("rejects window edges that are not ISO instants", () => {
    // The past edge bounds the enumeration that doubles as the snapshot, so an
    // unparseable one would build a request Graph rejects.
    expect(validateOutlookCalendarCursor({ windowStart: "last Tuesday" })).toBeNull();
    expect(validateOutlookCalendarCursor({ windowStart: 1700000000000 })).toBeNull();
    expect(validateOutlookCalendarCursor({ windowRefreshAfter: "soon" })).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(validateOutlookCalendarCursor("cursor")).toBeNull();
    expect(validateOutlookCalendarCursor(7)).toBeNull();
  });
});
