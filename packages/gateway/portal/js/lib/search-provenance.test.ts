// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS portal helpers.
import { graphRelation, provenanceLines, provenanceDocumentIds, provenancePanels } from "./search-provenance.js";

describe("structured graph sentences", () => {
  it("hydrates distinct identities only from bounded root, copy and path evidence", () => {
    expect(provenanceDocumentIds({ results: [
      { documentId: "unrelated" },
      { documentId: "root", provenance: { copies: [{ documentId: "copy" }], paths: [
        { documentIds: ["root", "message"] }, { documentIds: ["copy", "message"] },
      ] } },
    ] })).toEqual(["root", "copy", "message"]);
  });
  // Renders lines as text, with documents as their ids, for compact assertions.
  const text = (lines: Array<{ depth: number; parts: Array<{ text?: string; documentId?: string; more?: number }> }>) =>
    lines.map((line) => `${"  ".repeat(line.depth)}${line.parts.map((part) => part.documentId
      ? `${part.documentId}${part.more ? ` (+${part.more})` : ""}` : part.text).join("")}`);
  const step = (ids: string[], relations: string[]) => ({
    documentIds: ids, edges: relations.map(() => "outbound:references"), relations,
  });
  it("joins siblings that share a relation into one clause", () => {
    expect(text(provenanceLines({ paths: [
      step(["file", "message"], ["was attached to"]),
      step(["file", "message"], ["was attached to"]),
      step(["file", "catalogue"], ["links to"]),
      step(["file", "other"], ["links to"]),
    ] }))).toEqual(["file was attached to message and links to catalogue and other."]);
  });
  it("continues a single branch inline and says each route once", () => {
    const attached = "is attached to";
    const includes = "includes the attachment";
    const thread = "is in the same conversation as";
    expect(text(provenanceLines({ paths: [
      step(["doc", "mail", "pdf"], [attached, includes]),
      step(["doc", "mail", "logo1"], [attached, includes]),
      step(["doc", "mail", "reply", "signed"], [attached, thread, includes]),
      step(["doc", "mail", "later", "logo2"], [attached, thread, includes]),
    ] }))).toEqual([
      "doc is attached to mail, which:",
      "  includes the attachment pdf and logo1.",
      "  is in the same conversation as reply, which includes the attachment signed.",
      "  is in the same conversation as later, which includes the attachment logo2.",
    ]);
  });
  it("folds leaves that share a relation and a title into the first", () => {
    const titles: Record<string, string> = { logo1: "image001.png", logo2: "Image001.png", pdf: "Contract.pdf" };
    expect(text(provenanceLines({ paths: [
      step(["doc", "mail", "pdf"], ["is attached to", "includes the attachment"]),
      step(["doc", "mail", "logo1"], ["is attached to", "includes the attachment"]),
      step(["doc", "mail", "later", "logo2"], ["is attached to", "is in the same conversation as", "includes the attachment"]),
    ] }, (id: string) => titles[id]))).toEqual([
      "doc is attached to mail, which includes the attachment pdf and logo1 (+1) and is in the same conversation as later.",
    ]);
  });
  it("drops malformed and looping paths rather than inventing a connection", () => {
    expect(provenanceLines({ paths: [
      { documentIds: ["root", "email", "root"], edges: ["outbound:url", "outbound:url"] },
      { documentIds: ["root", "email", "map"], edges: ["outbound:url"] },
    ] })).toEqual([]);
  });
  it("folds names only within one root's tree", () => {
    const titles: Record<string, string> = { i1: "image001.png", i2: "image001.png" };
    expect(text(provenanceLines({ paths: [
      step(["a", "m1", "i1"], ["is attached to", "includes the attachment"]),
      step(["b", "m2", "i2"], ["is attached to", "includes the attachment"]),
    ] }, (id: string) => titles[id]))).toEqual([
      "a is attached to m1, which includes the attachment i1.",
      "b is attached to m2, which includes the attachment i2.",
    ]);
  });
  it("does not infer a chain from a shared target under a different root", () => {
    expect(text(provenanceLines({ paths: [
      { documentIds: ["a", "b"], edges: ["outbound:url"] },
      { documentIds: ["d", "b", "c"], edges: ["outbound:url", "outbound:references"] },
    ] }))).toEqual(["a links to b.", "d links to b, which references c."]);
  });
  it("keeps distinct directed meanings apart", () => {
    expect(text(provenanceLines({ paths: [
      { documentIds: ["a", "b", "c"], edges: ["outbound:url", "outbound:references"] },
      { documentIds: ["a", "b", "e"], edges: ["outbound:url", "inbound:references"] },
      { documentIds: ["a", "b", "f"], edges: ["inbound:url", "outbound:references"] },
    ] }))).toEqual([
      "a:",
      "  links to b, which references c and is referenced by e.",
      "  is linked from b, which references f.",
    ]);
  });
  it("keeps a real five-hop chain and its duplicate shorter prefixes in one fact", () => {
    const documentIds = ["a", "b", "c", "d", "e", "f"];
    const edges = ["outbound:url", "outbound:references", "outbound:replies-to", "part-of-thread", "calendar-event"];
    const paths = [2, 3, 4, 5, 6, 6].map((length) => ({ documentIds: documentIds.slice(0, length), edges: edges.slice(0, length - 1) }));
    expect(text(provenanceLines({ paths }))).toEqual([
      "a links to b, which references c, which replies to d, which shares a thread with e, which has an event connection with f.",
    ]);
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
