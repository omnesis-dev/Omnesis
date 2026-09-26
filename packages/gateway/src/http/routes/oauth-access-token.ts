// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";

import {
  ClientAssertionVerifier,
  JWT_BEARER_CLIENT_ASSERTION_TYPE,
  unverifiedAssertionSubject,
} from "../../access/client-assertion.js";
import { resolveOAuthUrls, type OAuthEndpointUrls } from "../../access/oauth-urls.js";
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
import type { OAuthClientCredentials } from "../../access/types.js";
import type { AppEnv, RouteApp } from "./types.js";

const log = createLogger("gateway:http:oauth-access");

type ClientAuthMethod = "none" | "client_secret_basic" | "private_key_jwt";

/**
 * The one client-authentication method a token or revocation request used.
 * A `private_key_jwt` assertion has already been verified here, off the
 * writer; the writer confirms the method matches the client's registration.
 */
type ClientAuthentication =
  | {
      ok: true;
      method: ClientAuthMethod;
      clientId: string | undefined;
      credentials: OAuthClientCredentials;
    }
  | {
      ok: false;
      method: ClientAuthMethod | "unknown";
      error: "invalid_client" | "invalid_request";
      reason: string;
    };

export function mountOAuthTokenRoutes(
  app: RouteApp,
  access: AccessService,
  options: {
    publicBaseUrl?: string;
    mcpResourceUrls?: readonly string[];
    clientAssertionVerifier?: Pick<ClientAssertionVerifier, "verify">;
  },
): void {
  const limiter = oauthTokenRateLimiter();
  const assertionVerifier = options.clientAssertionVerifier ?? new ClientAssertionVerifier();
  const rateLimitTokenMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (limiter.consume(clientIp(c))) return oauthRateLimitError(c);
    return next();
  };

  const authenticateClient = async (
    authorizationHeader: string | undefined,
    form: { client_id?: string; client_assertion_type?: string; client_assertion?: string },
    audiences: readonly string[],
  ): Promise<ClientAuthentication> => {
    const basic = parseBasicClient(authorizationHeader);
    if (authorizationHeader && !basic) {
      return {
        ok: false,
        method: "client_secret_basic",
        error: "invalid_client",
        reason: "malformed Authorization header",
      };
    }
    const assertionPresented =
      form.client_assertion !== undefined || form.client_assertion_type !== undefined;
    if (basic && assertionPresented) {
      return {
        ok: false,
        method: "unknown",
        error: "invalid_request",
        reason: "more than one client authentication method",
      };
    }
    if (basic) {
      if (form.client_id !== undefined && form.client_id !== basic.clientId) {
        return {
          ok: false,
          method: "client_secret_basic",
          error: "invalid_client",
          reason: "client_id does not match the Authorization header",
        };
      }
      return {
        ok: true,
        method: "client_secret_basic",
        clientId: basic.clientId,
        credentials: { clientSecret: basic.clientSecret },
      };
    }
    if (!assertionPresented) {
      return { ok: true, method: "none", clientId: form.client_id, credentials: {} };
    }
    if (
      form.client_assertion_type !== JWT_BEARER_CLIENT_ASSERTION_TYPE ||
      form.client_assertion === undefined
    ) {
      return {
        ok: false,
        method: "private_key_jwt",
        error: "invalid_client",
        reason: "unsupported or incomplete client assertion",
      };
    }
    const clientId = form.client_id ?? unverifiedAssertionSubject(form.client_assertion);
    const client = clientId ? access.getOAuthClient(clientId) : null;
    if (!clientId || !client) {
      return {
        ok: false,
        method: "private_key_jwt",
        error: "invalid_client",
        reason: "unknown client",
      };
    }
    if (client.tokenEndpointAuthMethod !== "private_key_jwt" || !client.jwksUri) {
      return {
        ok: false,
        method: "private_key_jwt",
        error: "invalid_client",
        reason: `client ${clientId} is registered for ${client.tokenEndpointAuthMethod}`,
      };
    }
    try {
      const clientAssertion = await assertionVerifier.verify(form.client_assertion, {
        clientId,
        jwksUri: client.jwksUri,
        audiences,
      });
      return { ok: true, method: "private_key_jwt", clientId, credentials: { clientAssertion } };
    } catch (error) {
      return {
        ok: false,
        method: "private_key_jwt",
        error: "invalid_client",
        reason: `client ${clientId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  /**
   * `aud` must identify this authorization server (RFC 7523 §3): its issuer
   * identifier, its token endpoint, or the endpoint receiving the assertion.
   */
  const assertionAudiences = (urls: OAuthEndpointUrls, endpoint: string) => [
    ...new Set([urls.issuer, urls.token, endpoint]),
  ];

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
      const grantType = params.data.grant_type;
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        return oauthError(c, 400, "unsupported_grant_type", "Unsupported grant type.");
      }
      const resource = params.data.resource;
      if (grantType === "authorization_code" && !resource) {
        return oauthError(c, 400, "invalid_request", "The OAuth resource is required.");
      }
      const auth = await authenticateClient(
        c.req.header("Authorization"),
        params.data,
        assertionAudiences(urls, urls.token),
      );
      if (!auth.ok) {
        log.warn(
          `OAuth client authentication rejected for ${grantType} using ${auth.method}: ${auth.reason}`,
        );
        return auth.error === "invalid_request"
          ? oauthError(c, 400, "invalid_request", "Use exactly one client authentication method.")
          : invalidClientError(c);
      }
      if (!auth.clientId) {
        log.warn(`OAuth client authentication rejected for ${grantType}: no client identified`);
        return invalidClientError(c);
      }
      const expectedResource =
        resource && urls.supportedResources.includes(resource) ? resource : urls.resource;
      const result =
        grantType === "authorization_code"
          ? await access.exchangeOAuthToken(
              {
                grantType: "authorization_code",
                code: params.data.code ?? "",
                clientId: auth.clientId,
                ...auth.credentials,
                redirectUri: params.data.redirect_uri ?? "",
                codeVerifier: params.data.code_verifier ?? "",
                resource: resource!,
              },
              expectedResource,
            )
          : await access.exchangeOAuthToken(
              {
                grantType: "refresh_token",
                refreshToken: params.data.refresh_token ?? "",
                clientId: auth.clientId,
                ...auth.credentials,
                ...(resource ? { resource } : {}),
              },
              expectedResource,
              urls.supportedResources,
            );
      if (!result.ok && result.error === "invalid-client") {
        log.warn(`OAuth client authentication failed for ${grantType} using ${auth.method}`);
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
      // A Basic-authenticated revocation names its client only in the header.
      if (parseBasicClient(authorizationHeader) && params.data.client_id) {
        return oauthError(
          c,
          400,
          "invalid_request",
          "Use exactly one client authentication method.",
        );
      }
      const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
      if (!urls) return oauthConfigurationRequired(c);
      const auth = await authenticateClient(
        authorizationHeader,
        params.data,
        assertionAudiences(urls, urls.revoke),
      );
      if (!auth.ok) {
        log.warn(
          `OAuth revocation client authentication rejected using ${auth.method}: ${auth.reason}`,
        );
        return auth.error === "invalid_request"
          ? oauthError(c, 400, "invalid_request", "Use exactly one client authentication method.")
          : invalidClientError(c);
      }
      if (auth.clientId) {
        const result = await access.revoke({
          kind: "token",
          token: params.data.token,
          clientId: auth.clientId,
          ...auth.credentials,
        });
        if (typeof result !== "boolean" && !result.ok && result.error === "invalid-client") {
          log.warn(`OAuth revocation client authentication failed using ${auth.method}`);
          return invalidClientError(c);
        }
      }
      return c.body(null, 200);
    },
  );
}
