// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSafeMcpResourceUrl, isSafePublicBaseUrl } from "@omnesis/config";

export interface OAuthEndpointUrls {
  issuer: string;
  resource: string;
  supportedResources: readonly string[];
  authorize: string;
  token: string;
  register: string;
  revoke: string;
  protectedResourceMetadata: string;
}

export interface OAuthMetadataPaths {
  authorizationServer: string;
  openIdConfiguration: string;
  protectedResources: readonly string[];
}

/** Resolve the stable authorization server and its configured MCP resources. */
export function resolveOAuthUrls(
  requestUrl: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
): OAuthEndpointUrls | null {
  let requested: URL;
  try {
    requested = new URL(requestUrl);
  } catch {
    return null;
  }
  if (configuredBaseUrl && !isSafePublicBaseUrl(configuredBaseUrl)) return null;
  const base = configuredBaseUrl ? new URL(configuredBaseUrl) : requested;
  if (!configuredBaseUrl && !isLoopbackHostname(requested.hostname)) return null;
  const pathPrefix = configuredBaseUrl && base.pathname !== "/" ? base.pathname : "";
  const canonicalBase = `${base.origin}${pathPrefix}`;
  const resource = `${canonicalBase}/mcp`;
  const supportedResources = new Set([resource]);
  for (const candidate of configuredResources ?? []) {
    if (!isSafeMcpResourceUrl(candidate)) return null;
    supportedResources.add(normalizeResource(candidate));
  }
  return {
    issuer: canonicalBase,
    resource,
    supportedResources: [...supportedResources],
    authorize: `${canonicalBase}/oauth/authorize`,
    token: `${canonicalBase}/oauth/token`,
    register: `${canonicalBase}/oauth/register`,
    revoke: `${canonicalBase}/oauth/revoke`,
    protectedResourceMetadata: protectedResourceMetadataUrl(resource),
  };
}

export function resolveOAuthMetadataPaths(
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
): OAuthMetadataPaths | null {
  const urls = resolveOAuthUrls("http://127.0.0.1/mcp", configuredBaseUrl, configuredResources);
  if (!urls) return null;
  const issuerPath = new URL(urls.issuer).pathname;
  const issuerPrefix = issuerPath === "/" ? "" : issuerPath;
  return {
    authorizationServer: `/.well-known/oauth-authorization-server${issuerPrefix}`,
    openIdConfiguration: `${issuerPrefix}/.well-known/openid-configuration`,
    protectedResources: [
      ...new Set(
        urls.supportedResources.map(
          (resource) => new URL(protectedResourceMetadataUrl(resource)).pathname,
        ),
      ),
    ],
  };
}

/** Match the exact external MCP URL used for a request against configured resources. */
export function resolveMcpRequestResource(
  requestUrl: string,
  supportedResources: readonly string[],
): string | null {
  let requested: URL;
  try {
    requested = new URL(requestUrl);
  } catch {
    return null;
  }
  const exact = normalizeResource(`${requested.origin}${requested.pathname}`);
  const exactMatch = supportedResources.find((resource) => normalizeResource(resource) === exact);
  if (exactMatch) return exactMatch;
  const hostAndPathMatches = supportedResources.filter((resource) => {
    const parsed = new URL(resource);
    return parsed.host === requested.host && parsed.pathname === requested.pathname;
  });
  if (hostAndPathMatches.length === 1) return hostAndPathMatches[0]!;
  if (requested.pathname !== "/mcp") return null;
  const hostMatches = supportedResources.filter(
    (resource) => new URL(resource).host === requested.host,
  );
  return hostMatches.length === 1 ? hostMatches[0]! : null;
}

/** Resolve a metadata request to the exact protected resource it describes. */
export function resolveMetadataRequestResource(
  requestUrl: string,
  supportedResources: readonly string[],
): string | null {
  let requested: URL;
  try {
    requested = new URL(requestUrl);
  } catch {
    return null;
  }
  const exact = normalizeResource(`${requested.origin}${requested.pathname}`);
  const exactMatch = supportedResources.find(
    (resource) => normalizeResource(protectedResourceMetadataUrl(resource)) === exact,
  );
  if (exactMatch) return exactMatch;
  const proxyMatches = supportedResources.filter((resource) => {
    const metadata = new URL(protectedResourceMetadataUrl(resource));
    return metadata.host === requested.host && metadata.pathname === requested.pathname;
  });
  return proxyMatches.length === 1 ? proxyMatches[0]! : null;
}

export function protectedResourceMetadataUrl(resource: string): string {
  const parsed = new URL(resource);
  return `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`;
}

function normalizeResource(value: string): string {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
