// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `search_many` — run several independent document searches in ONE model
 * round-trip. Wraps the singular `search_documents` tool: each child reuses its
 * validation, port call, and `search.results` shaping, so a renderer projects
 * each into the same ephemeral search card it shows today. Children run
 * concurrently (they land on the gateway's search-worker pool) and stream
 * per-child progress so the cards animate live.
 */

import { z } from "zod";

import { runBatch, BATCH_MAX_ITEMS, type BatchChild } from "./batch.js";
import {
  buildSearchDocumentsArgsSchema,
  createSearchDocumentsTool,
  type SearchToolDeps,
} from "./search.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export function createSearchManyTool(deps: SearchToolDeps): ToolHandle {
  const singular = createSearchDocumentsTool(deps);
  const itemSchema = buildSearchDocumentsArgsSchema();
  const schema = z.object({
    queries: z
      .array(itemSchema)
      .min(1)
      .max(BATCH_MAX_ITEMS)
      .describe(
        "One or more independent searches to run concurrently. Batch every " +
          "search you would otherwise issue one-by-one into a single call — the " +
          "results come back together in one round-trip. Each entry takes the " +
          "same fields as a single search (query, optional filters/limit).",
      ),
  });
  return {
    name: "search_many",
    description:
      "Search the user's indexed documents with SEVERAL queries at once, " +
      "concurrently, in one round-trip. Put each distinct query in `queries`; " +
      "prefer this over issuing separate searches. Returns one result per " +
      "query in order. Use fetch_many to read full bodies of the hits.",
    schema,
    summarize(args: unknown): string | undefined {
      const q = (args as { queries?: unknown[] } | null)?.queries;
      if (!Array.isArray(q) || q.length === 0) return undefined;
      const first = (q[0] as { query?: string }).query;
      return q.length === 1 ? first : `${q.length} searches${first ? `: ${first}, …` : ""}`;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const children: BatchChild<unknown>[] = parsed.data.queries.map((q) => ({
        args: q,
        summary: singular.summarize?.(q) ?? String((q as { query?: string }).query ?? ""),
      }));
      // Children carry the SINGULAR tool name so clients render each with the
      // existing search-card renderer.
      const items = await runBatch("search_documents", children, ctx, (a) =>
        singular.invoke(a, ctx),
      );
      return { kind: "search.batch", items } as ToolResult;
    },
  };
}
