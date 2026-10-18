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

/** 2000-01-01 and 2100-01-01 in epoch milliseconds: the span a stored moment falls in. */
const EPOCH_MS_FLOOR = 946_684_800_000;
const EPOCH_MS_CEILING = 4_102_444_800_000;

/**
 * The names the wire protocol gives a moment carried as a number: a document's
 * `ts`, a ledger entry's `at`, a field named for when something happened
 * (`createdAt`, `firedAt`) or for the latest of something (`lastInteraction`).
 */
const MOMENT_KEY = /^(?:ts|at)$|[a-z]At$|^last[A-Z]/u;

/**
 * Whether a number in a result is a moment in epoch milliseconds. Read by name
 * and range together, so a count or a duration is never mistaken for one.
 */
function isEpochMillis(key: string, value: number): boolean {
  return (
    MOMENT_KEY.test(key) &&
    Number.isInteger(value) &&
    value >= EPOCH_MS_FLOOR &&
    value < EPOCH_MS_CEILING
  );
}

/**
 * The text a model receives for one tool result. Graph evidence is presented
 * once and instants are annotated with the caller's local time; the canonical
 * result that clients, persistence and citation checks read is left intact.
 * A moment carried as epoch milliseconds is written as the instant it names
 * first, so it is annotated like every other: a model cannot read a clock
 * time off `1792344480000`, and converting it itself lands on UTC.
 */
export function serializeToolResultForModel(
  result: ToolResult,
  options: ToolResultSerializationOptions = {},
): string {
  const zone = resolvedZone(options.timeZone);
  const projected = project(result);
  if (!zone) return JSON.stringify(projected);
  return JSON.stringify(projected, (key, value: unknown) => {
    if (typeof value === "string") return annotateLocalTimes(value, zone);
    if (typeof value === "number" && isEpochMillis(key, value)) {
      return annotateLocalTimes(new Date(value).toISOString(), zone);
    }
    return value;
  });
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
