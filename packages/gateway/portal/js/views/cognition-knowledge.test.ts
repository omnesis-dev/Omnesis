// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — structural checks for the plain-JS portal renderer.
import { expect, it } from "vitest";
import { KnowledgeDetail, KnowledgeStatus, knowledgeReferenceHref } from "./cognition-knowledge.js";
import { resolveSection } from "./cognition.js";

function hosts(value, out = []) {
  if (value == null || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    value.forEach((child) => hosts(child, out));
    return out;
  }
  if (typeof value !== "object") return out;
  if (typeof value.type === "function") return hosts(value.type(value.props), out);
  out.push(value);
  hosts(value.props?.children, out);
  return out;
}
function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  return text(value.props?.children);
}
it("routes the inspector inside the existing experimental cognition area and encodes reference IDs", () => {
  expect(resolveSection("knowledge")).toBe("knowledge");
  expect(knowledgeReferenceHref("source:document/one#evidence:passage")).toBe(
    "/portal/doc/document%2Fone",
  );
  expect(knowledgeReferenceHref("wiki:project#claim:date")).toBe(
    "/portal/debug/cognition/knowledge/project",
  );
  expect(knowledgeReferenceHref("javascript:alert(1)")).toBeNull();
});
it("renders tagged provenance, exact claim revisions and history while treating generated markup as text", () => {
  const dangerous = '<script>alert("untrusted")</script>';
  const tree = KnowledgeDetail({
    node: {
      id: "root",
      kind: "root",
      title: "Orientation",
      revision: 3,
      meaningRevision: 2,
      validity: "stale",
      plainText: dangerous,
      markdown: `<claim id="date" refs="source:fixture">${dangerous}</claim>`,
      claims: [
        {
          id: "date",
          meaningRevision: 2,
          text: dangerous,
          verification: "stale",
          supportLogic: "all",
        },
      ],
      dependencies: [
        { claimId: "date", ref: "source:fixture", relation: "supports", inputVersion: "v2" },
      ],
      links: [{ fromId: "root", toId: "project", kind: "related_to" }],
      canonicalFields: {},
      metadata: {},
    },
    history: [
      {
        revision: 2,
        createdAt: 100,
        validity: "current",
        diff: { changedClaimIds: ["date"] },
        plainText: "Previous orientation.",
      },
    ],
  });
  const nodes = hosts(tree);
  expect(nodes.some((node) => node.type === "script" || node.props?.dangerouslySetInnerHTML)).toBe(
    false,
  );
  expect(nodes.some((node) => node.type === "pre" && text(node).includes(dangerous))).toBe(true);
  expect(nodes.filter((node) => node.type === "a").map((node) => node.props.href)).toEqual([
    "/portal/doc/fixture",
    "/portal/debug/cognition/knowledge/project",
  ]);
  expect(text(tree)).toContain("meaning 2");
  expect(text(tree)).toContain("Untagged text is unchecked context");
  expect(text(tree)).toContain("Previous orientation.");
});
it("shows actual pending work and discovery coverage without invented progress", () => {
  const tree = KnowledgeStatus({
    status: {
      cascades: { pending: 7 },
      work: [
        { count: 2, status: "pending", tier: "routine", reason: "source_changed", nextDueAt: 100 },
      ],
      coverage: [{ phase: "recent", status: "covered", count: 4, policyVersion: 1 }],
    },
  });
  expect(text(tree)).toContain("7 pending cascade steps");
  expect(text(tree)).toContain("2 pending");
  expect(text(tree)).toContain("4 subjects");
});
