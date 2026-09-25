// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { ownedWebDomainsBody } from "../../schemas/admin.js";
import { getOwnedWebDomains, setOwnedWebDomains } from "../../../owned-web-domains.js";
import { log as adminLog } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("owned-web-domains");

/**
 * Mount the owned-web-domains endpoints (#791).
 *
 * The collector POSTs the web hosts owned by *every known source type* (the
 * union of every loaded source definition's `ownedWebDomains`), derived at
 * boot. The browser capture policy (`GET /web-capture-policy`) folds the union
 * into `ownedDomains`, so a browser skips any visited host already covered by a
 * dedicated source and never double-ingests a page another source captures.
 *
 * Auth posture:
 *   - `POST /admin/owned-web-domains` — `scope.writeAny()` plus `write:*`
 *     refinement. This is a process-wide configuration push, so a
 *     source-specific push client must not be able to replace it.
 *   - `GET /owned-web-domains` — `scope.public()`. Served for extension builds
 *     that read the set on its own before the capture policy carried it; the
 *     set is non-secret public vendor hostnames, so a public read costs
 *     nothing.
 *
 * No source-specific logic lives here — the gateway treats domains as opaque
 * host strings. Per-source domain ownership lives in each source package on
 * `defineSource(...)`.
 */
export function mountOwnedWebDomainsRoutes(app: RouteApp): void {
  app.post("/admin/owned-web-domains", scope.writeAny(), validateJson(ownedWebDomainsBody), (c) => {
    enforceBroadWriteScope(c.get("auth").scopes);
    const { domains } = c.req.valid("json");
    setOwnedWebDomains(domains);
    log.info(`registered ${domains.length} owned web domain(s)`);
    return c.json({ ok: true, count: getOwnedWebDomains().length });
  });

  app.get("/owned-web-domains", scope.public(), (c) => {
    return c.json({ domains: getOwnedWebDomains() });
  });
}
