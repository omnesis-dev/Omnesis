// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a watch is any good — which is not the same question as whether it
 * is running.
 *
 * Every surface says what a watch *is*, what it *holds*, and what it *did*. A
 * watch that has said nothing for a month satisfies all three and reads as
 * perfectly well: it is active, it holds nothing because there is nothing to
 * hold, and it has no firings because nothing happened. That is also exactly
 * what a watch whose recall arm admits nothing looks like, and what one whose
 * proposition is never true looks like, and what one that wakes an agent
 * through a record that no longer exists looks like. A quiet week and a wrong
 * watch are indistinguishable, and telling them apart is the whole promise.
 *
 * So this names the difference, from instruments that already exist, and it
 * carries the numbers it decided from. A verdict without them is an adjective,
 * and an operator cannot act on an adjective — "never matched" is a shrug,
 * where "looked at 4,183 documents over 21 days and admitted none" says the
 * recall arm is too narrow and roughly how confident that is.
 *
 * ## What it will not do
 *
 * **It does not rank.** The list keeps its own order. Sorting by verdict makes
 * the top of the page mean "worst", and a watch with nothing to say would
 * arrive there through no fault of its own.
 *
 * **It does not guess early.** The two verdicts that read silence as a fault
 * need both enough looks and enough time, so a watch installed this morning is
 * `resting` and says so — a verdict that calls a new watch broken teaches the
 * operator to stop reading verdicts. The two that report a *fact* rather than
 * an inference do not wait: a watch holding no record to wake through is
 * reaching nobody on its first day as surely as on its thirtieth.
 *
 * **It does not run anything.** Each input is a number some store already
 * keeps, so a list of a hundred watches costs the reads it already made. The
 * recall probe is the instrument that would answer "would this arm ever match"
 * directly, and it is deliberately absent: it scores the corpus against an
 * embedder on demand and there is nowhere it is kept, so asking it per row
 * would read the whole index to draw a list.
 */

import type { WatchStatus } from "./definitions.js";
import type { StoppedCause } from "./health.js";

/**
 * What a watch's behaviour amounts to, in one word.
 *
 * Closed, and small on purpose: a vocabulary an operator has to learn is one
 * they will not read. Each member names a different thing to *do* — none, wait,
 * read the status, widen the arm, rewrite the proposition, fix the delivery —
 * which is the test for whether a new member belongs here.
 */
export type WatchVerdictName =
  | "healthy"
  | "resting"
  | "stopped"
  | "broken"
  | "never-matched"
  | "judge-declines-everything"
  | "silent-risk";

export const WATCH_VERDICT_NAMES: readonly WatchVerdictName[] = [
  "healthy",
  "resting",
  "stopped",
  "broken",
  "never-matched",
  "judge-declines-everything",
  "silent-risk",
];

/** Everything the verdict is derived from. Each is a number a store keeps. */
export interface WatchQualityInput {
  /**
   * Whether the watch is being evaluated at all.
   *
   * The first thing read, because a watch that is not running cannot be
   * diagnosed by what it has not done. Every rule below reads silence as
   * evidence about the watch's condition — its arm, its proposition, its
   * delivery — and for a stopped watch the silence is the status, which every
   * surface already shows. Without this a watch paused on a thrown node goes
   * on ageing until it is told its arm is too narrow, and a finished one is
   * warned about a record it will never wake anybody through.
   */
  readonly status: WatchStatus;
  /**
   * What stopped it, when something did — see `health.ts`'s `stoppedCause`.
   *
   * `paused` is written by five sites, four of which are faults the machine
   * detected (a node that threw, ontology drift, a mint that failed) and one of
   * which is the operator holding the watch deliberately. The status alone
   * cannot tell them apart, so without this a watch that *broke* reads exactly
   * like one somebody stopped on purpose — and the one thing an operator would
   * act on is the one thing the sentence would not say.
   */
  readonly stoppedCause: StoppedCause | null;
  /**
   * What the ontology check complained about, for a watch drift stopped.
   *
   * Absent for every other cause, and for a drift note written before the
   * codes were kept. Naming them is the difference between a sentence an
   * operator can act on and one that sends them to re-run the validation
   * themselves to find out what moved.
   */
  readonly driftCodes?: string | null;
  /**
   * Why a watch was held for review, when that is why it stopped.
   *
   * The other half of drift, and the one the sentence used to get wrong: a
   * held watch validates perfectly well, so telling its owner it "no longer
   * validates" sends them to rewrite something that is not broken. Absent for
   * every other cause.
   */
  readonly heldSurface?: string | null;
  /** Milliseconds since the watch was installed, and the clock it is read on. */
  readonly addedAtMs: number;
  readonly now: number;
  /** Whether its delivery block wakes an agent, and how many records stand. */
  readonly wakesAnAgent: boolean;
  readonly anchorStanding: number | null;
  /** Firings the watch itself produced. Forced ones are not counted upstream. */
  readonly firings: number;
  readonly lastFiredAtMs: number | null;
  /** Events a source arm looked at and took nothing up — the `ignored` class. */
  readonly declined: number;
  /** What the judge decided, ever, across restarts. */
  readonly judgeMatched: number;
  readonly judgeDeclined: number;
  /**
   * Whether it holds a cell that is still waiting on something, or a timer.
   *
   * Read as evidence that the watch has admitted *something*, which is why it
   * suppresses "admitted none". A watch holding an arm of a join whose deadline
   * is `infinite` therefore reads as waiting rather than as too narrow, and
   * keeps reading that way for as long as the other arm never comes — which is
   * the honest sentence for it. Saying the arm admits nothing would be false of
   * a watch that admitted one; naming a join that will never complete is a
   * verdict this vocabulary does not have, and inventing one would need a
   * number for how long is too long that nothing here can supply.
   */
  readonly holding: boolean;
  /** The sequence it has read up to; null when it has never evaluated. */
  readonly evaluatedThroughSeq: number | null;
}

