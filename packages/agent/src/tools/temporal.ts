// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `temporal_query` — the shared READ-ONLY temporal query. The gateway composes
 * deterministic, immutable source projections with LLM-owned temporal
 * annotations behind this one surface. Annotation mutation remains exclusive
 * to the background Cognition Steward.
 *
 * The agent queries by a window expressed in plain date terms; overlap (an entry
 * whose interval intersects the window) is resolved server-side. A point query
 * (`to` omitted) matches everything anchored at/around `from`.
 */

import { z } from "zod";

import {
  ACCEPTED_TEMPORAL_KINDS,
  canonicalTemporalKind,
  hostTimeZone,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_ORIGINS,
  TEMPORAL_STATUSES,
} from "@omnesis/core";
import type { TemporalKind, ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { TemporalReadPort } from "./types.js";

/** Hard cap on items returned by one `temporal_query` call. */
export const TEMPORAL_QUERY_MAX_LIMIT = 100;

/**
 * Map the kinds a model asked for onto the canonical vocabulary. The schema
 * already restricts the wire values to spellings the vocabulary accepts, so
 * every entry resolves; the guard only keeps the narrowing honest.
 */
function canonicalKinds(kinds: readonly string[]): TemporalKind[] {
  return kinds
    .map((kind) => canonicalTemporalKind(kind))
    .filter((kind): kind is TemporalKind => kind !== null);
}

const temporalQueryArgsSchema = z
  .object({
    from: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Window start: "now", an offset/Z ISO instant, YYYY-MM-DD, YYYY-MM, ' +
          'YYYY, or a relative calendar expression such as -7d. Defaults to "now".',
      ),
    to: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exclusive window end in the same formats, including relative "+7d", ' +
          '"+2w", "+3M", "+1y". Omit for the whole coarse `from` period.',
      ),
    timeZone: z
      .string()
      .min(1)
      .optional()
      .describe(
        "IANA time zone for dates and relative expressions. Defaults to the " +
          "caller's own zone — pass one only to ask about a different zone.",
      ),
    origins: z.array(z.enum(TEMPORAL_ORIGINS)).min(1).optional(),
    kinds: z
      .array(z.enum(ACCEPTED_TEMPORAL_KINDS))
      .min(1)
      .optional()
      .describe(
        `What the entry is, independent of where it came from: ${TEMPORAL_KINDS.join(", ")}.`,
      ),
    modalities: z.array(z.enum(TEMPORAL_MODALITIES)).min(1).optional(),
    statuses: z.array(z.enum(TEMPORAL_STATUSES)).min(1).optional(),
    sourceIds: z.array(z.string().min(1)).min(1).optional(),
    documentIds: z.array(z.string().min(1)).min(1).optional(),
    entityIds: z.array(z.string().min(1)).min(1).optional(),
    limit: z.number().int().min(1).max(TEMPORAL_QUERY_MAX_LIMIT).optional(),
    cursor: z.string().min(1).optional().describe("Opaque cursor returned by the prior page."),
  })
  .strict();

export interface TemporalQueryToolDeps {
  port: TemporalReadPort;
}

export function createTemporalQueryTool(deps: TemporalQueryToolDeps): ToolHandle {
  return {
    name: "temporal_query",
    description:
      "Query time across deterministic source projections and " +
      "LLM-owned temporal annotations. Give a plain-date window; returns every " +
      "overlapping temporal result with its origin and source document ids. " +
      "Each item is marked `anchored` (it starts or ends inside the window) " +
      "or not (it merely spans it), and `summary` counts both across the " +
      "whole window: a window with 0 anchored items is UNDESCRIBED however " +
      "many long-running ranges pass through it — do not read spanning rows " +
      "as coverage of the window's days. READ-ONLY. Empty results is a " +
      "successful call.",
    schema: temporalQueryArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      const from = typeof a.from === "string" ? a.from : "now";
      const to = typeof a.to === "string" ? a.to : from;
      return `${from} … ${to}`;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = temporalQueryArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      try {
        const { kinds, ...rest } = parsed.data;
        // Parsing, timezone arithmetic, half-open interval normalization,
        // coverage, cursors, and federation all belong to the gateway port.
        const result = await deps.port.query(
          {
            ...rest,
            from: parsed.data.from ?? "now",
            // The caller's zone, not the host's: the machine running the
            // gateway and the person asking "what's on today" are often on
            // different continents, and a window framed in the wrong zone
            // silently returns the wrong day. `ctx.timeZone` is absent only for
            // background work and test rigs, where the host's zone stands in.
            timeZone: parsed.data.timeZone ?? ctx.timeZone ?? hostTimeZone(),
            ...(kinds ? { kinds: canonicalKinds(kinds) } : {}),
          },
          ctx.abortSignal,
        );
        return {
          kind: "structured",
          resultType: "temporal.results",
          data: result,
        };
      } catch (err) {
        return {
          kind: "error",
          code: "temporal_query_failed",
          message: (err as Error).message ?? "temporal_query failed",
        };
      }
    },
  };
}
