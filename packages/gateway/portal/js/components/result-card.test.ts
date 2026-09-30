// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — renders the plain-JS search card in a lightweight DOM.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultCard } from "./result-card.js";

let host;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main");
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

it("presents the indexed snippet as a quote while retaining its result link and score", () => {
  render(h(ResultCard, { result: {
    documentId: "doc-example", sourceId: "example-notes:account", title: "Equipment plan",
    chunkText: "<script>example</script> quoted evidence", score: 0.7,
  } }), host);
  expect(host.querySelector("blockquote.result-snippet").textContent).toBe("<script>example</script> quoted evidence");
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector(".result-card").getAttribute("href")).toBe("/portal/doc/doc-example");
  expect(host.querySelector(".result-score").textContent).toBe("70%");
});

it("retains the snippet length bound inside the quote", () => {
  render(h(ResultCard, { result: { documentId: "doc-example", chunkText: "a".repeat(400) } }), host);
  expect(host.querySelector("blockquote.result-snippet").textContent).toBe(`${"a".repeat(300)}...`);
});

