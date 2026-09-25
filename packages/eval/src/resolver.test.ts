// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { expandWithContentHashSiblings, resolveSuite } from "./resolver.js";
import type { Suite } from "./types.js";

function suite(queries: Suite["queries"]): Suite {
  return {
    description: "t",
    version: 1,
    defaultTopK: 10,
    queries,
    sourcePath: "/tmp/x.yaml",
    sha256: "0".repeat(64),
  };
}

describe("resolveSuite", () => {
  it("returns docIds for every alias group with at least one match", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [
          { urls: ["https://example.com/a"] },
          { urls: ["https://example.com/b1", "https://example.com/b2"] },
        ],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(s, async () => {
      return new Map([
        ["https://example.com/a", ["doc-a"]],
        ["https://example.com/b2", ["doc-b"]],
      ]);
    });
    expect(result.resolvedDocIdGroups).toEqual([[["doc-a"], ["doc-b"]]]);
    expect(result.unresolved).toEqual([]);
  });

  it("flags every alias of an unresolved doc", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [{ urls: ["https://gone.example/x", "https://gone.example/y"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(s, async () => new Map());
    expect(result.resolvedDocIdGroups).toEqual([[[]]]);
    expect(result.unresolved).toEqual([
      { queryId: "q1", url: "https://gone.example/x" },
      { queryId: "q1", url: "https://gone.example/y" },
    ]);
  });

  it("partial alias resolution still counts the doc as resolved", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [{ urls: ["https://example.com/a", "https://example.com/b"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () => new Map([["https://example.com/b", ["doc-b"]]]),
    );
    expect(result.resolvedDocIdGroups).toEqual([[["doc-b"]]]);
    expect(result.unresolved).toEqual([]);
  });

  it("collects all matching ids when a URL resolves to several rows", async () => {
    // Gmail email + its attachment share a source_url.
    const s = suite([
      {
        id: "q1",
        query: "invoice",
        topK: 10,
        expectedDocs: [{ urls: ["https://mail.google.com/mail/u/0/#inbox/INV"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () =>
        new Map([
          ["https://mail.google.com/mail/u/0/#inbox/INV", ["doc-email", "doc-att-1", "doc-att-2"]],
        ]),
    );
    expect(result.resolvedDocIdGroups[0]![0]!.sort()).toEqual([
      "doc-att-1",
      "doc-att-2",
      "doc-email",
    ]);
  });

  it("reports expandedDocCount equal to resolvedDocs when no expansion runs", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [{ urls: ["https://example.com/a"] }, { urls: ["https://example.com/b"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(s, async () => {
      return new Map([
        ["https://example.com/a", ["doc-a"]],
        ["https://example.com/b", ["doc-b"]],
      ]);
    });
    expect(result.expandedDocCount).toBe(2);
  });

  it("auto-expands resolved groups via content-hash siblings when callback is provided", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        // Drive PDF; eval YAML lists just the one URL.
        expectedDocs: [{ urls: ["https://drive.google.com/file/d/PDF"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () => new Map([["https://drive.google.com/file/d/PDF", ["doc-drive"]]]),
      // doc-drive shares content_hash with doc-gmail-att.
      async (ids) => {
        const out = new Map<string, string[]>();
        for (const id of ids) {
          if (id === "doc-drive") out.set(id, ["doc-drive", "doc-gmail-att"]);
          else out.set(id, [id]);
        }
        return out;
      },
    );
    expect(result.resolvedDocIdGroups[0]![0]).toEqual(["doc-drive", "doc-gmail-att"]);
    expect(result.expandedDocCount).toBe(2);
  });

  it("sibling expansion never crosses alias-group boundaries", async () => {
    // Group A's doc shares a content_hash with a doc that ALSO happens
    // to share with Group B's doc — but the eval contract says each
    // group is a distinct "thing the user is looking for". The sibling
    // expansion must not merge them.
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [{ urls: ["https://example.com/a"] }, { urls: ["https://example.com/b"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () =>
        new Map([
          ["https://example.com/a", ["doc-a"]],
          ["https://example.com/b", ["doc-b"]],
        ]),
      // Sibling map says doc-a and doc-b BOTH have sibling doc-mystery,
      // but they're in different alias groups — the resolver must keep
      // them apart.
      async (ids) => {
        const out = new Map<string, string[]>();
        for (const id of ids) {
          if (id === "doc-a") out.set(id, ["doc-a", "doc-mystery-a"]);
          else if (id === "doc-b") out.set(id, ["doc-b", "doc-mystery-b"]);
          else out.set(id, [id]);
        }
        return out;
      },
    );
    // Each group expands independently — doc-a's group does NOT contain
    // doc-b or any of doc-b's siblings, and vice versa.
    expect(result.resolvedDocIdGroups[0]![0]).toEqual(["doc-a", "doc-mystery-a"]);
    expect(result.resolvedDocIdGroups[0]![1]).toEqual(["doc-b", "doc-mystery-b"]);
  });

  it("sibling expansion skips groups that didn't resolve", async () => {
    const s = suite([
      {
        id: "q1",
        query: "a",
        topK: 10,
        expectedDocs: [{ urls: ["https://gone.example/x"] }],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () => new Map(),
      async () => {
        throw new Error("getSiblings should not be called when nothing resolved");
      },
    );
    expect(result.resolvedDocIdGroups).toEqual([[[]]]);
    expect(result.expandedDocCount).toBe(0);
  });
});

describe("doctor-style end-to-end with content_hash collisions", () => {
  it("reports 3 expected → 3 resolved → 5 expanded when 2 docs each pick up 1 sibling", async () => {
    // Suite with 3 expected docs across 2 queries. Two of them happen
    // to be byte-identical with siblings in the index that the suite
    // doesn't mention.
    const s = suite([
      {
        id: "q1",
        query: "ticket",
        topK: 10,
        expectedDocs: [{ urls: ["https://drive.google.com/file/d/PDF-A"] }],
        unexpectedUrls: [],
      },
      {
        id: "q2",
        query: "english cert",
        topK: 10,
        expectedDocs: [
          { urls: ["https://drive.google.com/file/d/PDF-B"] },
          { urls: ["https://drive.google.com/file/d/PDF-C"] },
        ],
        unexpectedUrls: [],
      },
    ]);
    const result = await resolveSuite(
      s,
      async () =>
        new Map([
          ["https://drive.google.com/file/d/PDF-A", ["doc-A"]],
          ["https://drive.google.com/file/d/PDF-B", ["doc-B"]],
          ["https://drive.google.com/file/d/PDF-C", ["doc-C"]],
        ]),
      // doc-A has a Gmail sibling, doc-B does too, doc-C is alone.
      async (ids) => {
        const out = new Map<string, string[]>();
        for (const id of ids) {
          if (id === "doc-A") out.set(id, ["doc-A", "doc-A-gmail"]);
          else if (id === "doc-B") out.set(id, ["doc-B", "doc-B-gmail"]);
          else out.set(id, [id]);
        }
        return out;
      },
    );

    const totalExpected = s.queries.reduce((acc, q) => acc + q.expectedDocs.length, 0);
    const resolvedDocs = result.resolvedDocIdGroups.reduce(
      (acc, q) => acc + q.filter((g) => g.length > 0).length,
      0,
    );

    // 3 expected entries, 3 resolved, 5 expanded (3 originals + 2 siblings).
    expect(totalExpected).toBe(3);
    expect(resolvedDocs).toBe(3);
    expect(result.expandedDocCount).toBe(5);
    expect(result.unresolved).toEqual([]);
  });
});

describe("expandWithContentHashSiblings", () => {
  it("returns a deep copy when no siblings exist", async () => {
    const input = [[["doc-a"], ["doc-b"]]];
    const out = await expandWithContentHashSiblings(input, async (ids) => {
      return new Map(ids.map((id) => [id, [id]] as const));
    });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });

  it("appends siblings while preserving original order (self first)", async () => {
    const out = await expandWithContentHashSiblings(
      [[["doc-a"]]],
      async () => new Map([["doc-a", ["doc-a", "doc-b", "doc-c"]]]),
    );
    expect(out[0]![0]).toEqual(["doc-a", "doc-b", "doc-c"]);
  });

  it("dedupes when a sibling is already in the group", async () => {
    const out = await expandWithContentHashSiblings(
      [[["doc-a", "doc-b"]]],
      async () =>
        new Map([
          ["doc-a", ["doc-a", "doc-b"]],
          ["doc-b", ["doc-b", "doc-a"]],
        ]),
    );
    expect(out[0]![0]).toEqual(["doc-a", "doc-b"]);
  });

  it("batches a single getSiblings call across all resolved ids", async () => {
    let calls = 0;
    let receivedIds: readonly string[] | null = null;
    await expandWithContentHashSiblings([[["doc-a"], ["doc-b"]], [["doc-c"]]], async (ids) => {
      calls++;
      receivedIds = ids;
      return new Map(ids.map((id) => [id, [id]] as const));
    });
    expect(calls).toBe(1);
    expect(new Set(receivedIds!)).toEqual(new Set(["doc-a", "doc-b", "doc-c"]));
  });

  it("does not call getSiblings when there are no resolved docs", async () => {
    let called = false;
    await expandWithContentHashSiblings([[[]]], async () => {
      called = true;
      return new Map();
    });
    expect(called).toBe(false);
  });
});
