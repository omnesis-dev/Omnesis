// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
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

  it("accepts old paths without generating relation labels", () => {
    const paths = searchProvenanceSchema.parse(provenance).paths;
    expect(paths).toEqual(provenance.paths);
    expect(paths[0]).not.toHaveProperty("relations");
  });

  it("accepts old provenance without synthesizing compact model context", () => {
    expect(searchProvenanceSchema.parse(provenance)).not.toHaveProperty("modelContext");
  });

  it("preserves compact facts and actionable references while an older reader strips them", () => {
    const modelContext = {
      facts: ["D1 has matching extracted text in D2."],
      documents: [
        {
          ref: "D1",
          documentId: "file_example",
          sourceId: "files:example",
          title: "Project agreement.pdf",
          deviceName: "Example laptop",
          path: "Documents/agreement.pdf",
        },
        {
          ref: "D2",
          documentId: "drive_example",
          sourceId: "gdrive:example",
          url: "https://example.org/file",
          appUrl: "https://example.org/app/file",
        },
      ],
      limits: ["Additional connections were omitted at a hub."],
    };
    const enriched = { ...provenance, modelContext };
    expect(
      docRefSchema.parse({ ...legacyRef, provenance: enriched }).provenance?.modelContext,
    ).toEqual(modelContext);
    expect(searchProvenanceSchema.omit({ modelContext: true }).parse(enriched)).toEqual(
      searchProvenanceSchema.parse(provenance),
    );
  });

  it.each([
    { facts: Array(65).fill("fact") },
    { facts: ["x".repeat(2001)] },
    {
      documents: Array.from({ length: 65 }, (_, index) => ({
        ref: `D${index + 1}`,
        documentId: "file",
        sourceId: "files:example",
      })),
    },
    ...["D0", "D01", "D-1", "1", "D1\n"].map((ref) => ({
      documents: [{ ref, documentId: "file", sourceId: "files:example" }],
    })),
    { documents: [{ ref: "D1", documentId: "", sourceId: "files:example" }] },
    { documents: [{ ref: "D1", documentId: "file", sourceId: "" }] },
    {
      documents: [
        { ref: "D1", documentId: "file", sourceId: "files:example", title: "x".repeat(241) },
      ],
    },
    ...["deviceName", "path"].map((field) => ({
      documents: [
        { ref: "D1", documentId: "file", sourceId: "files:example", [field]: "x".repeat(241) },
      ],
    })),
    ...["url", "appUrl"].map((field) => ({
      documents: [
        { ref: "D1", documentId: "file", sourceId: "files:example", [field]: "x".repeat(2049) },
      ],
    })),
    {
      documents: [
        { ref: "D1", documentId: "first", sourceId: "files:example" },
        { ref: "D1", documentId: "second", sourceId: "files:example" },
      ],
    },
    { limits: Array(6).fill("limit") },
    { limits: ["x".repeat(241)] },
  ])("rejects invalid or unbounded compact model context: %j", (patch) => {
    expect(
      searchProvenanceSchema.safeParse({
        ...provenance,
        modelContext: { facts: [], documents: [], limits: [], ...patch },
      }).success,
    ).toBe(false);
  });

  it("accepts the maximum compact context budgets", () => {
    const modelContext = {
      facts: Array(64).fill("x".repeat(2000)),
      documents: Array.from({ length: 64 }, (_, index) => ({
        ref: `D${index + 1}`,
        documentId: `file_${index}`,
        sourceId: "files:example",
        title: "x".repeat(240),
        deviceName: "x".repeat(240),
        path: "x".repeat(240),
        url: "x".repeat(2048),
        appUrl: "x".repeat(2048),
      })),
      limits: Array(5).fill("x".repeat(240)),
    };
    expect(searchProvenanceSchema.parse({ ...provenance, modelContext }).modelContext).toEqual(
      modelContext,
    );
  });

  it("preserves human phrases in edge order alongside the unchanged technical labels", () => {
    const relations = ["is linked from", "has a containment connection to"];
    const result = docRefSchema.parse({
      ...legacyRef,
      provenance: { ...provenance, paths: [{ ...provenance.paths[0], relations }] },
    });
    expect(result.provenance?.paths[0]).toEqual({ ...provenance.paths[0], relations });
  });

  it("lets an older path reader strip new relation labels while retaining graph identities", () => {
    // The old wire contract has only these two fields and strips additive keys.
    const oldPathSchema = z
      .object({
        documentIds: z.array(z.string().min(1)).min(2).max(6),
        edges: z.array(z.string().min(1)).min(1).max(5),
      })
      .refine((path) => path.documentIds.length === path.edges.length + 1);
    const oldProvenanceSchema = searchProvenanceSchema.omit({ paths: true }).extend({
      paths: z.array(oldPathSchema).max(24),
    });
    const result = oldProvenanceSchema.parse({
      ...provenance,
      paths: [{ ...provenance.paths[0], relations: ["is linked from", "contains"] }],
    });
    expect(result.paths).toEqual(provenance.paths);
    expect(result.paths[0]).not.toHaveProperty("relations");
  });

  it.each([
    { relations: [] },
    { relations: ["one label"] },
    { relations: ["one", "two", "three"] },
    { relations: ["", "contains"] },
    { relations: ["x".repeat(161), "contains"] },
    { relations: null },
  ])("rejects unaligned or invalid optional relation phrases: %j", ({ relations }) => {
    expect(
      searchProvenanceSchema.safeParse({
        ...provenance,
        paths: [{ ...provenance.paths[0], relations }],
      }).success,
    ).toBe(false);
  });

  it("accepts five relation phrases at their maximum length", () => {
    const path = {
      documentIds: ["a", "b", "c", "d", "e", "f"],
      edges: [
        "outbound:url",
        "inbound:contains",
        "outbound:references",
        "inbound:replies-to",
        "outbound:part-of-thread",
      ],
      relations: Array(5).fill("x".repeat(160)),
    };
    expect(searchProvenanceSchema.parse({ ...provenance, paths: [path] }).paths[0]).toEqual(path);
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
