// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { browserFindFinalizationHistory } from "./finalization-history.js";
import type { ChatMessage } from "@omnesis/agent";

describe("browser Find repair history", () => {
  it("retains individual hits from one oversized batch without a prior presentation proposal", () => {
    const results = Array.from({ length: 100 }, (_, index) => ({
      documentId: `doc-${index}`,
      sourceId: "demo:one",
      sourceType: "demo",
      url: `https://example.org/activity/${index}`,
      snippet: "Evidence. ".repeat(2000),
    }));
    const history: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "search",
            result: {
              kind: "search.batch",
              items: [{ kind: "search.results", query: "example", durationMs: 0, results }],
            },
          },
        ],
      },
    ];
    expect(JSON.stringify(history).length).toBeGreaterThan(1_048_576);
    const text = JSON.stringify(browserFindFinalizationHistory(history));
    expect(text.length).toBeLessThan(300_000);
    expect(text).toContain("doc-0");
    expect(text).toContain("https://example.org/activity/0");
    expect(text).toContain("Some research was omitted");
  });

  it("keeps SQL row identities aligned when retaining part of a large SQL result", () => {
    const rowIdentities = Array.from({ length: 50 }, (_, index) => ({
      table: "demo_rows",
      recordKey: `demo_rows:${index}`,
      primaryKeyColumns: [{ name: "id", value: String(index) }],
    }));
    const history: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "sql",
            result: {
              kind: "sql.rows",
              sql: "SELECT id, content FROM demo_rows",
              columns: ["id", "content"],
              rows: rowIdentities.map((_, index) => [index, "Evidence. ".repeat(3000)]),
              rowCount: 50,
              durationMs: 0,
              rowIdentities,
            },
          },
        ],
      },
    ];
    const repair = browserFindFinalizationHistory(history);
    const part = repair[0]!.parts[0]!;
    if (part.kind !== "text") throw new Error("Expected a text transcript");
    const fragments = part.text.split("\n").filter((line) => line.startsWith("Tool result sql: "));
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.length).toBeLessThan(50);
    for (const fragment of fragments) {
      const value = JSON.parse(fragment.slice("Tool result sql: ".length));
      expect(value.rows).toHaveLength(1);
      expect(value.rowIdentities).toEqual([rowIdentities[value.rows[0][0]]]);
      expect(value.truncated).toBe(true);
    }
  });
  it("bounds replay after extensive research while retaining the rejected candidate and its error", () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "Find the example activity" }] },
      ...Array.from({ length: 12 }, (_, index): ChatMessage => ({
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: `search-${index}`,
            result: {
              kind: "search.results",
              query: "example",
              durationMs: 0,
              results: [
                {
                  documentId: "doc-1",
                  sourceId: "demo:one",
                  sourceType: "demo",
                  title: "Example activity",
                  url: "https://example.org/activity/1",
                  snippet: "A long weekend run. " + "Earlier evidence. ".repeat(8000),
                },
              ],
            },
          },
        ],
      })),
      {
        role: "assistant",
        parts: [
          {
            kind: "tool_use",
            toolCallId: "present-1",
            tool: "present_browser_results",
            args: {
              results: [
                {
                  destinationUrl: "https://example.org/activity/1",
                  title: "Example activity",
                  snippet: "An invented snippet",
                  evidence: { documentIds: ["doc-1"] },
                },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "present-1",
            result: {
              kind: "error",
              code: "ungrounded_snippet",
              message: "Use a verbatim evidence passage as the snippet",
            },
          },
        ],
      },
    ];
    const original = JSON.stringify(history);
    expect(original.length).toBeGreaterThan(1_048_576);
    const repair = browserFindFinalizationHistory(history, "Europe/Paris");
    const text = JSON.stringify(repair);
    expect(text.length).toBeLessThan(300_000);
    expect(text).toContain("Some research was omitted");
    expect(text).toContain("A long weekend run.");
    expect(text).toContain("present_browser_results");
    expect(text).toContain("ungrounded_snippet");
    expect(text).toContain("doc-1");
    expect(JSON.stringify(history)).toBe(original);
    expect(repair.every((message) => message.parts.every((part) => part.kind === "text"))).toBe(
      true,
    );
  });

  it("retains exact SQL row identities and omits oversized individual evidence without cutting it", () => {
    const reference = {
      table: "demo_rows",
      recordKey: "demo_rows:1",
      primaryKeyColumns: [{ name: "id", value: "1" }],
    };
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "x".repeat(1_100_000) }] },
      { role: "assistant", parts: [{ kind: "thinking", text: "Private reasoning" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "tool_use",
            toolCallId: "present-row",
            tool: "present_browser_results",
            args: { evidence: { record: reference } },
          },
        ],
      },
    ];
    const text = JSON.stringify(browserFindFinalizationHistory(history));
    expect(text).toContain(JSON.stringify(reference).replaceAll('"', '\\"'));
    expect(text).not.toContain("Private reasoning");
    expect(text).not.toContain("x".repeat(100));
    expect(text).toContain("Some research was omitted");
  });
});
