// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { knownUrlPatternsBody } from "../../schemas/admin.js";
import { getKnownUrlPatternSources, setKnownUrlPatterns } from "../../../known-url-patterns.js";
import {
  collectorDeclarationKey,
  refreshCollectorDeclarationRoster,
} from "../../../collector-declaration-roster.js";
import { updateLinkDeclarations } from "../../../domain/LinkDeclarationService.js";
import { invalidateLinkDeclarationBundle } from "../../../link-declaration-readiness.js";
import { log as adminLog, type AdminRoutesDeps } from "./internals.js";
import { linkDeclarationBodyLimit } from "./link-declaration-http.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("known-url-patterns");

/**
 * Mount the known-url-patterns admin endpoints.
 *
 * The collector POSTs the url-id patterns declared by *every known source
 * type* (not just added sources), derived from each loaded source
 * definition's `urlPatterns`. Link extraction uses the set to keep an
 * unresolved url link whose target matches a known source type — so a link
 * to a not-yet-added source (e.g. a Notion URL before Notion is added)
 * survives and resolves once that source is ingested, while
 * truly-external targets are still dropped.
 *
 * No source-specific logic lives here — the gateway treats patterns as
 * opaque regex strings. Per-source URL knowledge lives in each source
 * package on `defineSource(...)`.
 */
export function mountKnownUrlPatternsRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  // Process-wide collector metadata; requires a broad write token so a
  // source-specific push client cannot rewrite the global registry.
  app.post(
    "/admin/known-url-patterns",
    scope.writeAny(),
    linkDeclarationBodyLimit,
    validateJson(knownUrlPatternsBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const { patterns } = c.req.valid("json");
      const auth = c.get("auth");
      await updateLinkDeclarations(deps.writeGate, () => {
        refreshCollectorDeclarationRoster();
        const declarationKey = collectorDeclarationKey(
          deps.db,
          auth.deviceId,
          auth.scopes,
          auth.deviceId === null ? undefined : deps.wsServer?.isConnected(auth.deviceId),
        );
        invalidateLinkDeclarationBundle(declarationKey);
        setKnownUrlPatterns(declarationKey, patterns);
      });
      log.info(`registered ${patterns.length} known url-id pattern(s)`);
      return c.json({ ok: true, count: patterns.length });
    },
  );

  app.get("/admin/known-url-patterns", scope.read(), (c) => {
    const patterns = getKnownUrlPatternSources().map((regex) => ({ regex }));
    return c.json({ patterns });
  });
}
