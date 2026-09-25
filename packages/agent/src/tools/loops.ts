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
    limit: z
      .number()
      .int()
      .positive()
      .max(SEARCH_LOOPS_MAX_LIMIT)
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
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_LOOPS_MAX_LIMIT)
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
      "Search the background agent's open loops — the obligations, requests, " +
      "and unresolved decisions it privately tracks about the user's life " +
      "(e.g. an unanswered reply, a pending refund, a decision awaiting input). " +
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
      "Open one of the background agent's open loops in full: its current " +
      "state, importance, deadline, the people it concerns, the source " +
      "documents it rests on, and its recent history. READ-ONLY — you can " +
      "read what is in a loop, never change it. `loop` is absent when the id " +
      "matches nothing (a clean no-match, not an error).",
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
        return { kind: "loop.fetched", ...(loop ? { loop } : {}) };
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
      "List ALL of the background agent's currently open loops — the complete " +
      "set of tracked obligations, requests, and unresolved decisions, **most " +
      'important first**. Use this for "what am I tracking", "what are all my ' +
      'open loops", "what\'s outstanding" — it returns every active loop, so it ' +
      "does NOT miss any the way a keyword `search_loops` can. If more loops " +
      "exist than the returned cap, `truncated` is true and the ones dropped are " +
      "the least important. READ-ONLY; open one in full with `fetch_loop`. An " +
      "empty list (nothing tracked) is a clean, successful result.",
    schema: listLoopsArgsSchema,
    summarize(): string | undefined {
      return undefined;
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
        const result = await deps.port.list(parsed.data.limit ?? defaultLimit, ctx.abortSignal);
        return {
          kind: "structured",
          resultType: "loops.listed",
          data: {
            count: result.loops.length,
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
