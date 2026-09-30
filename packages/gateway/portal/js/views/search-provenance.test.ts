// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — mounts the plain-JS portal search view in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  search: vi.fn(), searchAgentContext: vi.fn(), getSearchReadiness: vi.fn(),
  getDocumentsPeopleBulk: vi.fn(), getDocumentSummariesBulk: vi.fn(), getPeople: vi.fn(), getStatus: vi.fn(),
}));
vi.mock("../api.js", () => api);
vi.mock("../components/facets.js", () => ({ FacetPanel: () => null }));
vi.mock("../components/pipeline-debug.js", () => ({ PipelineDebug: () => null }));
vi.mock("../components/indexer-warming-card.js", () => ({ IndexerWarmingCard: () => null }));
import { SearchView } from "./search.js";

const copy = { documentId: "doc-copy", sourceId: "example-files:account", title: "Equipment agreement", deviceName: "Example laptop", path: "/Example/Agreement.pdf", url: "https://example.com/file", appUrl: "exampleapp://file" };
const evidence = {
  summary: "This agreement is stored on Example laptop and was shared in a conversation.",
  copies: [copy], paths: [{ documentIds: ["doc-copy", "doc-message"], edges: ["inbound:contains"] }],
  truncated: true, stopReasons: ["hub"],
};
const normal = (id = "doc-copy", title = "Equipment agreement") => ({ query: { original: "agreement" }, results: [{ documentId: id, sourceId: "example-files:account", title, chunkText: "Original ranked snippet", score: 0.7, documentType: "file" }] });
const diagnostic = (summary = evidence.summary) => ({ kind: "search.results", query: "agreement", durationMs: 1, results: [{ documentId: "doc-primary", provenance: { ...evidence, summary } }] });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

let host;
async function submit(text) {
  await act(async () => {
    const input = host.querySelector(".search-input");
    input.value = text;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
}
async function mount() { await act(async () => { render(h(SearchView), host); }); await flush(); }

beforeEach(() => {
  vi.resetAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 1; });
  const cache = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: (key) => cache.delete(key) });
  host = dom.document.querySelector("main");
  api.getSearchReadiness.mockResolvedValue({ indexer: { status: "ready" }, agentContextAvailable: true });
  api.getPeople.mockResolvedValue({ people: [] }); api.getStatus.mockResolvedValue({});
  api.getDocumentsPeopleBulk.mockResolvedValue({ docs: {} });
  api.getDocumentSummariesBulk.mockResolvedValue({ docs: { "doc-message": { id: "doc-message", title: "Sharing note", source_id: "example-messages:account" } } });
  api.search.mockResolvedValue(normal()); api.searchAgentContext.mockResolvedValue(diagnostic());
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

