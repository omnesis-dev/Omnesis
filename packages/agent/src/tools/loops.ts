// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `search_loops` + `fetch_loop` + `list_loops` — the interactive (chat) agent's
 * READ-ONLY window into the background Cognition Steward's tracked obligations ("open
 * loops"), available only in experimental mode. The chat agent can find,
 * enumerate, and inspect what the background agent is tracking about the user's
 * life, but has no mutation surface: it never creates, updates, deletes, or
 * resolves a loop, and never touches briefs. `search_loops` / `fetch_loop`
 * return dedicated result kinds (`loops.searched`, `loop.fetched`); `list_loops`
 * (the exhaustive enumeration) returns a generic `structured` result.
 */

import { z } from "zod";
import { cappedLimit } from "./limit.js";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { LoopReadPort } from "./types.js";

/** Hard cap on loops returned by a single `search_loops` call. */
export const SEARCH_LOOPS_MAX_LIMIT = 25;

const searchLoopsArgsSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, "query must not be blank")
      .describe(
        "Free-form match against the tracked obligations — a person, a topic, " +
          'a thing owed or awaited. Examples: "deposit refund", "the notary", "Maya".',
      ),
    limit: cappedLimit(SEARCH_LOOPS_MAX_LIMIT)
      .optional()
      .describe("Cap loops returned (default 10)."),
  })
  .strict();

const fetchLoopArgsSchema = z
  .object({
    loopId: z
      .string()
      .min(1)
      .describe("The loop id to open (from a search_loops result or a document's inline loops)."),
  })
  .strict();

/** Hard cap on loops returned by a single `list_loops` call (matches the gateway port's ceiling). */
const LIST_LOOPS_MAX_LIMIT = 100;

const listLoopsArgsSchema = z
  .object({
    mode: z
      .enum(["navigation", "snapshot"])
      .default("navigation")
      .describe(
        "navigation selects records to fetch and supplies no factual/count evidence. snapshot explicitly captures an as-of inventory of stored tracking state for counts, absence or rank questions; never a complete list of real-world obligations.",
      ),
    limit: cappedLimit(LIST_LOOPS_MAX_LIMIT)
      .optional()
      .describe("Cap loops returned (default 30, max 100; most-important first)."),
  })
  .strict();

export interface LoopToolDeps {
  port: LoopReadPort;
  /** Override the default loop cap (default 10). */
  defaultLimit?: number;
}

export function createSearchLoopsTool(deps: LoopToolDeps): ToolHandle {
  const defaultLimit = deps.defaultLimit ?? 10;
  return {
    name: "search_loops",
    description:
      "Search the background agent's tracked outcome candidates. Open status " +
      "means still tracked, not verified outstanding; source evidence may " +
      "already answer or supersede a summary. " +
      "READ-ONLY: you can find and read loops to inform your answer, never " +
      "create, change, or close them. Returns matching loop summaries; open one " +
      "in full with `fetch_loop`. Empty results (nothing tracked matches) is a " +
      "successful call, not an error.",
    schema: searchLoopsArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const q = (args as Record<string, unknown>).query;
      return typeof q === "string" ? q.slice(0, 80) : undefined;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = searchLoopsArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const { query, limit } = parsed.data;
      try {
        const result = await deps.port.search(
          { query, limit: limit ?? defaultLimit },
          ctx.abortSignal,
        );
        return {
          kind: "loops.searched",
          query: result.query,
          durationMs: result.durationMs,
          loops: result.loops.map((l) => ({ ...l })),
        };
      } catch (err) {
        return {
          kind: "error",
          code: "search_loops_failed",
          message: (err as Error).message ?? "search_loops failed",
        };
      }
    },
  };
}

export function createFetchLoopTool(deps: LoopToolDeps): ToolHandle {
  return {
    name: "fetch_loop",
    description:
      "Open a shortlisted tracked outcome: its stored state, importance, " +
      "deadline, people, source document IDs and recorded history. Exact-ID reads " +
      "also return retained done or dismissed loops with their terminal state. Open status " +
      "is not proof the action is still needed. Reconcile related records and " +
      "follow the exact supporting document when their evidence disagrees; " +
      "history timestamps record notes, not necessarily source event dates. READ-ONLY — you can " +
      "read what is in a loop, never change it. Copy the exact loopId from " +
      "list_loops or search_loops; an unavailable ID returns loop_not_found.",
    schema: fetchLoopArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const id = (args as Record<string, unknown>).loopId;
      return typeof id === "string" ? id : undefined;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = fetchLoopArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      try {
        const loop = await deps.port.fetch(parsed.data.loopId, ctx.abortSignal);
        if (!loop) {
          return {
            kind: "error",
            code: "loop_not_found",
            message:
              "No accessible loop was found for that ID. Copy an exact loopId from " +
              "list_loops or search_loops before retrying; do not reconstruct or guess IDs.",
          };
        }
        return { kind: "loop.fetched", loop };
      } catch (err) {
        return {
          kind: "error",
          code: "fetch_loop_failed",
          message: (err as Error).message ?? "fetch_loop failed",
        };
      }
    },
  };
}

export function createListLoopsTool(deps: LoopToolDeps): ToolHandle {
  const defaultLimit = deps.defaultLimit ?? 30;
  return {
    name: "list_loops",
    description:
      "List active tracked outcome candidates, most important first. Default navigation " +
      "is only a shortlist: fetch_loop grounds relevant records; do not assert counts or absence " +
      "from navigation. For counts, empty inventories or recorded rankings choose mode=snapshot " +
      "and report the returned observation time and scope, not current real-world obligations. " +
      "Snapshot returned count is exact only when truncated=false; discovery may still be incomplete. Use this " +
      'for "what am I tracking" or to shortlist relevant priorities. Open ' +
      "status is not verified outstanding work: later evidence can answer or " +
      "supersede a tracked request. Compare summaries before choosing which " +
      "to open with `fetch_loop`; do not fetch every row merely because it is " +
      "listed. `truncated` means the cap omitted less important tracked items; " +
      "even an untruncated list is not a complete inventory of real-world " +
      "obligations. READ-ONLY; an empty list is a successful result.",
    schema: listLoopsArgsSchema,
    summarize(): string {
      return "";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = listLoopsArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      try {
        const result = await deps.port.list(parsed.data.limit ?? defaultLimit, ctx.abortSignal, {
          mode: parsed.data.mode,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
        });
        return {
          kind: "structured",
          resultType: "loops.listed",
          data: {
            count: result.loops.length,
            mode: parsed.data.mode,
            ...(result.observation ? { observation: result.observation } : {}),
            coverage:
              "Stored tracking only; source discovery and maintenance may be incomplete. This is not a complete inventory of real-world obligations.",
            truncated: result.truncated,
            durationMs: result.durationMs,
            loops: result.loops.map((l) => ({ ...l })),
          },
        };
      } catch (err) {
        return {
          kind: "error",
          code: "list_loops_failed",
          message: (err as Error).message ?? "list_loops failed",
        };
      }
    },
  };
}
