// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { AnnotationList } from "./annotation-list.js";

// Headless VNode-expansion harness (same as metadata-panel.test.ts): no jsdom,
// so a function component expands recursively into a flat host-element list.
/* eslint-disable @typescript-eslint/no-explicit-any */
function expandToHostNodes(vnode: any, out: any[] = []): any[] {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") return out;
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") {
    return expandToHostNodes(vnode.type(vnode.props ?? {}), out);
  }
  out.push({ tag: vnode.type, class: vnode.props?.class ?? "", text: collectText(vnode.props?.children) });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children: any): string {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function") return collectText(children.props?.children);
  return "";
}

// AnnotationList is the shared renderer for the agent's durable observations —
// used by both the document metadata panel and the person "Profile" block.
// Person + document annotations carry the same wire shape.
describe("AnnotationList", () => {
  const ANN = {
    id: "panno_1",
    claimType: "residence",
    claimText: "Rents a one-bedroom flat in the city centre",
    evidenceDocId: "doc-evidence",
    evidenceQuote: "confirming you'll be the new tenant next month",
    confidence: 0.8,
    claimBasis: "inferred",
    createdAt: "2026-07-15T00:00:00.000Z",
    verificationState: "verified",
    lastVerifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  };

  test("renders the claim type, confidence, claim text, and evidence quote", () => {
    const nodes = expandToHostNodes(AnnotationList({ annotations: [ANN] }));
    expect(nodes.find((n) => n.class === "meta-enriched-value")?.text).toBe("residence");
    expect(nodes.find((n) => n.class === "meta-annotation-confidence")?.text.trim()).toBe("80%");
    expect(nodes.find((n) => n.class === "meta-annotation-claim")?.text).toBe(
      "Rents a one-bedroom flat in the city centre",
    );
    expect(nodes.find((n) => n.class.includes("meta-annotation-quote"))?.text).toContain(
      "confirming you'll be the new tenant next month",
    );
  });

  test("renders the claim-basis chip and the verification marker with recency", () => {
    const nodes = expandToHostNodes(AnnotationList({ annotations: [ANN] }));
    expect(nodes.find((n) => n.class === "meta-annotation-basis")?.text).toBe("inferred");
    const verify = nodes.find((n) => n.class === "meta-annotation-verify")?.text.trim();
    expect(verify).toContain("verified");
    expect(verify).toContain("2d ago");
  });

  test("a verification stamp without a check time renders the bare state", () => {
    const nodes = expandToHostNodes(
      AnnotationList({
        annotations: [{ ...ANN, verificationState: "unverified", lastVerifiedAt: null }],
      }),
    );
    const verify = nodes.find((n) => n.class === "meta-annotation-verify")?.text.trim();
    expect(verify).toBe("unverified");
  });

  test("legacy rows without basis or verification render neither marker", () => {
    const legacy = {
      ...ANN,
      claimBasis: undefined,
      verificationState: null,
      lastVerifiedAt: null,
    };
    const nodes = expandToHostNodes(AnnotationList({ annotations: [legacy] }));
    expect(nodes.find((n) => n.class === "meta-annotation-basis")).toBeUndefined();
    expect(nodes.find((n) => n.class === "meta-annotation-verify")).toBeUndefined();
    // The rest of the row still renders.
    expect(nodes.find((n) => n.class === "meta-annotation-claim")).toBeDefined();
  });

  test("an annotation without an evidence quote omits the quote row", () => {
    const nodes = expandToHostNodes(AnnotationList({ annotations: [{ ...ANN, evidenceQuote: "" }] }));
    expect(nodes.find((n) => n.class === "meta-annotation-claim")).toBeDefined();
    expect(nodes.find((n) => n.class?.includes("meta-annotation-quote"))).toBeUndefined();
  });

  test("empty list renders nothing", () => {
    expect(expandToHostNodes(AnnotationList({ annotations: [] }))).toHaveLength(0);
  });

  test("dependents render as a disclosure with count and cognition links", () => {
    const withDeps = {
      ...ANN,
      dependents: [
        { kind: "brief", id: "brief_1", title: "Practice day changed" },
        { kind: "loop", id: "loop_1", title: "Confirm the new practice day" },
      ],
    };
    const nodes = expandToHostNodes(AnnotationList({ annotations: [withDeps] }));
    const summary = nodes.find((n) => n.tag === "summary");
    expect(summary?.text.trim()).toBe("2 dependent outputs");
    const links = nodes.filter((n) => n.class === "meta-annotation-dependent");
    expect(links.map((l) => l.text.trim())).toEqual([
      "brief: Practice day changed",
      "loop: Confirm the new practice day",
    ]);
  });

  test("rows without dependents render no disclosure", () => {
    for (const annotations of [[ANN], [{ ...ANN, dependents: [] }]]) {
      const nodes = expandToHostNodes(AnnotationList({ annotations }));
      expect(nodes.find((n) => n.tag === "details")).toBeUndefined();
    }
  });
});
