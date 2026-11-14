// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — Portal modules are JavaScript.
import { sameGrantIntent, sameScopePolicyIntent } from "./grant-intent.js";
// @ts-expect-error — Portal modules are JavaScript.
import { setSourcePolicy, scopeRefKey } from "./source-filter-state.js";
const participant = {
  capability: "person",
  label: "Original snapshot",
  identifiers: [
    { type: "email", value: "one@example.org" },
    { type: "email", value: "two@example.org" },
  ],
};
const policy = {
  sourceId: "fictional:one",
  audience: { accessLevel: "invented-level", capability: "answer" },
  rules: [{ action: "share", match: [participant, { capability: "membership", field: "extra.labelIds", id: "invented-label" }] }],
  otherwise: "hide",
};
const other = { ...policy, sourceId: "fictional:two" };
const answer = {
  capability: "answer",
  sources: { mode: "allowlist", sourceIds: ["fictional:one", "fictional:two"] },
  release: { mode: "unreviewed" },
  filterRevision: 7,
  scopePolicies: [policy, other],
};

test("boundary and reference selections compare as sets while display-only snapshot names do not change access", () => {
  const renamed = {
    ...participant,
    label: "Renamed snapshot",
    identifiers: [...participant.identifiers].reverse(),
  };
  const changed = {
    ...policy,
    rules: [{ ...policy.rules[0]!, match: [{ capability: "membership", field: "extra.labelIds", id: "invented-label" }, renamed] }],
  };
  expect(sameScopePolicyIntent(policy, changed)).toBe(true);
  expect(
    sameGrantIntent(
      { answer },
      {
        answer: {
          ...answer,
          sources: { ...answer.sources, sourceIds: [...answer.sources.sourceIds].reverse() },
          scopePolicies: [other, changed],
        },
      },
    ),
  ).toBe(true);
});
test("a no-op Apply on the first of two accounts retains the original wire policy order and snapshots", () => {
  const changed = {
    ...policy,
    rules: [
      {
        ...policy.rules[0]!,
        match: [
          { capability: "membership", field: "extra.labelIds", id: "invented-label" },
          {
            ...participant,
            label: "Renamed snapshot",
            identifiers: [...participant.identifiers].reverse(),
          },
        ],
      },
    ],
  };
  const before = JSON.stringify(answer);
  const next = setSourcePolicy(answer, policy.sourceId, changed);
  expect(next).toBe(answer);
  expect(JSON.stringify(next)).toBe(before);
  expect(next.scopePolicies[0]).toBe(policy);
});
test("different references, added identifiers and new source authority remain real changes", () => {
  const different = {
    ...policy,
    rules: [
      { ...policy.rules[0]!, match: [{ capability: "membership", field: "extra.labelIds", id: "different-label" }, participant] },
    ],
  };
  const wider = {
    ...policy,
    rules: [
      {
        ...policy.rules[0]!,
        match: [
          {
            ...participant,
            identifiers: [
              ...participant.identifiers,
              { type: "email", value: "three@example.org" },
            ],
          },
        ],
      },
    ],
  };
  expect(sameScopePolicyIntent(policy, different)).toBe(false);
  expect(sameScopePolicyIntent(policy, wider)).toBe(false);
  expect(
    sameGrantIntent(
      { answer },
      {
        answer: {
          ...answer,
          sources: {
            ...answer.sources,
            sourceIds: [...answer.sources.sourceIds, "fictional:three"],
          },
        },
      },
    ),
  ).toBe(false);
});
test("ordered advanced rules and unsupported clause fields remain authoritative", () => {
  const advanced = {
    ...policy,
    rules: [
      ...policy.rules,
      { action: "hide", match: [{ capability: "tree", field: "extra.folder", id: "invented-folder" }] },
    ],
    extraCondition: { label: "first", sequence: [1, 2] },
  };
  expect(
    sameScopePolicyIntent(advanced, { ...advanced, rules: [...advanced.rules].reverse() }),
  ).toBe(false);
  expect(
    sameScopePolicyIntent(advanced, {
      ...advanced,
      extraCondition: { label: "second", sequence: [1, 2] },
    }),
  ).toBe(false);
  expect(
    sameScopePolicyIntent(advanced, {
      ...advanced,
      extraCondition: { label: "first", sequence: [2, 1] },
    }),
  ).toBe(false);
});
test("exact participant identity deduplicates tuples without delimiter collisions or wire mutation", () => {
  const duplicates = {
    ...participant,
    label: "Another snapshot",
    identifiers: [...participant.identifiers].reverse().concat(participant.identifiers[0]!),
  };
  expect(scopeRefKey(duplicates)).toBe(scopeRefKey(participant));
  const one = { capability: "person", identifiers: [{ type: "email", value: "left|email:right" }] };
  const two = {
    capability: "person",
    identifiers: [
      { type: "email", value: "left" },
      { type: "email", value: "right" },
    ],
  };
  expect(scopeRefKey(one)).not.toBe(scopeRefKey(two));
  expect(duplicates.identifiers).toHaveLength(3);
});

test("reverting an all-source toggle to an empty denylist is a no-op without rewriting either wire value", () => {
  const all = { ...answer, sources: { mode: "all", sourceIds: [] } };
  const reverted = { ...answer, sources: { mode: "denylist", sourceIds: [] } };
  expect(sameGrantIntent({ answer: all }, { answer: reverted })).toBe(true);
  expect(all.sources.mode).toBe("all");
  expect(reverted.sources.mode).toBe("denylist");
});
