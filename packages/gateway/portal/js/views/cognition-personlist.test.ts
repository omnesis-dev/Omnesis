// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structural render coverage for the Cognition view's PersonList: an
 * enriched { id, name } ref renders the person's NAME linking to the
 * person page; a ref the backend could not resolve (name: null — e.g. a
 * legacy raw email) renders as plain text, never a dead person link.
 * Headless VNode-expansion harness (no jsdom), same as
 * cognition-doclist.test.ts.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import { PersonList } from "./cognition.js";

interface HostNode {
  tag: string;
  class: string;
  href: string;
  title: string;
  text: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- VNode expansion over untyped preact internals */
function expandToHostNodes(vnode: any, out: HostNode[] = []): HostNode[] {
  if (vnode == null || typeof vnode === "boolean" || typeof vnode === "string") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) expandToHostNodes(child, out);
    return out;
  }
  if (typeof vnode.type === "function") {
    expandToHostNodes(vnode.type(vnode.props), out);
    return out;
  }
  if (typeof vnode.type === "string") {
    out.push({
      tag: vnode.type,
      class: String(vnode.props?.class ?? ""),
      href: String(vnode.props?.href ?? ""),
      title: String(vnode.props?.title ?? ""),
      text: collectText(vnode),
    });
  }
  for (const child of [vnode.props?.children].flat(Infinity)) expandToHostNodes(child, out);
  return out;
}

function collectText(vnode: any): string {
  if (vnode == null || typeof vnode === "boolean") return "";
  if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
  if (Array.isArray(vnode)) return vnode.map(collectText).join("");
  if (typeof vnode.type === "function") return collectText(vnode.type(vnode.props));
  return collectText(vnode.props?.children);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("PersonList", () => {
  test("a resolved ref renders the person's name linking to the person page", () => {
    const nodes = expandToHostNodes(
      PersonList({ people: [{ id: "per-1", name: "Maya Reeves" }] }),
    );
    const link = nodes.find((n) => n.class.includes("cognition-person-chip"));
    expect(link).toBeDefined();
    expect(link!.href).toBe("/portal/people/per-1");
    expect(link!.text).toBe("Maya Reeves");
  });

  test("an unresolvable ref renders as plain text — never a dead person link", () => {
    const nodes = expandToHostNodes(
      PersonList({ people: [{ id: "ghost@example.com", name: null }] }),
    );
    const plain = nodes.find((n) => n.class.includes("cognition-person-unresolved"));
    expect(plain).toBeDefined();
    expect(plain!.text).toBe("ghost@example.com");
    // No anchor points at a person page for the unresolved value.
    expect(nodes.some((n) => n.tag === "a" && n.href.includes("ghost"))).toBe(false);
  });

  test("a plain-string ref falls back to the bare-id person link; empty renders a dash", () => {
    const nodes = expandToHostNodes(PersonList({ people: ["per-2"] }));
    const link = nodes.find((n) => n.tag === "a" && n.class.includes("cognition-id"));
    expect(link).toBeDefined();
    expect(link!.href).toBe("/portal/people/per-2");

    const empty = expandToHostNodes(PersonList({ people: [] }));
    expect(empty.some((n) => n.class.includes("cognition-id-empty"))).toBe(true);
  });
});