export interface WatchVerdict {
  readonly name: WatchVerdictName;
  /**
   * The verdict in a sentence, carrying its numbers.
   *
   * Written here rather than at each surface so the portal, the phone and the
   * CLI cannot come to describe one watch three ways — and so the numbers can
   * never be dropped by a surface that found them long.
   */
  readonly because: string;
  /** One word for it, for a surface with room for a word rather than a line. */
  readonly label: string;
  /**
   * Whether there is something to do about it.
   *
   * Written here for the same reason the sentence is, and for one more: a
   * client deciding this from a list of names it was compiled with renders
   * *nothing at all* for a name it has not heard of — so the one surface built
   * to raise an alarm stays silent about exactly the verdicts a newer gateway
   * learned to raise. A phone that has not been updated in a year still marks
   * an unfamiliar actionable verdict, because the gateway said to.
   *
   * `healthy` and `resting` are the ordinary states of a watch that is fine,
   * and `stopped` restates a status every surface already shows; a mark on
   * those makes the mark mean nothing, and makes an unmarked row read as
   * unknown rather than as well. `broken` is the exception among the
   * not-running verdicts: the operator did not ask for it and nothing else
   * says a watch stopped by itself.
   */
  readonly actionable: boolean;
}

/**
 * How much has to have happened before silence means anything.
 *
 * Both bounds have to clear, and they answer different doubts. A watch may look
 * at ten thousand documents in its first hour of a backfill, which says nothing
 * about the weeks it was written for; and one installed a month ago on a quiet
 * source may have seen almost nothing at all. Either alone produces a confident
 * verdict about a watch nobody has given a chance.
 *
 * Not operator settings. They decide what a reader is *told*, not what the
 * runtime does, and there is no install for which a different number is right
 * in a way an operator could reason about.
 */
const ENOUGH_LOOKS = 200;
const ENOUGH_DAYS = 7;

/**
 * How many judgements before "it always says no" is a claim rather than a run.
 *
 * Lower than the look threshold because a judgement is expensive and rare — a
 * watch whose arm nominates ten documents and is refused all ten has told you
 * something, where ten declined *looks* has told you nothing.
 *
 * Counted in **subjects**, because the sentence it produces counts documents.
 * A subject the judge has ever admitted counts as matched from then on and is
 * never given back, so a watch whose every early match was later overwritten by
 * a decline reads `resting` rather than reaching this — true, and silent about
 * the consecutive refusals since. That is the direction to be wrong in: this
 * verdict says the judge refused *every one*, and a watch it once said yes to
 * makes that sentence false.
 *
 * A second consequence is worth knowing: a node judging accumulated evidence with
 * `on_collision: accumulate` is asked about the same cell over and over, and is
 * recorded under the document that cell leads with — which does not change. So
 * such a node has one subject however long it runs, and a watch built entirely
 * from one can be declined daily for a year and never reach this number. It
 * reads `resting` instead, which is not false — nothing about it is being
 * claimed — but it is not the diagnosis either. Counting decisions rather than
 * subjects would reach the threshold and make the sentence untrue: a document
 * re-judged is not a document newly nominated.
 */
