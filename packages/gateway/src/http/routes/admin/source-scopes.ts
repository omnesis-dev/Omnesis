// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { sourceScopesBody } from "../../schemas/source-scopes.js";
import { SourceScopeService } from "../../services/SourceScopeService.js";
import type { AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

/** Contract publication requires broad collector write; catalogue reads belong to the owner. */
export function mountSourceScopesRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const service = new SourceScopeService(deps.db, deps.writeGate);
  app.post("/admin/source-scopes", scope.writeAny(), validateJson(sourceScopesBody), async (c) => {
    enforceBroadWriteScope(c.get("auth").scopes);
    const { stored } = await service.publish(c.req.valid("json").entries);
    return c.json({ ok: true, count: stored });
  });
  app.get("/admin/source-scopes", scope.admin(), (c) => c.json({ entries: service.list() }));
}
