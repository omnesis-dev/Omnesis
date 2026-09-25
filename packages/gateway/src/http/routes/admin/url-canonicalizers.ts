// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { urlCanonicalizersBody } from "../../schemas/admin.js";
import {
  getUrlCanonicalizerSpecs,
  setUrlCanonicalizersForDeclarer,
} from "../../../url-canonicalizers.js";
import { updateLinkDeclarations } from "../../../domain/LinkDeclarationService.js";
import {
  collectorDeclarationKey,
  refreshCollectorDeclarationRoster,
} from "../../../collector-declaration-roster.js";
import { invalidateLinkDeclarationBundle } from "../../../link-declaration-readiness.js";
import { log as adminLog, type AdminRoutesDeps } from "./internals.js";
import { linkDeclarationBodyLimit } from "./link-declaration-http.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("url-canonicalizers");

/**
 * Mount the URL-canonicalizer admin endpoints.
 *
 * The collector POSTs the full list of per-source canonicalizer specs
 * at startup, then optionally triggers a `recompute` to re-derive
 * `source_url` on every existing row using the freshly-registered
 * specs. Re-posting fully replaces the previous list.
 *
 * No source-specific logic lives here — the gateway treats specs as
 * opaque regex-rule data. Per-source URL knowledge lives entirely in
 * the source package (`urlCanonicalizer` on `defineSource`).
 */
export function mountUrlCanonicalizerRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  // Process-wide collector metadata; requires a broad write token so a
  // source-specific push client cannot rewrite URL normalization globally.
  app.post(
    "/admin/url-canonicalizers",
    scope.writeAny(),
    linkDeclarationBodyLimit,
    validateJson(urlCanonicalizersBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const { canonicalizers } = c.req.valid("json");
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
        setUrlCanonicalizersForDeclarer(declarationKey, canonicalizers);
      });
      log.info(
        `registered ${canonicalizers.length} canonicalizer(s) covering ` +
          `${canonicalizers.flatMap((c) => c.hosts).length} host(s)`,
      );
      return c.json({ ok: true, count: canonicalizers.length });
    },
  );

  app.get("/admin/url-canonicalizers", scope.read(), (c) => {
    return c.json({ canonicalizers: getUrlCanonicalizerSpecs() });
  });

  // Re-derive `source_url` on every row from `metadata.sourceUrl`,
  // using the currently-registered canonicalizers. Used by the
  // collector after registering canonicalizers on a gateway whose
  // documents were ingested before the canonicalizers were known.
  // Idempotent; safe to re-run. Reader workers plan bounded pages and the
  // writer receives only the changed rows from each page.
  app.post("/admin/url-canonicalizers/recompute-source-urls", scope.writeAny(), async (c) => {
    enforceBroadWriteScope(c.get("auth").scopes);
    // Use the original data-only specs, not the runtime registry: safe
    // registries attach RE2-backed `apply` functions, which cannot cross the
    // structured-clone boundary into a reader worker.
    const specs = getUrlCanonicalizerSpecs();
    const start = Date.now();
    const result = await deps.sourceUrlRecanonicalization.recompute(specs);
    const durationMs = Date.now() - start;
    log.info(
      `recompute: re-normalized source_url for ${result.touched}/${result.scanned} rows in ${durationMs}ms`,
    );
    return c.json({ ...result, duration_ms: durationMs });
  });
}
