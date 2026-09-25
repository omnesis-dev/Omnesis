// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `annotate_many` — record several document citations in ONE model round-trip.
 * Wraps the singular `annotate` tool so each child reuses its ref resolution
 * and `annotate.recorded` shaping. `annotate` is a SILENT tool (no card): the
 * session synthesises one `agent.citation` event per child result, so the
 * Citations drawer and Timeline fill exactly as they do for singular annotate.
 */

import { z } from "zod";

import { runBatch, BATCH_MAX_ITEMS, type BatchChild } from "./batch.js";
import { annotateArgsSchema, createAnnotateTool, type AnnotateToolDeps } from "./annotate.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export function createAnnotateManyTool(deps: AnnotateToolDeps): ToolHandle {
  const singular = createAnnotateTool(deps);
  const schema = z.object({
    annotations: z
      .array(annotateArgsSchema)
      .min(1)
      .max(BATCH_MAX_ITEMS)
      .describe(
        "One or more documents to cite at once. Batch every citation for this " +
          "answer into a single call rather than annotating one at a time. Each " +
          "entry takes the same fields as a single annotate (documentId, " +
          "optional quote/quoteAuthor/note).",
      ),
  });
  return {
    name: "annotate_many",
    description:
      "Cite SEVERAL documents that informed your answer at once, in one " +
      "round-trip. Put each citation in `annotations` (documentId + optional " +
      "quote/note). Returns one recorded citation or actionable error per item, " +
      "in order. Correct any invalid documentId and retry it before answering; " +
      "only validated documents become Timeline entries and Citations-drawer cards.",
    schema,
    summarize(args: unknown): string | undefined {
      const a = (args as { annotations?: unknown[] } | null)?.annotations;
      if (!Array.isArray(a) || a.length === 0) return undefined;
      return a.length === 1 ? singular.summarize?.(a[0]) : `${a.length} citations`;
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
      const children: BatchChild<unknown>[] = parsed.data.annotations.map((a) => ({
        args: a,
        summary: singular.summarize?.(a),
      }));
      const items = await runBatch("annotate", children, ctx, (a) => singular.invoke(a, ctx));
      return { kind: "annotate.batch", items } as ToolResult;
    },
  };
}
