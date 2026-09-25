// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Export routes (#57). Mounted from server.ts only when an `ExportService`
 * is wired (production; tests that don't exercise exports skip them).
 *
 * Surface (admin scope):
 *   POST /admin/export          → 202 { exportId }; 409 when one is already
 *                                 running; 503 when the gateway DB is absent
 *   GET  /admin/export/status   → { running, current?, lastResult? } with
 *                                 running document count
 *   GET  /admin/exports         → { exports: [manifest + path, …] }
 *
 * These power the `omnesis export` CLI command, which POSTs then polls the
 * status route until the run completes.
 */

import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { startExportBody } from "../schemas/export.js";
import type { ExportService } from "../services/ExportService.js";
import type { RouteApp } from "./types.js";

export interface ExportRoutesDeps {
  exportService: ExportService;
}

export function mountExportRoutes(app: RouteApp, deps: ExportRoutesDeps): void {
  app.post("/admin/export", scope.admin(), validateJson(startExportBody), (c) => {
    const body = c.req.valid("json");
    const { exportId } = deps.exportService.start(body);
    return c.json({ exportId }, 202);
  });

  app.get("/admin/export/status", scope.admin(), (c) => c.json(deps.exportService.getStatus()));

  app.get("/admin/exports", scope.admin(), (c) => c.json({ exports: deps.exportService.list() }));
}
