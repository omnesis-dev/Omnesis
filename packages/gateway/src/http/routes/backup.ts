// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backup routes. Mounted from server.ts only when a `BackupService`
 * is wired (production; tests that don't exercise backups skip them).
 *
 * Surface (admin scope):
 *   POST /admin/backup          → 202 { backupId, estimatedTotalBytes? }
 *                                 (the preflight's upper bound); 409 when one
 *                                 is already running; 507 when disk preflight
 *                                 fails
 *   GET  /admin/backup/status   → { running, current?, lastResult? } with
 *                                 per-file progress and, while a snapshot is
 *                                 being written, `current.currentFileBytes`
 *   GET  /admin/backups         → { backups: [manifest + path, …] }
 *
 * These power the `omnesis backup` CLI command, which POSTs then polls the
 * status route until the run completes.
 */

import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { startBackupBody } from "../schemas/backup.js";
import type { BackupService } from "../services/BackupService.js";
import type { RouteApp } from "./types.js";

export interface BackupRoutesDeps {
  backupService: BackupService;
}

export function mountBackupRoutes(app: RouteApp, deps: BackupRoutesDeps): void {
  app.post("/admin/backup", scope.admin(), validateJson(startBackupBody), (c) => {
    const body = c.req.valid("json");
    return c.json(deps.backupService.start(body), 202);
  });

  app.get("/admin/backup/status", scope.admin(), (c) => c.json(deps.backupService.getStatus()));

  app.get("/admin/backups", scope.admin(), (c) => c.json({ backups: deps.backupService.list() }));
}
