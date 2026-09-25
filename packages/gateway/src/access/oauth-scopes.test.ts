// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { normalizeInteractiveOAuthScope, OAUTH_OFFLINE_ACCESS_SCOPE } from "./oauth-scopes.js";
import { MCP_ACCESS_SCOPE } from "./types.js";

describe("OAuth scopes", () => {
  test("accepts delegated access with optional offline_access and preserves requested order", () => {
    expect(normalizeInteractiveOAuthScope(MCP_ACCESS_SCOPE)).toBe(MCP_ACCESS_SCOPE);
    expect(
      normalizeInteractiveOAuthScope(`${MCP_ACCESS_SCOPE} ${OAUTH_OFFLINE_ACCESS_SCOPE}`),
    ).toBe(`${MCP_ACCESS_SCOPE} ${OAUTH_OFFLINE_ACCESS_SCOPE}`);
    expect(
      normalizeInteractiveOAuthScope(`${OAUTH_OFFLINE_ACCESS_SCOPE} ${MCP_ACCESS_SCOPE}`),
    ).toBe(`${OAUTH_OFFLINE_ACCESS_SCOPE} ${MCP_ACCESS_SCOPE}`);
  });

  test("rejects missing, duplicated, or unknown authority", () => {
    expect(normalizeInteractiveOAuthScope(OAUTH_OFFLINE_ACCESS_SCOPE)).toBeNull();
    expect(normalizeInteractiveOAuthScope(`${MCP_ACCESS_SCOPE} ${MCP_ACCESS_SCOPE}`)).toBeNull();
    expect(normalizeInteractiveOAuthScope(`${MCP_ACCESS_SCOPE} corpus:write`)).toBeNull();
  });
});
