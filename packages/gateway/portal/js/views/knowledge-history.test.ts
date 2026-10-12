// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — structural tests for plain-JS portal components.
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ values: [] }));
vi.mock("preact/hooks", async (original) => ({
  ...(await original()),
  useState: (initial) => [state.values.length ? state.values.shift() : initial, vi.fn()],
}));
import { KnowledgeHistoryRevision, knowledgeHistoryComparisons, knowledgeRevisionText } from "./knowledge-history.js";
import { PrivacyPolicyDiff } from "./policies/policy.js";
const revision = (number, text = `Draft ${number}`) => ({
  revision: number, previousRevision: number - 1, title: "Workshop reference",
  plainText: text, createdAt: 1, validity: "current", diff: { changedClaimIds: ["intro"] },
});
function nodes(value, result = []) {
  if (Array.isArray(value)) value.forEach((child) => nodes(child, result));
  else if (value && typeof value === "object") {
    result.push(value);
    nodes(value.props?.children, result);
  }
  return result;
}
beforeEach(() => { state.values = []; });

it("pairs the thirty displayed revisions with their exact predecessors, including the extra snapshot", () => {
  const history = Array.from({ length: 31 }, (_, index) => revision(40 - index));
  const comparisons = knowledgeHistoryComparisons(history);
  expect(comparisons).toHaveLength(30);
  expect(comparisons[0]).toEqual({ revision: history[0], previous: history[1] });
  expect(comparisons.at(-1)).toEqual({ revision: history[29], previous: history[30] });
  expect(knowledgeHistoryComparisons([revision(4), revision(2)])[0].previous).toBeUndefined();
  expect(knowledgeHistoryComparisons([revision(1)])[0].previous).toBeNull();
});
it("starts each diff collapsed and does not render the full snapshot or eagerly compute a diff", () => {
  const tree = KnowledgeHistoryRevision({ revision: revision(2), previous: revision(1) });
  const all = nodes(tree);
  expect(all.find((node) => node.type === "details").props.open).toBeUndefined();
  expect(all.some((node) => node.type === PrivacyPolicyDiff)).toBe(false);
  expect(JSON.stringify(tree)).not.toContain("Draft 2");
});
it("reuses the existing paginated diff with previous-to-current text and title", () => {
  state.values = [true, 1];
  const before = revision(1, "Earlier text");
  const after = { ...revision(2, "Revised text"), title: "Updated reference" };
  const diff = nodes(KnowledgeHistoryRevision({ revision: after, previous: before }))
    .find((node) => node.type === PrivacyPolicyDiff);
  expect(diff.props).toMatchObject({
    before: "# Workshop reference\n\nEarlier text", after: "# Updated reference\n\nRevised text",
    page: 1, label: "Changes in version 2",
  });
  expect(typeof diff.props.onPage).toBe("function");
});
it("treats the initial version as additions and missing predecessors honestly", () => {
  state.values = [true, 0];
  const initial = nodes(KnowledgeHistoryRevision({ revision: revision(1), previous: null }));
  expect(initial.find((node) => node.type === PrivacyPolicyDiff).props.before).toBe("");
  state.values = [true, 0];
  const missing = KnowledgeHistoryRevision({ revision: revision(5), previous: undefined });
  expect(nodes(missing).some((node) => node.type === PrivacyPolicyDiff)).toBe(false);
  expect(JSON.stringify(missing)).toContain("no longer available for comparison");
});
it("does not present unchanged content as additions", () => {
  state.values = [true, 0];
  const tree = KnowledgeHistoryRevision({ revision: revision(2, "Same text"), previous: revision(1, "Same text") });
  expect(nodes(tree).some((node) => node.type === PrivacyPolicyDiff)).toBe(false);
  expect(JSON.stringify(tree)).toContain("No title or text changes");
  expect(knowledgeRevisionText(null)).toBe("");
});

it.each([
  ['<claim id="intro" refs="source:first">Same text.</claim>', '<claim id="intro" refs="source:second">Same text.</claim>'],
  ['[Detail](wiki:first)', '[Detail](wiki:second)'],
])("shows exact stored support and navigation edits despite identical readable text", (before, after) => {
  state.values = [true, 0];
  const tree = KnowledgeHistoryRevision({
    previous: { ...revision(1, "Same text."), markdown: before },
    revision: { ...revision(2, "Same text."), markdown: after },
  });
  const diff = nodes(tree).find((node) => node.type === PrivacyPolicyDiff);
  expect(diff.props.before).toContain(before);
  expect(diff.props.after).toContain(after);
});
it("includes title-only changes", () => {
  state.values = [true, 0];
  const tree = KnowledgeHistoryRevision({
    previous: revision(1, "Same body"),
    revision: { ...revision(2, "Same body"), title: "Revised heading" },
  });
  const diff = nodes(tree).find((node) => node.type === PrivacyPolicyDiff);
  expect(diff.props.before).toContain("# Workshop reference");
  expect(diff.props.after).toContain("# Revised heading");
});


it.each([
  ["integrated", "connected"],
  ["standalone", "standalone"],
  ["deferred", "deferred"],
])("shows one compact %s placement judgment without expanding the diff", (status, label) => {
  const current = revision(2);
  current.diff.placementAssessment = { status, batchId: "private-batch-marker", reason: "private-reason-marker" };
  const tree = KnowledgeHistoryRevision({ revision: current, previous: revision(1) });
  const all = nodes(tree);
  const caption = all.find((node) => node.type === "p" && node.props.class === "kn-caption");
  expect(JSON.stringify(caption)).toContain(`Placement: ${label}`);
  expect(JSON.stringify(tree).match(/Placement:/g)).toHaveLength(1);
  expect(JSON.stringify(tree)).not.toContain("private-batch-marker");
  expect(JSON.stringify(tree)).not.toContain("private-reason-marker");
  expect(JSON.stringify(tree)).not.toContain("verified");
  expect(all.find((node) => node.type === "details").props.open).toBeUndefined();
  expect(all.some((node) => node.type === PrivacyPolicyDiff)).toBe(false);
});
it.each([undefined, { status: "unrecognized" }])("omits placement text without a recognized assessment", (assessment) => {
  const current = revision(2);
  current.diff.placementAssessment = assessment;
  expect(JSON.stringify(KnowledgeHistoryRevision({ revision: current, previous: revision(1) })))
    .not.toContain("Placement:");
});
