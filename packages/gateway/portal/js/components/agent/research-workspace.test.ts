// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
//
// Structural render test for the bespoke research working-set surface
// (#748). There is no jsdom env / preact-render-to-string in this package,
// so we render the surface to its preact VNode tree and recursively expand
// the function-component VNodes (calling `type(props)` — every component
// here is a pure function of props) into a flat host-element tree. We then
// assert the bespoke class structure, that each researcher gets its own
// panel with its own source-tinted document chips, and that the accent is
// wired from the source registry — NOT the plain citation drawer re-skinned.
//
// This is the headless half of the visual self-critique: it pins the DOM
// shape and the source-tint classes. Pixel-level polish (spacing, motion,
// dark/light contrast) still needs operator browser QA — see the PR
// checklist.

import { describe, it, expect } from "vitest";
import { ResearchWorkspace } from "./parts.js";

// Recursively expand a VNode tree: invoke function components with their
// props (they're pure), flatten fragments/arrays, and collect every host
// (string-typed) node with its class + a shallow text projection.
function expandToHostNodes(vnode, out = []) {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") {
    if (out.__text != null) out.__text += String(vnode);
    return out;
  }
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") {
    // Expand the component one level by calling it with its props.
    const rendered = vnode.type(vnode.props ?? {});
    return expandToHostNodes(rendered, out);
  }
  // Host element (e.g. "div", "span", "a"): record it, then recurse.
  const node = {
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    style: vnode.props?.style ?? "",
    href: vnode.props?.href,
    dataSource: vnode.props?.["data-source"],
    text: collectText(vnode.props?.children),
  };
  out.push(node);
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

// Shallow text projection of a children tree (host + component text).
function collectText(children) {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function") return collectText(children.props?.children);
  return "";
}

function classesWith(nodes, fragment) {
  return nodes.filter((n) => typeof n.class === "string" && n.class.includes(fragment));
}

describe("ResearchWorkspace — structural render (#748)", () => {
  const twoPanels = [
    {
      subagentId: "r1",
      specialist: "history-sweep",
      title: "Budget history",
      task: "Sweep mail for the budget thread",
      status: null,
      stepCount: 3,
      tokens: 1200,
      summary: null,
      docs: [
        { documentId: "d-a", title: "Q4 budget review", sourceId: "alpha-mail:acct" },
        { documentId: "d-b", title: "Trip plan", sourceId: "beta-files:vol" },
      ],
    },
    {
      subagentId: "r2",
      specialist: "source-digest",
      title: "Drive digest",
      task: "Digest the shared drive",
      status: "complete",
      stepCount: 2,
      tokens: 800,
      summary: "Found the spec sheet.",
      docs: [{ documentId: "d-c", title: "Spec sheet", sourceId: "gamma-notes:db" }],
    },
  ];

  it("renders a dedicated workspace band, NOT a citation drawer", () => {
    const nodes = expandToHostNodes(ResearchWorkspace({ panels: twoPanels }));
    // The bespoke surface uses its own `research-*` class family.
    expect(classesWith(nodes, "research-workspace")).not.toHaveLength(0);
    expect(classesWith(nodes, "research-workspace-head")).not.toHaveLength(0);
    expect(classesWith(nodes, "research-workspace-rail")).not.toHaveLength(0);
    // It must NOT reuse the citation-drawer classes.
    expect(classesWith(nodes, "agent-cite")).toHaveLength(0);
  });

  it("renders one compact named worker chip per researcher", () => {
    const nodes = expandToHostNodes(ResearchWorkspace({ panels: twoPanels }));
    const workers = classesWith(nodes, "research-worker").filter(
      (n) => n.class.split(" ").includes("research-worker"),
    );
    expect(workers).toHaveLength(2);
    expect(workers.map((n) => n.text)).toEqual(["Budget history", "Drive digest"]);
  });

  it("does not render reader documents in the working set", () => {
    const nodes = expandToHostNodes(ResearchWorkspace({ panels: twoPanels }));
    expect(classesWith(nodes, "research-doc-chip")).toHaveLength(0);
  });

  it("encodes each worker's status on its chip", () => {
    const nodes = expandToHostNodes(ResearchWorkspace({ panels: twoPanels }));
    expect(classesWith(nodes, "research-worker-running")).not.toHaveLength(0);
    expect(classesWith(nodes, "research-worker-done")).not.toHaveLength(0);
  });

  it("does not add a document placeholder for a pending worker", () => {
    const onePending = [
      {
        subagentId: "r1",
        specialist: "history-sweep",
        title: "Sweep",
        task: "Sweep",
        status: null,
        stepCount: 0,
        tokens: 0,
        summary: null,
        docs: [],
      },
    ];
    const nodes = expandToHostNodes(ResearchWorkspace({ panels: onePending }));
    expect(classesWith(nodes, "research-worker")).toHaveLength(1);
    expect(classesWith(nodes, "research-doc-chip")).toHaveLength(0);
  });

  it("renders nothing for an empty panel set", () => {
    expect(ResearchWorkspace({ panels: [] })).toBeNull();
    expect(ResearchWorkspace({ panels: null })).toBeNull();
  });
});
