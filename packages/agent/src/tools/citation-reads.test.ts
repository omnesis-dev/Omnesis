// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { buildBuiltinTools } from "./registry.js";
import { CitationReads } from "./citation-reads.js";
import { createFetchManyTool } from "./fetch-many.js";
import { createAnnotateManyTool } from "./annotate-many.js";
import type { DocumentPort } from "./types.js";

const ctx = { sessionId: "session", messageId: "turn" };
function fixture(limit = 512, content = "Prism assembly is complete. Calibration is planned.") {
  let version = "one";
  let visible = true;
  const port: DocumentPort = {
    requiresCitationRead: true,
    async fetch(id) {
      if (!visible) return null;
      const documentId = id === "wiki:prism" ? "page" : id;
      return {
        ref: { documentId, sourceId: "fixture", sourceType: "fixture" },
        document: {
          id: documentId,
          content,
          references: ["original"],
        },
        readSnapshot: { documentId, version },
      };
    },
  };
  const citationReads = new CitationReads(limit);
  return {
    port,
    fetch: createFetchManyTool({ port, citationReads }),
    cite: createAnnotateManyTool({ port, citationReads }),
    change: () => {
      version = "two";
    },
    hide: () => {
      visible = false;
    },
  };
}
async function cite(
  f: ReturnType<typeof fixture>,
  documentId: string,
  quote?: string,
  context = ctx,
) {
  const result = await f.cite.invoke(
    { annotations: [{ documentId, ...(quote ? { quote } : {}) }] },
    context,
  );
  if (result.kind !== "annotate.batch") throw Error("Unexpected result");
  return result.items[0];
}
it("requires an actual explicit read, not annotate's hidden fetch or a wiki's references", async () => {
  const f = fixture();
  expect(await cite(f, "original")).toMatchObject({
    kind: "error",
    code: "citation_read_required",
  });
  expect(await cite(f, "original")).toMatchObject({
    kind: "error",
    code: "citation_read_required",
  });
  await f.fetch.invoke({ documents: [{ documentId: "wiki:prism" }] }, ctx);
  expect(await cite(f, "page")).toMatchObject({ kind: "annotate.recorded" });
  expect(await cite(f, "original")).toMatchObject({
    kind: "error",
    code: "citation_read_required",
  });
});
it("rechecks revision, privacy and turn isolation before recording", async () => {
  const f = fixture();
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  expect(await cite(f, "original")).toMatchObject({ kind: "annotate.recorded" });
  expect(await cite(f, "original", undefined, { ...ctx, messageId: "next" })).toMatchObject({
    code: "citation_read_required",
  });
  expect(await cite(f, "original", undefined, { ...ctx, sessionId: "other" })).toMatchObject({
    code: "citation_read_required",
  });
  f.change();
  expect(await cite(f, "original")).toMatchObject({ code: "citation_read_required" });
  f.hide();
  expect(await cite(f, "original")).toMatchObject({ code: "document_not_found" });
});
it("accepts only exact quotes inside a returned bounded span", async () => {
  const f = fixture();
  const result = await f.fetch.invoke(
    { documents: [{ documentId: "original", maxContentChars: 27 }] },
    ctx,
  );
  expect(result).toMatchObject({
    kind: "document.batch",
    items: [
      {
        document: {
          content: "Prism assembly is complete.",
          contentRange: { truncated: true, returnedCharacters: 27 },
        },
      },
    ],
  });
  expect(await cite(f, "original")).toMatchObject({ code: "citation_read_required" });
  expect(await cite(f, "original", "Calibration is planned.")).toMatchObject({
    code: "citation_read_required",
  });
  expect(await cite(f, "original", "Prism assembly is complete.")).toMatchObject({
    kind: "annotate.recorded",
  });
});
it("recovers an invalid reconstructed quote only within an actual current read", async () => {
  const f = fixture(512, "Prism assembly is complete.\n> Calibration is planned.");
  const reconstructed = "Prism assembly is complete. Calibration is planned.";
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await cite(f, "original", reconstructed)).toMatchObject({
      kind: "error",
      code: "citation_read_required",
      message: expect.stringContaining("Correct the quote rather than repeating it unchanged"),
    });
  }
  expect(await cite(f, "original", "> Calibration is planned.")).toMatchObject({
    kind: "annotate.recorded",
    quote: "> Calibration is planned.",
  });
  expect(await cite(f, "original")).toMatchObject({ kind: "annotate.recorded" });
  f.change();
  expect(await cite(f, "original")).toMatchObject({ code: "citation_read_required" });

  const partial = fixture();
  await partial.fetch.invoke({ documents: [{ documentId: "original", maxContentChars: 27 }] }, ctx);
  expect(await cite(partial, "original")).toMatchObject({ code: "citation_read_required" });
});
it("evicts bounded receipts safely and preserves mixed batch order", async () => {
  const f = fixture(1);
  await f.fetch.invoke({ documents: [{ documentId: "a" }] }, ctx);
  await f.fetch.invoke({ documents: [{ documentId: "b" }] }, ctx);
  const result = await f.cite.invoke(
    { annotations: [{ documentId: "a" }, { documentId: "b" }] },
    ctx,
  );
  expect(result).toMatchObject({
    kind: "annotate.batch",
    items: [{ code: "citation_read_required" }, { kind: "annotate.recorded", documentId: "b" }],
  });
});

