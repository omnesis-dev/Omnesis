// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS portal helpers.
import { graphRelation, provenanceSentences, provenanceDocumentIds, provenancePanels } from "./search-provenance.js";

describe("structured graph sentences", () => {
  it("hydrates distinct identities only from bounded root, copy and path evidence", () => {
    expect(provenanceDocumentIds({ results: [
      { documentId: "unrelated" },
      { documentId: "root", provenance: { copies: [{ documentId: "copy" }], paths: [
        { documentIds: ["root", "message"] }, { documentIds: ["copy", "message"] },
      ] } },
    ] })).toEqual(["root", "copy", "message"]);
  });
  it("joins same-subject one-hop clauses and keeps distinct directed meanings", () => {
    expect(provenanceSentences({ paths: [
      { documentIds: ["file", "message"], edges: ["inbound:contains"], relations: ["was attached to"] },
      { documentIds: ["file", "message"], edges: ["inbound:contains"], relations: ["was attached to"] },
      { documentIds: ["file", "catalogue"], edges: ["outbound:url"] },
    ] })).toEqual([{ root: "file", steps: [], clauses: [
      { documentId: "message", relation: "was attached to" }, { documentId: "catalogue", relation: "links to" },
    ] }]);
  });
  it("does not infer a chain from a shared target under a different root", () => {
    expect(provenanceSentences({ paths: [
      { documentIds: ["a", "b"], edges: ["outbound:url"] },
      { documentIds: ["d", "b", "c"], edges: ["outbound:url", "outbound:references"] },
    ] })).toEqual([
      { root: "a", steps: [], clauses: [{ documentId: "b", relation: "links to" }] },
      { root: "d", steps: [{ documentId: "b", relation: "links to" }], clauses: [{ documentId: "c", relation: "references" }] },
    ]);
  });
  it("merges only identical direction and relation prefixes before joining leaf clauses", () => {
    const sentences = provenanceSentences({ paths: [
      { documentIds: ["a", "b", "c"], edges: ["outbound:url", "outbound:references"] },
      { documentIds: ["a", "b", "e"], edges: ["outbound:url", "inbound:references"] },
      { documentIds: ["a", "b", "f"], edges: ["inbound:url", "outbound:references"] },
    ] });
    expect(sentences).toEqual([
      { root: "a", steps: [{ documentId: "b", relation: "links to" }], clauses: [
        { documentId: "c", relation: "references" }, { documentId: "e", relation: "is referenced by" },
      ] },
      { root: "a", steps: [{ documentId: "b", relation: "is linked from" }], clauses: [{ documentId: "f", relation: "references" }] },
    ]);
  });
  it("keeps a real five-hop chain and its duplicate shorter prefixes in one fact", () => {
    const documentIds = ["a", "b", "c", "d", "e", "f"];
    const edges = ["outbound:url", "outbound:references", "outbound:replies-to", "part-of-thread", "calendar-event"];
    const paths = [2, 3, 4, 5, 6, 6].map((length) => ({ documentIds: documentIds.slice(0, length), edges: edges.slice(0, length - 1) }));
    expect(provenanceSentences({ paths })).toEqual([{ root: "a", steps: [
      { documentId: "b", relation: "links to" }, { documentId: "c", relation: "references" },
      { documentId: "d", relation: "replies to" }, { documentId: "e", relation: "shares a thread with" },
    ], clauses: [{ documentId: "f", relation: "has an event connection with" }] }]);
  });
  it("does not create a panel for a self-only derived summary or self-loop", () => {
    const provenance = { copies: [{ documentId: "root" }], summary: "Derived summary with no new facts", paths: [{ documentIds: ["root", "root"], edges: ["references"] }] };
    expect(Object.keys(provenancePanels([{ documentId: "root" }], { root: provenance }))).toEqual([]);
  });
  it.each([
    ["outbound:url", "links to"], ["inbound:url", "is linked from"],
    ["inbound:references", "is referenced by"], ["outbound:replies-to", "replies to"],
    ["inbound:replies-to", "has a reply from"], ["outbound:part-of-thread", "shares a thread with"],
    ["calendar-event", "has an event connection with"], ["inbound:contains", "has related content in"],
    ["outbound:contains", "has related content in"], ["revision-of", "is another version of"],
    ["unrecognized-code", "is connected to"],
  ])("uses human fallback for %s", (edge, expected) => { expect(graphRelation(edge)).toBe(expected); });
});
