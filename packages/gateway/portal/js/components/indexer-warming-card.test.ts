// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer in a lightweight DOM.
import { parseHTML } from "linkedom";
import { h, render } from "preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexerWarmingCard } from "./indexer-warming-card.js";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => ({ navigate }));

let host;
beforeEach(() => {
  const { document } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", document);
  host = document.querySelector("main");
  navigate.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

function show(indexer) {
  render(h(IndexerWarmingCard, { readiness: { indexer } }), host);
}

it("explains keyword-only search and links directly to embedding settings", () => {
  show({
    status: "disabled",
    reason: "Embedder assignment disabled; keyword indexing active",
    keywordIndexingActive: true,
  });

  expect(host.textContent).toContain("Keyword-only search");
  expect(host.textContent).not.toContain("INDEXER ERROR");
  expect(host.textContent).not.toContain("Embedder assignment disabled");
  const link = host.querySelector("a");
  expect(link.textContent).toBe("Set up an embedding model");
  expect(link.getAttribute("href")).toBe("/portal/settings/models/embedder");
  link.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/models/embedder");
});

it("offers setup when the assigned model file is missing", () => {
  show({ status: "disabled", reason: "Embedding model not found at /models/example.gguf" });

  expect(host.textContent).toContain("Embedding model missing");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/portal/settings/models/embedder");
});

it("keeps the cause of an unavailable model in collapsed details", () => {
  show({
    status: "disabled",
    reason: "Assigned model cannot be used for embedding; keyword indexing active",
    keywordIndexingActive: true,
  });

  const details = host.querySelector("details");
  expect(details.hasAttribute("open")).toBe(false);
  expect(details.querySelector("pre").textContent).toBe("Assigned model cannot be used for embedding");
});

it.each([
  { status: "disabled", reason: "OMNESIS_INDEXER_ENABLED=false" },
  { status: "failed", reason: "Could not open index database" },
])("keeps diagnostics when the indexer is $status without keyword indexing", (indexer) => {
  show(indexer);

  expect(host.textContent).toContain("INDEXER ERROR");
  expect(host.textContent).toContain(indexer.reason);
  expect(host.querySelector("a")).toBeNull();
});
