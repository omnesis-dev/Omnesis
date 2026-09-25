// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
//
// Structural render test for the Cognition brief-detail "Asserted claims"
// section (BriefClaimList). Same headless VNode-expansion harness as
// cognition-doclist.test.ts: no jsdom — the component renders to its preact
// VNode tree, function components are recursively expanded into a flat
// host-element list, and the DOM shape is asserted:
//   - each claim renders its basis chip, verification marker, confidence %,
//     claim text, and evidence quote (annotation-list conventions);
//   - a null verification state (written with no verifier configured) hides
//     the marker, exactly like AnnotationList;
//   - the evidence document renders as a chip linking to /portal/doc/:id;
//   - an empty claim set renders a dash.
//
// All fixture data is invented; none comes from any real corpus.

import { describe, expect, it } from "vitest";

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

describe("Cognition brief detail — Asserted claims section render (BriefClaimList)", () => {
  it("renders basis chip, verification marker, confidence, claim text, quote, and the evidence doc link", async () => {
    const { BriefClaimList } = await import("./cognition.js");
    const claims = [
      {
        id: "bclaim_1",
        claimText: "the venue deposit was paid",
        claimBasis: "quoted",
        confidence: 0.8,
        verificationState: "verified",
        evidenceQuote: "we paid the venue deposit this morning",
        evidenceDoc: { id: "doc-1", title: null, sourceType: null },
      },
      {
        id: "bclaim_2",
        claimText: "the caterer expects a headcount by Friday",
        claimBasis: "inferred",
        confidence: 0.55,
        verificationState: "unverified",
        evidenceQuote: "could you confirm numbers by Friday",
        evidenceDoc: { id: "doc-2", title: null, sourceType: null },
      },
      {
        id: "bclaim_3",
        claimText: "the florist quote arrived on Tuesday",
        claimBasis: "quoted",
        confidence: 0.7,
        // Written with no verifier configured: no stamp, marker hidden.
        verificationState: null,
        evidenceQuote: "attached is our quote for the arrangements",
        evidenceDoc: { id: "doc-3", title: null, sourceType: null },
      },
    ];
    const nodes = expandToHostNodes(BriefClaimList({ claims }));

    // Three claim rows in annotation-list conventions.
    expect(nodes.filter((n) => n.class.includes("meta-annotation-head"))).toHaveLength(3);
    const bases = nodes.filter((n) => n.class.includes("meta-annotation-basis"));
    expect(bases.map((n) => n.text)).toEqual(["quoted", "inferred", "quoted"]);
    // The null-state claim renders NO verification marker (AnnotationList
    // convention: no gate ran, nothing to show).
    const verifies = nodes.filter((n) => n.class.includes("meta-annotation-verify"));
    expect(verifies.map((n) => n.text)).toEqual(["verified", "unverified"]);
    const confidences = nodes.filter((n) => n.class.includes("meta-annotation-confidence"));
    expect(confidences.map((n) => n.text)).toEqual(["80%", "55%", "70%"]);
    const texts = nodes.filter((n) => n.class.includes("meta-annotation-claim"));
    expect(texts.map((n) => n.text)).toEqual([
      "the venue deposit was paid",
      "the caterer expects a headcount by Friday",
      "the florist quote arrived on Tuesday",
    ]);
    const quotes = nodes.filter((n) => n.class.includes("meta-annotation-quote"));
    expect(quotes[0].text).toContain("we paid the venue deposit this morning");

    // Each evidence doc links to the portal doc route (title-less docs fall
    // back to the bare-id link, like every doc ref in this view).
    const links = nodes.filter((n) => n.href?.startsWith("/portal/doc/"));
    expect(links.map((n) => n.href)).toEqual([
      "/portal/doc/doc-1",
      "/portal/doc/doc-2",
      "/portal/doc/doc-3",
    ]);
  });

  it("renders a dash for an empty or absent claim set", async () => {
    const { BriefClaimList } = await import("./cognition.js");
    for (const claims of [[], undefined]) {
      const nodes = expandToHostNodes(BriefClaimList({ claims }));
      expect(nodes.find((n) => n.class.includes("cognition-id-empty"))).toBeDefined();
    }
  });
});
