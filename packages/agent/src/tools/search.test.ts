// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createSearchDocumentsTool } from "./search.js";
import { UnsupportedSearchFilterError } from "./types.js";
import type { DocRef } from "@omnesis/core";

import type { SearchPort, SearchPortInput, SearchPortResult } from "./types.js";

function port(impl: (input: SearchPortInput) => Promise<SearchPortResult>): SearchPort {
  return { search: (input) => impl(input) };
}

const ctx = { sessionId: "S", messageId: "M" };

describe("search_documents tool", () => {
  it("forwards args + maps the port result to a search.results tool-result", async () => {
    let seen: SearchPortInput | undefined;
    const refA: DocRef = {
      documentId: "d1",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Re: apartment",
    };
    const tool = createSearchDocumentsTool({
      port: port(async (input) => {
        seen = input;
        return {
          query: input.query,
          durationMs: 42,
          totalCandidates: 17,
          results: [refA],
        };
      }),
    });

    const result = await tool.invoke({ query: "Paris apartment", limit: 3 }, ctx);
    expect(seen?.query).toBe("Paris apartment");
    expect(seen?.limit).toBe(3);
    expect(result.kind).toBe("search.results");
    if (result.kind !== "search.results") return;
    expect(result.results).toEqual([refA]);
    expect(result.durationMs).toBe(42);
    expect(result.candidates).toBe(17);
  });

  it("applies defaultLimit when the model omits it", async () => {
    let seen: SearchPortInput | undefined;
    const tool = createSearchDocumentsTool({
      port: port(async (input) => {
        seen = input;
        return { query: input.query, durationMs: 0, results: [] };
      }),
      defaultLimit: 17,
    });
    await tool.invoke({ query: "foo" }, ctx);
    expect(seen?.limit).toBe(17);
  });

  it("rejects invalid args without invoking the port", async () => {
    let called = false;
    const tool = createSearchDocumentsTool({
      port: port(async () => {
        called = true;
        return { query: "", durationMs: 0, results: [] };
      }),
    });
    const r = await tool.invoke({ query: "" }, ctx);
    expect(called).toBe(false);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("returns a tool-error result when the port throws", async () => {
    const tool = createSearchDocumentsTool({
      port: { search: async () => Promise.reject(new Error("indexer offline")) },
    });
    const r = await tool.invoke({ query: "x" }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("search_failed");
      expect(r.message).toContain("indexer offline");
    }
  });
});

describe("search_documents names a refused filter", () => {
  it("maps UnsupportedSearchFilterError to an unsupported_filter error with the port's message", async () => {
    const tool = createSearchDocumentsTool({
      port: {
        search: async () => {
          throw new UnsupportedSearchFilterError(
            ["by:maya"],
            "the by:maya filter is not available",
          );
        },
      },
    });
    const r = await tool.invoke({ query: "budget by:maya" }, ctx);
    expect(r).toEqual({
      kind: "error",
      code: "unsupported_filter",
      message: "the by:maya filter is not available",
    });
  });
});

describe("search_documents passes its own conversation to the port", () => {
  it("forwards the session id so the port can drop this conversation's own record", async () => {
    // Enforcement lives in the port, not in a tool argument: the model is
    // never given a way to opt out of it.
    let seen: SearchPortInput | undefined;
    const tool = createSearchDocumentsTool({
      port: port(async (input) => {
        seen = input;
        return { query: input.query, durationMs: 1, results: [] };
      }),
    });
    await tool.invoke({ query: "what did we decide" }, ctx);
    expect(seen?.currentConversationId).toBe("S");
  });

  it("exposes no conversation argument on the tool schema", () => {
    const tool = createSearchDocumentsTool({
      port: port(async () => ({ query: "", durationMs: 0, results: [] })),
    });
    expect(JSON.stringify(tool.schema)).not.toContain("currentConversationId");
  });
});
