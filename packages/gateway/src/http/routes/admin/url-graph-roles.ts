// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { linkDeclarationsBody, urlGraphRolesBody, urlHubSourcesBody } from "../../schemas/admin.js";
import {
  getFallbackUrlRepresentationSources,
  getReferenceOnlyUrlSources,
  getUrlTraversalHubSources,
  setUrlGraphRoles,
  setLegacyUrlTraversalHubs,
  urlGraphRolesReady,
} from "../../../url-graph-roles.js";
import {
  collectorDeclarationKey,
  refreshCollectorDeclarationRoster,
} from "../../../collector-declaration-roster.js";
import { updateLinkDeclarations } from "../../../domain/LinkDeclarationService.js";
import { setKnownUrlPatterns } from "../../../known-url-patterns.js";
import { setUrlCanonicalizersForDeclarer } from "../../../url-canonicalizers.js";
import {
  invalidateLinkDeclarationBundle,
  markLinkDeclarationBundleReady,
} from "../../../link-declaration-readiness.js";
import { log as adminLog, type AdminRoutesDeps } from "./internals.js";
import { linkDeclarationBodyLimit } from "./link-declaration-http.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("url-graph-roles");

/**
 * Mount the URL graph-role admin endpoints.
 *
 * The collector POSTs the full list of source-type prefixes whose
 * `defineSource` declares `urlHub: true`. The gateway merges with its
 * built-in seed (`web` — the unified Web Pages source) and uses the union
 * to filter noisy graph pivots. The collector separately declares sources
 * whose documents are fallback URL representations; only that second role
 * participates in ownership and `same-resource` repair.
 *
 * No source-specific logic lives here — the gateway treats entries as
 * opaque source-id prefixes. Per-source hub knowledge lives in each
 * source package on `defineSource(...)`. Reference-only URL roles are carried
 * in the same atomic declaration so a partial role set is never applied.
 */
export function mountUrlGraphRolesRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.post(
    "/admin/link-declarations",
    scope.writeAny(),
    linkDeclarationBodyLimit,
    validateJson(linkDeclarationsBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const auth = c.get("auth");
      const body = c.req.valid("json");
      await updateLinkDeclarations(deps.writeGate, () => {
        refreshCollectorDeclarationRoster();
        const declarationKey = collectorDeclarationKey(
          deps.db,
          auth.deviceId,
          auth.scopes,
          auth.deviceId === null ? undefined : deps.wsServer?.isConnected(auth.deviceId),
        );
        setUrlCanonicalizersForDeclarer(declarationKey, body.canonicalizers);
        setUrlGraphRoles(
          declarationKey,
          body.traversalHubPrefixes,
          body.fallbackRepresentationPrefixes,
          body.referenceOnlyPrefixes,
        );
        setKnownUrlPatterns(declarationKey, body.patterns);
        markLinkDeclarationBundleReady(declarationKey);
      });
      return c.json({ ok: true });
    },
  );

  // Process-wide collector metadata; requires a broad write token so a
  // source-specific push client cannot rewrite graph traversal globally.
  app.post(
    "/admin/url-graph-roles",
    scope.writeAny(),
    linkDeclarationBodyLimit,
    validateJson(urlGraphRolesBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const auth = c.get("auth");
      const { traversalHubPrefixes, fallbackRepresentationPrefixes, referenceOnlyPrefixes } =
        c.req.valid("json");
      await updateLinkDeclarations(deps.writeGate, () => {
        refreshCollectorDeclarationRoster();
        const declarationKey = collectorDeclarationKey(
          deps.db,
          auth.deviceId,
          auth.scopes,
          auth.deviceId === null ? undefined : deps.wsServer?.isConnected(auth.deviceId),
        );
        invalidateLinkDeclarationBundle(declarationKey);
        setUrlGraphRoles(
          declarationKey,
          traversalHubPrefixes,
          fallbackRepresentationPrefixes,
          referenceOnlyPrefixes,
        );
      });
      log.info(
        `registered ${traversalHubPrefixes.length} traversal-hub source(s), ${fallbackRepresentationPrefixes.length} fallback representation source(s), ${referenceOnlyPrefixes.length} reference-only source(s)`,
      );
      return c.json({
        ok: true,
        traversalHubCount: traversalHubPrefixes.length,
        fallbackRepresentationCount: fallbackRepresentationPrefixes.length,
        referenceOnlyCount: referenceOnlyPrefixes.length,
      });
    },
  );

  // Compatibility for collectors that only knew about traversal hubs. This
  // route must not mark URL target-role metadata ready.
  app.post(
    "/admin/url-hub-sources",
    scope.writeAny(),
    linkDeclarationBodyLimit,
    validateJson(urlHubSourcesBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const auth = c.get("auth");
      const { prefixes } = c.req.valid("json");
      await updateLinkDeclarations(deps.writeGate, () => {
        refreshCollectorDeclarationRoster();
        const declarationKey = collectorDeclarationKey(
          deps.db,
          auth.deviceId,
          auth.scopes,
          auth.deviceId === null ? undefined : deps.wsServer?.isConnected(auth.deviceId),
        );
        invalidateLinkDeclarationBundle(declarationKey);
        setLegacyUrlTraversalHubs(declarationKey, prefixes);
      });
      log.info(`registered ${prefixes.length} legacy traversal-hub source(s)`);
      return c.json({ ok: true, count: prefixes.length });
    },
  );

  app.get("/admin/url-hub-sources", scope.read(), (c) => {
    return c.json({ prefixes: Array.from(getUrlTraversalHubSources()).sort() });
  });

  app.get("/admin/url-graph-roles", scope.read(), (c) => {
    // Returns the merged view (built-in ∪ collector-declared) — useful
    // for debugging "why is this `url` edge missing from the graph?".
    const merged = getUrlTraversalHubSources();
    return c.json({
      traversalHubPrefixes: Array.from(merged).sort(),
      fallbackRepresentationPrefixes: Array.from(getFallbackUrlRepresentationSources()).sort(),
      referenceOnlyPrefixes: Array.from(getReferenceOnlyUrlSources()).sort(),
      ready: urlGraphRolesReady(),
    });
  });
}
