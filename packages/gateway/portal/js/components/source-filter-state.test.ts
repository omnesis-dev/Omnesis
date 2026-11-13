// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { canonicalScopeIdentifier } from "@omnesis/source-sdk";
// @ts-expect-error — portal modules are plain JavaScript.
import * as filters from "./source-filter-state.js";
// @ts-expect-error — portal modules are plain JavaScript.
import * as grants from "./grant-builder-state.js";

const policy = {
  sourceId: "fictional:one",
  audience: { accessLevel: "saved-level", capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "conversation", id: "stable-room" }] }],
  otherwise: "hide",
};
const answer = {
  capability: "answer",
  sources: { mode: "all", sourceIds: [] },
  release: { mode: "unreviewed" },
  filterRevision: 7,
  scopePolicies: [policy],
};

test("normalization and serialization preserve saved scope policies, revisions and unsupported settings", () => {
  const saved = { ...answer, scopePolicies: [{ ...policy, maxAge: { days: 3 } }] };
  expect(grants.serializeGrantRules(grants.normalizeGrantRules([saved]))).toEqual([saved]);
  expect(filters.editableSourcePolicy(saved.scopePolicies[0])).toBe(false);
  const changed = grants.setSourceAllowed(
    grants.normalizeGrantRules([saved]).answer,
    "fictional:two",
    false,
  );
  expect(grants.serializeGrantRules({ answer: changed })[0].scopePolicies).toEqual(
    saved.scopePolicies,
  );
});

test("ordinary new whole-source rules keep their existing DTO shape", () => {
  const direct = grants.newGrantRule("direct");
  expect(grants.serializeGrantRules({ direct })).toEqual([
    { capability: "direct", sources: { mode: "allowlist", sourceIds: [] } },
  ]);
  expect(direct).not.toHaveProperty("filterRevision");
  expect(direct).not.toHaveProperty("scopePolicies");
});

test("source boundary linking never copies filters, and explicit filter copy retains target revision", () => {
  const direct = {
    capability: "direct",
    sources: { mode: "allowlist", sourceIds: ["fictional:two"] },
    filterRevision: 3,
    scopePolicies: [],
  };
  expect(grants.copyRuleSources(direct, answer).scopePolicies).toEqual([]);
  const copied = filters.copyRuleFilters(direct, answer, "saved-level");
  expect(copied.filterRevision).toBe(3);
  expect(copied.sources).toEqual(direct.sources);
  expect(copied.scopePolicies[0].audience).toEqual({
    accessLevel: "saved-level",
    capability: "direct",
  });
  expect(answer.scopePolicies[0].audience.capability).toBe("answer");
});

test("new policies bind the creation sentinel and revision zero only when intentionally added", () => {
  const draft = filters.newSourcePolicy("fictional:one", "direct");
  draft.rules[0].match.push({ kind: "conversation", id: "stable-room" });
  const direct = filters.setSourcePolicy(grants.newGrantRule("direct"), "fictional:one", draft);
  expect(direct.filterRevision).toBe(0);
  expect(direct.scopePolicies[0].audience).toEqual({ accessLevel: "new", capability: "direct" });
});

test("the same native item ID in another source account never changes the first account", () => {
  const other = { ...policy, sourceId: "fictional:two" };
  const original = { ...answer, scopePolicies: [policy, other] };
  const changed = filters.setSourcePolicy(original, "fictional:two", {
    ...other,
    otherwise: "share",
  });
  expect(
    changed.scopePolicies.find((item: { sourceId: string }) => item.sourceId === "fictional:one"),
  ).toEqual(policy);
  expect(original.scopePolicies[1].otherwise).toBe("hide");
});

test("an unselected account keeps its filter in the draft, and what is saved leaves it out", () => {
  const sources = [{ id: "fictional:one" }, { id: "fictional:two" }];
  const blocked = grants.setSourceAllowed(
    grants.setSourceAllowed(answer, "fictional:two", true),
    "fictional:one",
    false,
  );
  expect(blocked.scopePolicies).toEqual(answer.scopePolicies);
  // Nothing stops the save: the filter of an account that is not shared is not sent.
  expect(grants.validateGrantRules({ answer: blocked }, sources)).toBeNull();
  expect(grants.serializeGrantRules({ answer: blocked })[0].scopePolicies).toEqual([]);
  // Selecting the account again in the same edit brings its filter back.
  const restored = grants.setSourceAllowed(blocked, "fictional:one", true);
  expect(grants.serializeGrantRules({ answer: restored })[0].scopePolicies).toEqual(
    answer.scopePolicies,
  );
  const removed = filters.setSourcePolicy(blocked, "fictional:one", null);
  expect(removed.filterRevision).toBe(7);
  expect(removed.scopePolicies).toEqual([]);
});

test("revision fencing includes removed original capabilities independently of proposed rules", () => {
  const original = { answer, direct: { capability: "direct", filterRevision: 11 } };
  expect(filters.expectedFilterRevisions(original)).toEqual({ answer: 7, direct: 11 });
  expect(filters.expectedFilterRevisions({ answer: { capability: "answer" } })).toEqual({
    answer: 0,
  });
});

test("mixed kinds use one OR bucket and only/exclude switches preserve exact selected values", () => {
  let draft = filters.newSourcePolicy("fictional:one", "answer");
  for (const ref of [
    { kind: "conversation", id: "room" },
    { kind: "label", id: "label-id" },
    { kind: "folder", id: "folder-id" },
  ])
    draft = filters.toggleScopeRef(draft, ref);
  const except = filters.setFilterMode(draft, "except");
  expect(except.rules).toEqual([{ action: "hide", match: draft.rules[0].match }]);
  expect(except.otherwise).toBe("share");
  expect(filters.setFilterMode(except, "only")).toEqual(draft);
});

