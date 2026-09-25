// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
//
// Structural render test for the Cognition loop-detail Documents section.
// Uses a headless VNode-expansion harness: there is
// no jsdom env, so we render the component to its preact VNode tree and
// recursively expand the function-component VNodes into a flat host-element
// tree, then assert the DOM shape:
//   - each enriched doc renders its source ICON (from the registry via
//     `sourceIconUrl`, no hardcoded glyph) + its TITLE, linking to
//     /portal/doc/:id;
//   - a doc with no title (deleted / never ingested) falls back to the bare
//     id link.
//
// All fixture data is invented; none comes from any real corpus.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

// loadSourceMeta pulls /portal/source-meta.json (synced map) and
// /admin/source-descriptors (provider descriptors). Route by URL so the
// module-private _metaCache is seeded with a known source icon.
function mockMetaFetch(descriptorItems) {
  return async (url) => {
    if (typeof url === "string" && url.includes("source-meta.json")) {
      return { ok: true, json: async () => ({}) };
    }
    if (typeof url === "string" && url.includes("/admin/source-descriptors")) {
      return { ok: true, json: async () => ({ items: descriptorItems }) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

function expandToHostNodes(vnode, out = []) {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") return out;
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") {
    const rendered = vnode.type(vnode.props ?? {});
    return expandToHostNodes(rendered, out);
  }
  out.push({
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    href: vnode.props?.href,
    src: vnode.props?.src,
    text: collectText(vnode.props?.children),
  });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children) {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function")
    return collectText(children.props?.children);
  return "";
}

describe("Cognition loop detail — Documents section render (DocList)", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders each doc as [source icon] + title linking to /portal/doc/:id; a missing title falls back to the bare id", async () => {
    // Prime the source-meta cache so sourceIconUrl resolves a real icon.
    globalThis.fetch = mockMetaFetch([
      { id: "alpha-mail", name: "Alpha webmail", icon: { imageDataUri: PNG_DATA_URI } },
    ]);
    const format = await import("../lib/format.js");
    await format.loadSourceMeta();

    const { DocList } = await import("./cognition.js");
    const docs = [
      { id: "doc-1", title: "Booking confirmation for a studio session", sourceType: "alpha-mail" },
      { id: "doc-missing", title: null, sourceType: null },
    ];
    const nodes = expandToHostNodes(DocList({ docs }));

    // The enriched doc renders as a titled chip linking to the doc page…
    const chip = nodes.find((n) => n.class.includes("cognition-doc-chip"));
    expect(chip).toBeDefined();
    expect(chip.href).toBe("/portal/doc/doc-1");
    expect(chip.text).toContain("Booking confirmation for a studio session");
    // …with its source icon sourced from the registry (not a hardcoded glyph).
    const icon = nodes.find((n) => n.tag === "img" && n.class.includes("source-icon"));
    expect(icon).toBeDefined();
    expect(icon.src).toBe(PNG_DATA_URI);

    // The missing doc falls back to the bare-id link, still to the doc page.
    const idFallback = nodes.find(
      (n) => n.class.includes("cognition-id") && n.text === "doc-missing",
    );
    expect(idFallback).toBeDefined();
    expect(idFallback.href).toBe("/portal/doc/doc-missing");

    // The enriched doc is NOT rendered as a bare id.
    expect(nodes.find((n) => n.class.includes("cognition-id") && n.text === "doc-1")).toBeUndefined();
  });

  it("renders a dash for an empty document list", async () => {
    const { DocList } = await import("./cognition.js");
    const nodes = expandToHostNodes(DocList({ docs: [] }));
    expect(nodes.find((n) => n.class.includes("cognition-id-empty"))).toBeDefined();
  });
});
