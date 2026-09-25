// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the compiler's loop reads off a replay, whichever substrate replayed it.
 *
 * Two substrates replay a candidate: a universe directory and a live install.
 * Their reports are different shapes holding the same facts, and each carries
 * far more than the loop looks at. So the loop is stated against the facts
 * rather than against either shape, and both substrates hand it one of these.
 *
 * The fields the loop cannot always be given are optional rather than defaulted,
 * and that distinction is the point: an empty `unboundedNodes` says "nothing
 * holds state without a deadline", while an absent one says "this replay did not
 * measure that". Defaulting the second to the first would put a claim in front
 * of the model that nobody checked.
 */

export interface LoopBacktestFacts {
  /** The watch's name, for a report the model reads. */
  readonly watch: string;
  /** Journal events replayed. */
  readonly events: number;
  /**
   * The span the replay covered, in days of semantic time.
   *
   * The denominator for every rate below it, which is why it is days of what
   * was *consumed* rather than of what was asked for: a window cut short by a
   * young journal or an event backstop is a smaller denominator, and dividing
   * by the requested span reports a watch as quieter than it is.
   */
  readonly days: number;
  /**
   * The span that was asked for, when the substrate asked for one.
   *
   * Absent where nothing was requested — a universe replay covers the journal it
   * has. Present and larger than `days`, it says the replay covered less than it
   * set out to, which is the difference between a watch that stayed quiet for a
   * season and one that had twelve days to prove itself. Silence over the first
   * is evidence; over the second it is barely anything.
   */
  readonly daysRequested?: number;
  /**
   * The short window was a ceiling on the replay, not the end of the history.
   *
   * The two produce the same small number of days and call for opposite
   * conclusions: a ceiling means the install has more history than one replay
   * reads, so a longer look is available; the end of the history means there is
   * nothing older to look at, and the watch cannot be told anything more about
   * itself until time passes. Telling a model the second when the first is true
   * sends it to loosen a filter over evidence that was never gathered.
   */
  readonly windowWasCapped?: boolean;
  /** How often the sink fired, judges excluded. */
  readonly firings: number;
  /** How often each node holding a judge would have asked one. */
  readonly reachByNode: Readonly<Record<string, number>>;
  readonly totalReaches: number;
  /**
   * A node that threw while replaying, when one did.
   *
   * Kept apart from the counts because it means the opposite of what they
   * suggest: a watch that threw and a watch that stayed quiet both come back
   * with nothing, and reading the second for the first sends a reader after a
   * filter when the fault is a column that does not exist.
   */
  readonly failure?: { readonly nodeId: string; readonly detail?: string };
  /**
   * The replay stopped before the window did, because the watch was finished.
   *
   * Which changes what `days` can be a denominator for, differently for each of
   * the two ways a watch finishes. A `once_ever` watch that fires on day two of
   * a ninety-day replay stopped *because* it fired, so its span is an artefact
   * of the firing being divided by it: one firing per two days reads as a flood,
   * and the watch that behaved exactly as asked is the one sent back to be
   * changed. A horizon passing owes the firings nothing — that watch really did
   * run its whole window at whatever rate it ran.
   *
   * Either way `days` is the whole of what there was to cover: a watch whose
   * life ended inside the replay has been replayed completely, however small a
   * fraction of the requested span that life came to.
   */
  readonly endedEarly?: "fired" | "expired";
}

/**
 * What a replay measured about nodes that hold state with no deadline.
 *
 * Both halves or neither, because they are one measurement. A report that named
 * an unbounded node while carrying no peaks at all would leave its only reader
 * to invent every number it prints, in a report whose whole discipline is to
 * state what was measured. Within a measurement a node missing from the peaks is
 * a node that never armed, which is a peak of zero and is measured. Absent, not
 * empty, on a replay that does not track instance lifetimes: "none held state
 * without a deadline" and "nobody looked" call for opposite revisions.
 */
export type StateBounds =
  | {
      readonly unboundedNodes: readonly string[];
      readonly peakInstancesByNode: Readonly<Record<string, number>>;
    }
  | { readonly unboundedNodes?: undefined; readonly peakInstancesByNode?: undefined };

/** The facts the loop reads, with the state measurement it may not have. */
export type LoopBacktest = LoopBacktestFacts & StateBounds;

/**
 * Why a replay covered less than it asked for — three reasons, three revisions.
 *
 * A watch that finished is the one to say first, because it is the only one of
 * the three that is not about the install: a `once_ever` watch that fired on day
 * two of a ninety-day request has nothing more to replay, and telling a model
 * "the journal reaches no further back" states something false about the history
 * at the exact moment a concern is asking it to change the watch. Of the other
 * two, a ceiling means a longer look is available and the end of the history
 * means nothing older exists to look at.
 */
function whyItFellShort(report: LoopBacktest): string {
  if (report.endedEarly === "fired") return "the watch fired and retired";
  if (report.endedEarly === "expired") return "the watch's horizon passed";
  if (report.windowWasCapped === true) return "one replay reads no more than that at once";
  return "the journal reaches no further back";
}

/**
 * The replay, in the words a model is shown when it is asked to reconsider.
 *
 * States what was measured and stays silent about what was not — a replay that
 * did not track state bounds says nothing about them rather than reporting none,
 * because "no unbounded nodes" and "nobody looked" lead to opposite revisions.
 */
export function formatBacktest(report: LoopBacktest): string {
  // The span is exact in the shape, because every rate divides by it. Shown, it
  // is rounded: a replay bounded by a millisecond timestamp yields a number with
  // a dozen decimal places, and none of them mean anything to a reader.
  const span = Number.isInteger(report.days) ? report.days : report.days.toFixed(1);
  // Named only when the replay fell short of it. Stating that ninety days were
  // asked for and ninety covered is noise; stating that ninety were asked for
  // and twelve reached is the whole context for every zero below it — and why
  // it fell short decides what to do about it.
  const short =
    report.daysRequested !== undefined && report.daysRequested - report.days >= 1
      ? ` (${report.daysRequested} asked for; ${whyItFellShort(report)})`
      : "";
  const lines = [
    `${report.watch}`,
    `  replayed ${report.events} events over ${span} days${short}`,
    `  procedural firings: ${report.firings}`,
  ];

  if (report.totalReaches === 0) {
    lines.push("  model reaches: none — this watch decides procedurally");
  } else {
    lines.push(`  model reaches: ${report.totalReaches}`);
    for (const [node, count] of Object.entries(report.reachByNode)) {
      const perDay = report.days > 0 ? count / report.days : count;
      lines.push(`    ${node}: ${count} (${perDay.toFixed(2)}/day)`);
    }
  }

  for (const node of report.unboundedNodes ?? []) {
    const peak = report.peakInstancesByNode?.[node] ?? 0;
    lines.push(`  ${node} holds state with no deadline — peaked at ${peak} live instances`);
  }

  return lines.join("\n");
}
