// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `join_subagents` — await a set of in-flight sub-agents and collect their
 * findings (#748).
 *
 * This is the barrier the parent uses after fanning out with `spawn_subagent`:
 * it blocks until every named child has finished, then returns each child's
 * distilled finding + cited documents, plus the whole-tree token aggregate.
 * Already-finished children resolve immediately; a mixed set (some done, some
 * in-flight) is fine.
 *
 * Deliberately argument-minimal (a frozen #748 constraint): it takes only the
 * set of sub-agent handle ids to await — no backend/model/scope. When the
 * tree-wide token budget tripped during the fan-out, the result carries an
 * honest, named `stoppedReason` rather than silently dropping work.
 */

import { z } from "zod";

import { SubagentPortError, type SubagentPort } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export const joinSubagentsArgsSchema = z.object({
  subagentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .describe(
      "The sub-agent ids to await — the `subagentId` values returned by your " +
        "earlier `spawn_subagent` calls. Pass them all to collect every " +
        "finding in one barrier.",
    ),
});

export type JoinSubagentsArgs = z.infer<typeof joinSubagentsArgsSchema>;

export interface JoinSubagentsToolDeps {
  port: SubagentPort;
}

export function createJoinSubagentsTool(deps: JoinSubagentsToolDeps): ToolHandle {
  return {
    name: "join_subagents",
    description:
      "Await sub-agents you launched with `spawn_subagent` and collect their " +
      "distilled findings. Pass the sub-agent ids; this blocks until they all " +
      "finish, then returns each finding plus the total token spend across the " +
      "whole research tree. Call it once after launching your fan-out.",
    schema: joinSubagentsArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const ids = (args as Record<string, unknown>).subagentIds;
      return Array.isArray(ids) ? `join ${ids.length} sub-agent(s)` : undefined;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = joinSubagentsArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      try {
        const joined = await deps.port.join({
          parentSessionId: ctx.sessionId,
          subagentIds: parsed.data.subagentIds,
          signal: ctx.abortSignal,
        });
        return {
          kind: "subagent.joined",
          results: joined.results.map((r) => ({
            subagentId: r.subagentId,
            specialist: r.specialist,
            status: r.status,
            summary: r.summary,
            citations: [...r.citations],
            ...(r.usage ? { usage: r.usage } : {}),
            ...(r.failure ? { failure: r.failure } : {}),
          })),
          ...(joined.treeUsage ? { treeUsage: joined.treeUsage } : {}),
          ...(joined.stoppedReason ? { stoppedReason: joined.stoppedReason } : {}),
        };
      } catch (err) {
        if (err instanceof SubagentPortError) {
          return { kind: "error", code: err.code, message: err.message };
        }
        return {
          kind: "error",
          code: "subagent_join_failed",
          message: (err as Error).message ?? "join failed",
        };
      }
    },
  };
}
