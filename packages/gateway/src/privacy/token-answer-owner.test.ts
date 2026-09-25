// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { tokenAnswerOwnerId, tokenIdOfAnswerOwner } from "./token-answer-owner.js";
import type { AccessGrantCapability } from "../access/types.js";

function answerScope(rule: Partial<AccessGrantCapability> = {}) {
  return createCorpusAuthorization(
    {
      principalId: "device:dev-1",
      grantId: "level:level-1",
      grantRevision: 1,
      credentialId: "device:dev-1",
      accessTokenId: "tok-1",
    },
    [
      {
        capability: "answer",
        sourceMode: "all",
        sourceIds: [],
        releaseMode: "reviewed",
        policyFamilyId: "11111111-1111-4111-8111-111111111111",
        policyRevision: "rev-1",
        privacyPolicy: "11111111-1111-4111-8111-111111111111",
        ...rule,
      },
    ],
    "answer",
  )!;
}

describe("token answer owners", () => {
  it("keeps the plain token owner without an access level", () => {
    expect(tokenAnswerOwnerId("tok-1")).toBe("token:tok-1");
  });

  it("scopes an access level's Answer rule into its own owner", () => {
    const wide = tokenAnswerOwnerId("tok-1", answerScope());
    expect(wide).not.toBe(tokenAnswerOwnerId("tok-1"));
    // Sources, release mode and policy each change the scope.
    expect(
      tokenAnswerOwnerId("tok-1", answerScope({ sourceMode: "allowlist", sourceIds: ["s1"] })),
    ).not.toBe(wide);
    expect(
      tokenAnswerOwnerId(
        "tok-1",
        answerScope({
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        }),
      ),
    ).not.toBe(wide);
    expect(
      tokenAnswerOwnerId(
        "tok-1",
        answerScope({ policyFamilyId: "22222222-2222-4222-8222-222222222222" }),
      ),
    ).not.toBe(wide);
    // A new revision of the same policy does not.
    expect(tokenAnswerOwnerId("tok-1", answerScope({ policyRevision: "rev-2" }))).toBe(wide);
  });

  it("recovers the token id from either shape and nothing else", () => {
    expect(tokenIdOfAnswerOwner(tokenAnswerOwnerId("tok-1"))).toBe("tok-1");
    expect(tokenIdOfAnswerOwner(tokenAnswerOwnerId("tok-1", answerScope()))).toBe("tok-1");
    expect(tokenIdOfAnswerOwner("device:dev-1")).toBeNull();
    expect(tokenIdOfAnswerOwner("principal:p:grant:g:credential:c:answer-scope:x")).toBeNull();
    expect(tokenIdOfAnswerOwner("token:")).toBeNull();
  });
});
