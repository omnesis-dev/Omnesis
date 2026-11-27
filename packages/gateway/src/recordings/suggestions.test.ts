// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  buildSuggestions,
  type CalendarEventCandidate,
  type SuggestionContext,
} from "./suggestions.js";

function event(overrides: Partial<CalendarEventCandidate> = {}): CalendarEventCandidate {
  return {
    documentId: "doc-sync",
    title: "Weekly sync",
    start: "2026-03-02T09:00:00.000Z",
    end: "2026-03-02T10:00:00.000Z",
    attendees: [
      { personId: "p-priya", name: "Priya S." },
      { personId: "p-jamie", name: "Jamie R." },
    ],
    ...overrides,
  };
}

function context(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    title: null,
    events: [],
    mappedPeople: new Set(),
    dismissed: new Set(),
    ...overrides,
  };
}

describe("buildSuggestions", () => {
  test("nothing to go on suggests nothing", () => {
    expect(buildSuggestions(context())).toEqual([]);
  });

  test("the calendar offers its title and its attendees for any speaker", () => {
    expect(buildSuggestions(context({ events: [event()] }))).toEqual([
      {
        key: "title:doc-sync",
        kind: "title",
        source: "calendar",
        title: "Weekly sync",
        documentId: "doc-sync",
      },
      {
        key: "person:p-priya",
        kind: "person",
        source: "calendar",
        speaker: null,
        personId: "p-priya",
        name: "Priya S.",
        evidence: "Weekly sync",
      },
      {
        key: "person:p-jamie",
        kind: "person",
        source: "calendar",
        speaker: null,
        personId: "p-jamie",
        name: "Jamie R.",
        evidence: "Weekly sync",
      },
    ]);
  });

  test("a title already given, a person already mapped and anything dismissed are not offered", () => {
    const out = buildSuggestions(
      context({
        title: "Weekly sync",
        events: [event()],
        mappedPeople: new Set(["p-priya"]),
        dismissed: new Set(["person:p-jamie"]),
      }),
    );
    expect(out).toEqual([]);
  });

  test("a calendar attendee marked present is not offered again for a speaker", () => {
    const out = buildSuggestions(
      context({
        title: "Weekly sync",
        events: [event()],
        presentPeople: new Set(["p-priya"]),
      }),
    );
    expect(out).toEqual([
      {
        key: "person:p-jamie",
        kind: "person",
        source: "calendar",
        speaker: null,
        personId: "p-jamie",
        name: "Jamie R.",
        evidence: "Weekly sync",
      },
    ]);
  });
});
