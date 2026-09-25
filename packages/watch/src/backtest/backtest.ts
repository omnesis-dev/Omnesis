// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Replaying a watch to find out what it would cost.
 *
 * A backtest runs the identical engine over a journal slice with one thing
 * changed: every LLM node — including the precision judge embedded in a
 * semantic-match source — is replaced by a counter that never fires. The recall
 * pass still runs, because embeddings are cheap and local and because recall is
 * exactly the filter whose selectivity the compiler is trying to judge.
 *
 * The output is deliberately two numbers rather than one verdict:
 *
 * - **How often the procedural part fired.** "This would have fired zero times
 *   in ninety days" is a compiler bug, and so is four hundred.
 * - **How often it reached a model.** This is the cost, and it is the number
 *   that pushes a compiler toward cheap pre-filtering. A watch that reaches the
 *   judge on every inbound email is not the same watch as one that reaches it
 *   twice a month, even when both are correct.
 *
 * Because judges never fire, anything downstream of one never fires either, and
 * the firing count is the procedural part alone. That is the intent: the
 * question a backtest answers is what the *cheap* half of the watch does.
 */

import { readJournal } from "../journal/read.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, journalPath, loadOntology } from "../universe/paths.js";
import { WatchEngine } from "../runtime/engine.js";
import { CountingJudge, ScriptedRecall, type RecallScorer } from "../runtime/providers.js";
import { loadWatch } from "../runtime/run.js";
import { validateWatch } from "../validator/validate.js";
import { formatBacktest, type LoopBacktest, type LoopBacktestFacts } from "./loop-backtest.js";
import type { WatchDefinition } from "../dsl/schema.js";
import type { WatchTrace } from "../runtime/trace.js";

export interface BacktestOptions {
  readonly universe?: string;
  /**
   * The recall scorer. A backtest wants the real one — the whole point is to
   * measure how much work recall actually lets through.
   */
  readonly recall?: RecallScorer;
  /** Replay only the first N events. */
  readonly through?: number;
}

/**
 * Everything a universe replay measured.
 *
 * A superset of {@link LoopBacktestFacts}: the compiler's loop reads a handful
 * of these fields and a live install's replay supplies the same handful in a
 * different shape, so the loop is stated against that narrower type and this
 * one satisfies it. Both halves of the state measurement are always here — a
 * universe replay tracks instance lifetimes — so this is the narrower type plus
 * that pair, rather than the pair's either-or.
 */
export interface BacktestReport extends LoopBacktestFacts {
  readonly watch: string;
  /** Journal events replayed. */
  readonly events: number;
  /** The span the replay covered, in semantic time. */
  readonly from: string;
  readonly to: string;
  readonly days: number;
  /** How often the sink fired, judges excluded. */
  readonly firings: number;
  /** How often each LLM node would have been invoked. */
  readonly reachByNode: Readonly<Record<string, number>>;
  readonly totalReaches: number;
  /**
   * Nodes that hold state with no deadline. The peak live instance count is
   * the number that says whether "infinite" was a considered choice or an
   * omission.
   */
  readonly unboundedNodes: readonly string[];
  /**
   * The most instances any node held at once. An unbounded node is only a
   * problem at the number it actually reaches, so the report states it rather
   * than telling the reader to go and find out.
   */
  readonly peakInstancesByNode: Readonly<Record<string, number>>;
  readonly trace: WatchTrace;
}

/** Replay a named watch from a universe, counting what it would have asked a model. */
export async function backtest(
  name: string,
  options: BacktestOptions = {},
): Promise<BacktestReport> {
  return backtestDefinition(loadWatch(name, options.universe), options);
}

/**
 * Replay a definition that need not live in a universe.
 *
 * This is the half the compiler needs: it has just written a watch and wants
 * to know what that watch would have done, before anything is written to disk
 * and before there is a name to load it by.
 */