const typedValue = (type: string, input: string) =>
  filters.typedParticipant(type, input)?.identifiers[0].value ?? null;

test("a typed address becomes one participant item named by its saved spelling", () => {
  expect(filters.typedParticipant("phone", "+1 (555) 010-0123")).toEqual({
    kind: "participant",
    label: "+15550100123",
    identifiers: [{ type: "phone", value: "+15550100123" }],
  });
  expect(filters.typedParticipant("name", "Fictional Person")).toBeNull();
  expect(filters.typedParticipant("email", `${"a".repeat(600)}@example.org`)).toBeNull();
});

const TYPED: Array<["phone" | "email" | "domain", string]> = [
  ["phone", "+15550100123"],
  ["phone", "+1 (555) 010-0123"],
  ["phone", "+1.555.010.0123"],
  ["phone", "+1 555\u2011010\u20130123"],
  ["phone", "0015550100123"],
  ["phone", "00 1 555 010 0123"],
  ["phone", "tel:+1-555-010-0123"],
  ["phone", "\uFF0B\uFF11\uFF15\uFF15\uFF15\uFF10\uFF11\uFF10\uFF10\uFF11\uFF12\uFF13"],
  ["phone", "5550100123"],
  ["phone", "(555) 010-0123"],
  ["phone", "+44 (0)7700 900123"],
  ["phone", "+12"],
  ["phone", "+1 555 010 CALL"],
  ["phone", "maya@example.org"],
  ["phone", ""],
  ["email", "maya@example.org"],
  ["email", "  Maya@Example.ORG "],
  ["email", "<maya@example.org>"],
  ["email", "Maya <Maya@example.org>"],
  ["email", '"Reeves, Maya" <maya@example.org>'],
  ["email", "mailto:maya@example.org"],
  ["email", "maya@example.org."],
  ["email", "maya+receipts@example.org"],
  ["email", "maya"],
  ["email", "@example.org"],
  ["email", "maya@"],
  ["email", "maya@localhost"],
  ["email", "maya reeves@example.org"],
  ["email", ""],
  ["domain", "example.org"],
  ["domain", "EXAMPLE.Org"],
  ["domain", "@example.org"],
  ["domain", " example.org. "],
  ["domain", "mail.example.org"],
  ["domain", "localhost"],
  ["domain", "*.example.org"],
  ["domain", "example.org/path"],
  ["domain", "https://example.org"],
  ["domain", "maya@example.org"],
  ["domain", "example..org"],
  ["domain", "-example.org"],
  ["domain", "example.123"],
  ["domain", ""],
];

test.each(TYPED)("a typed %s written as %j is read exactly as the gateway reads it", (type, raw) => {
  expect(typedValue(type, raw)).toBe(canonicalScopeIdentifier(type, raw)?.value ?? null);
});

test.each([
  ["email", "maya@b\u00FCcher.example"],
  ["domain", "b\u00FCcher.example"],
] as const)("a typed %s the gateway respells, %j, is still accepted", (type, raw) => {
  expect(typedValue(type, raw)).toBe(raw);
  expect(canonicalScopeIdentifier(type, raw)).not.toBeNull();
});

test("newly proposed person identifiers are added only by an explicit immutable update", () => {
  const draft = {
    ...policy,
    rules: [
      {
        action: "share",
        match: [
          {
            kind: "participant",
            label: "Fictional person",
            identifiers: [{ type: "email", value: "person@example.com" }],
          },
        ],
      },
    ],
  };
  const expanded = filters.addProposedIdentifiers(draft, {
    itemIndex: 0,
    identifiers: [{ type: "phone", value: "+15550100123" }],
  });
  expect(draft.rules[0].match[0].identifiers).toHaveLength(1);
  expect(expanded.rules[0].match[0].identifiers).toHaveLength(2);
  expect(expanded.rules[0].match[0]).not.toHaveProperty("personId");
});

test("request identity binds every source, kind, search and folder location", () => {
  const key = filters.requestIdentity("fictional:one", "folder", "project", "root");
  for (const values of [
    ["fictional:two", "folder", "project", "root"],
    ["fictional:one", "label", "project", "root"],
    ["fictional:one", "folder", "changed", "root"],
    ["fictional:one", "folder", "project", "elsewhere"],
  ])
    expect(filters.requestIdentity(...values)).not.toBe(key);
});

test("closed authoring guards candidate boundaries without pruning policies or freezing ordinary choices", () => {
  const blocked = grants.setSourceAllowed(answer, policy.sourceId, false);
  expect(grants.sourceBoundaryBlocksSavedFilter(blocked, false)).toBe(true);
  expect(blocked.scopePolicies).toEqual([policy]);
  expect(grants.sourceBoundaryBlocksSavedFilter(blocked, true)).toBe(false);
  const sibling = grants.setSourceAllowed(answer, "fictional:two", false);
  expect(grants.sourceBoundaryBlocksSavedFilter(sibling, false)).toBe(false);
  const retainedSource = {
    ...answer,
    scopePolicies: [{ ...policy, sourceId: "fictional:retired" }],
  };
  expect(
    grants.sourceBoundaryBlocksSavedFilter(
      grants.setFutureSourcesAllowed(retainedSource, false, ["fictional:one"]),
      false,
    ),
  ).toBe(true);
  expect(
    grants.sourceBoundaryBlocksSavedFilter(
      grants.setFutureSourcesAllowed(answer, false, ["fictional:one"]),
      false,
    ),
  ).toBe(false);
  expect(grants.serializeGrantRules({ answer })).toEqual([answer]);
});
