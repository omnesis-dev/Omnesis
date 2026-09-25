// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins the Outlook Calendar document-event profile to what the normalizer
 * actually emits. Every assertion drives the real sync path over a mocked Graph
 * and compares the resulting documents against the declaration — a field that
 * exists only in the profile would let a condition compile into a predicate
 * that can never match, and one the normalizer writes but does not declare is
 * invisible to a watch however carefully it is worded.
 */

import { describe, test, expect, vi } from "vitest";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { outlookCalendarDocumentEventProfile } from "./document-event-profiles.js";
import { OutlookCalendarSource } from "./outlook-calendar.js";
import outlookProvider from "./index.js";
import type {
  CalendarDeltaResponse,
  CalendarGraphClientLike,
  GraphEvent,
} from "./outlook-calendar-types.js";
import type { DocumentInput, PersonRole } from "@omnesis/types";

const CALENDAR = { id: "cal-1", name: "Work", isDefaultCalendar: true };
const DELTA = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d";

/** A Graph transport serving one page of hand-authored events. */
function graphServing(value: GraphEvent[]): CalendarGraphClientLike {
  return {
    get: vi.fn((path: string) => {
      // `/me/calendars/{id}/calendarView/delta` starts the same way, so the
      // list route has to exclude it or every calendar arrives as an event.
      if (path.startsWith("/me/calendars") && !path.includes("/calendarView")) {
        return Promise.resolve({ value: [CALENDAR] });
      }
      return Promise.resolve({ value, "@odata.deltaLink": DELTA } as CalendarDeltaResponse);
    }) as unknown as CalendarGraphClientLike["get"],
  };
}

/** Drain a whole cycle — one call per calendar-page, plus the one that ends it. */
async function drain(graph: CalendarGraphClientLike): Promise<DocumentInput[]> {
  const source = new OutlookCalendarSource(
    async () => "token",
    "outlook-calendar:user@example.com",
    "microsoft:user@example.com",
    undefined,
    { graph },
  );
  const docs: DocumentInput[] = [];
  let cursor = null;
  for (let i = 0; i < 12; i++) {
    const page = await source.sync(cursor);
    docs.push(...page.documents);
    if (!page.hasMore) return docs;
    cursor = page.cursor;
  }
  throw new Error("cycle did not finish");
}

/** A fully-populated event — every declared path should be present on it. */
function richEvent(overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: "evt-1",
    iCalUId: "ical-evt-1",
    subject: "Vendor evaluation",
    body: { contentType: "text", content: "Reach david@example.com before Thursday." },
    start: { dateTime: "2026-03-04T10:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-03-04T11:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    type: "singleInstance",
    location: { displayName: "Harbourview room" },
    organizer: { emailAddress: { name: "Maya Reeves", address: "maya@example.com" } },
    attendees: [
      {
        type: "required",
        status: { response: "accepted" },
        emailAddress: { name: "Jamie Lopez", address: "jamie@example.com" },
      },
    ],
    webLink: "https://outlook.live.com/calendar/0/view/x?itemid=evt-1",
    createdDateTime: "2026-03-01T00:00:00Z",
    lastModifiedDateTime: "2026-03-02T00:00:00Z",
    ...overrides,
  };
}

function extraOf(doc: DocumentInput): Record<string, unknown> {
  return (doc.metadata.extra ?? {}) as Record<string, unknown>;
}

describe("the Outlook Calendar profile is valid and wired into the descriptor", () => {
  test("it satisfies the source-boundary contract", () => {
    expect(() =>
      validateDocumentEventProfile(outlookCalendarDocumentEventProfile, "outlook-calendar"),
    ).not.toThrow();
  });

  test("the descriptor publishes it, so the collector can harvest it", () => {
    // Declared but unpublished is the silent failure this guards: the watch
    // journal reads the descriptor, not the module.
    const calendar = outlookProvider.sources.find((s) => s.id === "outlook-calendar");
    expect(calendar?.documentEventProfile).toBe(outlookCalendarDocumentEventProfile);
  });
});

