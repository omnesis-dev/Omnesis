// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { parseQuery } from "./query-parser.js";

describe("parseQuery", () => {
  test("returns plain text when no filters", () => {
    const result = parseQuery("budget meeting notes");
    expect(result.text).toBe("budget meeting notes");
    expect(result.filters).toEqual({});
  });

  test("extracts from: as a sender/author/owner PersonFilter", () => {
    const result = parseQuery("from:john budget meeting");
    expect(result.text.trim()).toBe("budget meeting");
    expect(result.filters.personFilters).toEqual([
      { refs: ["john"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("extracts by: as alias of from:", () => {
    const result = parseQuery("by:jane project plan");
    expect(result.text.trim()).toBe("project plan");
    expect(result.filters.personFilters).toEqual([
      { refs: ["jane"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("extracts to: as a recipient/attendee PersonFilter", () => {
    const result = parseQuery("to:bob hello");
    expect(result.text.trim()).toBe("hello");
    expect(result.filters.personFilters).toEqual([
      { refs: ["bob"], roles: ["recipient", "attendee"] },
    ]);
  });

  test("extracts with: as an any-role PersonFilter", () => {
    const result = parseQuery("with:alice project");
    expect(result.text.trim()).toBe("project");
    // `with:` carries no role constraint — the resulting entry must
    // have `roles` undefined so the document_people JOIN matches
    // any role (sender, recipient, participant, attendee, etc.).
    expect(result.filters.personFilters).toEqual([{ refs: ["alice"] }]);
    expect(result.filters.personFilters![0].roles).toBeUndefined();
  });

  test("groups multiple refs of the same intent into one bucket (OR)", () => {
    const result = parseQuery("from:alice from:bob report");
    expect(result.text.trim()).toBe("report");
    expect(result.filters.personFilters).toEqual([
      { refs: ["alice", "bob"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("from:X to:Y creates two PersonFilters (AND intersection)", () => {
    // Regression: the previous parser pushed both refs into a flat
    // `authors` array and set a single `personRoles=["recipient"]`,
    // which silently coerced alice into a recipient too. The new
    // model keeps two distinct buckets so the pipeline AND-intersects
    // alice-as-sender with bob-as-recipient.
    const result = parseQuery("from:alice to:bob meeting");
    expect(result.text.trim()).toBe("meeting");
    expect(result.filters.personFilters).toEqual([
      { refs: ["alice"], roles: ["sender", "author", "owner"] },
      { refs: ["bob"], roles: ["recipient", "attendee"] },
    ]);
  });

  test("from:X with:Y creates two PersonFilters", () => {
    const result = parseQuery("from:alice with:carol");
    expect(result.filters.personFilters).toEqual([
      { refs: ["alice"], roles: ["sender", "author", "owner"] },
      { refs: ["carol"] },
    ]);
  });

  test("extracts type: document type filter", () => {
    const result = parseQuery("type:email quarterly report");
    expect(result.text.trim()).toBe("quarterly report");
    expect(result.filters.documentTypes).toEqual(["email"]);
  });

  test("extracts in: document type filter", () => {
    const result = parseQuery("in:conversation hello");
    expect(result.text.trim()).toBe("hello");
    expect(result.filters.documentTypes).toEqual(["conversation"]);
  });

  test("extracts after: ISO date filter", () => {
    const result = parseQuery("after:2026-01-01 project update");
    expect(result.text.trim()).toBe("project update");
    expect(result.filters.dateFrom).toBe("2026-01-01");
  });

  test("extracts before: ISO date filter", () => {
    const result = parseQuery("before:2026-06-01 old stuff");
    expect(result.text.trim()).toBe("old stuff");
    expect(result.filters.dateTo).toBe("2026-06-01");
  });

  test("extracts until: as alias of before:", () => {
    const result = parseQuery("until:2026-06-01 old stuff");
    expect(result.text.trim()).toBe("old stuff");
    expect(result.filters.dateTo).toBe("2026-06-01");
  });

  test("extracts source: filter", () => {
    const result = parseQuery("source:gmail important");
    expect(result.text.trim()).toBe("important");
    expect(result.filters.sourceIds).toEqual(["gmail"]);
  });

  test("extracts tag: filter", () => {
    const result = parseQuery("tag:work meeting");
    expect(result.text.trim()).toBe("meeting");
    expect(result.filters.tags).toEqual(["work"]);
  });

  test("extracts hashtag filter", () => {
    const result = parseQuery("meeting #urgent #work");
    expect(result.text.trim()).toBe("meeting");
    expect(result.filters.tags).toEqual(["urgent", "work"]);
  });

  test("handles multiple filters", () => {
    const result = parseQuery("from:john type:email after:2026-01-01 budget");
    expect(result.text.trim()).toBe("budget");
    expect(result.filters.personFilters).toEqual([
      { refs: ["john"], roles: ["sender", "author", "owner"] },
    ]);
    expect(result.filters.documentTypes).toEqual(["email"]);
    expect(result.filters.dateFrom).toBe("2026-01-01");
  });

  test("handles quoted multi-word values", () => {
    const result = parseQuery('from:"John Doe" project');
    expect(result.text.trim()).toBe("project");
    expect(result.filters.personFilters).toEqual([
      { refs: ["John Doe"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("handles quoted with: value", () => {
    const result = parseQuery('with:"Ada Lovelace" hello');
    expect(result.filters.personFilters).toEqual([{ refs: ["Ada Lovelace"] }]);
  });

  test("handles empty query after filter extraction", () => {
    const result = parseQuery("type:email");
    expect(result.text).toBe("");
    expect(result.filters.documentTypes).toEqual(["email"]);
  });

  test("handles since: as date from alias", () => {
    const result = parseQuery("since:2026-03-01 updates");
    expect(result.text.trim()).toBe("updates");
    expect(result.filters.dateFrom).toBe("2026-03-01");
  });

  describe("relative date keywords", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Pin "now" so the relative-date resolver is deterministic.
      vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("after:today resolves to today's ISO date", () => {
      const result = parseQuery("after:today logs");
      expect(result.filters.dateFrom).toBe("2026-05-14");
    });

    test("since:yesterday resolves to yesterday", () => {
      const result = parseQuery("since:yesterday logs");
      expect(result.filters.dateFrom).toBe("2026-05-13");
    });

    test('after:"last week" resolves to 7 days ago', () => {
      const result = parseQuery('after:"last week" logs');
      expect(result.filters.dateFrom).toBe("2026-05-07");
    });

    test('after:"last month" resolves to 1 month ago', () => {
      const result = parseQuery('after:"last month" logs');
      expect(result.filters.dateFrom).toBe("2026-04-14");
    });

    test('after:"last year" resolves to 1 year ago', () => {
      const result = parseQuery('after:"last year" logs');
      expect(result.filters.dateFrom).toBe("2025-05-14");
    });

    test('before:"last month" populates dateTo', () => {
      const result = parseQuery('before:"last month" logs');
      expect(result.filters.dateTo).toBe("2026-04-14");
    });
  });

  test("silently drops unrecognized date values but emits a notice", () => {
    // `after:bogusdate` is consumed by the regex but resolveDate
    // returns null, so the filter is dropped without raising. The
    // token is still stripped from the text so it doesn't leak into
    // BM25 as a literal term, and the parser pushes a `date` notice
    // so the caller learns the filter was ignored rather than guessing
    // why the result set didn't shrink.
    const result = parseQuery("after:bogusdate hello");
    expect(result.filters.dateFrom).toBeUndefined();
    expect(result.text.trim()).toBe("hello");
    expect(result.notices).toEqual([
      {
        filter: "date",
        level: "error",
        token: "after:bogusdate",
        message: expect.stringContaining("Couldn't parse"),
      },
    ]);
  });

  test("notices is empty when nothing odd happened", () => {
    const result = parseQuery("from:alice type:email Q3");
    expect(result.notices).toEqual([]);
  });

  test("date filter is case-insensitive on the key", () => {
    const result = parseQuery("AFTER:2026-01-01 hello");
    expect(result.filters.dateFrom).toBe("2026-01-01");
  });

  test("tokens keep every consumed filter as typed, aliases included", () => {
    const result = parseQuery('by:maya #work tag:"deep work" in:email since:2026-01-01 budget');
    expect(result.tokens).toEqual([
      { filter: "person", token: "by:maya" },
      { filter: "tag", token: 'tag:"deep work"' },
      { filter: "type", token: "in:email" },
      { filter: "date", token: "since:2026-01-01" },
      { filter: "tag", token: "#work" },
    ]);
    expect(result.text).toBe("budget");
  });
});
