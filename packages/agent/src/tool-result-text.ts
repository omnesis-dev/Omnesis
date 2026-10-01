// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolResult } from "@omnesis/core";

/** Present graph evidence once to the model; keep canonical results intact for clients. */
export function serializeToolResultForModel(result: ToolResult): string {
  return JSON.stringify(project(result));
}

function project(result: ToolResult): unknown {
  if (result.kind === "search.batch") {
    return { ...result, items: result.items.map(project) };
  }
  if (result.kind !== "search.results") return result;
  return {
    ...result,
    results: result.results.map((document) =>
      document.provenance?.modelContext
        ? { ...document, provenance: document.provenance.modelContext }
        : document,
    ),
  };
}
