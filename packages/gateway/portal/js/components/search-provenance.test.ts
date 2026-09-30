// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — renders the plain-JS portal component in a lightweight DOM.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SearchProvenance } from "./search-provenance.js";

let host;
const root = { documentId: "root", title: "Equipment agreement", sourceId: "example-files:account" };
const copy = { documentId: "copy", title: "Agreement attachment", sourceId: "example-mail:account", deviceName: "Example laptop", path: "/Example/Agreement.pdf", url: "https://example.com/attachment", appUrl: "exampleapp://attachment" };
const documents = {
  message: { title: "Sharing note", source_id: "example-messages:account" },
  thread: { title: "Equipment discussion", source_id: "example-messages:account" },
  revision: { title: "Agreement revision", source_id: "example-files:account" },
};
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("main");
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });
const mount = (provenance, resultDocumentId = "root", knownDocuments = documents) => render(h(SearchProvenance, { provenance, resultDocumentId, documents: knownDocuments, panelId: "context" }), host);
// Decorative source icons are separate from the readable relationship and title.
function proseText(node) {
  const clone = node.cloneNode(true);
  for (const icon of clone.querySelectorAll(".search-graph-document-icon")) {
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.parentElement.className).toBe("search-graph-document");
    expect(icon.nextElementSibling.className).toBe("search-graph-document-title");
    icon.remove();
  }
  return clone.textContent;
}

it("hides singleton or self-only derived evidence entirely", () => {
  mount({ copies: [root], paths: [], summary: "Derived summary about this same document", truncated: true, stopReasons: ["hub"] });
  expect(host.children).toHaveLength(0);
});
it("describes one other copy and omits the visible document from locations", () => {
  mount({ copies: [root, copy], paths: [] });
  expect(host.textContent).toContain("The same text appears in 1 other document");
  expect(host.textContent).not.toContain("Equipment agreement");
  expect(host.textContent).not.toContain("Indexed locations");
  expect(host.querySelectorAll(".search-provenance-copies .search-graph-document")).toHaveLength(1);
  expect(host.textContent).toContain(copy.deviceName); expect(host.textContent).toContain(copy.path);
  expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/portal/doc/copy"]);
  expect(host.textContent).not.toContain("Open source"); expect(host.textContent).not.toContain("Open app");
});
it("shows a singleton physical location as one concise fact without listing itself", () => {
  mount({ copies: [copy], paths: [] }, "copy");
  expect(host.textContent).toBe(`This document is on ${copy.deviceName} at ${copy.path}.`);
  expect(host.querySelectorAll(".search-provenance-facts > li")).toHaveLength(1);
  expect(host.querySelector("a")).toBeNull();
});
it("lists only the other copies relative to the actual visible result", () => {
  const third = { ...root, documentId: "third", title: "Archived agreement" };
  mount({ copies: [root, copy, third], paths: [] }, "copy");
  expect(host.textContent).toContain("2 other documents");
  expect(host.textContent).not.toContain(copy.title);
  expect([...host.querySelectorAll(".search-provenance-copies .search-graph-document")].map((link) => link.getAttribute("href"))).toEqual(["/portal/doc/root", "/portal/doc/third"]);
});
it("shows attachment roles and deeper connections as prose without numbered roots or raw codes", () => {
  mount({ copies: [root], paths: [
    { documentIds: ["root", "message"], edges: ["inbound:contains"], relations: ["was attached to"] },
    { documentIds: ["root", "message", "thread"], edges: ["inbound:contains", "outbound:part-of-thread"], relations: ["was attached to", "belongs to"] },
  ], truncated: true, stopReasons: ["hub"] });
  expect(proseText(host)).toContain("This document was attached to Sharing note");
  expect(proseText(host)).toContain("This document was attached to Sharing note, which belongs to Equipment discussion");
  expect(host.querySelectorAll(".search-provenance-connection")).toHaveLength(1);
  expect(host.querySelector("details")).toBeNull();
  expect(host.querySelector("h2, h3, .search-provenance-heading")).toBeNull();
  expect(host.querySelector("ol")).toBeNull(); expect(host.querySelector("code")).toBeNull();
  expect(host.textContent.match(/This document/g)).toHaveLength(1);
  expect(host.textContent).not.toContain("inbound:contains"); expect(host.textContent).not.toContain("hub");
});
it("keeps two same-title evidenced IDs linked separately without title parsing", () => {
  mount({ copies: [root], paths: [
    { documentIds: ["root", "message"], edges: ["outbound:url"] },
    { documentIds: ["root", "thread"], edges: ["outbound:url"] },
  ] }, "root", { ...documents, thread: { ...documents.thread, title: documents.message.title } });
  const links = [...host.querySelectorAll(".search-provenance-connection a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/portal/doc/message", "/portal/doc/thread"]);
  expect(links.map((link) => link.lastElementChild.textContent)).toEqual(["Sharing note", "Sharing note"]);
  for (const link of links) expect(link.firstElementChild.className).toBe("search-graph-document-icon");
});
it("shows linked revisions as relationships rather than additional matching copies", () => {
  mount({ copies: [root], paths: [{ documentIds: ["root", "revision"], edges: ["outbound:references"], relations: ["has a revised version in"] }] });
  expect(proseText(host)).toContain("This document has a revised version in Agreement revision");
  expect(host.textContent).not.toContain("Other copies");
  expect(host.querySelector("a").getAttribute("href")).toBe("/portal/doc/revision");
});