const ENOUGH_JUDGEMENTS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One word per verdict, and whether it asks for anything.
 *
 * Beside the rules rather than at each surface, because they are the same kind
 * of fact as the sentence: a property of the verdict, decided once, so no
 * client has to keep a table in step with a vocabulary it does not own.
 */
const VERDICTS: Readonly<Record<WatchVerdictName, { label: string; actionable: boolean }>> = {
  healthy: { label: "Working", actionable: false },
  resting: { label: "Nothing to do yet", actionable: false },
  stopped: { label: "Stopped", actionable: false },
  broken: { label: "Broken", actionable: true },
  "never-matched": { label: "Never matched", actionable: true },
  "judge-declines-everything": { label: "Judge refuses everything", actionable: true },
  "silent-risk": { label: "Reaching nobody", actionable: true },
};

/** The verdict, with the two things every surface reads off its name. */
function verdict(name: WatchVerdictName, because: string): WatchVerdict {
  return { name, because, ...VERDICTS[name] };
}

/**
 * What to say about this watch, and why.
 *
 * A total function, and ordered: the first rule that holds wins. The order is
 * the priority an operator would apply themselves — a watch that reaches nobody
 * is worth knowing about whatever else is true of it, and a watch that has
 * fired is working whatever it has declined along the way.
 */
export function watchVerdict(input: WatchQualityInput): WatchVerdict {
  // A stored instant that cannot be parsed reads as an age of nothing rather
  // than as NaN: every comparison against NaN is false, which would silently
  // disable the age gate and leave a watch describable only as one that has
  // seen too little — however much it has seen.
  const elapsed = input.now - input.addedAtMs;
  const ageDays = Number.isFinite(elapsed) ? Math.max(0, elapsed) / DAY_MS : 0;

  // What a watch already lost is not undone by its having stopped. A watch that
  // fired into a record that could not carry the firings woke nobody those
  // times, and being retired makes that permanent rather than moot — it is the
  // one breach nothing can repair, and reading it as "finished, nothing to do"
  // is the silence this whole module exists to break.
  const lostFirings = input.wakesAnAgent && input.anchorStanding === 0 && input.firings > 0;

  // Otherwise not running outranks every diagnosis. Each rule below reads what
  // the watch has not done as evidence about how it was written, and none of
  // that reasoning holds for a watch nothing evaluates: its arm admits nothing
  // because it is never offered anything, and the record it would wake an agent
  // through has nothing left to carry.
  if (input.status !== "active" && !lostFirings) {
    return stoppedVerdict(input);
  }

  // Reaching nobody outranks everything: the watch may be matching perfectly
  // and every firing is going into a record that cannot carry it.
  if (input.wakesAnAgent && input.anchorStanding !== null && input.anchorStanding !== 1) {
    // The firing count is the cost, and it is the number worth leading with: a
    // watch that has fired forty times through a record that cannot carry them
    // has lost forty wakes, and nothing else on any screen says so.
    const cost =
      input.firings > 0
        ? `has fired ${count(input.firings, "time")}, and `
        : `has fired ${count(0, "time")} so far, and `;
    return verdict(
      "silent-risk",
      input.anchorStanding === 0
        ? `${cost}holds no record to wake an agent through`
        : `${cost}holds ${count(input.anchorStanding, "record")} to wake an agent through; only one is reachable`,
    );
  }

  if (input.firings > 0) {
    return verdict("healthy", `fired ${count(input.firings, "time")}${lastFired(input)}`);
  }

  // The judge answering and always answering no is a statement about the
  // proposition, and a different repair from a recall arm that admits nothing:
  // the words to change are in a different part of the watch.
  if (input.judgeMatched === 0 && input.judgeDeclined >= ENOUGH_JUDGEMENTS) {
    return verdict(
      "judge-declines-everything",
      `its arm nominated ${count(input.judgeDeclined, "document")} and the judge refused every one`,
    );
  }

  // "Admitted none" is a claim about everything the watch has taken up, so it
  // has to be false of *everything*: a judge that has matched, or a cell part
  // way through arming, is something admitted. Reading only the decline count
  // let a mid-flight join with three matches and an armed cell be told its arm
  // admits nothing — false, with a repair attached that would make it worse.
  if (
    input.declined >= ENOUGH_LOOKS &&
    ageDays >= ENOUGH_DAYS &&
    input.judgeMatched === 0 &&
    !input.holding
  ) {
    return verdict(
      "never-matched",
      `looked at ${count(input.declined, "event")} over ${count(Math.floor(ageDays), "day")} and admitted none`,
    );
  }

  return verdict("resting", restingBecause(input, ageDays));
}

