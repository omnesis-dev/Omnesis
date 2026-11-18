// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSafeMcpResourceUrl, isSafePublicBaseUrl } from "@omnesis/config";

export type OAuthIssuerSource = readonly string[] | (() => readonly string[]);

/** A request URL whose Host is no issuer's, so the configured issuers alone decide. */
const CONFIGURED_ISSUER_REQUEST = "https://configured-issuer.invalid/mcp";

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

/**
 * Select an explicitly configured issuer, or the loopback origin a request names, and keep
 * each issuer's authorization resources separate. Any other request Host is never an issuer.
 * A loopback Host is an issuer when nothing is configured, or when the caller knows the
 * request came from the gateway's own machine (`local`): a Host alone cannot say so, since a
 * proxy or Tailscale passes on whatever Host the client sent.
 */
export function resolveOAuthUrls(
  requestUrl: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  issuerSource: OAuthIssuerSource = [],
  { local = false }: { local?: boolean } = {},
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
  // Software on the gateway's own machine signs in at the loopback address it dialled,
  // whatever public address the gateway also has.
  const loopback =
    isLoopbackHostname(requested.hostname) && (!primary || local) ? requested.origin : undefined;
  const issuer =
    extras.find((value) => new URL(value).host === requested.host) ??
    loopback ??
    primary ??
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
  // A stored loopback resource was authorized for a request from the gateway's own machine.
  const urls = resolveOAuthUrls(resource, base, resources, additionalIssuers, { local: true });
  return urls?.issuerResources.includes(resource) ? urls : null;
}

/**
 * What the portal's access overview offers agents: the addresses resolved for the portal's
 * own request, led by the configured address even for a portal open on the gateway's own
 * machine; without any, the gateway's loopback address. A remote request origin is never
 * offered.
 */
export function resolveOAuthOverviewUrls(
  requestUrl: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  loopbackBaseUrl?: string,
  additionalIssuers?: OAuthIssuerSource,
): OAuthEndpointUrls | null {
  return (
    resolveOAuthUrls(
      isLoopbackUrl(requestUrl) ? CONFIGURED_ISSUER_REQUEST : requestUrl,
      configuredBaseUrl,
      configuredResources,
      additionalIssuers,
    ) ??
    resolveLocalOAuthUrls(
      loopbackBaseUrl,
      configuredBaseUrl,
      configuredResources,
      additionalIssuers,
    )
  );
}

/**
 * The gateway's loopback address alone, which software on its own machine can always sign
 * in through, whatever else is configured: the overview's last resort when no other
 * address answers. Null without a loopback listener.
 */
export function resolveLocalOAuthUrls(
  loopbackBaseUrl?: string,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  additionalIssuers?: OAuthIssuerSource,
): OAuthEndpointUrls | null {
  if (!loopbackBaseUrl || !isLoopbackUrl(loopbackBaseUrl)) return null;
  const local = resolveOAuthUrls(
    loopbackBaseUrl,
    configuredBaseUrl,
    configuredResources,
    additionalIssuers,
    { local: true },
  );
  if (!local) return null;
  return { ...local, supportedResources: [local.resource], issuerResources: [local.resource] };
}

/**
 * Keep only the resources `answers` accepts, leading with the overview's own
 * resource while it is one of them. With none left, `fallback` decides. When
 * every resource answers the overview is returned unchanged.
 */
export function narrowOAuthOverviewUrls(
  urls: OAuthEndpointUrls | null,
  answers: (resource: string) => boolean,
  fallback: () => OAuthEndpointUrls | null,
): OAuthEndpointUrls | null {
  if (!urls) return null;
  const supportedResources = urls.supportedResources.filter(answers);
  if (supportedResources.length === urls.supportedResources.length) return urls;
  if (supportedResources.length === 0) return fallback();
  const resource = answers(urls.resource) ? urls.resource : supportedResources[0]!;
  return {
    ...urls,
    resource,
    supportedResources,
    issuerResources: urls.issuerResources.filter(answers),
    protectedResourceMetadata: protectedResourceMetadataUrl(resource),
  };
}

export function resolveOAuthMetadataPaths(
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  additionalIssuers?: OAuthIssuerSource,
): OAuthMetadataPaths | null {
  // The loopback issuer's paths are the defaults the metadata routes fall back to.
  const urls = resolveOAuthUrls(
    CONFIGURED_ISSUER_REQUEST,
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

/** Whether an address names this machine's loopback interface. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
