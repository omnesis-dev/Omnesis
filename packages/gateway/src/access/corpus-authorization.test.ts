// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  answerOwnerScopeDigest,
  createCorpusAuthorization,
  corpusAuthorizationDigest,
  externalAnswerOwnerId,
  parseCorpusAuthorization,
  serializeCorpusAuthorization,
} from "./corpus-authorization.js";

const identity = {
  principalId: "principal-example",
  grantId: "grant-example",
  grantRevision: 3,
  credentialId: "credential-example",
  accessTokenId: "token-example",
};

describe("corpus authorization", () => {
  test("normalizes allowlists into a deterministic immutable scope", () => {
    const first = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "allowlist",
          sourceIds: ["mail:beta", "mail:alpha", "mail:alpha"],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;
    const second = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "allowlist",
          sourceIds: ["mail:alpha", "mail:beta"],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;

    expect(first.sourceIds).toEqual(["mail:alpha", "mail:beta"]);
    expect(first.digest).toBe(second.digest);
    expect(first.allowsSource("mail:alpha")).toBe(true);
    expect(first.allowsSource("mail:future")).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sourceIds)).toBe(true);
  });

  test("denylist automatically admits a future source while retaining its exclusion", () => {
    const authorization = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "denylist",
          sourceIds: ["mail:denied"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-example",
          privacyPolicy: "policy-v2",
        },
      ],
      "answer",
    )!;

    expect(authorization.allowsSource("mail:denied")).toBe(false);
    expect(authorization.allowsSource("mail:future")).toBe(true);
    expect(parseCorpusAuthorization(serializeCorpusAuthorization(authorization)).digest).toBe(
      authorization.digest,
    );
  });

  test("keeps Answer ownership stable across token and policy revisions but partitions corpus scope", () => {
    const authorization = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:primary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-one",
          privacyPolicy: "Fictional first policy.",
        },
      ],
      "answer",
    )!;

    expect(externalAnswerOwnerId(authorization)).toContain("grant:grant-example:credential:");
    expect(externalAnswerOwnerId(authorization)).toContain(
      "credential:credential-example:answer-scope:",
    );
    const revisedPolicy = createCorpusAuthorization(
      { ...identity, grantRevision: 4, accessTokenId: "token-next" },
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:primary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-two",
          privacyPolicy: "Fictional revised policy.",
        },
      ],
      "answer",
    )!;
    const changedSources = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:secondary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-one",
          privacyPolicy: "Fictional first policy.",
        },
      ],
      "answer",
    )!;

    expect(externalAnswerOwnerId(revisedPolicy)).toBe(externalAnswerOwnerId(authorization));
    expect(externalAnswerOwnerId(changedSources)).not.toBe(externalAnswerOwnerId(authorization));
  });

  test("fails closed for a stored empty allowlist and normalizes an empty denylist", () => {
    const emptyAllowlist = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: [],
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "answer",
    )!;
    const emptyDenylist = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "denylist",
          sourceIds: [],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;

    expect(emptyAllowlist.allowsSource("mail:future")).toBe(false);
    expect(emptyDenylist.allowsSource("mail:future")).toBe(true);
    expect(emptyDenylist.sourceMode).toBe("all");
    expect(emptyDenylist.restricted).toBe(false);
  });

  test("rejects malformed Answer release state instead of inferring access", () => {
    expect(() =>
      createCorpusAuthorization(
        identity,
        [
          {
            capability: "answer",
            sourceMode: "all",
            sourceIds: [],
            releaseMode: "unreviewed",
            policyFamilyId: "policy-family-example",
            policyRevision: "policy-revision-example",
            privacyPolicy: null,
          },
        ],
        "answer",
      ),
    ).toThrow("valid release mode");
  });
  test("Notes cannot become corpus read authority", () => {
    const notes = {
      capability: "notes" as const,
      sourceMode: "all" as const,
      sourceIds: [],
      releaseMode: null,
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    };
    expect(createCorpusAuthorization(identity, [notes], "answer")).toBeNull();
    expect(createCorpusAuthorization(identity, [notes], "direct")).toBeNull();
    expect(
      // @ts-expect-error Runtime callers cannot turn append-only authority into read access.
      createCorpusAuthorization(identity, [notes], "notes"),
    ).toBeNull();
  });
});

