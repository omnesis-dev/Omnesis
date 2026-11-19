// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { UnsecuredJWT } from "jose";
import { expect, test } from "vitest";
import { normalizeGoogleEmail, verifiedGoogleEmail } from "./google-email.js";

test("only an email google verified is used, normalized as google compares it", () => {
  const token = (claims: Record<string, unknown>) => new UnsecuredJWT(claims).encode();
  expect(
    verifiedGoogleEmail(token({ email: " Maya.Reeves@Example.com", email_verified: true })),
  ).toBe("maya.reeves@example.com");
  for (const claims of [
    { email: "maya.reeves@example.com", email_verified: false },
    { email: "maya.reeves@example.com", email_verified: "true" },
    { email: "maya.reeves@example.com" },
    { email_verified: true },
    { email: 42, email_verified: true },
  ])
    expect(verifiedGoogleEmail(token(claims))).toBeUndefined();
  expect(verifiedGoogleEmail("not-a-token")).toBeUndefined();
});

test("an address that is too long, malformed or carries control characters is no address", () => {
  expect(normalizeGoogleEmail(" Jamie.Lopez@Example.org ")).toBe("jamie.lopez@example.org");
  for (const value of [
    "not an address",
    `${"a".repeat(250)}@example.com`,
    "jamie\u0007@example.com",
  ])
    expect(normalizeGoogleEmail(value)).toBeUndefined();
});
