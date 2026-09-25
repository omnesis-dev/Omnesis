// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for the backup routes mounted in `routes/backup.ts`.
 */
import { z } from "zod";

// POST /admin/backup — `.default({})` lets a bodyless POST through. All fields
// are optional: `includeIndex: false` skips the index.db vacuum (it rebuilds
// from omnesis.db), `note` lands in the backup manifest, and `purpose` lets the
// service retain tool-created pre-update snapshots separately from backups the
// operator asked for directly.
export const startBackupBody = z
  .object({
    includeIndex: z.boolean().optional(),
    note: z.string().min(1).max(500).optional(),
    purpose: z.enum(["operator", "pre-update"]).optional(),
  })
  .default({});
export type StartBackupBody = z.infer<typeof startBackupBody>;
