// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolHandle } from "@omnesis/agent";
import type { LabFeatureId } from "../lab/store.js";

export type LabEnabled = (id: LabFeatureId) => boolean;

function featuresForTool(name: string): readonly LabFeatureId[] {
  if (name.startsWith("task_")) return ["tasks"];
  if (name.startsWith("watch_") || name === "watches_list") return ["watches"];
  if (
    name.startsWith("open_loop_") ||
    ["list_loops", "search_loops", "fetch_loop", "entity_context"].includes(name)
  )
    return ["brain", "tasks"];
  if (["observation_suppress", "interest_record"].includes(name)) return ["brain"];
  return [];
}

/** Hide disabled tools and recheck captured handles at invocation, including in live turns. */
export function withLabTools(tools: readonly ToolHandle[], enabled: LabEnabled): ToolHandle[] {
  return tools.flatMap((tool) => {
    const features = featuresForTool(tool.name);
    if (!features.length) return [tool];
    if (!features.every(enabled)) return [];
    return [
      {
        ...tool,
        invoke: (args, context) =>
          features.every(enabled)
            ? tool.invoke(args, context)
            : Promise.resolve({
                kind: "error" as const,
                code: "feature_disabled",
                message: `${features.find((feature) => !enabled(feature)) ?? "Feature"} is disabled in Omnesis Lab.`,
              }),
      },
    ];
  });
}
