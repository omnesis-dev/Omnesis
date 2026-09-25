// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { buildSelfPatch } from "./self.js";

describe("buildSelfPatch", () => {
  it("builds a patch from name + normalized, deduped emails/phones", () => {
    const patch = buildSelfPatch({
      name: "  Maya  ",
      email: ["Me@Example.com", "me@example.com"], // cased duplicate collapses
      phone: ["+1 202 555 0123"],
    });
    expect(patch).toEqual({
      name: "Maya",
      emails: ["me@example.com"],
      phones: ["+12025550123"],
    });
  });

  it("patches only the fields supplied (deep-merge friendly)", () => {
    expect(buildSelfPatch({ email: "me@example.com" })).toEqual({ emails: ["me@example.com"] });
    expect(buildSelfPatch({ name: "Maya" })).toEqual({ name: "Maya" });
  });

  it("throws when nothing is supplied", () => {
    expect(() => buildSelfPatch({})).toThrow(/Nothing to set/);
  });

  it("throws on a malformed email", () => {
    expect(() => buildSelfPatch({ email: "not-an-email" })).toThrow(/Invalid --email/);
  });

  it("throws on a non-E.164 phone", () => {
    expect(() => buildSelfPatch({ phone: "garbage" })).toThrow(/Invalid --phone/);
  });
});
