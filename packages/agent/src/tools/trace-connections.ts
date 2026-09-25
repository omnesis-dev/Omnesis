// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `trace_connections` — deep-walk the graph of documents connected to one or
 * more seed documents, returned in chronological order. The walk reaches
 * every related document the link graph touches: people by role, attachments
 * nested inside their parent event, near-duplicates of the same content
 * across channels, forwarded copies, and the calendar event behind an email,
 * each with cross-document references carrying the link type verbatim.
 *
 * This is a RETRIEVAL tool: its output is the agent's working memory for the
 * turn, NOT a user-facing surface. The documents it returns do not land on
 * the Timeline — only documents the agent explicitly `annotate`s do. When the
 * walk surfaces something that grounds the answer, the agent annotates that
 * document to put it on the Timeline.
 *
 * Returns an `event_trail.built` tool result carrying the full `EventTrail`
 * payload. `event_trail.built` is a stable internal wire tag retained across
 * this tool's rename: it is persisted in conversation history and decoded by
 * the portal / iOS / Android clients, so renaming it would break historical
 * decode for zero user benefit. The result kind therefore keeps the legacy
 * name even though the tool is now `trace_connections`.
 *
 * The schema, port surface, and underlying graph walk are defined in
 * `@omnesis/core` / `@omnesis/gateway` — this file is the tool wrapper.
 */

import { z } from "zod";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { TrailPort } from "./types.js";

export const traceConnectionsArgsSchema = z.object({
  seedIds: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Documents to start the walk from. Pass multiple when the user's question " +
        "spans several anchor docs (e.g. comparing two contracts).",
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Max BFS depth (default 4). Higher = more context, lower = faster."),
  fanoutCap: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Per-vertex per-category fanout cap (default 25). Tighter than the portal " +
        "debug page because agent answers usually don't need every member of a " +
        "huge email thread.",
    ),
});

export type TraceConnectionsArgs = z.infer<typeof traceConnectionsArgsSchema>;

export interface TraceConnectionsToolDeps {
  port: TrailPort;
}

export function createTraceConnectionsTool(deps: TraceConnectionsToolDeps): ToolHandle {
  return {
    name: "trace_connections",
    description:
      "Deep-walk the graph of documents connected to one or more seed documents, " +
      "returned in chronological order — every related document the link graph " +
      "reaches: attachments nested inline, thread members, near-duplicates of the " +
      "same content across channels, forwarded copies, and the calendar event " +
      "behind an email, each with its time and its people by role. It reaches the " +
      "WHOLE neighbourhood, unlike the capped one-hop `breadcrumb` / " +
      "`includeNeighbors` sample. Use it when completeness across a document's " +
      "connections matters and that sample is not enough: 'what's the latest on " +
      "this thread', 'where did this come from', 'show me everything around this " +
      "contract / meeting', or comparing several anchor docs (up to 5 seeds). " +
      "RETRIEVAL ONLY: the result is your working memory for the turn — its " +
      "documents do NOT appear on the Timeline unless you `annotate` them.",
    schema: traceConnectionsArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (!Array.isArray(a.seedIds) || a.seedIds.length === 0) return undefined;
      const seeds = a.seedIds.filter((s): s is string => typeof s === "string");
      if (seeds.length === 0) return undefined;
      const head = seeds.map((s) => s.slice(0, 8)).join(",");
      const extras: string[] = [];
      if (typeof a.depth === "number") extras.push(`depth=${a.depth}`);
      if (typeof a.fanoutCap === "number") extras.push(`fanout=${a.fanoutCap}`);
      return extras.length > 0 ? `${head} ${extras.join(" ")}` : head;
    },
    async invoke(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = traceConnectionsArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const trail = await deps.port.build(args.seedIds, {
          depth: args.depth,
          fanoutCap: args.fanoutCap,
        });
        // Result kind stays `event_trail.built` — a stable wire tag (see file header).
        return {
          kind: "event_trail.built",
          seeds: [...trail.seeds],
          events: [...trail.events],
          truncated: trail.truncated,
          stats: trail.stats,
        };
      } catch (err) {
        const message = (err as Error).message ?? "trail walk failed";
        // Surface seed-not-found as a distinct code so the agent can
        // recover by retrying without the bad seed; everything else
        // collapses to a generic walk-failure code.
        const code = /seed not found|seed id is empty|ambiguous seed prefix/.test(message)
          ? "seed_not_found"
          : "trail_walk_failed";
        return { kind: "error", code, message };
      }
    },
  };
}
