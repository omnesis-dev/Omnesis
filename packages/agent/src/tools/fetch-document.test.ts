// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createFetchDocumentTool } from "./fetch-document.js";
import type { DocRef } from "@omnesis/core";

import type { DocumentPort, DocumentPortResult } from "./types.js";

const ctx = { sessionId: "S", messageId: "M" };

function port(
  impl: (id: string, opts?: { includeNeighbors?: boolean }) => Promise<DocumentPortResult | null>,
): DocumentPort {
  return { fetch: (id, opts) => impl(id, opts) };
}

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
