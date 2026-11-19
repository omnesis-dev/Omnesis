// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { allowlisted, claAllowlist } from "./cla-allowlist.mjs";

const base = "maintainer,*[bot]";
const signers = [{ name: "maya-reeves", id: 101 }];

describe("CLA allowlist for coding-agent commits", () => {
  it("counts a signed author's coding-agent commits as theirs", () => {
    const allowlist = claAllowlist({ base, author: { login: "maya-reeves", id: 101 }, signers });
    expect(allowlisted(allowlist, "claude")).toBe(true);
    expect(allowlisted(allowlist, "Claude")).toBe(true);
  });

  it("recognizes a signer who renamed their account by id", () => {
    const allowlist = claAllowlist({ base, author: { login: "maya-r", id: 101 }, signers });
    expect(allowlisted(allowlist, "claude")).toBe(true);
  });

  it("vouches for the exempt maintainer's coding-agent commits", () => {
    const allowlist = claAllowlist({ base, author: { login: "maintainer", id: 1 }, signers });
    expect(allowlisted(allowlist, "claude")).toBe(true);
  });

  it("still asks everyone else on a signed author's pull request to sign", () => {
    const allowlist = claAllowlist({ base, author: { login: "maya-reeves", id: 101 }, signers });
    expect(allowlisted(allowlist, "jamie-lopez")).toBe(false);
  });

  it("keeps coding-agent commits unsigned when the author has not signed", () => {
    const allowlist = claAllowlist({ base, author: { login: "jamie-lopez", id: 202 }, signers });
    expect(allowlist).toBe(base);
    expect(allowlisted(allowlist, "claude")).toBe(false);
  });

  it("vouches for nothing on a comment with no pull request author", () => {
    expect(claAllowlist({ base, author: null, signers })).toBe(base);
  });

  it("matches like CLA Assistant: exact names and * wildcards", () => {
    expect(allowlisted(base, "dependabot[bot]")).toBe(true);
    expect(allowlisted(base, "maintainer")).toBe(true);
    expect(allowlisted(base, "maintainer2")).toBe(false);
    expect(allowlisted(base, "bot")).toBe(false);
  });
});
