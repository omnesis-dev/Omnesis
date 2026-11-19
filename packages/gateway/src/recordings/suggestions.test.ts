// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  addressedNames,
  buildSuggestions,
  type CalendarEventCandidate,
  type NameResolution,
  type SuggestionContext,
} from "./suggestions.js";

describe("addressedNames", () => {
  test("a name set off by a comma at either end of a sentence is someone spoken to", () => {
    expect(addressedNames("Thanks, Jamie.")).toEqual(["Jamie"]);
    expect(addressedNames("Jamie, can you take the notes?")).toEqual(["Jamie"]);
    expect(addressedNames("That works for me, Priya!")).toEqual(["Priya"]);
  });

  test("a greeting or thanks needs no comma before the name", () => {
    expect(addressedNames("Thank you Jamie")).toEqual(["Jamie"]);
    expect(addressedNames("hi Priya, good to see you")).toEqual(["Priya"]);
    expect(addressedNames("grazie Marco.")).toEqual(["Marco"]);
  });

  test("a name alone is a call", () => {
    expect(addressedNames("Jamie?")).toEqual(["Jamie"]);
  });

  test("a name talked about, and words that only look like names, are not", () => {
    expect(addressedNames("I spoke to Jamie yesterday.")).toEqual([]);
    expect(addressedNames("So, what do we do?")).toEqual([]);
    expect(addressedNames("Okay, thanks.")).toEqual([]);
    expect(addressedNames("We ship on Thursday, Friday.")).toEqual([]);
    expect(addressedNames("Yes.")).toEqual([]);
    expect(addressedNames("thanks, everyone")).toEqual([]);
  });
});

const JAMIE: NameResolution = { kind: "person", personId: "p-jamie", name: "Jamie R." };

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
    turns: [],
    events: [],
    namedSpeakers: new Set(),
    mappedPeople: new Set(),
    dismissed: new Set(),
    resolveName: () => ({ kind: "name" }),
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

  test("a name addressed is offered for the speaker who answers, with the line it was heard in", () => {
    const out = buildSuggestions(
      context({
        turns: [
          { speaker: 1, text: "Let's start. Jamie, can you share the numbers?" },
          { speaker: 1, text: "Whenever you are ready." },
          { speaker: 2, text: "Sure, here they are." },
        ],
        resolveName: (name) => (name === "Jamie" ? JAMIE : { kind: "name" }),
      }),
    );
    expect(out).toEqual([
      {
        key: "mention:2:p-jamie",
        kind: "person",
        source: "mention",
        speaker: 2,
        personId: "p-jamie",
        name: "Jamie R.",
        evidence: "Jamie, can you share the numbers?",
      },
    ]);
  });

  test("a name nobody or several people go by is offered as a plain name", () => {
    const out = buildSuggestions(
      context({
        turns: [
          { speaker: 2, text: "Thanks, Alex." },
          { speaker: 1, text: "You're welcome." },
        ],
      }),
    );
    expect(out).toMatchObject([
      { key: "mention:1:alex", speaker: 1, personId: null, name: "Alex", source: "mention" },
    ]);
  });

  test("of several people by one name, the meeting's attendee is the one", () => {
    const out = buildSuggestions(
      context({
        events: [event()],
        turns: [
          { speaker: 1, text: "Over to you, Priya." },
          { speaker: 2, text: "Thanks." },
        ],
      }),
    );
    // Heard and invited: offered for the speaker, not again as a mere attendee.
    expect(out.filter((s) => s.kind === "person")).toMatchObject([
      { key: "mention:2:p-priya", speaker: 2, personId: "p-priya", name: "Priya S." },
      { key: "person:p-jamie", speaker: null, personId: "p-jamie" },
    ]);
  });

  test("a speaker already named, or nobody answering, gets no mention", () => {
    const turns = [
      { speaker: 1, text: "Thanks, Jamie." },
      { speaker: 2, text: "Any time." },
    ];
    const resolveName = () => JAMIE;
    expect(buildSuggestions(context({ turns, resolveName, namedSpeakers: new Set([2]) }))).toEqual(
      [],
    );
    expect(buildSuggestions(context({ turns: [turns[0]!], resolveName }))).toEqual([]);
  });

  test("a name heard twice for the same speaker is offered once; a dismissed one never", () => {
    const turns = [
      { speaker: 1, text: "Jamie?" },
      { speaker: 2, text: "Yes." },
      { speaker: 1, text: "Thanks, Jamie." },
      { speaker: 2, text: "Sure." },
    ];
    const resolveName = () => JAMIE;
    expect(buildSuggestions(context({ turns, resolveName }))).toHaveLength(1);
    expect(
      buildSuggestions(context({ turns, resolveName, dismissed: new Set(["mention:2:p-jamie"]) })),
    ).toEqual([]);
  });
});
