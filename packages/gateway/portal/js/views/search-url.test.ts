// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — mounts the plain-JS portal search view in a lightweight DOM.
// The search page's address names its query: a link opens a search, and a
// search run on the page is written back to the address.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  search: vi.fn(),
  searchAgentContext: vi.fn(),
  getSearchReadiness: vi.fn(),
  getDocumentsPeopleBulk: vi.fn(),
  getDocumentSummariesBulk: vi.fn(),
  getPeople: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("../api.js", () => api);
vi.mock("../components/facets.js", () => ({ FacetPanel: () => null }));
vi.mock("../components/pipeline-debug.js", () => ({ PipelineDebug: () => null }));
vi.mock("../components/indexer-warming-card.js", () => ({ IndexerWarmingCard: () => null }));
import { SearchView } from "./search.js";

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

let host;
let replaceState;
beforeEach(() => {
  vi.resetAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    callback();
    return 1;
  });
  const cache = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
    removeItem: (key) => cache.delete(key),
  });
  vi.stubGlobal("location", { pathname: "/portal/search", search: "" });
  replaceState = vi.fn();
  vi.stubGlobal("history", { replaceState, pushState: vi.fn() });
  host = dom.document.querySelector("main");
  api.getSearchReadiness.mockResolvedValue({ indexer: { status: "ready" } });
  api.getPeople.mockResolvedValue({ people: [] });
  api.getStatus.mockResolvedValue({});
  api.getDocumentsPeopleBulk.mockResolvedValue({ docs: {} });
  api.search.mockImplementation(async (text) => ({ query: { original: text }, results: [] }));
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

describe("search page address", () => {
  it("runs the query the address names", async () => {
    await act(async () => {
      render(h(SearchView, { initialQuery: "dentist next month" }), host);
    });
    await flush();
    expect(api.search).toHaveBeenCalledWith("dentist next month", { verbose: false });
    expect(host.querySelector(".search-input").value).toBe("dentist next month");
  });

  it("writes a search run on the page to the address", async () => {
    await act(async () => {
      render(h(SearchView), host);
    });
    await flush();
    await act(async () => {
      const input = host.querySelector(".search-input");
      input.value = "invoice from March";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/portal/search?q=invoice%20from%20March");
  });

  it("leaves other addresses this view answers alone", async () => {
    vi.stubGlobal("location", { pathname: "/portal/unknown", search: "" });
    await act(async () => {
      render(h(SearchView, { initialQuery: "receipts last week" }), host);
    });
    await flush();
    expect(api.search).toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
