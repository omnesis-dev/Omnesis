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
import { normalizeTimeZone } from "@omnesis/core";
import { nonEmptyString } from "./common.js";

// POST /search
export const searchBody = z
  .object({
    text: nonEmptyString,
    verbose: z.boolean().optional(),
    // When true, hits whose source declares a `boundDocument` carry
    // their co-described DuckDB analytics row in `boundRow`.
    includeBoundRow: z.boolean().optional(),
    // Add bounded graph facts without changing the ordinary search ranking.
    includeGraphContext: z.boolean().optional(),
    // IANA zone the query's own dates ("last week", "tomorrow") are read in.
    timeZone: z
      .string()
      .refine((zone) => normalizeTimeZone(zone) !== undefined, "Expected an IANA time zone name")
      .optional(),
    // Per-request temporal-lane override, e.g. to compare results with and without it.
    temporal: z
      .object({
        enabled: z.boolean().optional(),
        weight: z.number().min(0).max(10).optional(),
        referenceTime: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type SearchBody = z.infer<typeof searchBody>;

/** Operator debugging surface; no caller-controlled authorization or graph knobs. */
export const agentSearchContextBody = z
  .object({
    text: z.string().trim().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