it("shares actual read receipts through the public tool registry", async () => {
  const f = fixture();
  const tools = buildBuiltinTools({
    ports: {
      document: f.port,
      search: {
        async search(input) {
          return { query: input.query, durationMs: 0, results: [] };
        },
      },
    },
  });
  const fetch = tools.find((tool) => tool.name === "fetch_many")!;
  const annotate = tools.find((tool) => tool.name === "annotate_many")!;
  const args = { annotations: [{ documentId: "page" }] };
  expect(await annotate.invoke(args, ctx)).toMatchObject({
    items: [{ code: "citation_read_required" }],
  });
  await fetch.invoke({ documents: [{ documentId: "wiki:prism" }] }, ctx);
  expect(await annotate.invoke(args, ctx)).toMatchObject({
    items: [{ kind: "annotate.recorded" }],
  });
});

it("validates supplied full-read quotes without requiring a quote for full reads", async () => {
  const f = fixture();
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  expect(await cite(f, "original")).toMatchObject({ kind: "annotate.recorded" });
  expect(await cite(f, "original", "Calibration is planned.")).toMatchObject({
    kind: "annotate.recorded",
  });
  expect(await cite(f, "original", "Calibration is complete.")).toMatchObject({
    code: "citation_read_required",
  });
});

it("resolves whitespace-only quotes to the exact original observed text", async () => {
  const original = "Calibration\r\n  is\u00a0ready.";
  const f = fixture(512, original);
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  expect(await cite(f, "original", "Calibration is ready.")).toMatchObject({
    kind: "annotate.recorded",
    quote: original,
  });
  expect(await cite(f, "original", "Calibration ready.")).toMatchObject({
    code: "citation_read_required",
  });
  f.change();
  expect(await cite(f, "original", "Calibration is ready.")).toMatchObject({
    code: "citation_read_required",
  });
});
it("refuses ambiguous whitespace matches and unseen spans without expanding read authority", async () => {
  const f = fixture(512, "Ready\n now. Ready\t now. Unseen\n material.");
  expect(await cite(f, "original", "Ready now.")).toMatchObject({ code: "citation_read_required" });
  await f.fetch.invoke({ documents: [{ documentId: "original", maxContentChars: 23 }] }, ctx);
  expect(await cite(f, "original", "Ready now.")).toMatchObject({ code: "citation_read_required" });
  expect(await cite(f, "original", "Unseen material.")).toMatchObject({
    code: "citation_read_required",
  });
  // An exact quote still has its original explicit authority, even if another
  // whitespace-equivalent passage exists elsewhere.
  expect(await cite(f, "original", "Ready\n now.")).toMatchObject({
    kind: "annotate.recorded",
    quote: "Ready\n now.",
  });
});
it("returns only the unique bounded passage and deduplicates overlapping read spans", async () => {
  const f = fixture(512, "Intro. Ready\n now. Other material.");
  await f.fetch.invoke({ documents: [{ documentId: "original", maxContentChars: 19 }] }, ctx);
  await f.fetch.invoke({ documents: [{ documentId: "original", maxContentChars: 19 }] }, ctx);
  expect(await cite(f, "original", "Ready now.")).toMatchObject({
    kind: "annotate.recorded",
    quote: "Ready\n now.",
  });
});

