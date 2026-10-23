// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { renderConsentPage } from "@omnesis/gateway/src/http/routes/oauth-consent-page.js";
import { describe, expect, test } from "vitest";

import { scrapeOAuthUserCode } from "./mcp-oauth-helper.js";
import type { AuthorizationRequestPublic } from "@omnesis/gateway/src/access/types.js";

const request: AuthorizationRequestPublic = {
  id: "fictional-authorization",
  status: "pending",
  clientId: "fictional-client",
  clientName: "Fictional consent client",
  clientUri: null,
  redirectOrigin: "https://example.com",
  userCode: "JKLM-NPQR",
  resource: "https://example.com/mcp",
  scope: "mcp",
  createdAt: 0,
  expiresAt: 2_000_000_000_000,
  decisionAt: null,
  requiresAnswer: true,
};

describe("OAuth consent short-code extraction", () => {
  test.each([
    { nonce: "ABCD-EFGHabcdefghijklmno2", handle: "fictional-handle" },
    { nonce: "abcdefghijklmnopqrstuvwx", handle: "ABCD-EFGHabcdefghijklmno2" },
  ])("reads the displayed code despite a code-shaped nonce or handle: %j", (input) => {
    const html = renderConsentPage({ ...input, request });

    // A bare code-shaped match would select unrelated random page material.
    expect(html.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/u)?.[0]).toBe("ABCD-EFGH");
    expect(scrapeOAuthUserCode(html)).toBe(request.userCode);
  });

  test("rejects a decided page even when its nonce looks like a code", () => {
    const html = renderConsentPage({
      nonce: "ABCD-EFGHabcdefghijklmno2",
      handle: "fictional-handle",
      request: { ...request, status: "denied" },
    });

    expect(html).toContain("ABCD-EFGH");
    expect(scrapeOAuthUserCode.bind(null, html)).toThrow(
      "The anonymous consent page omitted its short code.",
    );
  });
});