describe("direct search graph diagnostics", () => {
  it("preserves ordinary snippets and displays only additional human connections", async () => {
    await mount(); await submit("agreement");
    expect(api.search).toHaveBeenCalledWith("agreement", { verbose: false });
    expect(api.searchAgentContext).toHaveBeenCalledWith("agreement");
    expect(host.querySelector(".result-snippet").textContent).toBe("Original ranked snippet");
    const panel = host.querySelector(".search-provenance");
    const connection = panel.querySelector(".search-provenance-connection");
    const prose = connection.cloneNode(true);
    for (const icon of prose.querySelectorAll('.search-graph-document-icon[aria-hidden="true"]')) icon.remove();
    expect(prose.textContent).toBe("This document has related content in Sharing note.");
    const link = connection.querySelector("a");
    expect(link.getAttribute("href")).toBe("/portal/doc/doc-message");
    expect(link.firstElementChild.className).toBe("search-graph-document-icon");
    expect(link.firstElementChild.getAttribute("aria-hidden")).toBe("true");
    expect(link.lastElementChild.textContent).toBe("Sharing note");
    expect(panel.textContent).not.toContain("Other copies");
    expect(panel.textContent).not.toContain(evidence.summary);
    expect(panel.textContent).not.toContain("doc-message");
    expect(panel.textContent).not.toContain("inbound:contains");
    expect(panel.textContent).not.toContain("hub");
    expect(panel.closest("a")).toBeNull();
    expect(panel.querySelector("a .search-graph-document-icon")).not.toBeNull();
    expect(panel.querySelector("details")).toBeNull();
    expect(panel.textContent).not.toContain("context may be omitted");
  });
  it("uses exact hydrated identities without linking an unrelated same-title document", async () => {
    api.getDocumentSummariesBulk.mockResolvedValue({ docs: {
      "doc-message": { title: "Sharing note", source_id: "example-messages:account" },
      "unrelated-id": { title: "Sharing note", source_id: copy.sourceId },
    } });
    await mount(); await submit("agreement");
    expect(api.getDocumentSummariesBulk).toHaveBeenCalledWith(["doc-primary", "doc-copy", "doc-message"]);
    const panel = host.querySelector(".search-provenance");
    expect(panel.querySelector('a[href="/portal/doc/unrelated-id"]')).toBeNull();
    expect(panel.querySelectorAll('a[href="/portal/doc/doc-message"]')).toHaveLength(1);
    for (const link of panel.querySelectorAll(".search-graph-document")) {
      expect(link.firstElementChild.className).toBe("search-graph-document-icon");
      expect(link.firstElementChild.getAttribute("aria-hidden")).toBe("true");
      expect(link.lastElementChild.textContent).toBe("Sharing note");
    }
  });
  it("keeps failed hydration linked without displaying raw prose or IDs", async () => {
    api.getDocumentSummariesBulk.mockRejectedValue(new Error("Unavailable"));
    api.searchAgentContext.mockResolvedValue(diagnostic("Unknown title links to doc-message."));
    await mount(); await submit("agreement");
    const panel = host.querySelector(".search-provenance");
    expect(panel.textContent).not.toContain("Unknown title");
    expect(panel.textContent).not.toContain("doc-message");
    expect(panel.querySelector('a[href="/portal/doc/doc-message"]').textContent).toContain("Untitled document");
  });
  it("does not request or restore context without the server capability", async () => {
    api.getSearchReadiness.mockResolvedValue({ indexer: { status: "ready" } });
    sessionStorage.setItem("omnesis_search_cache", JSON.stringify({ query: "agreement", results: normal().results, response: normal() }));
    await mount(); await submit("agreement");
    expect(api.searchAgentContext).not.toHaveBeenCalled(); expect(host.querySelector(".search-provenance")).toBeNull();
  });
  it("shows one full panel for a copy family without grouping ordinary cards", async () => {
    const secondCopy = { ...copy, documentId: "doc-second", title: "Equipment agreement copy" };
    api.search.mockResolvedValue({ ...normal(), results: [...normal().results, ...normal("doc-second", secondCopy.title).results] });
    api.searchAgentContext.mockResolvedValue({ kind: "search.results", results: [{ documentId: "doc-primary", provenance: { ...evidence, copies: [copy, secondCopy], summary: "Matching indexed text; Shared in a conversation; Stored on a device" } }] });
    await mount(); await submit("agreement");
    expect([...host.querySelectorAll(".result-title")].map((title) => title.textContent)).toEqual(["Equipment agreement", secondCopy.title]);
    expect(host.querySelectorAll(".result-snippet")).toHaveLength(2);
    expect(host.querySelectorAll(".search-provenance")).toHaveLength(1);
    const panel = host.querySelector(".search-provenance");
    expect(host.querySelector(".search-provenance-shared")).toBeNull();
    expect(panel.textContent).toContain("The same text appears in 1 other document");
    expect(panel.querySelectorAll(".search-provenance-copies .search-graph-document")).toHaveLength(1);
    expect(panel.querySelector(".search-provenance-copies a").getAttribute("href")).toBe("/portal/doc/doc-second");
  });
  it("refetches restored results using their actual query instead of an edited input", async () => {
    const context = deferred();
    api.searchAgentContext.mockImplementationOnce(() => context.promise);
    sessionStorage.setItem("omnesis_search_cache", JSON.stringify({ query: "Unsubmitted draft", results: normal().results, response: normal() }));
    await mount();
    expect(api.searchAgentContext).toHaveBeenCalledWith("agreement");
    expect(api.search).not.toHaveBeenCalled();
    expect(host.querySelector(".search-input").value).toBe("Unsubmitted draft");
    expect(host.querySelector(".search-provenance")).toBeNull();
    await act(async () => { context.resolve(diagnostic()); });
    await flush();
    const panel = host.querySelector(".search-provenance");
    expect(panel.querySelector(".search-provenance-connection .search-graph-document-title").textContent).toBe("Sharing note");
    expect(panel.querySelector(".search-provenance-connection a").getAttribute("href")).toBe("/portal/doc/doc-message");
  });
  it("refreshes capability and discards in-flight context after a downgrade", async () => {
    const old = deferred(); api.searchAgentContext.mockImplementationOnce(() => old.promise);
    await mount(); await submit("first");
    api.getSearchReadiness.mockResolvedValue({ indexer: { status: "ready" } });
    await submit("second");
    await act(async () => { old.resolve(diagnostic("Stale enabled context")); }); await flush();
    expect(api.searchAgentContext).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".search-provenance")).toBeNull();
    expect(host.textContent).not.toContain("Stale enabled context");
    expect(host.querySelector(".result-card")).not.toBeNull();
  });
  it.each([403, 404, 405])("keeps ordinary results for unavailable diagnostic endpoint %i", async (status) => {
    api.searchAgentContext.mockRejectedValue(Object.assign(new Error("Unavailable"), { status }));
    await mount(); await submit("agreement");
    expect(host.querySelector(".result-card")).not.toBeNull();
    expect(host.querySelector(".search-error")).toBeNull(); expect(host.querySelector(".search-context-notice")).toBeNull();
  });
  it("reports other diagnostic failures without hiding successful search", async () => {
    api.searchAgentContext.mockRejectedValue(Object.assign(new Error("Private diagnostic body"), { status: 500 }));
    await mount(); await submit("agreement");
    expect(host.querySelector(".result-card")).not.toBeNull();
    expect(host.querySelector(".search-context-notice").textContent).toContain("Ordinary results are shown");
    expect(host.textContent).not.toContain("Private diagnostic body");
  });
  it("ignores previous-query diagnostics after a newer query wins", async () => {
    const old = deferred(); api.searchAgentContext.mockImplementationOnce(() => old.promise);
    await mount(); await submit("first");
    await submit("second");
    await act(async () => { old.resolve({ kind: "search.results", results: [{ documentId: "doc-copy", provenance: { ...evidence, paths: [{ documentIds: ["doc-copy", "doc-stale"], edges: ["outbound:url"] }] } }] }); }); await flush();
    expect(host.querySelector('a[href="/portal/doc/doc-stale"]')).toBeNull(); expect(host.textContent).toContain("Sharing note");
  });
  it("ignores previous ordinary results that resolve after a newer search", async () => {
    const old = deferred(); api.search.mockImplementationOnce(() => old.promise);
    await mount(); await submit("first"); await submit("second");
    await act(async () => { old.resolve(normal("doc-old", "Stale result")); }); await flush();
    expect(host.textContent).not.toContain("Stale result"); expect(api.searchAgentContext).toHaveBeenCalledTimes(1);
  });
  it("escapes relation text and rejects executable source links on other copies", async () => {
    const other = { ...copy, documentId: "doc-other", title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", appUrl: "data:text/html,unsafe" };
    api.searchAgentContext.mockResolvedValue({ kind: "search.results", results: [{ documentId: "doc-copy", provenance: {
      ...evidence, copies: [copy, other], paths: [{ documentIds: ["doc-copy", "doc-message"], edges: ["contains"], relations: ["<script>relation</script>"] }],
    } }] });
    await mount(); await submit("agreement");
    const panel = host.querySelector(".search-provenance");
    expect(panel.querySelector("img")).toBeNull(); expect(panel.querySelector("script")).toBeNull();
    expect(panel.textContent).toContain("<img src=x onerror=alert(1)>"); expect(panel.textContent).toContain("<script>relation</script>");
    expect([...panel.querySelectorAll("a")].every((link) => link.getAttribute("href").startsWith("/portal/doc/"))).toBe(true);
  });
});