it("retains full page authority only for a complete same-version read while citations stay byte-bound", () => {
  const reads = new CitationReads();
  const result = {
    ref: { documentId: "page", sourceId: "brain-knowledge", sourceType: "brain-knowledge" },
    document: { content: "Revision banner.\nActual paragraph." },
    readSnapshot: { documentId: "page", version: "one", fullPageAuthorityVersion: "meaning-one" },
  };
  reads.record(ctx, result, false, { offset: 0, length: 10 });
  expect(reads.snapshot(ctx)[0]?.fullPageAuthorityVersion).toBeUndefined();
  reads.record(ctx, result, true);
  expect(reads.snapshot(ctx)[0]?.fullPageAuthorityVersion).toBe("meaning-one");
  reads.record(
    ctx,
    {
      ...result,
      readSnapshot: { ...result.readSnapshot, fullPageAuthorityVersion: "unobserved-proof" },
    },
    false,
    { offset: 0, length: 10 },
  );
  expect(reads.snapshot(ctx)[0]?.fullPageAuthorityVersion).toBe("meaning-one");
  const refreshed = { ...result, readSnapshot: { ...result.readSnapshot, version: "two" } };
  expect(reads.resolve(ctx, refreshed, "Actual paragraph.")).toBeNull();
  reads.record(ctx, refreshed, false, { offset: 0, length: 10 });
  expect(reads.snapshot(ctx)[0]?.fullPageAuthorityVersion).toBeUndefined();
});

it("distinguishes unread and changed receipts without exposing document contents", async () => {
  const f = fixture();
  expect(await cite(f, "original", "invented passage")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining("no current explicit read in this turn"),
  });
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  f.change();
  expect(await cite(f, "original", "invented passage")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining("changed after its recorded read"),
  });
  f.hide();
  expect(await cite(f, "original", "invented passage")).toMatchObject({
    code: "document_not_found",
  });
});

it("offers note-only recovery for full reads but never for incomplete spans", async () => {
  const full = fixture();
  await full.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  expect(await cite(full, "original", "A different assertion.")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining(
      "omit quote and cite the fully read document with a short note",
    ),
  });
  expect(
    await full.cite.invoke(
      { annotations: [{ documentId: "original", note: "Assembly record." }] },
      ctx,
    ),
  ).toMatchObject({
    items: [{ kind: "annotate.recorded", note: "Assembly record." }],
  });
  const partial = fixture();
  await partial.fetch.invoke({ documents: [{ documentId: "original", maxContentChars: 27 }] }, ctx);
  expect(await cite(partial, "original")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining("Supply an exact quote from the returned span"),
  });
  expect(await cite(partial, "original", "Calibration is planned.")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining("omitting quote does not authorize the unread remainder"),
  });
});

it("diagnoses ambiguous whitespace matches while retaining exact quote acceptance", async () => {
  const f = fixture(512, "Ready\n now. Ready\t now.");
  await f.fetch.invoke({ documents: [{ documentId: "original" }] }, ctx);
  expect(await cite(f, "original", "Ready now.")).toMatchObject({
    code: "citation_read_required",
    message: expect.stringContaining("multiple whitespace-equivalent matches"),
  });
  expect(await cite(f, "original", "Ready\n now.")).toMatchObject({ kind: "annotate.recorded" });
});

it("preserves the compatibility resolver and fails closed without receipt or quoteable body", () => {
  const reads = new CitationReads();
  const result = {
    ref: { documentId: "opaque", sourceId: "fixture", sourceType: "fixture" },
    document: { content: "" },
    readSnapshot: { documentId: "opaque", version: "one" },
  };
  expect(reads.resolveDetailed(ctx, { ...result, readSnapshot: undefined })).toEqual({
    ok: false,
    reason: "unread",
    full: false,
  });
  reads.record(ctx, result, true);
  expect(reads.resolve(ctx, result)).toEqual({});
  expect(reads.resolveDetailed(ctx, result, "")).toEqual({
    ok: false,
    reason: "quote_mismatch",
    full: true,
  });
  expect(reads.resolve(ctx, result, "")).toBeNull();
  const partial = new CitationReads();
  partial.record(ctx, result, false, { offset: 0, length: 0 });
  expect(partial.resolveDetailed(ctx, result, "")).toEqual({
    ok: false,
    reason: "quote_required",
    full: false,
  });
  expect(partial.resolve(ctx, result, "")).toBeNull();
  expect(reads.resolveDetailed(ctx, { ...result, document: {} }, "text")).toEqual({
    ok: false,
    reason: "body_unavailable",
    full: true,
  });
  expect(reads.resolve(ctx, result, "text")).toBeNull();
});
