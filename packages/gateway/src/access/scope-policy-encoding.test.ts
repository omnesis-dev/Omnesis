// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { SOURCE_FILTER_MAX_ENTRIES, sourceFilterSchema } from "./scope-policy.js";
import {
  SCOPE_POLICY_STORAGE_PROTOCOL,
  encodeStoredScopePolicies,
  decodeStoredScopePolicies,
} from "./scope-policy-encoding.js";
import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
  parseCorpusAuthorization,
} from "./corpus-authorization.js";
import type { SourceFilter } from "@omnesis/types";

const policy: SourceFilter = {
  sourceId: "fictional:scope",
  audience: { accessLevel: "fictional-level", capability: "answer" },
  rules: [
    {
      action: "share",
      match: [{ capability: "membership", field: "extra.chatId", id: "fictional-conversation" }],
    },
  ],
  otherwise: "hide",
};
const authorization = createCorpusAuthorization(
  {
    principalId: "fictional-principal",
    grantId: "fictional-grant",
    grantRevision: 1,
    credentialId: "fictional-credential",
    accessTokenId: "fictional-token",
  },
  [
    {
      capability: "answer",
      sourceMode: "all",
      sourceIds: [],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
      filterRevision: 1,
      scopePolicies: [policy],
    },
  ],
  "answer",
)!;

test("the storage marker makes a strict reader refuse the stored form, while this build reads it back", () => {
  const encoded = encodeStoredScopePolicies([policy]);
  expect(encoded[0]?.minimumProtocol).toBe(SCOPE_POLICY_STORAGE_PROTOCOL);
  expect(sourceFilterSchema.safeParse(encoded[0]).success).toBe(false);
  expect(decodeStoredScopePolicies(encoded)).toEqual([policy]);
  const wire = JSON.parse(serializeCorpusAuthorization(authorization));
  expect(sourceFilterSchema.safeParse(wire.scopePolicies[0]).success).toBe(false);
  const restored = parseCorpusAuthorization(JSON.stringify(wire));
  expect(restored.digest).toBe(authorization.digest);
  expect(restored.scopePolicies).toEqual(authorization.scopePolicies);
  expect(restored.allowsSource(policy.sourceId)).toBe(true);
  // A reader that knows only the source boundary denies the filtered account.
  expect(wire.sourceIds).toContain(policy.sourceId);
  expect(wire.sourceMode).toBe("denylist");
});

test.each([0, SCOPE_POLICY_STORAGE_PROTOCOL + 1, String(SCOPE_POLICY_STORAGE_PROTOCOL), null])(
  "an unknown or invalid storage protocol %j fails closed",
  (minimumProtocol) => {
    expect(() => decodeStoredScopePolicies([{ ...policy, minimumProtocol }])).toThrow(/protocol/);
  },
);

test("an unmarked stored filter is read, and the marker never reaches what a reader is given", () => {
  expect(decodeStoredScopePolicies([policy])).toEqual([policy]);
  const wire = JSON.parse(serializeCorpusAuthorization(authorization));
  delete wire.scopePolicies[0].minimumProtocol;
  expect(parseCorpusAuthorization(JSON.stringify(wire)).digest).toBe(authorization.digest);
  expect(sourceFilterSchema.safeParse(policy).success).toBe(true);
});

test("a stored entry in a shape this build does not save fails closed rather than being dropped", () => {
  const legacy = {
    ...policy,
    rules: [{ action: "share", match: [{ kind: "conversation", id: "fictional-conversation" }] }],
    minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL,
  };
  expect(() => decodeStoredScopePolicies([legacy])).toThrow();
  for (const value of [null, "[]", {}, [null], [[]]]) {
    expect(() => decodeStoredScopePolicies(value)).toThrow();
  }
});

test("stored filters obey the same entry limit as an owner's edit", () => {
  const oversized = Array.from({ length: SOURCE_FILTER_MAX_ENTRIES + 1 }, (_, index) => ({
    ...policy,
    sourceId: `fictional:${index}`,
    minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL,
  }));
  expect(() => decodeStoredScopePolicies(oversized)).toThrow();
  const wide = {
    ...policy,
    sourceId: "fictional:wide",
    rules: [
      {
        action: "share",
        match: Array.from({ length: SOURCE_FILTER_MAX_ENTRIES }, (_, index) => ({
          capability: "membership",
          field: "extra.labelIds",
          id: `stable-${index}`,
        })),
      },
    ],
    otherwise: "hide",
    minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL,
  };
  expect(() =>
    decodeStoredScopePolicies([
      wide,
      { ...policy, minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL },
    ]),
  ).toThrow(/exceed/);
  expect(decodeStoredScopePolicies([wide])).toHaveLength(1);
});