/**
 * A watch that is not being evaluated, and whether anyone meant that.
 *
 * The two readings need different words and different urgency. A watch the
 * operator paused, or one that reached its horizon, is doing what it was told;
 * a watch a thrown node or an ontology change stopped is one that broke while
 * nobody was looking, and it will go on not running until somebody notices. The
 * status column says `paused` for both.
 */
function stoppedVerdict(input: WatchQualityInput): WatchVerdict {
  const cost = count(input.firings, "firing");
  switch (input.stoppedCause) {
    case "failed":
      return verdict(
        "broken",
        `a node threw and stopped it after ${cost}; see \`watch trace\` for which`,
      );
    case "drifted": {
      // The remedy depends on *what* moved, and the old sentence named the
      // wrong one for the common case. The install's shape is a single hash, so
      // a source shipping a table no watch has heard of moves it for every
      // watch at once — and re-stamping heals all of them without a word of any
      // definition changing. Rewriting is the answer only for a watch that
      // still fails once it has been checked against the world as it now is.
      // A watch held for review is not broken and must not be told it is: it
      // validates, and what stopped it is that something it reads moved. The
      // answer is a person looking, which is what re-stamping is.
      if (input.heldSurface !== null && input.heldSurface !== undefined) {
        return verdict(
          "broken",
          `it still validates but the ontology it reads has changed, so it is held after ${cost}; ${input.heldSurface}`,
        );
      }
      const moved =
        input.driftCodes === null || input.driftCodes === undefined ? "" : ` (${input.driftCodes})`;
      return verdict(
        "broken",
        `it no longer validates against this install after ${cost}${moved}; re-stamp it if only the fingerprint moved, otherwise it needs rewriting`,
      );
    }
    case "unarmed":
      // Nothing is wrong with the watch: the record that wakes the agent could
      // not be created, so it is held rather than left evaluating into nothing.
      // Resuming it re-runs the minting, which is why the sentence says so.
      return verdict(
        "broken",
        `its wake record could not be created, so it is held after ${cost}; resume it to try again`,
      );
    case "retired":
      return verdict("stopped", `finished after ${cost}; it will not fire again`);
    // `held` is the operator's own decision, and `null` cannot happen here —
    // the caller only reaches this for a watch that is not active. Both read as
    // deliberately stopped, which is the answer that asks for nothing.
    default:
      return verdict("stopped", `paused after ${cost}; nothing is evaluated until it runs again`);
  }
}

/** Why there is nothing to say yet — which is a different answer each time. */
function restingBecause(input: WatchQualityInput, ageDays: number): string {
  if (input.evaluatedThroughSeq === null) return "installed, and has not read anything yet";
  if (input.holding) return "holding something, and waiting for the rest of it";
  // Its judge has said yes and nothing has come out the other side, so what is
  // waiting is somewhere between the two — a join short an arm, a cooldown, a
  // deadline. Saying "too few to say" here would be false about a watch that
  // has admitted plenty, and it is the sentence a decline count alone reaches.
  if (input.judgeMatched > 0) {
    // Documents, not occasions: the count is of subjects the judge has ever
    // admitted, and one re-judged twice is still one document.
    return `its judge has admitted ${count(input.judgeMatched, "document")}, and nothing has fired yet`;
  }
  if (ageDays < ENOUGH_DAYS) {
    return `installed ${count(Math.floor(ageDays), "day")} ago; too early to say`;
  }
  return `looked at ${count(input.declined, "event")}; too few to say`;
}

function lastFired(input: WatchQualityInput): string {
  if (input.lastFiredAtMs === null) return "";
  const days = Math.floor(Math.max(0, input.now - input.lastFiredAtMs) / DAY_MS);
  if (days === 0) return ", most recently today";
  return `, most recently ${count(days, "day")} ago`;
}

/** `1 event` / `4,183 events` — the number always, the plural when it earns it. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}
