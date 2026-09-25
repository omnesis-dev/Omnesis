// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compiler's backtest, run against this install rather than a universe.
 *
 * The compiler's loop has two halves: the validator says whether a candidate is
 * legal, and a replay says what it would actually have done. The replay the loop
 * ships with reads a journal and materialised analytics out of a universe
 * directory, and a running gateway is not one — so a live install needs its own
 * way to answer the second half, or the substrate every watch actually runs on
 * is the one substrate no watch is measured against before it is installed.
 *
 * `preflight` is that way: it replays a candidate over the live journal and
 * answers in its own shape. This turns that shape into the one the loop reads,
 * so the concern and the single revision that follows it are the same ones a
 * universe compile gets, rather than a second loop written beside the first.
 *
 * **Read-only by construction.** `preflight` takes a DSL rather than an
 * installed watch and writes nothing, so a compile that never installs stays a
 * compile that never installs — the property the whole compile-only path exists
 * for.
 */

import { createLogger } from "@omnesis/core";
import type { LoopBacktest, WatchDefinition } from "@omnesis/watch";

import type { PreflightOutcome, PreflightReport } from "./preflight.js";

const log = createLogger("gateway:watch-v2:compile");

const MS_PER_DAY = 86_400_000;

/**
 * How far back a compile-time replay reaches.
 *
 * A season rather than an afternoon: most conditions worth watching are monthly
 * or rarer, and a window that cannot contain one occurrence turns every reach
 * number into a zero that means nothing — which is worse than no number, because
 * the loop would read it as a filter that matches nothing and send the model to
 * repair a watch that is fine.
 */
export const COMPILE_BACKTEST_DAYS = 90;

/** What one compile-time replay cost, for the latency this is measured against. */
export interface LiveBacktestTiming {
  readonly wallMs: number;
  readonly outcome: "replayed" | "refused" | "empty" | "failed";
}

/**
 * Turn a preflight report into what the loop reads.
 *
 * `days` comes from the time the replay *consumed*, never from the time it was
 * asked for: an event backstop or a young journal cuts the window short, and
 * dividing by the requested span reports a watch as quieter than it is. A window
 * that consumed nothing yields `null` rather than a report of zeroes — a watch
 * that reached nothing and a watch nobody replayed lead to opposite revisions,
 * and only one of them is worth spending a repair turn on.
 */
export function loopBacktestFrom(report: PreflightReport, name: string): LoopBacktest | null {
  const days = report.window.observedMs / MS_PER_DAY;
  if (report.window.events === 0 || days <= 0) return null;

  const reachByNode: Record<string, number> = {};
  for (const node of report.nodes) {
    if (node.wouldAsk > 0) reachByNode[node.nodeId] = node.wouldAsk;
  }
  const failed = report.failed?.[0];

  return {
    watch: name,
    events: report.window.events,
    days,
    ...(report.window.daysRequested === undefined
      ? {}
      : { daysRequested: report.window.daysRequested }),
    ...(report.window.truncated === true ? { windowWasCapped: true } : {}),
    firings: report.firings,
    reachByNode,
    totalReaches: report.nodes.reduce((total, node) => total + node.wouldAsk, 0),
    ...(report.window.ended === undefined ? {} : { endedEarly: report.window.ended }),
    ...(failed
      ? {
          failure: {
            nodeId: failed.nodeId,
            // The kind and the engine's own words, joined: the kind alone says
            // a node broke without saying how, and the detail alone loses the
            // classification a reader needs to know where to look.
            detail: failed.detail ? `${failed.failure}: ${failed.detail}` : failed.failure,
          },
        }
      : {}),
    // Deliberately absent rather than empty. This replay does not track how many
    // instances a stateful node held at once, and an empty list would say "none
    // held state without a deadline" — a claim nobody checked, put in front of
    // the model as though it had been.
  };
}

/**
 * The port the compiler calls once a candidate validates.
 *
 * Failures are swallowed into `null`, deliberately: the backtest is advice, and
 * advice must never cost a working compilation. A replay that refuses because it
 * cannot score a semantic arm, or throws, leaves the validated watch standing.
 *
 * `replay` returns `null` rather than a promise on a gateway with no watch
 * runtime. That is an install with no history to replay a candidate over, which
 * is a fact about the install and not an error — so it costs no timing, no
 * warning and no stack unwind, and it cannot be counted among the replays that
 * broke. Those two have to stay apart: a rate of *broken* replays is the number
 * that would say this loop should be switched off, and a permanent absence
 * logged once per compile would drown it.
 */
export function liveBacktestPort(
  replay: (watch: WatchDefinition, days: number) => Promise<PreflightOutcome> | null,
  onTiming?: (timing: LiveBacktestTiming) => void,
): (watch: WatchDefinition) => Promise<LoopBacktest | null> {
  return async (watch) => {
    const pending = replay(watch, COMPILE_BACKTEST_DAYS);
    if (pending === null) return null;

    const started = Date.now();
    // Overwritten by every path that reaches an answer. A replay killed by a
    // thrown error never reassigns it, and the throw is what it stays.
    let outcome: LiveBacktestTiming["outcome"] = "failed";
    try {
      const result = await pending;
      if (result.outcome !== "probed") {
        outcome = "refused";
        log.info(`compile-time replay declined for ${watch.name}: ${result.refusal.reason}`);
        return null;
      }
      const report = loopBacktestFrom(result.report, watch.name);
      outcome = report === null ? "empty" : "replayed";
      return report;
    } catch (error) {
      log.warn(
        `compile-time replay threw for ${watch.name}; compiling without it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      onTiming?.({ wallMs: Date.now() - started, outcome });
    }
  };
}
