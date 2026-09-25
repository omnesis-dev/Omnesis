// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for the export routes mounted in `routes/export.ts`.
 */
import { z } from "zod";

// POST /admin/export — `.default({})` lets a bodyless POST through; every
// field is optional. `format` selects the documents file layout (`json` →
// JSONL, `csv` → column-subset CSV plus per-table analytics CSVs);
// `sourceId` limits the export to a single source.
export const startExportBody = z
  .object({
    format: z.enum(["json", "csv"]).optional(),
    sourceId: z.string().min(1).max(200).optional(),
  })
  .default({});
export type StartExportBody = z.infer<typeof startExportBody>;
