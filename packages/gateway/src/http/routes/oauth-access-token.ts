// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";

import { resolveOAuthUrls } from "../../access/oauth-urls.js";
import { oauthTokenRateLimiter } from "../../rate-limit.js";
import { oauthRevokeForm, oauthTokenForm } from "../schemas/oauth-access.js";
import { scope } from "../scope.js";
import { clientIp } from "./admin/internals.js";
import {
  invalidClientError,
  noStore,
  oauthBodyLimit,
  oauthConfigurationRequired,
  oauthError,
  oauthRateLimitError,
  parseBasicClient,
  readOAuthForm,
  tokenMutationError,
} from "./oauth-access-shared.js";
import type { MiddlewareHandler } from "hono";
import type { AccessService } from "../../access/service.js";
import type { AppEnv, RouteApp } from "./types.js";

const log = createLogger("gateway:http:oauth-access");

export function mountOAuthTokenRoutes(
  app: RouteApp,
  access: AccessService,
  options: { publicBaseUrl?: string; mcpResourceUrls?: readonly string[] },
): void {
  const limiter = oauthTokenRateLimiter();
  const rateLimitTokenMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (limiter.consume(clientIp(c))) return oauthRateLimitError(c);
    return next();
  };
  app.post(
    "/oauth/token",
    noStore,
    scope.public(),
    rateLimitTokenMutation,
    oauthBodyLimit,
    async (c) => {
      const form = await readOAuthForm(c);
      if (!form.ok) return oauthError(c, 400, "invalid_request", form.description);
      const params = oauthTokenForm.safeParse(form.values);
      if (!params.success) {
        return oauthError(c, 400, "invalid_request", "The token request is invalid.");
      }
      const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
      if (!urls) return oauthConfigurationRequired(c);
      const authorizationHeader = c.req.header("Authorization");
      const basic = parseBasicClient(authorizationHeader);
      if (authorizationHeader && !basic) {
        log.warn("OAuth client authentication rejected: malformed Authorization header");
        return invalidClientError(c);
      }
      const resource = params.data.resource;
      const expectedResource =
        resource && urls.supportedResources.includes(resource) ? resource : urls.resource;
      let result;
      if (params.data.grant_type === "authorization_code") {
        if (!resource) {
          return oauthError(c, 400, "invalid_request", "The OAuth resource is required.");
        }
        if (
          (!basic && !params.data.client_id) ||
          (basic && params.data.client_id && basic.clientId !== params.data.client_id)
        ) {
          log.warn("OAuth client authentication rejected for authorization_code");
          return invalidClientError(c);
        }
        result = await access.exchangeOAuthToken(
          {
            grantType: "authorization_code",
            code: params.data.code ?? "",
            clientId: basic?.clientId ?? params.data.client_id ?? "",
            ...(basic ? { clientSecret: basic.clientSecret } : {}),
            redirectUri: params.data.redirect_uri ?? "",
            codeVerifier: params.data.code_verifier ?? "",
            resource,
          },
          expectedResource,
        );
      } else if (params.data.grant_type === "refresh_token") {
        if (
          (!basic && !params.data.client_id) ||
          (basic && params.data.client_id && basic.clientId !== params.data.client_id)
        ) {
          log.warn("OAuth client authentication rejected for refresh_token");
          return invalidClientError(c);
        }
        result = await access.exchangeOAuthToken(
          {
            grantType: "refresh_token",
            refreshToken: params.data.refresh_token ?? "",
            clientId: basic?.clientId ?? params.data.client_id ?? "",
            ...(basic ? { clientSecret: basic.clientSecret } : {}),
            ...(resource ? { resource } : {}),
          },
          expectedResource,
          urls.supportedResources,
        );
      } else {
        return oauthError(c, 400, "unsupported_grant_type", "Unsupported grant type.");
      }
      if (!result.ok && result.error === "invalid-client") {
        log.warn(
          `OAuth client authentication failed for ${params.data.grant_type} using ${basic ? "client_secret_basic" : "none"}`,
        );
      }
      if (!result.ok) return tokenMutationError(c, result.error);
      return c.json({
        access_token: result.value.accessToken,
        token_type: result.value.tokenType,
        expires_in: result.value.expiresIn,
        scope: result.value.scope,
        ...(result.value.refreshToken ? { refresh_token: result.value.refreshToken } : {}),
      });
    },
  );

  app.post(
    "/oauth/revoke",
    noStore,
    scope.public(),
    rateLimitTokenMutation,
    oauthBodyLimit,
    async (c) => {
      const form = await readOAuthForm(c);
      if (!form.ok) return oauthError(c, 400, "invalid_request", form.description);
      const params = oauthRevokeForm.safeParse(form.values);
      if (!params.success) return c.body(null, 200);
      const authorizationHeader = c.req.header("Authorization");
      const basic = parseBasicClient(authorizationHeader);
      if (authorizationHeader && !basic) return invalidClientError(c);
      if (basic && params.data.client_id) {
        return oauthError(
          c,
          400,
          "invalid_request",
          "Use exactly one client authentication method.",
        );
      }
      const clientId = basic?.clientId ?? params.data.client_id ?? "";
      if (clientId) {
        const result = await access.revoke({
          kind: "token",
          token: params.data.token,
          clientId,
          ...(basic ? { clientSecret: basic.clientSecret } : {}),
        });
        if (typeof result !== "boolean" && !result.ok && result.error === "invalid-client") {
          return invalidClientError(c);
        }
      }
      return c.body(null, 200);
    },
  );
}
