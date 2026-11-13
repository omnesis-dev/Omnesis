// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  resolveMetadataRequestResource,
  resolveMcpRequestResource,
  resolveOAuthMetadataPaths,
  resolveOAuthUrls,
  resolveOAuthOverviewUrls,
  resolveOAuthResourceUrls,
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
      issuerResources: ["https://gateway.example.com/omnesis/mcp"],
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

test("independent explicitly configured issuers preserve direct discovery when a relay origin is added", () => {
  const direct = "https://existing.example.org",
    relay = "https://opaque-relay.example.net";
  const resolve = (url: string) => resolveOAuthUrls(url, direct, [`${direct}/mcp`], [relay])!;
  expect(resolve(`${direct}/.well-known/oauth-authorization-server`)).toMatchObject({
    issuer: direct,
    token: `${direct}/oauth/token`,
    issuerResources: [`${direct}/mcp`],
  });
  expect(resolve(`${relay}/.well-known/oauth-authorization-server`)).toMatchObject({
    issuer: relay,
    token: `${relay}/oauth/token`,
    issuerResources: [`${relay}/mcp`],
  });
  expect(resolve("https://unconfigured.example.org/oauth/token").issuer).toBe(direct);
});

test("issuer selection is allowlisted, resources remain scoped and portal completion follows stored resource", () => {
  const direct = "https://existing.example.org",
    relay = "https://opaque-relay.example.net",
    legacy = "https://old-private.example.org/mcp";
  const config = [direct, [legacy], [relay]] as const;
  const primary = resolveOAuthUrls(`${direct}/oauth/token`, ...config)!;
  const cloud = resolveOAuthUrls(`${relay}/oauth/token`, ...config)!;
  expect(primary.supportedResources).toEqual([`${direct}/mcp`, `${relay}/mcp`, legacy]);
  expect(primary.issuerResources).toEqual([`${direct}/mcp`, legacy]);
  expect(cloud.issuerResources).toEqual([`${relay}/mcp`]);
  expect(resolveOAuthResourceUrls(`${relay}/mcp`, ...config)?.issuer).toBe(relay);
  expect(resolveOAuthResourceUrls(legacy, ...config)?.issuer).toBe(direct);
  expect(resolveOAuthResourceUrls("https://attacker.example.org/mcp", ...config)).toBeNull();
  expect(resolveOAuthResourceUrls("not a URL", ...config)).toBeNull();
  expect(resolveOAuthUrls("http://opaque-relay.example.net/oauth/token", ...config)?.issuer).toBe(
    relay,
  );
  expect(
    resolveOAuthUrls("https://unknown.example.org/oauth/token", undefined, [], [relay])?.issuer,
  ).toBe(relay);
  expect(
    resolveOAuthUrls("http://localhost:7600/oauth/token", undefined, [], [relay]),
  ).toMatchObject({
    issuer: "http://localhost:7600",
    issuerResources: ["http://localhost:7600/mcp"],
  });
  expect(resolveOAuthUrls(`${relay}/oauth/token`, undefined, [], [relay, relay])?.issuer).toBe(
    relay,
  );
  for (const issuers of [["http://insecure.example"], [direct + "/other"], Array(9).fill(relay)])
    expect(resolveOAuthUrls(`${relay}/oauth/token`, direct, [], issuers)).toBeNull();
  expect(resolveOAuthUrls(`${relay}/oauth/token`, undefined, ["not a URL"], [relay])).toBeNull();
  expect(
    resolveOAuthMetadataPaths("https://existing.example.org/prefix", [], [relay])
      ?.protectedResources,
  ).toEqual([
    "/.well-known/oauth-protected-resource/prefix/mcp",
    "/.well-known/oauth-protected-resource/mcp",
  ]);
  expect(resolveOAuthOverviewUrls(`${relay}/portal`, direct, [], undefined, [relay])?.issuer).toBe(
    relay,
  );
});

test("loopback IPv6 fallback and invalid metadata configuration stay bounded", () => {
  expect(resolveOAuthUrls("https://[::1]:7600/mcp")?.issuer).toBe("https://[::1]:7600");
  expect(resolveOAuthMetadataPaths("http://insecure.example")).toBeNull();
  expect(resolveOAuthOverviewUrls("https://external.example")).toBeNull();
});

test("malformed or unknown MCP metadata cannot select an audience, while exact configured metadata does", () => {
  const resource = "https://existing.example.org/mcp";
  expect(resolveMcpRequestResource("not a URL", [resource])).toBeNull();
  expect(resolveMetadataRequestResource("not a URL", [resource])).toBeNull();
  expect(
    resolveMetadataRequestResource(
      "https://existing.example.org/.well-known/oauth-protected-resource/mcp",
      [resource],
    ),
  ).toBe(resource);
  expect(
    resolveMetadataRequestResource(
      "https://unknown.example.org/.well-known/oauth-protected-resource/mcp",
      [resource],
    ),
  ).toBeNull();
  expect(resolveOAuthMetadataPaths("https://existing.example.org")?.authorizationServer).toBe(
    "/.well-known/oauth-authorization-server",
  );
});

test("trusted management can add an independent issuer after startup without trusting the request Host", () => {
  let issuers: readonly string[] = [];
  const source = () => issuers;
  expect(
    resolveOAuthUrls(
      "https://relay-gateway.example.test/mcp",
      "https://direct.example.test",
      [],
      source,
    )?.issuer,
  ).toBe("https://direct.example.test");
  issuers = ["https://relay-gateway.example.test"];
  expect(
    resolveOAuthUrls(
      "https://relay-gateway.example.test/mcp",
      "https://direct.example.test",
      [],
      source,
    )?.issuer,
  ).toBe("https://relay-gateway.example.test");
  expect(
    resolveOAuthUrls("https://attacker.example.test/mcp", "https://direct.example.test", [], source)
      ?.issuer,
  ).toBe("https://direct.example.test");
  issuers = ["http://attacker.example.test"];
  expect(
    resolveOAuthUrls(
      "https://relay-gateway.example.test/mcp",
      "https://direct.example.test",
      [],
      source,
    ),
  ).toBeNull();
});
