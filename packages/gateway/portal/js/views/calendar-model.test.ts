// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — the portal ships plain browser JavaScript.
import { describe, expect, it } from "vitest";
import {
  groupDayEntries,
  groupMentionDocuments,
  filterCalendarEntries,
  relatedCalendarEntries,
  readCalendarPreferences,
  saveCalendarPreferences,
} from "./calendar-model.js";

const record = (id, kind, allDay = true, origin = "projection") => ({ id, kind, allDay, origin });

describe("Calendar organization", () => {
  it("separates date mentions, timed engagements, due dates and folded activities", () => {
    const entries = [
      record("booking", "appointment", false),
      record("block", "event"),
      record("due", "deadline", false),
      record("activity", "episode", false),
      record("visit", "visit", false),
      record("phrase", "event", true, "mention"),
    ];
    const groups = groupDayEntries(entries);
    expect(groups.timed.map((entry) => entry.id)).toEqual(["booking"]);
    expect(groups.allDay.map((entry) => entry.id)).toEqual(["block", "due"]);
    expect(groups.activity.map((entry) => entry.id)).toEqual(["activity", "visit"]);
    expect(groups.mentions.map((entry) => entry.id)).toEqual(["phrase"]);
  });

  it("keeps every distinct phrase grouped under its document", () => {
    const entries = [
      {
        ...record("a", "event", true, "mention"),
        mention: { documentId: "doc-a", text: "15 October" },
      },
      {
        ...record("b", "deadline", true, "mention"),
        mention: { documentId: "doc-a", text: "by 16 October" },
      },
      {
        ...record("c", "event", true, "mention"),
        mention: { documentId: "doc-b", text: "15 October" },
      },
    ];
    expect(
      groupMentionDocuments(entries).map((group) => group.entries.map((entry) => entry.id)),
    ).toEqual([["a", "b"], ["c"]]);
  });

  it("combines origin and due filters without dropping mention deadlines", () => {
    const entries = [
      record("a", "deadline"),
      record("b", "expiry", true, "annotation"),
      record("c", "event", true, "mention"),
      record("d", "deadline", true, "mention"),
    ];
    expect(filterCalendarEntries(entries, { dueOnly: true }).map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "d",
    ]);
    expect(
      filterCalendarEntries(entries, { origin: "mention", dueOnly: true }).map((entry) => entry.id),
    ).toEqual(["d"]);
  });

  it("relates only explicit projection links, never matching titles or shared evidence", () => {
    const projection = {
      ...record("p", "event"),
      label: "Workshop",
      projection: { documentId: "doc-a" },
    };
    const linked = {
      ...record("linked", "event", true, "annotation"),
      annotation: { projectionIds: ["p"] },
    };
    const unlinked = {
      ...record("unlinked", "event", true, "annotation"),
      label: "Workshop",
      annotation: { documentIds: ["doc-a"] },
    };
    const entries = [projection, linked, unlinked];
    expect(relatedCalendarEntries(projection, entries)).toEqual([linked]);
    expect(relatedCalendarEntries(linked, entries)).toEqual([projection]);
    expect(relatedCalendarEntries(unlinked, entries)).toEqual([]);
  });

  it("persists validated preferences and tolerates broken or unavailable storage", () => {
    let value;
    const storage = {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
    };
    expect(readCalendarPreferences(storage)).toEqual({ origin: "all", dueOnly: false });
    saveCalendarPreferences({ origin: "mention", dueOnly: true }, storage);
    expect(readCalendarPreferences(storage)).toEqual({ origin: "mention", dueOnly: true });
    value = '{"origin":"unknown","dueOnly":"yes"}';
    expect(readCalendarPreferences(storage)).toEqual({ origin: "all", dueOnly: false });
    value = "invalid JSON";
    expect(readCalendarPreferences(storage)).toEqual({ origin: "all", dueOnly: false });
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readCalendarPreferences(denied)).toEqual({ origin: "all", dueOnly: false });
    expect(() => saveCalendarPreferences({ origin: "all", dueOnly: false }, denied)).not.toThrow();
  });
});
