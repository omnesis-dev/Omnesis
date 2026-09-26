// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { buildPage, clampLimit, scopeSatisfies, SCOPE_ADMIN, tryDeviceId } from "@omnesis/types";

import {
  createServedByGatewayCheck,
  type CertificateProbe,
  type ServedResource,
} from "../../access/served-by-gateway.js";
import { resolveOAuthOverviewUrls, resolveOAuthUrls } from "../../access/oauth-urls.js";
import { ClientMetadataDocumentResolver } from "../../access/client-metadata-document.js";
import { normalizeInteractiveOAuthScope } from "../../access/oauth-scopes.js";
import { MCP_ACCESS_SCOPE, type AuthorizationRequestPortal } from "../../access/types.js";
import {
  oauthAuthorizationNotificationRateLimiter,
  oauthAuthorizationRateLimiter,
  oauthTokenRateLimiter,
} from "../../rate-limit.js";
import { NotFoundError } from "../errors.js";
import { decodePageCursor, encodePageCursor } from "../pagination-cursor.js";
import {
  accessConnectionLevelBody,
  accessDeviceLevelBody,
  accessDecisionBody,
  accessExecutionBindingBody,
  accessExecutionReissueBody,
  accessGrantUpdateBody,
  accessLevelCreateBody,
  accessLevelUpdateBody,
  accessLookupBody,
  accessPrincipalUpdateBody,
  accessRevokeBody,
  oauthApprovalId,
  oauthAuthorizationQuery,
} from "../schemas/oauth-access.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { clientIp } from "./admin/internals.js";
import {
  applyConsentHeaders,
  renderConsentFinishedPage,
  renderConsentGonePage,
  renderConsentPage,
} from "./oauth-consent-page.js";
import {
  authorizationRedirectError,
  hasDuplicateQueryParameter,
  mapAuthorizeError,
  noStore,
  oauthConfigurationRequired,
  oauthError,
  oauthRateLimitError,
  parseAuthorizationHandle,
  validateHttpsUrl,
  validateRedirectUri,
} from "./oauth-access-shared.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, RouteApp } from "./types.js";
import type { AccessService } from "../../access/service.js";
import type { AccessAuthorizationNotifier } from "../../access/authorization-notifier.js";

const log = createLogger("gateway:http:oauth-access");
const REPEATABLE_AUTHORIZATION_PARAMETERS = new Set(["resource"]);
const ACCESS_AUDIT_CURSOR_SCOPE = "access-audit";
const ACCESS_AUDIT_DEFAULT_LIMIT = 50;
const ACCESS_AUDIT_MAX_LIMIT = 500;

