// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  resolveMetadataRequestResource,
  resolveMcpRequestResource,
  resolveOAuthMetadataPaths,
  resolveOAuthUrls,
} from "../../access/oauth-urls.js";
import { SUPPORTED_CLIENT_ASSERTION_ALGORITHMS } from "../../access/client-assertion.js";
import { OAUTH_OFFLINE_ACCESS_SCOPE } from "../../access/oauth-scopes.js";
import { MCP_ACCESS_SCOPE } from "../../access/types.js";
import { oauthRegistrationRateLimiter } from "../../rate-limit.js";
import { oauthRegisterBody } from "../schemas/oauth-access.js";
import { scope } from "../scope.js";
import { clientIp } from "./admin/internals.js";
import {
  noStore,
  oauthBodyLimit,
  oauthConfigurationRequired,
  oauthError,
  oauthRateLimitError,
  validateHttpsUrl,
  validateRedirectUri,
} from "./oauth-access-shared.js";
import type { Handler, MiddlewareHandler } from "hono";
import type { AccessService } from "../../access/service.js";
import type { AppEnv, RouteApp } from "./types.js";

export function mountOAuthMetadataRoutes(
  app: RouteApp,
  access: AccessService,
  options: { publicBaseUrl?: string; mcpResourceUrls?: readonly string[] },
): void {
  const registrationLimiter = oauthRegistrationRateLimiter();
  const metadataPaths = resolveOAuthMetadataPaths(options.publicBaseUrl, options.mcpResourceUrls);
  const rateLimitRegistration: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (registrationLimiter.consume(clientIp(c))) return oauthRateLimitError(c);
    return next();
  };
  const protectedResourceMetadata: Handler<AppEnv> = (c) => {
    const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
    if (!urls) return oauthConfigurationRequired(c);
    const resource =
      resolveMetadataRequestResource(c.req.url, urls.supportedResources) ??
      (c.req.path === "/.well-known/oauth-protected-resource"
        ? resolveMcpRequestResource(`${new URL(c.req.url).origin}/mcp`, urls.supportedResources)
        : null);
    if (!resource) return c.json({ error: "Unknown OAuth protected resource." }, 404);
    return c.json({
      resource,
      authorization_servers: [urls.issuer],
      scopes_supported: [MCP_ACCESS_SCOPE, OAUTH_OFFLINE_ACCESS_SCOPE],
      bearer_methods_supported: ["header"],
    });
  };
  const authorizationServerMetadata: Handler<AppEnv> = (c) => {
    const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
    if (!urls) return oauthConfigurationRequired(c);
    return c.json({
      issuer: urls.issuer,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      registration_endpoint: urls.register,
      revocation_endpoint: urls.revoke,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      // `private_key_jwt` is for clients identified by a metadata document
      // that names their key set; dynamic registration offers the other two.
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: [...SUPPORTED_CLIENT_ASSERTION_ALGORITHMS],
      revocation_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "private_key_jwt",
      ],
      revocation_endpoint_auth_signing_alg_values_supported: [
        ...SUPPORTED_CLIENT_ASSERTION_ALGORITHMS,
      ],
      scopes_supported: [MCP_ACCESS_SCOPE, OAUTH_OFFLINE_ACCESS_SCOPE],
      resource_indicators_supported: true,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };
  const protectedResourcePaths = new Set([
    ...(metadataPaths?.protectedResources ?? ["/.well-known/oauth-protected-resource/mcp"]),
    // Some hosts probe the origin-level RFC 9728 endpoint before making an
    // MCP request, so they have no WWW-Authenticate challenge to follow yet.
    "/.well-known/oauth-protected-resource",
  ]);
  for (const path of protectedResourcePaths) {
    app.get(path, noStore, scope.public(), protectedResourceMetadata);
  }
  app.get(
    metadataPaths?.authorizationServer ?? "/.well-known/oauth-authorization-server",
    noStore,
    scope.public(),
    authorizationServerMetadata,
  );
  app.get(
    metadataPaths?.openIdConfiguration ?? "/.well-known/openid-configuration",
    noStore,
    scope.public(),
    authorizationServerMetadata,
  );
  app.post(
    "/oauth/register",
    noStore,
    scope.public(),
    rateLimitRegistration,
    oauthBodyLimit,
    async (c) => {
      const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return oauthError(c, 400, "invalid_client_metadata", "Registration requires JSON.");
      }
      let untrusted: unknown;
      try {
        untrusted = await c.req.json();
      } catch {
        return oauthError(c, 400, "invalid_client_metadata", "Registration JSON is malformed.");
      }
      const parsed = oauthRegisterBody.safeParse(untrusted);
      if (!parsed.success) {
        const redirectIssue = parsed.error.issues.some(
          (issue) => issue.path[0] === "redirect_uris",
        );
        return oauthError(
          c,
          400,
          redirectIssue ? "invalid_redirect_uri" : "invalid_client_metadata",
          "OAuth client metadata is invalid.",
        );
      }
      const body = parsed.data;
      let redirectUris: string[];
      try {
        redirectUris = body.redirect_uris.map(validateRedirectUri);
      } catch (error) {
        return oauthError(c, 400, "invalid_redirect_uri", errorMessage(error));
      }
      let clientUri: string | null;
      try {
        clientUri = body.client_uri ? validateHttpsUrl(body.client_uri, "client_uri") : null;
      } catch (error) {
        return oauthError(c, 400, "invalid_client_metadata", errorMessage(error));
      }
      const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
      const responseTypes = body.response_types ?? ["code"];
      const tokenEndpointAuthMethod = body.token_endpoint_auth_method ?? "none";
      if (
        !grantTypes.includes("authorization_code") ||
        grantTypes.some((value) => value !== "authorization_code" && value !== "refresh_token") ||
        responseTypes.length !== 1 ||
        responseTypes[0] !== "code" ||
        (tokenEndpointAuthMethod !== "none" && tokenEndpointAuthMethod !== "client_secret_basic")
      ) {
        return oauthError(c, 400, "invalid_client_metadata", "Unsupported OAuth client metadata.");
      }
      const registered = await access.registerOAuthClient({
        clientName: body.client_name,
        redirectUris,
        grantTypes,
        responseTypes,
        tokenEndpointAuthMethod,
        clientUri,
      });
      return c.json(
        {
          client_id: registered.clientId,
          client_id_issued_at: Math.floor(registered.createdAt / 1_000),
          client_name: registered.clientName,
          redirect_uris: registered.redirectUris,
          grant_types: registered.grantTypes,
          response_types: registered.responseTypes,
          token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
          ...(registered.clientSecret
            ? { client_secret: registered.clientSecret, client_secret_expires_at: 0 }
            : {}),
          ...(registered.clientUri ? { client_uri: registered.clientUri } : {}),
        },
        201,
      );
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid OAuth client metadata.";
}