it("shows at most five copy names and an exact known remainder without a generic limit warning", () => {
  const others = Array.from({ length: 8 }, (_, index) => ({ documentId: `copy-${index}`, title: `Agreement copy ${index}`, sourceId: "example-files:account" }));
  mount({ copies: [root, ...others], paths: [], truncated: true, stopReasons: ["nodes"] });
  expect(host.textContent).toContain("The same text appears in 8 other documents");
  expect(host.textContent).toContain("and 3 more");
  expect(host.textContent).not.toContain("at least");
  expect(host.textContent).not.toContain("Agreement copy 5");
  expect(host.querySelectorAll(".search-provenance-copies a")).toHaveLength(5);
  expect(host.querySelectorAll(".search-provenance-facts > li")).toHaveLength(1);
  expect(host.querySelector("details, h2, h3, .search-provenance-heading")).toBeNull();
  expect(host.textContent).not.toMatch(/indexed|extracted|omitted|bounded|Open source|Open app|Other copies|Connections/);
});
it("uses at least only when the server copy inventory itself was capped", () => {
  mount({ copies: [root, copy], paths: [], truncated: true, stopReasons: ["copies"] });
  expect(host.textContent).toContain("The same text appears in at least 1 other document");
  expect(host.textContent).not.toContain("omitted");
});
it("joins independent same-subject connections with and rather than inventing a which chain", () => {
  mount({ copies: [root], paths: [
    { documentIds: ["root", "message"], edges: ["inbound:url"] },
    { documentIds: ["root", "thread"], edges: ["outbound:url"] },
  ] });
  expect(host.querySelectorAll(".search-provenance-connection")).toHaveLength(1);
  expect(proseText(host)).toContain("This document is linked from Sharing note and links to Equipment discussion");
  expect(host.textContent).not.toContain("which");
});
it("renders a true five-hop chain as one flat visible fact", () => {
  const ids = ["root", "message", "thread", "revision", "four", "five"];
  const edges = Array(5).fill("outbound:url");
  mount({ copies: [root], paths: [2, 3, 4, 5, 6].map((length) => ({ documentIds: ids.slice(0, length), edges: edges.slice(0, length - 1) })) }, "root", {
    ...documents, four: { title: "Supporting schedule" }, five: { title: "Project appendix" },
  });
  expect(host.querySelectorAll(".search-provenance-connection")).toHaveLength(1);
  expect(host.textContent.match(/which/g)).toHaveLength(4);
  expect(host.textContent.match(/This document/g)).toHaveLength(1);
  expect(host.querySelector("details, ol")).toBeNull();
  expect([...host.querySelectorAll(".search-provenance-connection a")].map((link) => link.getAttribute("href"))).toEqual(ids.slice(1).map((id) => `/portal/doc/${id}`));
});
it("links the exact other-copy root instead of assigning its connection to this document", () => {
  mount({ copies: [root, copy], paths: [{ documentIds: ["copy", "message"], edges: ["inbound:contains"], relations: ["was attached to"] }] });
  const fact = host.querySelector(".search-provenance-connection");
  expect(proseText(fact)).toContain("Agreement attachment was attached to Sharing note");
  expect(fact.textContent).not.toContain("This document");
  expect(fact.querySelector("a").getAttribute("href")).toBe("/portal/doc/copy");
});
