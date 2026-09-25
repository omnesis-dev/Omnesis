// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `fetch_many` — pull the full bodies of several documents in ONE model
 * round-trip. Wraps the singular `fetch_document` tool so each child reuses its
 * validation, port call, and `document` shaping; children run concurrently and
 * stream per-child progress so each fetch card animates live.
 */

import { z } from "zod";

import { runBatch, BATCH_MAX_ITEMS, type BatchChild } from "./batch.js";
import {
  createFetchDocumentTool,
  fetchDocumentArgsSchema,
  type FetchDocumentToolDeps,
} from "./fetch-document.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export function createFetchManyTool(deps: FetchDocumentToolDeps): ToolHandle {
  const singular = createFetchDocumentTool(deps);
  const schema = z.object({
    documents: z
      .array(fetchDocumentArgsSchema)
      .min(1)
      .max(BATCH_MAX_ITEMS)
      .describe(
        "One or more documents to fetch concurrently. Batch every body you " +
          "need into a single call rather than fetching one at a time. Each " +
          "entry takes the same fields as a single fetch (documentId, optional " +
          "includeNeighbors).",
      ),
  });
  return {
    name: "fetch_many",
    description:
      "Fetch the full bodies of SEVERAL previously surfaced documents at once, " +
      "concurrently, in one round-trip. Put each documentId in `documents`. " +
      "Returns one document (or error) per entry in order. Only fetch the hits " +
      "likely to answer the question, not every candidate.",
    schema,
    summarize(args: unknown): string | undefined {
      const d = (args as { documents?: unknown[] } | null)?.documents;
      if (!Array.isArray(d) || d.length === 0) return undefined;
      const first = (d[0] as { documentId?: string }).documentId;
      return d.length === 1 ? first?.slice(0, 24) : `${d.length} documents`;
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
      const children: BatchChild<unknown>[] = parsed.data.documents.map((d) => ({
        args: d,
        summary: singular.summarize?.(d) ?? String((d as { documentId?: string }).documentId ?? ""),
      }));
      const items = await runBatch("fetch_document", children, ctx, (a) => singular.invoke(a, ctx));
      return { kind: "document.batch", items } as ToolResult;
    },
  };
}
