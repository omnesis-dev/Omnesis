// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { zodToJsonSchema } from "../zod-to-json-schema.js";
import { createFetchDocumentTool } from "./fetch-document.js";
import { createFetchManyTool } from "./fetch-many.js";
import type { DocRef } from "@omnesis/core";

import type { DocumentPort, DocumentPortResult } from "./types.js";

const ctx = { sessionId: "S", messageId: "M" };

function port(
  impl: (id: string, opts?: { includeNeighbors?: boolean }) => Promise<DocumentPortResult | null>,
): DocumentPort {
  return { fetch: (id, opts) => impl(id, opts) };
}

describe("opaque fetch pointers", () => {
  it.each([createFetchDocumentTool, createFetchManyTool])(
    "explains corpus IDs separately from aliases only on supporting ports",
    (create) => {
      const ordinary = create({ port: port(async () => null) });
      expect(ordinary.description).not.toContain("wiki:<pageId>");
      const supported = create({
        port: { ...port(async () => null), supportsKnowledgeAliases: true },
      });
      expect(supported.description).toContain("alias only from an actual wiki link");
      expect(supported.description).toContain("returned documentIds are opaque corpus IDs");
      expect(supported.description).toContain("without adding wiki: or any other prefix");
      const schema = JSON.stringify(zodToJsonSchema(supported.schema));
      expect(schema).toContain("Copy it exactly; do not add a prefix");
    },
  );

  it("forwards returned corpus pointers exactly and does not guess a repair for prefixed IDs", async () => {
    const seen: string[] = [];
    const documentPort = {
      supportsKnowledgeAliases: true,
      fetch: async (id: string) => {
        seen.push(id);
        return id === "projection-detail"
          ? {
              ref: { documentId: id, sourceType: "knowledge", sourceId: "knowledge:fixture" },
              document: { id },
            }
          : null;
      },
    };
    const single = createFetchDocumentTool({ port: documentPort });
    expect((await single.invoke({ documentId: "projection-detail" }, ctx)).kind).toBe("document");
    const batch = createFetchManyTool({ port: documentPort });
    const result = await batch.invoke(
      {
        documents: [{ documentId: "projection-detail" }, { documentId: "wiki:projection-detail" }],
      },
      ctx,
    );
    expect(result.kind).toBe("document.batch");
    if (result.kind === "document.batch") {
      expect(result.items.map((item) => item.kind)).toEqual(["document", "error"]);
    }
    expect(seen).toEqual(["projection-detail", "projection-detail", "wiki:projection-detail"]);
  });
});

describe("fetch_document tool", () => {
  it("returns a document tool-result and forwards includeNeighbors", async () => {
    let seenId: string | undefined;
    let seenOpts: { includeNeighbors?: boolean } | undefined;
    const ref: DocRef = { documentId: "d1", sourceType: "gmail", sourceId: "gmail:me" };
    const neighbor: DocRef = { documentId: "d2", sourceType: "gmail", sourceId: "gmail:me" };
    const tool = createFetchDocumentTool({
      port: port(async (id, opts) => {
        seenId = id;
        seenOpts = opts;
        return { ref, document: { id, body: "the body" }, neighbors: [neighbor] };
      }),
    });
    const r = await tool.invoke({ documentId: "d1", includeNeighbors: true }, ctx);
    expect(seenId).toBe("d1");
    expect(seenOpts?.includeNeighbors).toBe(true);
    expect(r.kind).toBe("document");
    if (r.kind !== "document") return;
    expect(r.ref).toEqual(ref);
    expect(r.neighbors).toEqual([neighbor]);
  });

  it("returns a not_found error when the port returns null", async () => {
    const tool = createFetchDocumentTool({ port: port(async () => null) });
    const r = await tool.invoke({ documentId: "missing" }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("not_found");
  });

  it("returns a fetch_failed error when the port throws", async () => {
    const tool = createFetchDocumentTool({
      port: { fetch: async () => Promise.reject(new Error("db locked")) },
    });
    const r = await tool.invoke({ documentId: "d1" }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("fetch_failed");
      expect(r.message).toContain("db locked");
    }
  });

  it("rejects an empty documentId", async () => {
    const tool = createFetchDocumentTool({ port: port(async () => null) });
    const r = await tool.invoke({ documentId: "" }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });
});
