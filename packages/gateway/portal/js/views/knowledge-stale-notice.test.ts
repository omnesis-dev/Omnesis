// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
// @ts-expect-error Plain-JavaScript portal module.
import { KnowledgeStaleNotice } from "./knowledge-stale-notice.js";

function markup(causes: unknown): string {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  try {
    const root = document.createElement("div");
    render(h(KnowledgeStaleNotice, { causes }), root);
    return root.innerHTML;
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

it("lists the changed documents and pages with links, and a gone document without one", () => {
  const html = markup({
    total: 3,
    reason: null,
    items: [
      { kind: "source", id: "doc 1", title: "Workshop agenda", sourceId: "notes:test", change: "changed" },
      { kind: "source", id: "doc_gone", title: null, sourceId: null, change: "deleted" },
      { kind: "node", id: "wiki_plan", nodeKind: "wiki", title: "Workshop plan", change: "owner_changed" },
    ],
  });
  expect(html).toContain("Supporting information that changed:");
  expect(html).toContain('href="/portal/doc/doc%201"');
  expect(html).toContain("Workshop agenda");
  expect(html).toContain("A document that is no longer available");
  expect(html).not.toContain("doc_gone");
  expect(html).toContain('href="/portal/debug/cognition/knowledge/wiki_plan"');
  expect(html).toContain("updated, not yet reflected here");
  expect(html).not.toContain("more</p>");
});

it("counts the records past the listed ones", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    kind: "source",
    id: `doc_${index}`,
    title: `Note ${index}`,
    sourceId: null,
    change: "changed",
  }));
  expect(markup({ total: 14, reason: null, items })).toContain("and 4 more");
});

it("explains a stale page with no changed records in plain words", () => {
  const html = markup({ total: 0, reason: "claims_pending", items: [] });
  expect(html).toContain("some of its claims are waiting to be verified again");
  expect(html).not.toContain("Supporting information that changed:");
  expect(markup({ total: 0, reason: "withdrawn", items: [] })).toContain("was withdrawn");
});

it("keeps the notice when the causes are not available", () => {
  expect(markup(null)).toContain("Some context needs another look.");
});
