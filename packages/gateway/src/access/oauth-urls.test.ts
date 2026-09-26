// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  resolveMetadataRequestResource,
  resolveMcpRequestResource,
  resolveOAuthMetadataPaths,
  resolveOAuthUrls,
  resolveOAuthOverviewUrls,
} from "./oauth-urls.js";

describe("resolveOAuthUrls", () => {
  test("uses the configured public origin instead of the request Host", () => {
    expect(
      resolveOAuthUrls(
        "https://attacker.example.org/oauth/token",
        "https://gateway.example.com:7600",
      ),
    ).toMatchObject({
      issuer: "https://gateway.example.com:7600",
      resource: "https://gateway.example.com:7600/mcp",
      supportedResources: ["https://gateway.example.com:7600/mcp"],
      protectedResourceMetadata:
        "https://gateway.example.com:7600/.well-known/oauth-protected-resource/mcp",
    });
  });

  test("accepts only explicitly configured protected resources", () => {
    expect(
      resolveOAuthUrls(
        "https://gateway.example.com:7600/oauth/token",
        "https://gateway.example.com",
        ["https://private.example.net:7600/mcp"],
      )?.supportedResources,
    ).toEqual(["https://gateway.example.com/mcp", "https://private.example.net:7600/mcp"]);
  });

  test("preserves a configured reverse-proxy path in endpoints and well-known URLs", () => {
    expect(
      resolveOAuthUrls(
        "https://internal.example.org/oauth/token",
        "https://gateway.example.com/omnesis",
      ),
    ).toEqual({
      issuer: "https://gateway.example.com/omnesis",
      resource: "https://gateway.example.com/omnesis/mcp",
      supportedResources: ["https://gateway.example.com/omnesis/mcp"],
      authorize: "https://gateway.example.com/omnesis/oauth/authorize",
      token: "https://gateway.example.com/omnesis/oauth/token",
      register: "https://gateway.example.com/omnesis/oauth/register",
      revoke: "https://gateway.example.com/omnesis/oauth/revoke",
      protectedResourceMetadata:
        "https://gateway.example.com/.well-known/oauth-protected-resource/omnesis/mcp",
    });
    expect(resolveOAuthMetadataPaths("https://gateway.example.com/omnesis")).toEqual({
      authorizationServer: "/.well-known/oauth-authorization-server/omnesis",
      openIdConfiguration: "/omnesis/.well-known/openid-configuration",
      protectedResources: ["/.well-known/oauth-protected-resource/omnesis/mcp"],
    });
  });

  test("allows request-origin fallback only on loopback", () => {
    expect(resolveOAuthUrls("http://127.0.0.1:7600/mcp")?.resource).toBe(
      "http://127.0.0.1:7600/mcp",
    );
    expect(resolveOAuthUrls("http://localhost:7600/mcp")?.resource).toBe(
      "http://localhost:7600/mcp",
    );
    expect(resolveOAuthUrls("https://gateway.example.org/mcp")).toBeNull();
  });

  test.each([
    "https://user:secret@gateway.example.org",
    "https://gateway.example.org?redirect=elsewhere",
    "https://gateway.example.org?",
    "https://gateway.example.org#fragment",
    "https://gateway.example.org#",
    "https://gateway.example.org:99999",
  ])("rejects an unsafe configured public URL without throwing: %s", (configuredBaseUrl) => {
    expect(resolveOAuthUrls("http://localhost:7600/mcp", configuredBaseUrl)).toBeNull();
  });

  test("returns null for a malformed request URL instead of throwing", () => {
    expect(resolveOAuthUrls("not a URL")).toBeNull();
  });

  test("matches bearer-token audiences to the exact requested MCP resource", () => {
    const resources = ["https://gateway.example.org/mcp", "https://private.example.net:7600/mcp"];
    expect(resolveMcpRequestResource("https://private.example.net:7600/mcp", resources)).toBe(
      resources[1],
    );
    expect(resolveMcpRequestResource("https://unknown.example.net/mcp", resources)).toBeNull();
    expect(resolveMcpRequestResource("https://gateway.example.org/other", resources)).toBeNull();
  });

  test("uses an allowlisted Host to recover a path-prefixed resource after proxy rewriting", () => {
    const resources = [
      "https://gateway.example.org/omnesis/mcp",
      "https://private.example.net:7600/mcp",
    ];
    expect(resolveMcpRequestResource("http://gateway.example.org/mcp", resources)).toBe(
      resources[0],
    );
    expect(resolveMcpRequestResource("http://gateway.example.org/omnesis/mcp", resources)).toBe(
      resources[0],
    );
    expect(resolveMcpRequestResource("http://upstream.internal/mcp", resources)).toBeNull();
    expect(
      resolveMetadataRequestResource(
        "http://gateway.example.org/.well-known/oauth-protected-resource/omnesis/mcp",
        resources,
      ),
    ).toBe(resources[0]);
  });
});

describe("local OAuth setup overview", () => {
  test("advertises the actual loopback listener without enabling remote OAuth", () => {
    const remote = "https://gateway.example.org/portal/api/access";
    const local = "https://localhost:17600";
    expect(resolveOAuthOverviewUrls(remote, undefined, undefined, local)?.resource).toBe(
      `${local}/mcp`,
    );
    expect(resolveOAuthUrls(remote)).toBeNull();
    expect(
      resolveOAuthOverviewUrls(remote, undefined, undefined, "https://external.example.org"),
    ).toBeNull();
    expect(
      resolveOAuthOverviewUrls(remote, "http://external.example.org", undefined, local),
    ).toBeNull();
  });
});
