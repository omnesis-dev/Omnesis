// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mountObservabilityRoutes } from "./admin/observability.js";
import { mountDeviceRoutes } from "./admin/devices.js";
import { mountTokenRoutes } from "./admin/tokens.js";
import { mountSourceRoutes } from "./admin/sources.js";
import { mountAuthRoutes } from "./admin/auth.js";
import { mountPairingRoutes } from "./admin/pairing.js";
import { mountUrlCanonicalizerRoutes } from "./admin/url-canonicalizers.js";
import { mountSourcePriorDefaultsRoutes } from "./admin/source-prior-defaults.js";
import { mountUrlGraphRolesRoutes } from "./admin/url-graph-roles.js";
import { mountSelfIdentitySourcesRoutes } from "./admin/self-identity-sources.js";
import { mountSelfRoutes } from "./admin/self.js";
import { mountKnownUrlPatternsRoutes } from "./admin/known-url-patterns.js";
import { mountOwnedWebDomainsRoutes } from "./admin/owned-web-domains.js";
import { mountSourceDocumentProfilesRoutes } from "./admin/source-document-profiles.js";
import { mountWidgetOriginsRoutes } from "./admin/widget-origins.js";
import { mountWidgetRenderersRoutes } from "./admin/widget-renderers.js";
import { mountDoctorRoutes } from "./admin/doctor.js";
import { mountTlsRoutes } from "./admin/tls.js";
import { mountWatermarkRoutes } from "./admin/watermarks.js";
import { mountHostFleetUpdateRoutes } from "./admin/host-fleet-update.js";
import type { RouteApp } from "./types.js";

export type { AdminRoutesDeps } from "./admin/internals.js";
import type { AdminRoutesDeps } from "./admin/internals.js";

/**
 * Mount the /admin/* HTTP surface (plus the unauthenticated /oauth/callback
 * and /devices/pair endpoints, which historically share a deps bundle with
 * the admin routes).
 *
 * This is a thin façade over six per-subdomain mounts (`observability` /
 * `devices` / `tokens` / `sources` / `auth` / `pairing`). Splitting the
 * monolithic admin.ts made each subdomain reasonable in
 * isolation while keeping the public mount API unchanged for `server.ts`.
 *
 * `/admin/config` lives in `status.ts` and `/admin/index/reindex-missing`
 * lives in `indexer.ts` — both predate this split and stayed where they
 * were.
 */
export function mountAdminRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  mountObservabilityRoutes(app, deps);
  mountDeviceRoutes(app, deps);
  mountTokenRoutes(app, deps);
  mountSourceRoutes(app, deps);
  mountAuthRoutes(app, deps);
  mountPairingRoutes(app, deps);
  mountUrlCanonicalizerRoutes(app, deps);
  mountSourcePriorDefaultsRoutes(app);
  mountUrlGraphRolesRoutes(app, deps);
  mountSelfIdentitySourcesRoutes(app, deps);
  mountSelfRoutes(app, deps);
  mountKnownUrlPatternsRoutes(app, deps);
  mountOwnedWebDomainsRoutes(app);
  mountSourceDocumentProfilesRoutes(app, deps);
  mountWidgetOriginsRoutes(app);
  mountWidgetRenderersRoutes(app);
  mountDoctorRoutes(app, deps);
  mountTlsRoutes(app, deps);
  mountWatermarkRoutes(app, deps);
  mountHostFleetUpdateRoutes(app, deps);
}
