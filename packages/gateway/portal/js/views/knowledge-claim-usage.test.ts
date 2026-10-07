// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain JavaScript portal module.
import { claimUsageGroups } from "./knowledge-claim-usage.js";

const support = {
  direction: "incoming",
  relationship: "supports",
  dependency: true,
  node: { id: "wiki-project", kind: "wiki", title: "Project plan" },
  claimId: "consumer-claim",
  targetClaimId: "schedule",
  ref: "wiki:wiki-current#claim:schedule",
};

it("separates exact claim consumers from whole-page consumers and deduplicates each", () => {
  const wholePage = { ...support, targetClaimId: null, ref: "wiki:wiki-current" };
  const groups = claimUsageGroups(
    [
      support,
      { ...support, claimId: "another-consumer-claim" },
      wholePage,
      { ...wholePage, claimId: "another-page-consumer" },
    ],
    "schedule",
  );
  expect(groups.claim).toHaveLength(1);
  expect(groups.page).toHaveLength(1);
  expect(groups.claim[0].node.id).toBe("wiki-project");
  expect(groups.page[0].node.id).toBe("wiki-project");
});

it("excludes outgoing, unrelated, organization and field-selector edges", () => {
  const edges = [
    { ...support, direction: "outgoing" },
    { ...support, dependency: false, claimId: null, ref: null },
    { ...support, targetClaimId: "other" },
    { ...support, targetClaimId: null, ref: "wiki:wiki-current#field:deadline" },
    { ...support, targetClaimId: null, ref: "wiki:wiki-current#claim:schedule" },
    { ...support, targetClaimId: null, ref: null },
    { ...support, targetClaimId: null, ref: "" },
  ];
  expect(claimUsageGroups(edges, "schedule")).toEqual({ claim: [], page: [] });
});

it("never mistakes missing claim identity for an exact claim match", () => {
  const wholePage = { ...support, targetClaimId: null, ref: "wiki:wiki-current" };
  expect(claimUsageGroups([support, wholePage], null)).toEqual({ claim: [], page: [wholePage] });
});

it("includes context references as well as maintenance dependencies", () => {
  const context = { ...support, relationship: "context", dependency: false };
  expect(claimUsageGroups([context], "schedule").claim).toEqual([context]);
});