describe("the profile matches what the normalizer writes", () => {
  test("the declared document types are the ones emitted", async () => {
    const docs = await drain(graphServing([richEvent()]));
    expect([...new Set(docs.map((d) => d.metadata.documentType))]).toEqual(
      outlookCalendarDocumentEventProfile.documentTypes,
    );
  });

  test("the declared person roles are the ones emitted", async () => {
    const docs = await drain(graphServing([richEvent()]));
    const roles = [...new Set((docs[0]!.metadata.people ?? []).map((p) => p.role))].sort();
    // The body carries an address, so `mentioned` is populated too.
    expect([...(outlookCalendarDocumentEventProfile.personRoles as PersonRole[])].sort()).toEqual(
      roles,
    );
  });

  test("every declared metadata path is populated on a fully-described event", async () => {
    // A path the normalizer never writes compiles into a condition that can
    // never match, and nothing downstream would say so.
    const docs = await drain(graphServing([richEvent()]));
    const extra = extraOf(docs[0]!);
    for (const field of outlookCalendarDocumentEventProfile.metadataFields ?? []) {
      expect(field.path.startsWith("extra.")).toBe(true);
      const key = field.path.slice("extra.".length);
      expect(
        extra[key],
        `profile declares ${field.path} but the normalizer left it unset`,
      ).toBeDefined();
    }
  });

  test("the values the normalizer writes are inside the declared vocabularies", async () => {
    const docs = await drain(
      graphServing([
        richEvent({ id: "busy", showAs: "busy" }),
        richEvent({ id: "free", showAs: "free" }),
        richEvent({ id: "away", showAs: "oof" }),
      ]),
    );
    const declared = (path: string) =>
      outlookCalendarDocumentEventProfile.metadataFields?.find((f) => f.path === path)
        ?.allowedValues ?? [];

    for (const doc of docs) {
      const extra = extraOf(doc);
      expect(declared("extra.showAs")).toContain(extra.showAs);
      // One value, not merely "includes confirmed": widening it would advertise
      // a state a document can never be in, and a condition written against
      // that state could never match.
      expect(declared("extra.status")).toEqual(["confirmed"]);
    }
  });

  test("the availability vocabulary is Graph's, so a value it sends is never unwritable", () => {
    // The declaration is the closed set the source will emit, and `showAsOf`
    // drops anything outside it. If the two disagree, either Graph's value is
    // silently discarded or the profile advertises one that never arrives.
    const declared =
      outlookCalendarDocumentEventProfile.metadataFields?.find((f) => f.path === "extra.showAs")
        ?.allowedValues ?? [];
    expect([...declared].sort()).toEqual(
      ["busy", "free", "oof", "tentative", "unknown", "workingElsewhere"].sort(),
    );
  });

  test("the calendar's name is declared as naming a person, because it usually does", () => {
    // A calendar shared in from another mailbox is named after its owner, so
    // filtering on it identifies a human as surely as an attendee filter. The
    // flag is what makes the privacy surface treat it that way.
    const field = outlookCalendarDocumentEventProfile.metadataFields?.find(
      (f) => f.path === "extra.calendarName",
    );
    expect(field?.identifiesPeople).toBe(true);
    // And nothing else claims to, so the flag stays meaningful.
    const flagged = (outlookCalendarDocumentEventProfile.metadataFields ?? [])
      .filter((f) => f.identifiesPeople)
      .map((f) => f.path);
    expect(flagged).toEqual(["extra.calendarName"]);
  });

  test("a cancelled event never reaches a document, which is why status has one value", async () => {
    // The declaration says `confirmed` and nothing else. That is only honest
    // because the cancelled ones are retracted rather than written.
    const docs = await drain(
      graphServing([richEvent({ id: "live" }), richEvent({ id: "off", isCancelled: true })]),
    );
    expect(docs.map((d) => d.externalId)).toEqual(["cal-1:live"]);
  });

  test("an unrecognised showAs is dropped rather than smuggled past the vocabulary", async () => {
    // Graph may add a value this version has never heard of. Writing it through
    // would put a value in the journal that no declared condition can match and
    // that the drift discipline cannot see.
    const docs = await drain(graphServing([richEvent({ showAs: "hotDesking" })]));
    expect(extraOf(docs[0]!).showAs).toBeUndefined();
  });
});
