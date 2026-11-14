// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import * as filters from "./source-filter-state.js";
// @ts-expect-error — portal modules are plain JavaScript.
import * as grants from "./grant-builder-state.js";

const policy = {
  sourceId: "fictional:one",
  audience: { accessLevel: "saved-level", capability: "answer" },
  rules: [{ action: "share", match: [{ capability: "membership", field: "extra.roomId", id: "stable-room" }] }],
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
  draft.rules[0].match.push({ capability: "membership", field: "extra.roomId", id: "stable-room" });
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

test("mixed fields use one OR bucket and only/exclude switches preserve exact selected values", () => {
  let draft = filters.newSourcePolicy("fictional:one", "answer");
  for (const ref of [
    { capability: "membership", field: "extra.roomId", id: "room" },
    { capability: "membership", field: "extra.labelIds", id: "label-id" },
    { capability: "tree", field: "extra.folder", id: "~/work", device: "dev-one" },
    { capability: "person", label: "Maya Reeves", identifiers: [{ type: "email", value: "maya@example.org" }] },
  ])
    draft = filters.toggleScopeRef(draft, ref);
  const except = filters.setFilterMode(draft, "except");
  expect(except.rules).toEqual([{ action: "hide", match: draft.rules[0].match }]);
  expect(except.otherwise).toBe("share");
  expect(filters.setFilterMode(except, "only")).toEqual(draft);
});

test("an entry is keyed by its field, device and item, or by a person's identifiers", () => {
  const key = filters.scopeRefKey;
  const folder = { capability: "tree", field: "extra.folder", id: "~/work", device: "dev-one" };
  // The same path on another device, or in another field, is another entry.
  expect(key({ ...folder, device: "dev-two" })).not.toBe(key(folder));
  expect(key({ ...folder, field: "extra.other" })).not.toBe(key(folder));
  // A membership and a tree entry naming the same item of a field are one entry.
  expect(key({ ...folder, capability: "membership" })).toBe(key(folder));
  // A person is its identifiers, in any order, whatever it is called.
  const maya = {
    capability: "person",
    label: "Maya Reeves",
    identifiers: [
      { type: "email", value: "maya@example.org" },
      { type: "phone", value: "+15550100142" },
    ],
  };
  expect(key({ ...maya, label: "M. Reeves", identifiers: [...maya.identifiers].reverse() })).toBe(
    key(maya),
  );
  expect(key({ ...maya, identifiers: maya.identifiers.slice(1) })).not.toBe(key(maya));
});

test.each([
  [{ capability: "membership", field: "extra.labelIds", id: "Label_12" }, true],
  [{ capability: "tree", field: "extra.folder", id: "", device: "dev-one" }, true],
  [{ capability: "tree", field: "extra.folder", id: "" }, false],
  [{ capability: "tree", field: "", id: "x" }, false],
  [{ capability: "tree", field: "extra.folder", id: "x", device: "" }, false],
  [{ capability: "range", field: "extra.date", id: "x" }, false],
  [{ capability: "membership", field: "extra.labelIds", id: "x", extra: true }, false],
  [{ kind: "label", id: "x" }, false],
  [{ capability: "person", label: "Maya", identifiers: [{ type: "phone", value: "+15550100142" }] }, true],
  [{ capability: "person", label: " ", identifiers: [{ type: "phone", value: "+15550100142" }] }, false],
  [{ capability: "person", label: "Maya", identifiers: [] }, false],
  [{ capability: "person", label: "Maya", identifiers: [{ type: "fax", value: "1" }] }, false],
])("the editor changes only the entries it can show: %j → %s", (ref, editable) => {
  expect(
    filters.editableSourcePolicy({ ...policy, rules: [{ action: "share", match: [ref] }] }),
  ).toBe(editable);
});

test("a whole device is an entry with no item, on a field whose items belong to a device", () => {
  expect(filters.isDeviceRef({ capability: "tree", field: "f", id: "", device: "dev-one" })).toBe(true);
  expect(filters.isDeviceRef({ capability: "tree", field: "f", id: "~", device: "dev-one" })).toBe(false);
  expect(filters.isDeviceRef({ capability: "person", label: "", identifiers: [] })).toBe(false);
});

test("an entry finds its field in the editor, a person by the person field", () => {
  const editor = {
    fields: [
      { field: "$people", capability: "person" },
      { field: "extra.labelIds", capability: "membership" },
    ],
  };
  expect(filters.refField(editor, { capability: "person", label: "x", identifiers: [] }).field).toBe(
    "$people",
  );
  expect(
    filters.refField(editor, { capability: "membership", field: "extra.labelIds", id: "x" }).field,
  ).toBe("extra.labelIds");
  expect(filters.refField(editor, { capability: "tree", field: "gone", id: "x" })).toBeUndefined();
});

test("an address the gateway read becomes one person entry named by its spelling", () => {
  expect(filters.identifierRef({ type: "phone", value: "+15550100123" })).toEqual({
    capability: "person",
    label: "+15550100123",
    identifiers: [{ type: "phone", value: "+15550100123" }],
  });
});

test("a draft needs at least one entry and at most 256, and never counts on counts", () => {
  const draft = filters.newSourcePolicy("fictional:one", "answer");
  expect(filters.filterDraftError(draft)).toBe("Select at least one item.");
  const entries = (count: number) => ({
    ...draft,
    rules: [
      {
        action: "share",
        match: Array.from({ length: count }, (_, index) => ({
          capability: "membership",
          field: "extra.labelIds",
          id: `label-${index}`,
        })),
      },
    ],
  });
  expect(filters.filterDraftError(entries(256))).toBeNull();
  expect(filters.filterDraftError(entries(257))).toBe("A filter can include at most 256 items.");
  expect(filters.filterDraftError({ ...draft, otherwise: "share" })).toMatch(/cannot change/);
});

test("a person counts against the limit once per address, as the gateway counts it", () => {
  const draft = filters.newSourcePolicy("fictional:one", "answer");
  const person = (addresses: number) => ({
    capability: "person",
    label: "Maya Reeves",
    identifiers: Array.from({ length: addresses }, (_, index) => ({
      type: "email",
      value: `maya.${index}@example.org`,
    })),
  });
  const labels = Array.from({ length: 250 }, (_, index) => ({
    capability: "membership",
    field: "extra.labelIds",
    id: `label-${index}`,
  }));
  const with_ = (addresses: number) => ({
    ...draft,
    rules: [{ action: "share", match: [...labels, person(addresses)] }],
  });
  expect(filters.filterDraftError(with_(6))).toBeNull();
  expect(filters.filterDraftError(with_(7))).toBe("A filter can include at most 256 items.");
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