export async function backtestDefinition(
  watch: WatchDefinition,
  options: BacktestOptions = {},
): Promise<BacktestReport> {
  const ontology = loadOntology(options.universe);
  const all = readJournal(journalPath(options.universe));
  const journal = options.through === undefined ? all : all.slice(0, options.through);

  const analytics = await AnalyticsDatabase.materialize(
    ontology,
    analyticsDir(options.universe),
    "projections",
  );
  const judge = new CountingJudge();

  try {
    // What the validator makes of this definition, for the values the engine
    // will bind. A backtest that bound them differently from the host would be
    // measuring a watch the install would never run.
    const types = validateWatch({ watch }, ontology).types;
    const engine = new WatchEngine({
      watch,
      ontology,
      journal,
      analytics,
      ...(types ? { valueTypes: types } : {}),
      judge,
      recall: options.recall ?? new ScriptedRecall([], 1),
    });
    const trace = await engine.run();

    // The window the watch was actually live for, not the window the journal
    // covers. A watch with a horizon stops partway through, and reporting the
    // whole journal would divide its cost by a stretch it never ran in — the
    // rate a reach policy reads would fall simply because the journal is long.
    // Worse, `expires_at` is compiler-authored, so a watch could buy itself a
    // healthy per-day rate by declaring a short horizon.
    const ran = journal.slice(0, engine.eventsConsumed);
    const from = ran[0]?.occurredAt ?? "";
    const to = ran.at(-1)?.occurredAt ?? "";
    const days =
      from && to ? Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)) : 0;

    return {
      watch: watch.name,
      events: ran.length,
      from,
      to,
      days,
      firings: trace.firings.length,
      reachByNode: judge.reachCounts(),
      totalReaches: judge.total,
      peakInstancesByNode: peakInstances(trace),
      unboundedNodes: watch.nodes
        .filter((node) => "deadline" in node && node.deadline === "infinite")
        .map((node) => node.id),
      trace,
      ...failureFrom(trace),
      // A replay the watch itself finished covered as long as the watch lasted,
      // not as long as the question — so its firings are a count, not a rate.
      ...(trace.ended === undefined ? {} : { endedEarly: trace.ended }),
    };
  } finally {
    analytics.close();
  }
}

/**
 * The node that threw, lifted out of the trace into the field the loop reads.
 *
 * The loop asks one question of every substrate — "did anything fail?" — and only
 * this one answers it with a trace. A node that threw and a node that stayed
 * quiet are indistinguishable in the counts, and they call for opposite
 * revisions: one wants a filter loosened, the other wants a column name fixed.
 *
 * Exported so the lifting itself is testable. A replay that has to crash a real
 * node to prove this works is a slow test of the wrong thing.
 */
export function failureFrom(
  trace: WatchTrace,
): { failure: { nodeId: string; detail?: string } } | Record<string, never> {
  const failed = trace.records.find((record) => record.transition === "failed");
  if (!failed) return {};
  // The kind and the engine's own words, joined, which is what the live
  // substrate hands the loop for the same fact. The kind alone says a node broke
  // without saying how; the detail alone loses the classification that tells a
  // reader whether to look at the query, the provider or the budget.
  const detail =
    failed.detail === undefined
      ? failed.failure
      : failed.failure === undefined
        ? failed.detail
        : `${failed.failure}: ${failed.detail}`;
  return {
    failure: {
      nodeId: failed.nodeId,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

/**
 * The most instances each node held at once, over the whole replay.
 *
 * Counted from the trace rather than the store: the store holds the final
 * state, and the number that matters is the high-water mark on the way there.
 * `accumulated` is excluded — an accumulating cell survives its own firing by
 * design, so counting it would report growth where nothing is concurrent.
 */
function peakInstances(trace: WatchTrace): Record<string, number> {
  const live = new Map<string, Set<string>>();
  const peak: Record<string, number> = {};
  for (const record of trace.records) {
    const held = live.get(record.nodeId) ?? new Set<string>();
    const instance = `${record.key}#${record.instance ?? 0}`;
    if (record.transition === "armed") held.add(instance);
    else if (["fired", "cancelled", "expired", "dropped"].includes(record.transition)) {
      held.delete(instance);
    }
    live.set(record.nodeId, held);
    peak[record.nodeId] = Math.max(peak[record.nodeId] ?? 0, held.size);
  }
  return peak;
}

/**
 * The report as a compiler would read it: what the cheap half did, and what it
 * would have cost to finish the job.
 */
export function formatReport(report: LoopBacktest): string {
  return formatBacktest(report);
}
