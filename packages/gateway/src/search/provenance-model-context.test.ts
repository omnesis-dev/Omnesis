// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { searchProvenanceSchema, type SearchProvenance } from "@omnesis/core";
import { provenanceModelContext } from "./provenance-model-context.js";

const copies = [
  {
    documentId: "a",
    sourceId: "archive:fictional",
    title: "Agreement",
    url: "https://example.org/a",
  },
  {
    documentId: "d",
    sourceId: "archive:fictional",
    title: "Local agreement",
    deviceName: "Example laptop",
    path: "Documents/agreement.pdf",
  },
];
const documents = new Map([
  ...copies.map((doc) => [doc.documentId, doc] as const),
  ...["b", "c", "e", "f", "g"].map(
    (id) =>
      [
        id,
        {
          documentId: id,
          sourceId: "archive:fictional",
          title: `Title ${id}`,
          url: `https://example.org/${id}`,
        },
      ] as const,
  ),
]);
function path(ids: string[], relations?: string[]): SearchProvenance["paths"][number] {
  return {
    documentIds: ids,
    edges: ids.slice(1).map(() => "outbound:url"),
    relations: relations ?? ids.slice(1).map(() => "links to"),
  };
}
function context(
  paths: SearchProvenance["paths"],
  options: {
    budget?: number;
    reasons?: SearchProvenance["stopReasons"];
    hubs?: string[];
    derived?: boolean;
  } = {},
) {
  return provenanceModelContext(
    "a",
    copies,
    paths,
    documents,
    new Map([["b", "participant: Jamie Lopez"]]),
    new Set(options.hubs),
    new Set(options.reasons),
    options.budget ?? 2000,
    options.derived,
  );
}

describe("prose-led graph facts", () => {
  it("lists other matching-text documents and anchors a physical location to its own ID", () => {
    const result = context([]);
    expect(result.facts).toEqual([
      "Matching extracted text also appears in [D2]. Byte identity has not been verified.",
      '[D2] is indexed on "Example laptop" at "Documents/agreement.pdf".',
    ]);
    expect(result.documents.map((doc) => [doc.ref, doc.documentId])).toEqual([
      ["D1", "a"],
      ["D2", "d"],
    ]);
    expect(result.documents[1].path).toBe("Documents/agreement.pdf");
  });
  it("merges same-subject branches and keeps participant evidence attached to the right document", () => {
    const result = context([path(["a", "b"], ["is linked from"]), path(["a", "c"])]);
    expect(result.facts).toContain("[D1] is linked from [D3] and links to [D4].");
    expect(result.facts).toContain("[D3] lists participant: Jamie Lopez.");
    expect(result.documents.find((doc) => doc.ref === "D3")?.documentId).toBe("b");
    expect(result.facts.join(" ")).not.toMatch(/originally|sent by|shared by/);
  });
  it("renders a genuine five-hop chain once rather than repeating every prefix", () => {
    const ids = ["a", "b", "c", "e", "f", "g"];
    const paths = ids.slice(1).map((_, index) => path(ids.slice(0, index + 2)));
    const result = context(paths);
    const graph = result.facts.filter((fact) => fact.includes("links to"));
    expect(graph).toEqual([
      "[D1] links to [D3], which links to [D4], which links to [D5], which links to [D6], which links to [D7].",
    ]);
  });
  it("never joins paths that merely share an endpoint", () => {
    const result = context([path(["a", "b"]), path(["d", "b", "c"])]);
    expect(result.facts).toContain("[D1] links to [D3].");
    expect(result.facts).toContain("[D2] links to [D3], which links to [D4].");
    expect(result.facts).not.toContain("[D1] links to [D3], which links to [D4].");
  });
  it("keeps attachment direction in prose and supplies its parent document URL", () => {
    const result = context([path(["d", "b"], ["is attached to"])]);
    expect(result.facts).toContain("[D2] is attached to [D3].");
    expect(result.documents.find((doc) => doc.ref === "D3")?.url).toBe("https://example.org/b");
  });
  it("explains a hub stop without inventing its unvisited neighbours", () => {
    const result = context([path(["a", "b"])], { hubs: ["b"], reasons: ["hub"] });
    expect(result.limits).toEqual([
      "Further connections of [D3] were not explored because they are highly connected.",
    ]);
    expect(result.documents.map((doc) => doc.documentId)).toEqual(["a", "d", "b"]);
    expect(result.facts.join(" ")).not.toContain("Title c");
  });
  it("does not cut sentences in half and explicitly qualifies budget and inventory limits", () => {
    const result = context([path(["a", "b", "c"])], {
      budget: 30,
      reasons: ["depth", "nodes", "copies"],
    });
    expect(result.facts.reduce((n, fact) => n + fact.length, 0)).toBeLessThanOrEqual(30);
    expect(result.limits.join(" ")).toMatch(/depth/);
    expect(result.limits.join(" ")).toMatch(/more copies or connections/);
    expect(result.limits.join(" ")).toMatch(/copy inventory was capped/);
    expect(result.limits.join(" ")).toMatch(/omitted or shortened/);
    expect(searchProvenanceSchema.shape.modelContext.parse(result)).toEqual(result);
  });
  it("keeps derived documents searchable without presenting their copied links as evidence", () => {
    const result = provenanceModelContext(
      "a",
      copies.slice(0, 1),
      [],
      documents,
      new Map(),
      new Set(),
      new Set(),
      2000,
      true,
    );
    expect(result.facts).toEqual([
      "This is Omnesis-generated context. Its document links are not independent evidence of sharing.",
    ]);
    expect(result.documents).toHaveLength(1);
  });
  it("does not create a graph assertion for a self-loop", () => {
    expect(context([path(["a", "a"])]).facts.some((fact) => fact.includes("links to"))).toBe(false);
  });
});
