// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for routes mounted in `routes/search.ts`.
 *
 * `SearchQuery` in `@omnesis/core/search/types` is a wide structural type;
 * we validate the load-bearing fields here (`text` is required, others are
 * passed through) so the pipeline can rely on its presence. The loose
 * passthrough of remaining fields preserves forward-compat with new
 * pipeline knobs without forcing a schema bump.
 */
import { z } from "zod";
import { nonEmptyString } from "./common.js";

// POST /search
export const searchBody = z
  .object({
    text: nonEmptyString,
    verbose: z.boolean().optional(),
    // When true, hits whose source declares a `boundDocument` carry
    // their co-described DuckDB analytics row in `boundRow`.
    includeBoundRow: z.boolean().optional(),
  })
  .passthrough();
export type SearchBody = z.infer<typeof searchBody>;
