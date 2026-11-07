// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSafeMcpResourceUrl, isSafePublicBaseUrl } from "@omnesis/config";

export type OAuthIssuerSource = readonly string[] | (() => readonly string[]);

export interface OAuthEndpointUrls {
  issuer: string;
  resource: string;
  supportedResources: readonly string[];
  /** Resources this explicitly configured issuer may authorize or refresh. */
  issuerResources: readonly string[];
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

/** Select only an explicitly configured issuer and keep its authorization resources separate. */
export function resolveOAuthUrls(
  requestUrl: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  issuerSource: OAuthIssuerSource = [],
): OAuthEndpointUrls | null {
  const additionalIssuers = typeof issuerSource === "function" ? issuerSource() : issuerSource;
  let requested: URL;
  try {
    requested = new URL(requestUrl);
  } catch {
    return null;
  }
  if (configuredBaseUrl && !isSafePublicBaseUrl(configuredBaseUrl)) return null;
  if (
    additionalIssuers.length > 8 ||
    additionalIssuers.some((value) => !isSafePublicBaseUrl(value))
  )
    return null;
  const primary = configuredBaseUrl ? canonicalIssuer(configuredBaseUrl) : undefined;
  const extras = [...new Set(additionalIssuers.map(canonicalIssuer))];
  const configured = [...new Set([...(primary ? [primary] : []), ...extras])];
  // Distinct issuer prefixes on the same origin cannot be selected safely after proxy path rewriting.
  if (new Set(configured.map((value) => new URL(value).origin)).size !== configured.length)
    return null;
  const loopback =
    !primary && isLoopbackHostname(requested.hostname) ? requested.origin : undefined;
  const issuer =
    extras.find((value) => new URL(value).host === requested.host) ??
    primary ??
    loopback ??
    extras[0];
  if (!issuer) return null;
  const bases = [...configured, ...(loopback ? [loopback] : [])];
  const defaultIssuer = primary ?? extras[0] ?? issuer;
  const issuerOf = (resource: string): string =>
    bases.find((base) => new URL(base).origin === new URL(resource).origin) ?? defaultIssuer;
  const resource = `${issuer}/mcp`;
  const supportedResources = new Set([
    `${primary ?? issuer}/mcp`,
    ...extras.map((base) => `${base}/mcp`),
  ]);
  for (const candidate of configuredResources ?? []) {
    if (!isSafeMcpResourceUrl(candidate)) return null;
    supportedResources.add(normalizeResource(candidate));
  }
  supportedResources.add(resource);
  return {
    issuer,
    resource,
    supportedResources: [...supportedResources],
    issuerResources: [...supportedResources].filter((value) => issuerOf(value) === issuer),
    authorize: `${issuer}/oauth/authorize`,
    token: `${issuer}/oauth/token`,
    register: `${issuer}/oauth/register`,
    revoke: `${issuer}/oauth/revoke`,
    protectedResourceMetadata: protectedResourceMetadataUrl(resource),
  };
}

function canonicalIssuer(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

/** Completion follows the stored, already validated resource, never the portal's request Host. */
export function resolveOAuthResourceUrls(
  resource: string,
  base?: string,
  resources?: readonly string[],
  additionalIssuers?: OAuthIssuerSource,
): OAuthEndpointUrls | null {
  const urls = resolveOAuthUrls(resource, base, resources, additionalIssuers);
  return urls?.issuerResources.includes(resource) ? urls : null;
}

/** Advertise same-machine setup without permitting OAuth on a remote request origin. */
export function resolveOAuthOverviewUrls(
  requestUrl: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  loopbackBaseUrl?: string,
  additionalIssuers?: OAuthIssuerSource,
): OAuthEndpointUrls | null {
  const urls = resolveOAuthUrls(
    requestUrl,
    configuredBaseUrl,
    configuredResources,
    additionalIssuers,
  );
  if (urls || configuredBaseUrl || !loopbackBaseUrl) return urls;
  return resolveOAuthUrls(loopbackBaseUrl, undefined, configuredResources, additionalIssuers);
}

export function resolveOAuthMetadataPaths(
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  additionalIssuers?: OAuthIssuerSource,
): OAuthMetadataPaths | null {
  const urls = resolveOAuthUrls(
    "http://127.0.0.1/mcp",
    configuredBaseUrl,
    configuredResources,
    additionalIssuers,
  );
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
