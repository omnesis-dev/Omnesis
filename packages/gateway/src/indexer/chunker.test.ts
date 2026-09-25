// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { DocumentChunker } from "./chunker.js";
import type { IndexableDocument } from "./types.js";

function makeDoc(overrides: Partial<IndexableDocument> = {}): IndexableDocument {
  return {
    id: "doc-1",
    title: "Test Doc",
    content: overrides.content ?? "Hello world",
    contentHash: "abc123",
    sourceId: "gmail:user@example.com",
    metadata: {
      documentType: "email",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
      people: [{ role: "sender", name: "Alice", emails: ["alice@example.com"] }],
      ...overrides.metadata,
    },
    updatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("DocumentChunker", () => {
  const chunker = new DocumentChunker(200, 50); // small sizes for testing

  test("short document returns single chunk", () => {
    const doc = makeDoc({ content: "Short content here." });
    const chunks = chunker.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe("Short content here.");
    // The chunker emits the metadata preamble + content. The embedder
    // owns the task-specific prefix (`search_document: ` for nomic;
    // family-aware when `search.embedderPrefixes.enabled` is true) so
    // the chunker output stays prefix-agnostic.
    expect(chunks[0].embeddingInput).not.toContain("search_document:");
    expect(chunks[0].embeddingInput).toContain("Short content here.");
  });

  test("preamble includes document type, title, author, date", () => {
    const doc = makeDoc({ content: "Test" });
    const chunks = chunker.chunk(doc);
    const input = chunks[0].embeddingInput;

    expect(input).toContain("[email]");
    expect(input).toContain("Test Doc");
    expect(input).toContain("Alice");
    expect(input).toContain("2026-03-10");
  });

  test("long email is split into multiple chunks", () => {
    // Create content longer than chunk size with paragraphs
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i}: ${"Lorem ipsum dolor sit amet. ".repeat(5)}`,
    );
    const content = paragraphs.join("\n\n");

    const doc = makeDoc({ content });
    const chunks = chunker.chunk(doc);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);

    // Each chunk should have content
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  test("markdown document splits at headings", () => {
    const content = [
      "# Introduction",
      "This is the introduction. ".repeat(10),
      "## Methods",
      "This is the methods section. ".repeat(10),
      "## Results",
      "This is the results section. ".repeat(10),
    ].join("\n");

    const doc = makeDoc({
      content,
      metadata: { documentType: "note", sourceCreatedAt: "2026-03-10T00:00:00Z" },
    });
    const chunks = chunker.chunk(doc);

    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should contain the introduction heading
    expect(chunks[0].text).toContain("Introduction");
  });

  test("conversation splits at message boundaries", () => {
    const messages = Array.from(
      { length: 20 },
      (_, i) =>
        `**Alice** (${String(10 + Math.floor(i / 2)).padStart(2, "0")}:${String((i % 2) * 30).padStart(2, "0")}): ${"This is a message about various topics. ".repeat(3)}`,
    );
    const content = messages.join("\n");

    const doc = makeDoc({
      content,
      metadata: {
        documentType: "conversation",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    });
    const chunks = chunker.chunk(doc);

    expect(chunks.length).toBeGreaterThan(1);
  });

  test("empty content returns single empty chunk", () => {
    const doc = makeDoc({ content: "" });
    const chunks = chunker.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("");
  });

  test("single-instance short docs (bookmarks, events) stay as one chunk", () => {
    const doc = makeDoc({
      content: "Meeting with Bob at 3pm in Room 204",
      metadata: {
        documentType: "event",
        sourceCreatedAt: "2026-03-10T15:00:00Z",
      },
    });
    const chunks = chunker.chunk(doc);
    expect(chunks).toHaveLength(1);
  });

  test("oversize single segment is split to stay under chunkSize", () => {
    // One markdown section with no paragraph breaks, larger than
    // chunkSize. Before the fix this would fall through the merge step
    // as a single oversize chunk and the embedder would throw "Input is
    // longer than the context size".
    const bigSection =
      "## Heavy hour\n" +
      Array.from(
        { length: 50 },
        (_, i) => `- [title-${i}](https://example.com/path/${i}) — 1m 30s`,
      ).join("\n");
    expect(bigSection.length).toBeGreaterThan(200);

    const doc = makeDoc({
      content: bigSection,
      metadata: { documentType: "browsing-history", sourceCreatedAt: "2026-02-24T00:00:00Z" },
    });
    const chunks = chunker.chunk(doc);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
    }
  });

  test("oversize content across many sections stays under chunkSize", () => {
    // Browsing-history-style: many ## hour headings, each with a big
    // list of links. Verifies the char-window split composes cleanly
    // with the markdown section split.
    const hours = Array.from({ length: 10 }, (_, h) => {
      const lines = Array.from(
        { length: 30 },
        (_, i) => `- [visit-${h}-${i}](https://example.com/${h}/${i}) — 2m`,
      );
      return `## ${String(h).padStart(2, "0")}:00\n${lines.join("\n")}`;
    });
    const content = hours.join("\n\n");

    const doc = makeDoc({
      content,
      metadata: { documentType: "browsing-history", sourceCreatedAt: "2026-02-24T00:00:00Z" },
    });
    const chunks = chunker.chunk(doc);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
    }
  });
});