describe("corpus filter revisions", () => {
  const rule = {
    capability: "answer" as const,
    sourceMode: "all" as const,
    sourceIds: [],
    releaseMode: "unreviewed" as const,
    policyFamilyId: null,
    policyRevision: null,
    privacyPolicy: null,
  };
  const authorization = (filterRevision?: number) =>
    createCorpusAuthorization(identity, [{ ...rule, filterRevision }], "answer")!;

  test("omitted and zero revisions retain the legacy digests and wire shape", () => {
    const legacy = authorization();
    const zero = authorization(0);
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value), "utf8").digest("base64url");
    expect(legacy.filterRevision).toBe(0);
    expect(legacy.restricted).toBe(false);
    expect(legacy.digest).toBe(
      hash({
        v: 1,
        capability: rule.capability,
        sourceMode: rule.sourceMode,
        sourceIds: rule.sourceIds,
        releaseMode: rule.releaseMode,
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
      }),
    );
    expect(answerOwnerScopeDigest(legacy)).toBe(
      hash({
        v: 1,
        capability: rule.capability,
        sourceMode: rule.sourceMode,
        sourceIds: rule.sourceIds,
        releaseMode: rule.releaseMode,
        policyFamilyId: null,
      }),
    );
    expect(zero.digest).toBe(legacy.digest);
    expect(answerOwnerScopeDigest(zero)).toBe(answerOwnerScopeDigest(legacy));
    expect(serializeCorpusAuthorization(zero)).toBe(serializeCorpusAuthorization(legacy));
    expect(JSON.parse(serializeCorpusAuthorization(legacy))).not.toHaveProperty("filterRevision");
    expect(parseCorpusAuthorization(serializeCorpusAuthorization(legacy)).filterRevision).toBe(0);
  });

  test("filter revisions round-trip and fence both corpus and Answer ownership", () => {
    const first = authorization(1);
    const next = authorization(2);
    const roundTrip = parseCorpusAuthorization(serializeCorpusAuthorization(first));
    expect(first.restricted).toBe(false);
    expect(roundTrip.filterRevision).toBe(1);
    expect(roundTrip.digest).toBe(first.digest);
    expect(answerOwnerScopeDigest(roundTrip)).toBe(answerOwnerScopeDigest(first));
    expect(first.digest).not.toBe(authorization().digest);
    expect(next.digest).not.toBe(first.digest);
    expect(externalAnswerOwnerId(next)).not.toBe(externalAnswerOwnerId(first));
    expect(externalAnswerOwnerId(first)).not.toBe(externalAnswerOwnerId(authorization()));
    expect(corpusAuthorizationDigest({ ...rule, filterRevision: 1 })).toBe(first.digest);
  });

  test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid runtime revision %s",
    (filterRevision) => {
      expect(() => authorization(filterRevision)).toThrow("Invalid corpus filter revision");
      expect(() => serializeCorpusAuthorization({ ...authorization(), filterRevision })).toThrow(
        "Invalid corpus filter revision",
      );
    },
  );

  test.each([-1, 1.5, null, "1", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid serialized revision %s",
    (filterRevision) => {
      const serialized = JSON.stringify({
        ...JSON.parse(serializeCorpusAuthorization(authorization())),
        filterRevision,
      });
      expect(() => parseCorpusAuthorization(serialized)).toThrow("Invalid corpus authorization");
    },
  );
  test("canonical policy content partitions ownership even when revisions coincide", () => {
    const policy = {
      sourceId: "chat:primary",
      audience: { accessLevel: "level-example", capability: "answer" as const },
      rules: [
        {
          action: "share" as const,
          match: [
            { kind: "conversation" as const, id: "chat-z" },
            { kind: "conversation" as const, id: "chat-a" },
          ],
        },
      ],
      otherwise: "hide" as const,
    };
    const scoped = (scopePolicies: (typeof policy)[]) =>
      createCorpusAuthorization(
        identity,
        [{ ...rule, filterRevision: 1, scopePolicies }],
        "answer",
      )!;
    const first = scoped([policy]);
    const reordered = scoped([
      { ...policy, rules: [{ ...policy.rules[0]!, match: [...policy.rules[0]!.match].reverse() }] },
    ]);
    expect(first.digest).toBe(reordered.digest);
    expect(answerOwnerScopeDigest(first)).toBe(answerOwnerScopeDigest(reordered));
    const changed = scoped([
      {
        ...policy,
        rules: [{ action: "share", match: [{ kind: "conversation", id: "another-chat" }] }],
      },
    ]);
    expect(first.digest).not.toBe(changed.digest);
    expect(answerOwnerScopeDigest(first)).not.toBe(answerOwnerScopeDigest(changed));
    expect(first.restricted).toBe(true);
    expect(Object.isFrozen(first.scopePolicies)).toBe(true);
    expect(Object.isFrozen(first.scopePolicies[0]!.rules[0]!.match)).toBe(true);
    policy.rules[0]!.match[0]!.id = "mutated-caller-input";
    expect(first.scopePolicies[0]!.rules[0]!.match).toEqual([
      { kind: "conversation", id: "chat-a" },
      { kind: "conversation", id: "chat-z" },
    ]);
  });
  test.each([
    { sourceMode: "all" as const, sourceIds: [] },
    { sourceMode: "allowlist" as const, sourceIds: ["chat:filtered", "chat:whole"] },
    { sourceMode: "allowlist" as const, sourceIds: ["chat:filtered"] },
    { sourceMode: "denylist" as const, sourceIds: ["chat:excluded"] },
  ])("serialized %j scope denies filtered sources to an older parser", (boundary) => {
    const scopePolicies = [
      {
        sourceId: "chat:filtered",
        audience: { accessLevel: "level-example", capability: "answer" as const },
        rules: [
          { action: "share" as const, match: [{ kind: "conversation" as const, id: "allowed" }] },
        ],
        otherwise: "hide" as const,
      },
    ];
    const original = createCorpusAuthorization(
      identity,
      [{ ...rule, ...boundary, filterRevision: 1, scopePolicies }],
      "answer",
    )!;
    const serialized = serializeCorpusAuthorization(original);
    const wire = JSON.parse(serialized) as {
      sourceMode: "all" | "allowlist" | "denylist";
      sourceIds: string[];
    };
    // The V1 parser reads only these source fields and ignores filter extensions.
    const oldAllowsSource = (sourceId: string) =>
      wire.sourceMode === "all" ||
      (wire.sourceMode === "allowlist"
        ? wire.sourceIds.includes(sourceId)
        : !wire.sourceIds.includes(sourceId));
    expect(oldAllowsSource("chat:filtered")).toBe(false);
    expect(oldAllowsSource("chat:whole")).toBe(original.allowsSource("chat:whole"));
    expect(oldAllowsSource("chat:excluded")).toBe(original.allowsSource("chat:excluded"));
    const restored = parseCorpusAuthorization(serialized);
    expect(restored.sourceMode).toBe(original.sourceMode);
    expect(restored.sourceIds).toEqual(original.sourceIds);
    expect(restored.scopePolicies).toEqual(original.scopePolicies);
    expect(restored.digest).toBe(original.digest);
    expect(answerOwnerScopeDigest(restored)).toBe(answerOwnerScopeDigest(original));
    expect(restored.allowsSource("chat:filtered")).toBe(true);
  });

  test("filtered snapshots cannot restore canonical access without a matching conservative boundary", () => {
    const scopePolicies = [
      {
        sourceId: "chat:filtered",
        audience: { accessLevel: "level-example", capability: "answer" as const },
        rules: [
          { action: "share" as const, match: [{ kind: "conversation" as const, id: "allowed" }] },
        ],
        otherwise: "hide" as const,
      },
    ];
    const original = createCorpusAuthorization(
      identity,
      [{ ...rule, filterRevision: 1, scopePolicies }],
      "answer",
    )!;
    const wire = JSON.parse(serializeCorpusAuthorization(original)) as Record<string, unknown>;
    const missing = { ...wire };
    delete missing.canonicalSources;
    expect(() => parseCorpusAuthorization(JSON.stringify(missing))).toThrow(
      "canonical source boundary",
    );
    for (const canonicalSources of [
      null,
      "all",
      [],
      { mode: "unknown", sourceIds: [] },
      { mode: "all", sourceIds: null },
      { mode: "all", sourceIds: [], future: true },
    ]) {
      expect(() => parseCorpusAuthorization(JSON.stringify({ ...wire, canonicalSources }))).toThrow(
        "canonical source boundary",
      );
    }
    expect(() =>
      parseCorpusAuthorization(JSON.stringify({ ...wire, sourceMode: "all", sourceIds: [] })),
    ).toThrow("conservative source boundary");
    expect(() => parseCorpusAuthorization(JSON.stringify({ ...wire, sourceIds: [] }))).toThrow(
      "conservative source boundary",
    );
    expect(() => parseCorpusAuthorization(JSON.stringify({ ...wire, scopePolicies: [] }))).toThrow(
      "Unexpected canonical source boundary",
    );
  });
});
