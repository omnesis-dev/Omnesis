// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `spawn_subagent` — delegate a focused sub-task to a nested `AgentSession`
 * driven by a generic read-only worker.
 *
 * The parent agent calls this when a sub-task is large enough to warrant its
 * own fresh context (a long history sweep, a single source's digest, a
 * citation re-check) rather than bloating the parent's own transcript. The
 * child runs to completion and returns a distilled finding plus the documents
 * it cited; the parent reasons over that finding. The full child transcript
 * reaches the user via the `agent.subagent.*` events, rendered one level of
 * recursion on each client.
 *
 * Deliberately argument-minimal: the parent supplies only a self-contained task
 * and optional human-facing title. The host owns the child's fixed system
 * prompt, model role, and read-only tool policy; none are negotiated by the
 * model on each spawn.
 *
 * Fan-out is **asynchronous**: this tool LAUNCHES a child and returns a handle
 * IMMEDIATELY (`status: "running"`, or `"queued"` while the concurrency cap
 * holds it), so the parent can launch several children that run concurrently,
 * then await them with `join_subagents` to collect their findings. The child's
 * distilled finding + citations arrive on the matching `join_subagents` entry,
 * not on this launch handle. Generic workers cannot spawn grandchildren.
 */

import { z } from "zod";

import { SubagentPortError, type SubagentPort } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export const spawnSubagentArgsSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("A short human-facing outcome for this work; do not repeat the full task brief."),
  task: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "A self-contained natural-language brief for the sub-agent — it becomes " +
        "the child's first user message. Include everything the child needs; " +
        "it does NOT see the parent conversation.",
    ),
});

export type SpawnSubagentArgs = z.infer<typeof spawnSubagentArgsSchema>;

export interface SpawnSubagentToolDeps {
  port: SubagentPort;
}

export function createSpawnSubagentTool(deps: SpawnSubagentToolDeps): ToolHandle {
  return {
    name: "spawn_subagent",
    description:
      "Launch a focused read-only worker in its own fresh context. Returns a " +
      "handle IMMEDIATELY — the sub-agent runs in the " +
      "background; call `join_subagents` with the returned id(s) to collect its " +
      "finding. Launch several in a row to fan out work in parallel, then join " +
      "them. Use it when a request has substantial independent workstreams that " +
      "benefit from separate iterative retrieval or reasoning; keep quick " +
      "lookups and simple batched searches local.",
    schema: spawnSubagentArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.title === "string") return a.title;
      return typeof a.task === "string" ? a.task.slice(0, 120) : undefined;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = spawnSubagentArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const handle = await deps.port.spawn({
          parentSessionId: ctx.sessionId,
          title: args.title ?? args.task,
          task: args.task,
          parentToolCallId: ctx.messageId,
          signal: ctx.abortSignal,
          timeZone: ctx.timeZone,
        });
        return {
          kind: "subagent.spawned",
          subagentId: handle.subagentId,
          specialist: handle.specialist,
          status: handle.status,
        };
      } catch (err) {
        if (err instanceof SubagentPortError) {
          return { kind: "error", code: err.code, message: err.message };
        }
        return {
          kind: "error",
          code: "subagent_failed",
          message: (err as Error).message ?? "sub-agent failed",
        };
      }
    },
  };
}
