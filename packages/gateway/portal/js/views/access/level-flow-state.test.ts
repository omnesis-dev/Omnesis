// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — Portal modules are JavaScript.
import { levelDecisionPath, changedLevelDecisions, sourceBoundarySummary } from "./level-flow-state.js";
// @ts-expect-error — Portal modules are JavaScript.
import { levelDecisions, levelSourceInventory } from "./level-flow-state.js";
// @ts-expect-error — Portal modules are JavaScript.
import { newGrantRule } from "../../components/grant-builder-state.js";
const answer = {
  ...newGrantRule("answer", "invented-policy"),
  sources: { mode: "allowlist", sourceIds: ["fictional:one"] },
};
const direct = { ...newGrantRule("direct"), sources: { ...answer.sources } };
const sources = [{ id: "fictional:one", displayName: "Invented account" }];
test("create path includes only relevant decisions, keeping the name and final save at review", () => {
  expect(levelDecisionPath({ notes: newGrantRule("notes") })).toEqual(["permissions", "review"]);
  expect(levelDecisionPath({ answer })).toEqual([
    "permissions",
    "answer-data",
    "future",
    "release",
    "review",
  ]);
  expect(levelDecisionPath({ direct })).toEqual(["permissions", "direct-data", "future", "review"]);
  expect(levelDecisionPath({ answer, direct }, true)).toEqual([
    "permissions",
    "answer-data",
    "direct-choice",
    "direct-data",
    "future",
    "release",
    "review",
  ]);
});
test("a release-only edit yields a paired release delta without repeating unchanged source decisions", () => {
  const before = { answer, direct },
    after = { answer: { ...answer, release: { mode: "unreviewed" } }, direct };
  expect(changedLevelDecisions(before, after, sources)).toEqual(["release"]);
  expect(before.answer.release).toEqual({ mode: "reviewed", policyFamilyId: "invented-policy" });
});
test("future account changes remain separate from the same current account selection", () => {
  const before = { answer },
    after = { answer: { ...answer, sources: { mode: "all", sourceIds: [] } } };
  expect(changedLevelDecisions(before, after, sources)).toEqual(["future"]);
});
test("retained and advanced restrictions are never described as all-content access", () => {
  const filtered = {
    ...answer,
    scopePolicies: [
      {
        sourceId: "fictional:one",
        audience: { accessLevel: "new", capability: "answer" },
        rules: [{ action: "share", match: [{ capability: "membership", field: "extra.labelIds", id: "invented" }] }],
        otherwise: "hide",
      },
    ],
  };
  expect(sourceBoundarySummary(filtered, sources[0])).toBe("Share matching content · 1 item");
  expect(
    sourceBoundarySummary(
      {
        ...filtered,
        scopePolicies: [
          {
            ...filtered.scopePolicies[0],
            rules: [...filtered.scopePolicies[0]!.rules, { action: "hide", match: [] }],
          },
        ],
      },
      sources[0],
    ),
  ).toBe("Saved filter");
});

test("newly granted Answer exposes inherited automatic future access in the change review", () => {
  const automatic = { ...direct, sources: { mode: "all", sourceIds: [] } };
  const inherited = { ...answer, sources: { ...automatic.sources } };
  expect(
    changedLevelDecisions({ direct: automatic }, { answer: inherited, direct: automatic }, sources),
  ).toContain("future");
});
test("the same number of selected matches with different identities is a data change", () => {
  const policy = (id: string) => ({
    sourceId: "fictional:one",
    audience: { accessLevel: "new", capability: "answer" },
    rules: [{ action: "share", match: [{ capability: "membership", field: "extra.labelIds", id }] }],
    otherwise: "hide",
  });
  expect(
    changedLevelDecisions(
      { answer: { ...answer, scopePolicies: [policy("earlier")] } },
      { answer: { ...answer, scopePolicies: [policy("later")] } },
      sources,
    ),
  ).toEqual(["answer-data"]);
});

test("renamed participant snapshots and reordered selections do not appear as changed access decisions", () => {
  const ref = {
    capability: "person",
    label: "Old snapshot",
    identifiers: [
      { type: "email", value: "one@example.org" },
      { type: "email", value: "two@example.org" },
    ],
  };
  const policy = {
    sourceId: sources[0]!.id,
    audience: { accessLevel: "invented-level", capability: "answer" },
    rules: [{ action: "share", match: [ref, { capability: "membership", field: "extra.labelIds", id: "invented-label" }] }],
    otherwise: "hide",
  };
  const before = { answer: { ...answer, scopePolicies: [policy] } };
  const after = {
    answer: {
      ...before.answer,
      scopePolicies: [
        {
          ...policy,
          rules: [
            {
              ...policy.rules[0]!,
              match: [
                { capability: "membership", field: "extra.labelIds", id: "invented-label" },
                { ...ref, label: "New snapshot", identifiers: [...ref.identifiers].reverse() },
              ],
            },
          ],
        },
      ],
    },
  };
  expect(changedLevelDecisions(before, after, sources)).toEqual([]);
});

test("an account that is gone is named for its source type, whether or not the overview still lists it", () => {
  const connected = { id: "fictional-mail:reader@example.org", name: "Fictional mail", available: true };
  // The overview lists a gone account a connection still names by its id alone.
  const listed = { id: "fictional-chat:room@example.org", name: "fictional-chat:room@example.org", icon: null, available: false };
  const rule = {
    capability: "answer",
    sources: { mode: "allowlist", sourceIds: [connected.id, "fictional-files:reader@example.org"] },
  };
  expect(levelSourceInventory([connected, listed], rule)).toEqual([
    connected,
    { ...listed, displayName: expect.stringMatching(/^fictional chat$/i) },
    { id: "fictional-files:reader@example.org", displayName: expect.stringMatching(/^fictional files$/i), available: false },
  ]);
});

test("a level's decisions are listed in one order, with the ones either side of a change calls for", () => {
  expect(levelDecisions({ notes: newGrantRule("notes") })).toEqual(["permissions"]);
  expect(levelDecisions({ direct })).toEqual(["permissions", "direct-data", "future"]);
  // A review of Answer being switched off still lists what Answer had.
  expect(levelDecisions({ direct }, { answer, direct })).toEqual([
    "permissions",
    "answer-data",
    "direct-data",
    "future",
    "release",
  ]);
});
