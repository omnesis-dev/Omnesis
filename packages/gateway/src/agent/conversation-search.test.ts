// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { conversationSnippet, rankConversationMatches } from "./conversation-search.js";
import type { ConversationSummary } from "./conversation-store.js";

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    model: "fictional-model",
    backend: "http",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    pinned: false,
  };
}

describe("rankConversationMatches", () => {
  const summaries = [
    summary("a", "Marathon entry form"),
    summary("b", "Q4 budget review"),
    summary("c", "Budget for the marathon"),
  ];

  test("puts index hits first, in their order, then title matches in list order", () => {
    const matches = rankConversationMatches(
      summaries,
      [{ conversationId: "b", text: "the marathon fee" }],
      "marathon",
    );
    expect(matches.map((m) => m.id)).toEqual(["b", "a", "c"]);
    expect(matches[0]!.match).toEqual({ snippet: "the marathon fee" });
    expect(matches[1]!.match).toBeUndefined();
  });

  test("a passage that opens with the title shows what follows it", () => {
    const [match] = rankConversationMatches(
      summaries,
      [{ conversationId: "b", text: "Q4 budget review\n\nThe budget closes Friday." }],
      "budget",
    );
    expect(match!.match).toEqual({ snippet: "The budget closes Friday." });
  });

  test("no passage when the title was all that matched", () => {
    const [match] = rankConversationMatches(
      summaries,
      [{ conversationId: "b", text: "Q4 budget review\n\nOn it." }],
      "review",
    );
    expect(match).toEqual(summaries[1]);
  });

  test("a title matches only when it holds every term", () => {
    expect(rankConversationMatches(summaries, [], "budget marathon").map((m) => m.id)).toEqual([
      "c",
    ]);
  });

  test("ignores hits for conversations the list does not hold, and repeats", () => {
    const matches = rankConversationMatches(
      summaries,
      [
        { conversationId: "gone", text: "x" },
        { conversationId: "a", text: "first" },
        { conversationId: "a", text: "second" },
      ],
      "zzz",
    );
    expect(matches).toEqual([{ ...summaries[0], match: { snippet: "first" } }]);
  });
});

describe("conversationSnippet", () => {
  test("collapses whitespace and drops emphasis and code markers", () => {
    expect(conversationSnippet("When is the **race**?\n\n  on `sunday`.", "race")).toBe(
      "When is the race? on sunday.",
    );
  });

  test("centres a long passage on the first term it contains, at word boundaries", () => {
    const text = `${"filler words ".repeat(30)}the stellar sound invoice arrived ${"tail words ".repeat(30)}`;
    const snippet = conversationSnippet(text, "stellar");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("the stellar sound invoice arrived");
    expect(snippet.length).toBeLessThanOrEqual(162);
    // Cut between words, never inside one.
    expect(snippet.slice(1).split(" ")[0]).toMatch(/^(filler|words)$/);
    expect(snippet.slice(0, -1).split(" ").at(-1)).toMatch(/^(tail|words)$/);
  });

  test("prefers the window holding the most query terms over the earliest term", () => {
    const text = `the start of it ${"filler ".repeat(40)}second message about the launch ${"tail ".repeat(40)}`;
    expect(conversationSnippet(text, "second message about the launch")).toContain(
      "second message about the launch",
    );
  });

  test("finds a term across case and accents", () => {
    const text = `${"x ".repeat(120)}Réunion au café ${"y ".repeat(120)}`;
    expect(conversationSnippet(text, "CAFE")).toContain("café");
  });

  test("a long passage without the term starts at its beginning", () => {
    const text = "word ".repeat(80);
    const snippet = conversationSnippet(text, "absent");
    expect(snippet.startsWith("word")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
