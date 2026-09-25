// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createAnnotateTool } from "./annotate.js";
import type { DocumentPort, DocumentPortResult } from "./types.js";

function port(fixture: DocumentPortResult | null): DocumentPort {
  return { fetch: async () => fixture };
}

const REF = {
  documentId: "doc1",
  sourceType: "gmail",
  sourceId: "gmail:self",
  title: "Re: status",
} as const;

const FIXTURE: DocumentPortResult = {
  ref: REF,
  document: {
    id: "doc1",
    content:
      "Hello team,\n\nThe deploy went green at 14:32 UTC and traffic is steady.\nWill follow up tomorrow.\n\nA.",
  },
};

const CTX = { sessionId: "S", messageId: "M" } as const;

describe("createAnnotateTool", () => {
  it("records a quote-only citation", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quote: "deploy went green at 14:32 UTC" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.documentId).toBe("doc1");
      expect(r.quote).toBe("deploy went green at 14:32 UTC");
      expect(r.note).toBeUndefined();
      expect(r.ref.title).toBe("Re: status");
    }
  });

  it("records a note-only citation", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke({ documentId: "doc1", note: "scheduled vendor sync" }, CTX);
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.note).toBe("scheduled vendor sync");
      expect(r.quote).toBeUndefined();
    }
  });

  it("records a citation with both quote and note", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quote: "anything goes", note: "why this matters" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quote).toBe("anything goes");
      expect(r.note).toBe("why this matters");
    }
  });

  it("accepts a quote that doesn't appear in the body — no validation", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quote: "this text is nowhere in the body" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
  });

  it("accepts a citation with neither quote nor note", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke({ documentId: "doc1" }, CTX);
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quote).toBeUndefined();
      expect(r.note).toBeUndefined();
    }
  });

  it("returns actionable feedback when the document id does not resolve", async () => {
    const tool = createAnnotateTool({ port: port(null) });
    const r = await tool.invoke({ documentId: "analytics-row-17", note: "n/a" }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("document_not_found");
      expect(r.message).toContain("search_many");
      expect(r.message).toContain("raw run_sql row");
      expect(r.message).toContain("cite_record");
      expect(r.message).toContain("No citation was recorded");
    }
  });

  it("returns retryable feedback when document validation fails", async () => {
    const tool = createAnnotateTool({
      port: {
        fetch: async () => {
          throw new Error("transient db error");
        },
      },
    });
    const r = await tool.invoke({ documentId: "doc1", note: "citation note" }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("document_lookup_failed");
      expect(r.message).toContain("Retry annotate_many");
      expect(r.message).toContain("no citation was recorded");
    }
  });

  it("rejects an empty documentId", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke({ documentId: "", quote: "x" }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("quoteAuthor is passed through when quote is present (non-self → quoteIsSelf absent)", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quote: "some text", quoteAuthor: "Alice" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quoteAuthor).toBe("Alice");
      expect(r.quote).toBe("some text");
      expect(r.quoteIsSelf).toBeUndefined();
    }
  });

  it('resolves quoteIsSelf=true when the author is the user ("You")', async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quote: "I will follow up tomorrow", quoteAuthor: "You" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quoteAuthor).toBe("You");
      expect(r.quoteIsSelf).toBe(true);
    }
  });

  it("quoteIsSelf is absent when there is no quote, even with a self author", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke({ documentId: "doc1", quoteAuthor: "You", note: "n" }, CTX);
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quoteAuthor).toBeUndefined();
      expect(r.quoteIsSelf).toBeUndefined();
    }
  });

  it("quoteAuthor is stripped when quote is absent", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quoteAuthor: "Alice", note: "some note" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quoteAuthor).toBeUndefined();
      expect(r.note).toBe("some note");
    }
  });

  it("quoteAuthor is stripped when quote is absent but note is present", async () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const r = await tool.invoke(
      { documentId: "doc1", quoteAuthor: "Bob", note: "important context" },
      CTX,
    );
    expect(r.kind).toBe("annotate.recorded");
    if (r.kind === "annotate.recorded") {
      expect(r.quoteAuthor).toBeUndefined();
      expect(r.quote).toBeUndefined();
      expect(r.note).toBe("important context");
    }
  });

  it("summarize produces a docId + quote excerpt", () => {
    const tool = createAnnotateTool({ port: port(FIXTURE) });
    const s = tool.summarize?.({ documentId: "doc1234567890ABC", quote: "shipped at 14:32 UTC" });
    expect(s).toContain("doc1234567890ABC");
    expect(s).toContain("shipped");
  });
});
