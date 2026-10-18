// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeTimeZone, type ToolResult } from "@omnesis/core";

import { annotateLocalTimes } from "./local-times.js";

export interface ToolResultSerializationOptions {
  /**
   * IANA zone of the caller the turn belongs to. When set, every instant in
   * the result's string values gains its wall-clock time in that zone, so the
   * model reads the user's local time instead of converting it. Unset for
   * background work, which speaks to no one in particular and keeps the
   * instants exactly as stored.
   */
  timeZone?: string;
}

/**
 * The text a model receives for one tool result. Graph evidence is presented
 * once and instants are annotated with the caller's local time; the canonical
 * result that clients, persistence and citation checks read is left intact.
 */
export function serializeToolResultForModel(
  result: ToolResult,
  options: ToolResultSerializationOptions = {},
): string {
  const zone = resolvedZone(options.timeZone);
  const projected = project(result);
  if (!zone) return JSON.stringify(projected);
  return JSON.stringify(projected, (_key, value: unknown) =>
    typeof value === "string" ? annotateLocalTimes(value, zone) : value,
  );
}

const resolvedZones = new Map<string, string | undefined>();

/** `normalizeTimeZone`, remembered: a whole history is re-serialized each model request. */
function resolvedZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) return undefined;
  if (!resolvedZones.has(timeZone)) {
    if (resolvedZones.size >= 64) resolvedZones.clear();
    resolvedZones.set(timeZone, normalizeTimeZone(timeZone));
  }
  return resolvedZones.get(timeZone);
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
