// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `lookup_people` — fuzzy person lookup across canonical name +
 * every alias type (email, phone, handle, name). Returns 0..N
 * candidates ordered by recency-decayed interaction score.
 *
 * Typical use: the user mentions a name ("what did Maria say about
 * the lease"), the agent calls `lookup_people` with that name, picks
 * the candidate with the highest interaction score (or asks the user
 * to disambiguate when two are close), then issues a follow-up
 * `search_documents` keyed on one of the chosen person's aliases as
 * a `from:` / `to:` operator.
 *
 * Returns a `person.results` tool result. The portal + iOS render it
 * as an ephemeral rolling-slot card (mirrors search_documents): each
 * candidate scrolls through the slot for ~350ms, then the card fades.
 */

import { z } from "zod";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { PersonPort } from "./types.js";

/**
 * Hard cap on candidates returned. Lined up with the renderer's
 * rolling-slot display cap on both portal + iOS — the user never sees
 * more than this anyway, so asking the agent to fetch more would just
 * inflate the wire payload. Exported so the gateway port adapter can
 * clamp consistently for non-tool callers (tests bypass zod).
 */
export const LOOKUP_PEOPLE_MAX_LIMIT = 12;

export const lookupPeopleArgsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, "query must not be blank")
    .describe(
      "Free-form fuzzy match against the person's canonical name and " +
        "every alias type (email, phone, handle, name). " +
        'Examples: "Maria Smith", "maria@", "+15550133".',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(LOOKUP_PEOPLE_MAX_LIMIT)
    .optional()
    .describe(
      "Cap candidates returned (default 5). Keep small — the user " +
        "typically only cares about the top 1-3 most likely matches.",
    ),
});

export type LookupPeopleArgs = z.infer<typeof lookupPeopleArgsSchema>;

export interface LookupPeopleToolDeps {
  port: PersonPort;
  /** Override the default candidate cap (default 5). */
  defaultLimit?: number;
}

export function createLookupPeopleTool(deps: LookupPeopleToolDeps): ToolHandle {
  const defaultLimit = deps.defaultLimit ?? 5;
  return {
    name: "lookup_people",
    description:
      "Find people in the user's corpus by fuzzy match against their " +
      "canonical name and every alias type (email, phone, handle). " +
      "Returns 0..N candidates ordered by recency-decayed interaction score; " +
      "each carries the person's full alias list, interaction counts " +
      "per channel (email / chat / meeting), and the timestamp of the " +
      "last interaction. Use BEFORE a `search_documents` whenever the " +
      "user mentions a person by name and the right alias isn't " +
      "obvious — pick the candidate the user most likely meant, then " +
      "pass one of that candidate's aliases to `search_documents` as a " +
      "`from:` / `to:` / `with:` operator for a precise filter. Empty " +
      "`results` (nobody matched) is a successful call, not an error.",
    schema: lookupPeopleArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.query !== "string") return undefined;
      return a.query.slice(0, 80);
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = lookupPeopleArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      const limit = args.limit ?? defaultLimit;
      try {
        const result = await deps.port.lookup({ query: args.query, limit }, ctx.abortSignal);
        return {
          kind: "person.results",
          query: result.query,
          durationMs: result.durationMs,
          results: result.results.map((p) => ({ ...p })),
        };
      } catch (err) {
        return {
          kind: "error",
          code: "lookup_failed",
          message: (err as Error).message ?? "lookup_people failed",
        };
      }
    },
  };
}
