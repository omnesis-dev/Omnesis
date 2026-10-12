// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { repairPageCitations } from "./answer-repair-citations.js";

const page = {
  documentId: "projection",
  nodeId: "prism",
  kind: "wiki",
  verifiedSupport: [{ ref: "wiki:prism#claim:inspection" }],
};

it.each(["wiki", "root"])("retains only exact current-owner claim links for %s", (kind) => {
  expect(repairPageCitations([{ ...page, kind }, page])).toEqual({
    pages: [
      {
        documentId: "projection",
        pageRef: "wiki:prism",
        supportedClaimRefs: ["wiki:prism#claim:inspection"],
      },
    ],
    incomplete: false,
  });
});

it.each([
  "wiki:another#claim:inspection",
  "loop:prism#claim:inspection",
  "wiki:prism",
  "wiki:prism#field:state",
  "https://example.com/wiki:prism",
  "wiki:prism#claim:inspection extra",
])("never derives a page handle from an invalid or foreign support ref: %s", (ref) => {
  expect(repairPageCitations([{ ...page, verifiedSupport: [{ ref }] }]).pages).toEqual([]);
});

it("requires a maintained-page identity and qualified support", () => {
  for (const change of [
    { nodeId: undefined },
    { nodeId: "wiki:prism" },
    { kind: "loop" },
    { documentId: "https://example.com" },
    { verifiedSupport: [] },
  ])
    expect(repairPageCitations([{ ...page, ...change }]).pages).toEqual([]);
});

it("bounds metadata bytes and input work without suggesting completeness", () => {
  const pages = Array.from({ length: 40 }, (_, i) => {
    const nodeId = `page_${i}_${"a".repeat(115)}`;
    return {
      documentId: `projection_${i}`,
      nodeId,
      kind: "wiki",
      verifiedSupport: Array.from({ length: 16 }, (_, j) => ({
        ref: `wiki:${nodeId}#claim:claim_${j}_${"b".repeat(115)}`,
      })),
    };
  });
  const result = repairPageCitations(pages);
  expect(result.incomplete).toBe(true);
  expect(result.pages.length).toBeGreaterThan(0);
  expect(result.pages.length).toBeLessThan(32);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_384);
  expect(repairPageCitations(Array(33).fill(page)).incomplete).toBe(true);
});

it("marks omitted references even when every inspected reference is ineligible", () => {
  expect(
    repairPageCitations([
      {
        ...page,
        verifiedSupport: [
          ...Array.from({ length: 16 }, () => ({ ref: "wiki:another#claim:inspection" })),
          ...page.verifiedSupport,
        ],
      },
    ]),
  ).toEqual({ pages: [], incomplete: true });
});
