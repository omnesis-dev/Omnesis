// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shape of a frozen golden, in one place.
 *
 * A golden is a replay's trace plus the backtest report's stable fields — the
 * counts, not the prose. Three callers care about that shape: the script that
 * writes the files, the test that compares against them, and the resume lane
 * that reads a watch's own trace to decide where to cut the journal. Stated
 * three times it drifts: a field added to the report reaches the file but not
 * the comparison, and the corpus stops noticing when that field moves.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { universeDir } from "../universe/paths.js";
import { runWatch } from "../runtime/run.js";
import { backtest } from "./backtest.js";
import type { WatchTrace } from "../runtime/trace.js";

export interface Golden {
  readonly trace: WatchTrace;
  readonly backtest: {
    readonly events: number;
    readonly days: number;
    readonly firings: number;
    readonly reachByNode: Record<string, number>;
    readonly totalReaches: number;
    readonly unboundedNodes: readonly string[];
    /**
     * Whether the watch finished before the window did.
     *
     * Frozen because a concern turns on it: a watch that fired and retired has
     * no firing rate. A golden that omitted it would assert what the policy
     * flags while the live engine flagged something else, and regenerating
     * would not close the gap.
     */
    readonly endedEarly?: "fired" | "expired";
  };
}

/** Every watch the universe defines, in a stable order. */
export function watchNames(): string[] {
  return readdirSync(join(universeDir(), "watches"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** The frozen golden for a watch, as recorded on disk. */
export function frozenGolden(name: string): Golden {
  const path = join(universeDir(), "traces", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Golden;
}

/** What the current engine produces for a watch, in golden shape. */
export async function recordGolden(name: string): Promise<Golden> {
  const trace = await runWatch(name);
  const report = await backtest(name);
  return {
    trace,
    backtest: {
      events: report.events,
      days: report.days,
      firings: report.firings,
      reachByNode: report.reachByNode,
      totalReaches: report.totalReaches,
      unboundedNodes: report.unboundedNodes,
      ...(report.endedEarly === undefined ? {} : { endedEarly: report.endedEarly }),
    },
  };
}
