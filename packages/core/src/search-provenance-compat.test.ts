// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { docRefSchema, searchProvenanceSchema, toolResultSchema } from "./agent-protocol.js";

const legacyRef = {
  documentId: "file_example",
  sourceType: "files",
  sourceId: "files:example",
  title: "Project agreement.pdf",
  url: "https://example.com/agreement.pdf",
};
const provenance = {
  summary: "Matching text also appears on Example laptop; linked from a message.",
  copies: [
    { ...legacyRef, deviceName: "Example laptop", path: "Documents/agreement.pdf" },
    { documentId: "drive_example", sourceId: "gdrive:example", url: "https://example.org/file" },
  ],
  paths: [
    {
      documentIds: ["file_example", "drive_example", "message_example"],
      edges: ["inbound:url", "outbound:contains"],
    },
  ],
  truncated: false,
  stopReasons: [],
};

describe("search provenance wire compatibility", () => {
  it("accepts legacy references without synthesizing provenance", () => {
    expect(docRefSchema.parse(legacyRef)).toEqual(legacyRef);
  });

  it("preserves additive provenance, IDs, link locations and path order", () => {
    const result = docRefSchema.parse({ ...legacyRef, provenance });
    expect(result.provenance).toEqual(searchProvenanceSchema.parse(provenance));
    expect(result.provenance?.paths[0]).toEqual(provenance.paths[0]);
    expect(result.provenance?.copies[1].url).toBe("https://example.org/file");
    expect(result.documentId).toBe(legacyRef.documentId);
    expect(result.url).toBe(legacyRef.url);
  });

  it("lets an older reference decoder ignore the additive field", () => {
    const oldSchema = docRefSchema.omit({ provenance: true });
    expect(oldSchema.parse({ ...legacyRef, provenance })).toEqual(legacyRef);
  });

  it("accepts legacy and enriched queries together in a batch result", () => {
    const result = toolResultSchema.parse({
      kind: "search.batch",
      items: [legacyRef, { ...legacyRef, provenance }].map((ref) => ({
        kind: "search.results",
        query: "agreement",
        durationMs: 2,
        results: [ref],
      })),
    });
    expect(result.kind).toBe("search.batch");
    if (result.kind !== "search.batch") throw new Error("Expected search batch");
    const first = result.items[0];
    const second = result.items[1];
    if (first.kind !== "search.results" || second.kind !== "search.results")
      throw new Error("Expected search results");
    expect(first.results[0].provenance).toBeUndefined();
    expect(second.results[0].provenance?.summary).toBe(provenance.summary);
  });

  it.each([
    { summary: "x".repeat(2001) },
    { copies: Array.from({ length: 25 }, () => provenance.copies[0]) },
    { copies: [{ documentId: "", sourceId: "files:example" }] },
    { copies: [{ documentId: "file", sourceId: "" }] },
    { paths: Array.from({ length: 25 }, () => provenance.paths[0]) },
    { paths: [{ documentIds: ["file"], edges: [] }] },
    { paths: [{ documentIds: ["a", "b", "c"], edges: ["url"] }] },
    { paths: [{ documentIds: ["a", "b"], edges: ["url", "attachment"] }] },
    { paths: [{ documentIds: ["a", ""], edges: ["url"] }] },
    { paths: [{ documentIds: ["a", "b"], edges: [""] }] },
    { paths: [{ documentIds: ["a", "b", "c", "d", "e", "f", "g"], edges: Array(6).fill("url") }] },
    { stopReasons: ["unknown"] },
    { truncated: "false" },
  ])("rejects malformed or unbounded provenance: %j", (patch) => {
    expect(searchProvenanceSchema.safeParse({ ...provenance, ...patch }).success).toBe(false);
  });

  it("accepts the maximum bounded path and explicit truncation reasons", () => {
    expect(
      searchProvenanceSchema.safeParse({
        ...provenance,
        paths: [{ documentIds: ["a", "b", "c", "d", "e", "f"], edges: Array(5).fill("url") }],
        truncated: true,
        stopReasons: ["hub", "depth", "nodes", "copies", "summary"],
      }).success,
    ).toBe(true);
  });
});