export function mountOAuthAuthorizationRoutes(
  app: RouteApp,
  access: AccessService,
  options: {
    publicBaseUrl?: string;
    /** Actual same-machine gateway origin advertised for local-only setup. */
    loopbackBaseUrl?: string;
    mcpResourceUrls?: readonly string[];
    authorizationNotifier?: Pick<AccessAuthorizationNotifier, "targetDeviceIds" | "wakeQueued">;
    clientMetadataResolver?: Pick<ClientMetadataDocumentResolver, "resolve">;
    /**
     * A request was created or decided, so the moment the access sweep should
     * next wake for has moved. The sweep re-reads that moment on its next
     * tick; this asks for that tick now rather than at the idle period.
     */
    onAuthorizationPending?: () => void;
    /**
     * A device was put on or taken off an access level. The device list is
     * served from a cache that only a mutation refreshes, so the route asks
     * for that refresh before it answers.
     */
    onDeviceLevelChanged?: () => void;
    /** SHA-256 fingerprint of the certificate this gateway serves right now. */
    tlsFingerprintSha256?: string | (() => string);
    /** The port the gateway listens on, which tells its own listener from a proxy. */
    listenPort?: number;
    /** Replaces the TLS connection that checks which certificate a resource presents (tests). */
    probeCertificate?: CertificateProbe;
  } = {},
): void {
  const authorizationLimiter = oauthAuthorizationRateLimiter();
  // The two device-facing agent-integration routes mint or bind the same
  // credential material `/oauth/token` does, so they get the same ceiling.
  // Authenticated is not unlimited: a wedged plugin retrying in a loop would
  // otherwise append token and audit rows without bound.
  const integrationLimiter = oauthTokenRateLimiter();
  const rateLimitIntegration: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (integrationLimiter.consume(clientIp(c))) return oauthRateLimitError(c);
    return next();
  };
  const clientMetadataResolver =
    options.clientMetadataResolver ?? new ClientMetadataDocumentResolver();
  const notificationPeerLimiter = oauthAuthorizationNotificationRateLimiter(
    "OAuth access notification per peer",
  );
  const notificationClientLimiter = oauthAuthorizationNotificationRateLimiter(
    "OAuth access notification per client",
  );
  const notificationGlobalLimiter = oauthAuthorizationNotificationRateLimiter(
    "OAuth access notification gateway-wide",
    {
      burst: { capacity: 10, windowMs: 60_000 },
      hourly: { capacity: 60, windowMs: 3_600_000 },
    },
  );

  app.get("/oauth/authorize", noStore, scope.public(), async (c) => {
    if (authorizationLimiter.consume(clientIp(c))) return oauthRateLimitError(c);
    const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
    if (!urls) return oauthConfigurationRequired(c);
    if (hasDuplicateQueryParameter(c.req.url, REPEATABLE_AUTHORIZATION_PARAMETERS)) {
      return oauthError(c, 400, "invalid_request", "OAuth parameters must occur exactly once.");
    }
    const requestedResources = new URL(c.req.url).searchParams.getAll("resource");
    const parsed = oauthAuthorizationQuery.safeParse(c.req.query());
    if (!parsed.success) {
      const raw = c.req.query();
      if (
        typeof raw.client_id === "string" &&
        typeof raw.redirect_uri === "string" &&
        (raw.state === undefined || (typeof raw.state === "string" && raw.state.length <= 4_096)) &&
        access.isRegisteredRedirect(raw.client_id, raw.redirect_uri)
      ) {
        return authorizationRedirectError(
          c,
          raw.redirect_uri,
          typeof raw.state === "string" ? raw.state : undefined,
          urls.issuer,
          "invalid_request",
          "The authorization request is invalid.",
        );
      }
      return oauthError(c, 400, "invalid_request", "The authorization request is invalid.");
    }
    const query = parsed.data;
    const requestedScope = normalizeInteractiveOAuthScope(query.scope ?? MCP_ACCESS_SCOPE);
    const requestedResource = requestedResources[0];
    const requestedResourceIsValid =
      requestedResource !== undefined &&
      urls.supportedResources.includes(requestedResource) &&
      requestedResources.every((resource) => resource === requestedResource);
    if (!requestedResourceIsValid || !requestedScope) {
      if (access.isRegisteredRedirect(query.client_id, query.redirect_uri)) {
        return authorizationRedirectError(
          c,
          query.redirect_uri,
          query.state,
          urls.issuer,
          requestedScope ? "invalid_target" : "invalid_scope",
          "The authorization request is invalid.",
        );
      }
      return oauthError(c, 400, "invalid_request", "The authorization request is invalid.");
    }
    if (/^https:/iu.test(query.client_id)) {
      try {
        const discovered = await clientMetadataResolver.resolve(query.client_id);
        if (!discovered || discovered.clientId !== query.client_id) {
          throw new Error("Client metadata is unavailable.");
        }
        await access.registerOAuthMetadataClient({
          ...discovered,
          redirectUris: discovered.redirectUris.map(validateRedirectUri),
          clientUri: discovered.clientUri
            ? validateHttpsUrl(discovered.clientUri, "client_uri")
            : null,
        });
      } catch (error) {
        log.warn(
          `Client metadata for ${JSON.stringify(query.client_id)} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        );
        return oauthError(c, 400, "invalid_client", "Client metadata could not be verified.");
      }
    }
    const created = await access.createAuthorizationRequest(
      {
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        state: query.state,
        codeChallenge: query.code_challenge,
        resource: requestedResource,
        scope: requestedScope,
        ...(query.omnesis_execution_binding
          ? { executionBinding: query.omnesis_execution_binding }
          : {}),
      },
      requestedResource,
    );
    if (created.ok) options.onAuthorizationPending?.();
    if (!created.ok) {
      if (
        created.error !== "invalid-client" &&
        created.error !== "invalid-redirect-uri" &&
        access.isRegisteredRedirect(query.client_id, query.redirect_uri)
      ) {
        return authorizationRedirectError(
          c,
          query.redirect_uri,
          query.state,
          urls.issuer,
          mapAuthorizeError(created.error),
          "Authorization refused.",
        );
      }
      return oauthError(c, 400, mapAuthorizeError(created.error), "Authorization refused.");
    }
    log.info(
      `Authorization request ${created.value.id} created for ${query.client_id.slice(0, 16)} returning to ${new URL(query.redirect_uri).origin}`,
    );
    if (
      options.authorizationNotifier &&
      notificationPeerLimiter.consume(clientIp(c)) === null &&
      notificationClientLimiter.consume(query.client_id) === null &&
      notificationGlobalLimiter.consume("gateway") === null
    ) {
      try {
        const queued = await access.enqueueAuthorizationNotification(
          created.value.id,
          options.authorizationNotifier.targetDeviceIds(),
        );
        // The outbox row is durable once enqueued and the retry scheduler owns
        // it from here, so the immediate wake — one writer turn per phone —
        // runs after this response rather than in front of the redirect.
        if (queued) {
          options.authorizationNotifier.wakeQueued(queued.deviceIds).catch(() => {
            log.warn("access authorization immediate wake failed; the retry scheduler owns it");
          });
        }
      } catch {
        // Notification is an optional wake path. Atomic outbox commit means a
        // failed write leaves no one-shot marker, so a later request may retry.
        log.warn("access authorization notification enqueue failed");
      }
    }
    return c.redirect(
      `/oauth/consent?request=${encodeURIComponent(created.value.browserHandle)}`,
      303,
    );
  });

  app.get("/oauth/consent", noStore, scope.public(), (c) => {
    const handle = parseAuthorizationHandle(c);
    const request = access.getAuthorizationByBrowserHandle(handle);
    const nonce = randomBytes(18).toString("base64url");
    if (!request) {
      // A person arrives here from a QR scan or a pasted link. The request
      // being gone is the ordinary end of a ten-minute window, and the page
      // owes them that sentence rather than the API's error envelope.
      applyConsentHeaders(c, nonce);
      return c.html(renderConsentGonePage({ nonce }), 404);
    }
    const auth = c.get("auth");
    const canApprove =
      auth?.authMethod === "portal-session" && scopeSatisfies(auth.scopes, SCOPE_ADMIN);
    if (canApprove) {
      const portalTarget = new URL(
        `/portal/settings/access/authorizations/${encodeURIComponent(request.id)}`,
        c.req.url,
      );
      portalTarget.searchParams.set("completion", "portal");
      return c.redirect(`${portalTarget.pathname}${portalTarget.search}`, 303);
    }
    if (request.status === "approved" && !request.requiresAnswer) {
      // For a redirect-based client the consent tab is the only thing that
      // issues the code: its poll navigates to the completion route once the
      // phone approves. A reload of an approved page must take the same path,
      // or the approval stays undelivered.
      return c.redirect(`/oauth/authorize/complete?request=${encodeURIComponent(handle)}`, 303);
    }
    applyConsentHeaders(c, nonce);
    return c.html(
      renderConsentPage({
        handle,
        request,
        nonce,
      }),
    );
  });

  app.get("/oauth/authorize/status", noStore, scope.public(), (c) => {
    const handle = parseAuthorizationHandle(c);
    const request = access.getAuthorizationByBrowserHandle(handle);
    if (!request) throw new NotFoundError("Authorization request not found.");
    return c.json({ status: request.status, expiresAt: request.expiresAt });
  });

  app.get("/oauth/authorize/complete", noStore, scope.public(), async (c) => {
    const handle = parseAuthorizationHandle(c);
    const result = await access.issueAuthorizationCode(handle);
    if (!result.ok) {
      if (result.error === "authorization-pending") {
        return c.redirect(`/oauth/consent?request=${encodeURIComponent(handle)}`, 303);
      }
      const status = result.error === "expired" ? 410 : result.error === "not-found" ? 404 : 409;
      // A browser reaches this route from the consent page's poll, and the
      // client polls the same request: when the client collected the code
      // first, the person is owed a sentence, not an error envelope. Only a
      // caller asking for JSON gets the envelope.
      if (!wantsJson(c)) {
        const nonce = randomBytes(18).toString("base64url");
        applyConsentHeaders(c, nonce);
        return c.html(
          result.error === "already-decided"
            ? renderConsentFinishedPage({ nonce })
            : renderConsentGonePage({ nonce }),
          status,
        );
      }
      return oauthError(c, status, "invalid_request", result.error);
    }
    const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
    if (!urls) return oauthConfigurationRequired(c);
    return c.redirect(authorizationCompletionTarget(result.value, urls.issuer), 303);
  });

  // Clients built before connections decode `reconnect` and read null as "a
  // plain new connection"; the gateway never joins by name or client, so it
  // is always null beside the `connection` proposal newer clients read.
  const lookupEnvelope = (request: AuthorizationRequestPortal) => ({
    request,
    reconnect: null,
    connection: access.getConnectionProposal(request),
  });
  // Every MCP resource the gateway accepts, marked with whether a client there
  // meets the gateway's own certificate: only then can it check the
  // fingerprint returned beside it.
  const fingerprint = () =>
    typeof options.tlsFingerprintSha256 === "function"
      ? options.tlsFingerprintSha256()
      : options.tlsFingerprintSha256;
  const servedByGateway = createServedByGatewayCheck({
    fingerprint,
    ...(options.listenPort !== undefined ? { listenPort: options.listenPort } : {}),
    ...(options.probeCertificate ? { probe: options.probeCertificate } : {}),
  });
  const accessOverview = async (requestUrl: string) => {
    const urls = resolveOAuthOverviewUrls(
      requestUrl,
      options.publicBaseUrl,
      options.mcpResourceUrls,
      options.loopbackBaseUrl,
    );
    const served = urls
      ? await servedByGateway(urls.supportedResources)
      : new Map<string, ServedResource>();
    return {
      ...access.overview(),
      oauth: urls
        ? {
            resource: urls.resource,
            ...(!options.publicBaseUrl ? { loopbackOnly: true } : {}),
            resources: urls.supportedResources.map((resource) => ({
              resource,
              servedByGateway: served.get(resource)?.servedByGateway ?? false,
              direct: served.get(resource)?.direct ?? false,
              publiclyTrusted: served.get(resource)?.publiclyTrusted ?? false,
            })),
            tlsFingerprintSha256: fingerprint() ?? null,
          }
        : null,
    };
  };
  app.get("/portal/api/access", noStore, scope.admin(), async (c) =>
    c.json(await accessOverview(c.req.url)),
  );
  app.get("/admin/access", noStore, scope.admin(), async (c) =>
    c.json(await accessOverview(c.req.url)),
  );
  app.post(
    "/portal/api/access/authorizations/lookup",
    noStore,
    scope.portalAdmin(),
    validateJson(accessLookupBody),
    (c) => {
      const request = access.getAuthorizationByUserCode(c.req.valid("json").code);
      if (!request) throw new NotFoundError("Authorization request not found.");
      return c.json(lookupEnvelope(request));
    },
  );
  // The portal wizard reads a request in any state so it can show the outcome
  // of one it decided; a device only ever opens a request it can still act on.
  const lookupAuthorizationById = (c: Context<AppEnv>, pendingOnly: boolean) => {
    const approvalId = oauthApprovalId.safeParse(c.req.param("id"));
    if (!approvalId.success) return c.json({ error: "not-found" }, 404);
    const request = access.getAuthorizationById(approvalId.data);
    if (!request || (pendingOnly && request.status !== "pending")) {
      throw new NotFoundError("Authorization request not found.");
    }
    return c.json(lookupEnvelope(request));
  };
  app.get("/portal/api/access/authorizations/:id", noStore, scope.admin(), (c) =>
    lookupAuthorizationById(c, false),
  );
  app.get("/admin/access/authorizations/:id", noStore, scope.admin(), (c) =>
    lookupAuthorizationById(c, true),
  );
  app.get("/admin/access/audit", noStore, scope.admin(), (c) => {
    const limit = clampLimit(c.req.query("limit"), {
      default: ACCESS_AUDIT_DEFAULT_LIMIT,
      max: ACCESS_AUDIT_MAX_LIMIT,
    });
    const principalId = c.req.query("principalId") || undefined;
    const grantId = c.req.query("grantId") || undefined;
    // Encoded as a JSON tuple so two filters never share a scope by sharing
    // characters: ("a:", "") and ("a", ":") stay distinct.
    const filter = JSON.stringify([principalId ?? null, grantId ?? null]);
    const filterScope = `${ACCESS_AUDIT_CURSOR_SCOPE}:${filter}`;
    const after = decodePageCursor(c.req.query("cursor"), filterScope, (payload) => {
      const candidate = payload as { occurredAt?: unknown; id?: unknown } | null;
      return typeof candidate?.occurredAt === "number" && typeof candidate.id === "string"
        ? { occurredAt: candidate.occurredAt, id: candidate.id }
        : null;
    });
    const page = access.listAuditEvents({
      limit,
      ...(after ? { after } : {}),
      ...(principalId ? { principalId } : {}),
      ...(grantId ? { grantId } : {}),
    });
    const last = page.items[page.items.length - 1];
    const nextCursor =
      page.hasMore && last
        ? encodePageCursor(filterScope, { occurredAt: last.occurredAt, id: last.id })
        : undefined;
    return c.json(buildPage(page.items, { hasMore: page.hasMore, limit, nextCursor }));
  });
  app.post(
    "/portal/api/access/authorizations/:id/complete",
    noStore,
    scope.portalAdmin(),
    async (c) => {
      const approvalId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!approvalId.success) return c.json({ error: "not-found" }, 404);
      const request = access.getAuthorizationById(approvalId.data);
      if (!request) throw new NotFoundError("Authorization request not found.");
      // Execution-bound CLI integrations poll and complete their own OAuth
      // request. Letting the browser compete would race the one-shot code.
      if (request.requiresAnswer) return c.json({ error: "client-completes" }, 409);
      const result = await access.issueAuthorizationCodeById(approvalId.data);
      if (!result.ok) {
        return c.json(
          { error: result.error },
          result.error === "not-found" ? 404 : result.error === "expired" ? 410 : 409,
        );
      }
      const urls = resolveOAuthUrls(c.req.url, options.publicBaseUrl, options.mcpResourceUrls);
      if (!urls) return c.json({ error: "oauth-not-configured" }, 503);
      return c.json({ redirectTo: authorizationCompletionTarget(result.value, urls.issuer) });
    },
  );
  app.post(
    "/portal/api/access/authorizations/:id/decision",
    noStore,
    scope.portalAdmin(),
    validateJson(accessDecisionBody),
    async (c) => {
      const body = c.req.valid("json");
      const auth = c.get("auth");
      const approvalId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!approvalId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.decideAuthorizationRequest({
        approvalId: approvalId.data,
        decision: body.decision,
        actorTokenId: auth.tokenId!,
        ...(body.decision === "approve" ? { selection: body.selection } : {}),
      });
      if (!result.ok)
        return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
      options.onAuthorizationPending?.();
      return c.json({ request: result.value });
    },
  );
  app.post(
    "/admin/access/authorizations/lookup",
    noStore,
    scope.admin(),
    validateJson(accessLookupBody),
    (c) => {
      const request = access.getAuthorizationByUserCode(c.req.valid("json").code);
      if (!request) throw new NotFoundError("Authorization request not found.");
      return c.json(lookupEnvelope(request));
    },
  );
  app.post(
    "/admin/access/authorizations/:id/decision",
    noStore,
    scope.admin(),
    validateJson(accessDecisionBody),
    async (c) => {
      const body = c.req.valid("json");
      const approvalId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!approvalId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.decideAuthorizationRequest({
        approvalId: approvalId.data,
        decision: body.decision,
        actorTokenId: c.get("auth").tokenId!,
        ...(body.decision === "approve" ? { selection: body.selection } : {}),
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
      }
      options.onAuthorizationPending?.();
      return c.json({ request: result.value });
    },
  );
  app.post(
    "/portal/api/access/revoke",
    noStore,
    scope.portalAdmin(),
    validateJson(accessRevokeBody),
    async (c) => {
      const body = c.req.valid("json");
      const revoked = await access.revoke({
        ...body,
        actorTokenId: c.get("auth").tokenId!,
      });
      return c.json({ revoked });
    },
  );
  app.patch(
    "/admin/access/grants/:id",
    noStore,
    scope.portalAdmin(),
    validateJson(accessGrantUpdateBody),
    async (c) => {
      const grantId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!grantId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.updateGrant({
        grantId: grantId.data,
        ...c.req.valid("json"),
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "inactive-grant" ? 404 : 409);
      }
      return c.json({ grant: result.value });
    },
  );
  app.post(
    "/admin/access/levels",
    noStore,
    scope.portalAdmin(),
    validateJson(accessLevelCreateBody),
    async (c) => {
      const result = await access.createLevel({
        ...c.req.valid("json"),
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      log.info(`Access level ${result.value.id} created`);
      return c.json({ level: result.value }, 201);
    },
  );
  app.patch(
    "/admin/access/levels/:id",
    noStore,
    scope.portalAdmin(),
    validateJson(accessLevelUpdateBody),
    async (c) => {
      const levelId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!levelId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.updateLevel({
        levelId: levelId.data,
        ...c.req.valid("json"),
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
      }
      log.info(
        `Access level ${levelId.data} updated to revision ${result.value.revision} for ${result.value.connectionCount} connections`,
      );
      return c.json({ level: result.value });
    },
  );
  app.delete("/admin/access/levels/:id", noStore, scope.portalAdmin(), async (c) => {
    const levelId = oauthApprovalId.safeParse(c.req.param("id"));
    if (!levelId.success) return c.json({ error: "not-found" }, 404);
    const result = await access.deleteLevel({
      levelId: levelId.data,
      actorTokenId: c.get("auth").tokenId!,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
    }
    log.info(`Access level ${levelId.data} deleted`);
    return c.json({ removed: true });
  });
  app.put(
    "/admin/access/connections/:id/level",
    noStore,
    scope.portalAdmin(),
    validateJson(accessConnectionLevelBody),
    async (c) => {
      const connectionId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!connectionId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.setConnectionLevel({
        connectionId: connectionId.data,
        ...c.req.valid("json"),
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
      }
      log.info(`Connection ${connectionId.data} moved to access level ${result.value.level.id}`);
      return c.json(result.value);
    },
  );
  // A device's access level decides what its `/answer` requests may read and
  // whether they are reviewed, so it is authored like every other access
  // decision: from a portal session, never with a bearer token.
  app.put(
    "/admin/access/devices/:id/level",
    noStore,
    scope.portalAdmin(),
    validateJson(accessDeviceLevelBody),
    async (c) => {
      const deviceId = tryDeviceId(c.req.param("id") ?? "");
      if (!deviceId) return c.json({ error: "not-found" }, 404);
      const result = await access.setDeviceLevel({
        deviceId,
        ...c.req.valid("json"),
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "not-found" ? 404 : 409);
      }
      options.onDeviceLevelChanged?.();
      log.info(
        `Device ${deviceId} ${result.value.level ? `moved to access level ${result.value.level.id}` : "taken off its access level"}`,
      );
      return c.json(result.value);
    },
  );
  app.patch(
    "/admin/access/principals/:id",
    noStore,
    scope.admin(),
    validateJson(accessPrincipalUpdateBody),
    async (c) => {
      const principalId = oauthApprovalId.safeParse(c.req.param("id"));
      if (!principalId.success) return c.json({ error: "not-found" }, 404);
      const result = await access.renamePrincipal({
        principalId: principalId.data,
        name: c.req.valid("json").name,
        actorTokenId: c.get("auth").tokenId!,
      });
      if (!result.ok) return c.json({ error: result.error }, 404);
      return c.json({ principal: result.value });
    },
  );
  app.post(
    "/agent-integration/oauth-binding",
    noStore,
    scope.subscriptionsManage(),
    rateLimitIntegration,
    validateJson(accessExecutionBindingBody),
    async (c) => {
      const auth = c.get("auth");
      if (!auth.deviceId) return c.json({ error: "A paired agent device is required." }, 403);
      const body = c.req.valid("json");
      const result = await access.createExecutionBinding({
        deviceId: auth.deviceId,
        oauthClientId: body.clientId,
        harness: body.harness,
      });
      return result.ok ? c.json(result.value, 201) : c.json({ error: result.error }, 403);
    },
  );
  // Headless recovery for a harness whose refresh token ran out.
  //
  // The device proves who it is with its own management token — the only
  // credential an unattended plugin still holds once the OAuth ticket is
  // gone — and gets a fresh pair for the credential the operator already
  // approved for it. It cannot reach any other device's credential (the
  // lookup is keyed on the caller's device id), and it cannot bring a
  // credential into being: revoke the grant in the portal and this answers
  // 404 forever after. What a stolen management token buys here is the same
  // corpus access its refresh token already granted, and the two live in one
  // file on one machine.
  //
  // The guard is `subscriptionsManage` because that is the single scope agent
  // pairing mints on the management token, unconditionally and regardless of
  // whether Watches are on. It is a Watch-shaped name in front of a route that
  // matters most on a gateway without Watches, so narrowing that grant when
  // the feature is off would break headless recovery exactly where it is
  // needed; give this route its own scope before doing that.
  app.post(
    "/agent-integration/oauth-reissue",
    noStore,
    scope.subscriptionsManage(),
    rateLimitIntegration,
    validateJson(accessExecutionReissueBody),
    async (c) => {
      const auth = c.get("auth");
      if (!auth.deviceId) return c.json({ error: "A paired agent device is required." }, 403);
      const result = await access.reissueExecutionDeviceTokens({
        deviceId: auth.deviceId,
        oauthClientId: c.req.valid("json").clientId,
      });
      if (!result.ok) {
        // One shape for "no approved credential is bound to you any more",
        // whether it was revoked, expired, or never existed: an unattended
        // plugin's only useful next step is the same either way.
        return c.json(
          {
            // A machine-readable code, because the plugin must tell this
            // refusal apart from the 404 a gateway too old to serve the route
            // returns — one means "re-authorize", the other "upgrade".
            code: "NO_APPROVED_CREDENTIAL",
            error: "no_approved_credential",
            error_description:
              "This device has no active approved Omnesis access credential. " +
              "Re-authorize it with `omnesis connect <harness> --refresh`.",
          },
          404,
        );
      }
      return c.json({
        access_token: result.value.accessToken,
        token_type: result.value.tokenType,
        expires_in: result.value.expiresIn,
        scope: result.value.scope,
        ...(result.value.refreshToken ? { refresh_token: result.value.refreshToken } : {}),
      });
    },
  );
}

/** An API caller names JSON; a browser navigating from the consent page does not. */
function wantsJson(c: Context<AppEnv>): boolean {
  return (c.req.header("Accept") ?? "").includes("application/json");
}

function authorizationCompletionTarget(
  result:
    | { status: "denied"; redirectUri: string; state: string }
    | { status: "approved"; redirectUri: string; state: string; code: string },
  issuer: string,
): string {
  const target = new URL(result.redirectUri);
  if (result.state) target.searchParams.set("state", result.state);
  target.searchParams.set("iss", issuer);
  if (result.status === "denied") target.searchParams.set("error", "access_denied");
  else target.searchParams.set("code", result.code);
  return target.toString();
}
