// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { ToolHandle } from "@omnesis/agent";
import type { ClaimedCognitionRun } from "./storage/types.js";

const TASK_FIELDS = new Set(["loopId", "loopIds", "relatedLoopIds", "triggeringLoopId"]);

export function isTaskRun(run: Pick<ClaimedCognitionRun, "payload">): boolean {
  const payload = run.payload;
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.loopId === "string" ||
    typeof value.decayCheckLoopId === "string" ||
    value.recheckDependentKind === "loop" ||
    Array.isArray(value.loopIds)
  );
}

function isTaskTool(name: string): boolean {
  return (
    name.startsWith("open_loop_") ||
    name.startsWith("task_") ||
    name === "entity_context" ||
    name === "loop_synthesis_save" ||
    name === "schedule_agent_run"
  );
}

/** Hide product tools and references, and enforce a live opt-out on retained handles. */
export function isolateTaskTools(tools: ToolHandle[], enabled: () => boolean): ToolHandle[] {
  const on = enabled();
  return tools
    .filter((tool) => on || !isTaskTool(tool.name))
    .map((tool): ToolHandle => {
      const hiddenFields =
        tool.schema instanceof z.ZodObject
          ? Object.keys(tool.schema.shape).filter((key) => TASK_FIELDS.has(key))
          : [];
      return {
        ...tool,
        ...(!on && hiddenFields.length
          ? {
              schema: z
                .object(
                  Object.fromEntries(
                    Object.entries((tool.schema as z.ZodObject).shape).filter(
                      ([key]) => !TASK_FIELDS.has(key),
                    ),
                  ),
                )
                .strict(),
            }
          : {}),
        ...(!on && tool.name === "temporal_annotation_add"
          ? {
              description:
                "Record an independently evidenced dated fact. Query the complete interval with temporal_query first, reconcile against existing annotations and source-owned projections, preserve the source's precision and modality, and pass evidence {docId, quote} for document-derived assertions. Never duplicate a projection or annotation already carrying the same interval and fact.",
            }
          : {}),
        async invoke(args, context) {
          if (
            !enabled() &&
            (isTaskTool(tool.name) ||
              (args &&
                typeof args === "object" &&
                Object.keys(args).some((key) => TASK_FIELDS.has(key))))
          ) {
            return {
              kind: "error",
              code: "feature_disabled",
              message: "This feature is disabled in Omnesis Lab.",
            };
          }
          const result = await tool.invoke(args, context);
          if (
            !enabled() &&
            result.kind === "structured" &&
            /^(?:annotation_|person_annotation_|temporal_annotation_|observation_)/.test(tool.name)
          ) {
            return { ...result, data: withoutTaskReferences(result.data) };
          }
          return result;
        },
      };
    });
}

/** Remove product backlinks from maintained memory, leaving source text untouched. */
function withoutTaskReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTaskReferences);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !TASK_FIELDS.has(key))
      .map(([key, item]) => [key, withoutTaskReferences(item)]),
  );
}
