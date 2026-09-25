// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Natural language in, a validated watch or an honest refusal out.
 *
 * The loop is short and its shape is the whole idea:
 *
 *   attempt → validator diagnostics as machine feedback → bounded repairs
 *           → backtest → at most one revision on the reach report
 *
 * Two feedback signals, and they answer different questions. The validator
 * answers *is this legal* — stable codes and JSON pointers, built as an API for
 * exactly this consumer — and the model gets them back verbatim, up to
 * `maxRepairs` times. The backtest answers *is this alive*: a watch that fires
 * zero times over the whole journal, or reaches a model on every event, is
 * usually a misreading of the request rather than an illegal plan, and the
 * validator cannot tell. That one gets a single revision pass, because a model
 * shown its own reach report twice starts optimising the number rather than the
 * meaning.
 *
 * Every turn is recorded. A run that failed is more useful than a verdict, and
 * the evaluation harness reads the attempt list to classify *how* it failed —
 * unparseable reply, still-invalid after repairs, or valid but wrong.
 *
 * Nothing here reaches the network. The model is a parameter, and the only
 * implementation that does is configured entirely from the environment.
 */

import { backtestDefinition, formatReport } from "../backtest/backtest.js";
import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { cadenceMessage, impliedCadence } from "./cadence.js";
import { addUsage, NO_USAGE, type ChatMessage, type ChatModel, type ModelUsage } from "./model.js";
import { parseReply } from "./parse.js";
import { disclosableCodes, type RefusalCode } from "./refusal.js";
import {
  boundsMessage,
  diagnosticsMessage,
  promptPrefix,
  queryMessage,
  reachMessage,
  unparseableMessage,
  type CompilerContext,
} from "./prompt.js";
import type { LoopBacktest } from "../backtest/loop-backtest.js";
import type { WatchDiagnostic } from "../validator/diagnostics.js";

/**
 * When a validating watch is worth one more look.
 *
 * Every bound is stated rather than assumed, because every one of them depends
 * on the journal a compilation is measured against: a month-long replay and a
 * year-long one disagree about what "never fires" and "too often" mean. This
 * is the compiler's policy, not the engine's.
 */
export interface ReachPolicy {
  /**
   * Below this many firings over the replayed span, ask again — but only for a
   * watch that reaches no model at all. In a backtest every judge is a counter
   * that never fires, so everything downstream of one never fires either, and
   * zero firings is the expected result for a judged watch rather than a
   * symptom. For those the reach count is the signal, and it is checked below.
   */
  readonly minFirings: number;
  /** Above this many firings per replayed day, ask again. */
  readonly maxFiringsPerDay: number;
  /** Above this many model reaches per replayed day, ask again. */
  readonly maxReachesPerDay: number;
  /**
   * The whole of what a finished watch may cost before its rate is worth reading.
   *
   * A retirement is the one thing that turns a rate into a total: a `once_ever`
   * watch that asked its judge twice and fired on day two cost two model calls
   * and will never cost another, and one a day describes a watch that no longer
   * exists. Past this the total is large enough that the rate behind it is worth
   * saying whether the watch is still running or not — dozens of calls across a
   * season are dozens of calls, paid.
   */
  readonly minRetiredReaches: number;
  /**
   * The least of a requested span a replay must cover before its silence counts.
   *
   * A replay is bounded by an event ceiling as well as by days, so on a busy
   * install a season's request comes back covering a fraction of one — measured
   * at eight days of a requested ninety on a real install, because that install
   * produces sixty thousand journal events a week. Nothing a monthly condition
   * does is visible in eight days, and a watch that stayed quiet through them
   * has shown nothing at all.
   *
   * Without this the loop reads that silence as a filter that cannot match and
   * spends its one revision telling a correct watch to change — which is worse
   * than saying nothing, because the watch that comes back is worse and the
   * turn is gone.
   *
   * How long is long enough would ideally be a question about the condition — a
   * window holding a couple of expected occurrences — and nothing available
   * answers that. The request's cadence band is the nearest thing to an absolute
   * rhythm anywhere in the compiler, and it is not one: `firingsPerDay` bounds
   * how often a watch of that kind should be allowed to *speak*, not how often
   * its condition *occurs*. Read as the second it inverts — the looser the
   * phrasing, the shorter the window it would accept, so "tell me every time an
   * invoice arrives" would call three days enough to conclude that a filter
   * matching nothing is the explanation. So the question asked here is the
   * weaker, honest one: how much of what was asked for the replay covered.
   *
   * Half. A replay that covered most of what it asked for still says something
   * about a condition that never occurred; one that covered a tenth does not,
   * and the gap between those is where a correct watch gets told to change.
   */
  readonly minWindowFraction: number; // See #1991 — why a replay falls short at all.
}

/**
 * The defaults, measured against the hand-written corpus rather than guessed.
 *
 * Six of the corpus's eighteen watches sit above 0.5 reaches a day, topping out
 * at 1.8 — two invoice filters that put every inbound email in front of a model,
 * a travel watch that judges every indexed document, and three whose semantic
 * arm admits one person's whole correspondence. All six are structural filters
 * carrying almost none of the load, which is what the report exists to name, so
 * the ceiling sits below them and those six are asked to reconsider. The rest
 * are quiet.
 *
 * The firing ceiling is far above anything the corpus produces (two firings in
 * 39 days at most) and exists to catch the other failure: a watch that fires on
 * everything. It is a smoke alarm rather than a tuned threshold.
 */
export const DEFAULT_REACH_POLICY: ReachPolicy = {
  minFirings: 1,
  maxFiringsPerDay: 1,
  maxReachesPerDay: 0.5,
  // The corpus's own retirements cost eight model calls and none: a dinner watch
  // that judged eight replies before its horizon passed, and a tax loop that
  // fired procedurally. Ten sits above the whole of the more expensive of those
  // and far below the forty-six a season-long judged watch runs up, which is the
  // cost this policy exists to name. Under it there is nothing worth spending a
  // revision turn on — the turn itself costs about as much.
  minRetiredReaches: 10,
  minWindowFraction: 0.5,
};

export interface CompileOptions {
  /**
   * The universe the watch is validated and replayed against. It has to be
   * one value, not two: validating against one ontology and backtesting
   * against another would report a legal watch behaving like a different one.
   * `context.ontology` is checked against it.
   *
   * Omit it together with `ontologyIsCallers` to compile against an ontology
   * that is not on disk — a live install's, which is assembled from the
   * running gateway rather than read from a universe directory.
   */
  readonly universe?: string;
  /**
   * Compile against the caller's ontology rather than a universe's.
   *
   * The invariant the universe check protects is that the ontology a watch is
   * *compiled* against is the one it is *validated* against — otherwise the
   * compiler writes against a substrate the install does not have. A universe
   * satisfies that by construction because both come from the same file. A
   * live install satisfies it too: the caller assembles one ontology and hands
   * the same object to both halves. What it cannot do is match a file, so the
   * file comparison is the wrong way to state the invariant for it.
   *
   * Backtesting is a separate matter, and is skipped when this is set: replay
   * needs a journal and materialised analytics on disk, which a live install
   * does not keep in that shape. A caller that sets this is choosing to accept
   * a watch whose reach has not been measured by replay, and owes it some
   * other bound.
   */
  readonly ontologyIsCallers?: boolean;
  /** Validator repairs after the first attempt. Zero means one attempt only. */
  readonly maxRepairs?: number;
  readonly reachPolicy?: ReachPolicy;
  /**
   * Whether a validating watch may be shown its reach report and asked once to
   * reconsider. Off measures what the compiler writes unprompted, which is a
   * different question from what it converges on.
   */
  readonly revise?: boolean;
  /** Skip the backtest entirely — used when only legality is being measured. */
  readonly skipBacktest?: boolean;
  /**
   * Replay a validated candidate on the caller's own substrate.
   *
   * A universe replays from files this package can read; a live install cannot,
   * and until it had a way to it was the one caller compiling blind — the half
   * of the loop that asks what a watch would actually have done never ran for
   * the only substrate anyone runs watches on. Given this, it runs there too,
   * through exactly the same concern and the same single revision.
   *
   * Returning `null` means the replay could not say anything — an empty journal,
   * a candidate it cannot score — and is treated as no report rather than as a
   * report of nothing, because a watch that reached zero and a watch nobody
   * replayed lead to opposite revisions.
   */
  readonly backtest?: (watch: WatchDefinition) => Promise<LoopBacktest | null>;
  /**
   * Write the graph first, then bound it in a turn of its own.
   *
   * The single-pass compiler asks for both at once. This asks for the plan,
   * takes the one that validates, and then puts the operational-bounds
   * checklist to the model with nothing else to hold — testing whether the
   * bounds are omitted because the model was not told to fit them or because it
   * had no capacity left to fit them while writing everything else.
   *
   * The written plan is the floor: a bounds turn that comes back unusable
   * leaves it standing, exactly as the reach revision does.
   */
  readonly boundsPass?: boolean;
}

/** What one exchange with the model produced. */
export interface CompileAttempt {
  readonly turn: number;
  /** Why this turn happened. The first is always `initial`. */
  readonly cause: "initial" | "unparseable" | "diagnostics" | "reach" | "bounds";
  readonly reply: string;
  readonly outcome: "watch" | "refusal" | "unparseable";
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly usage: ModelUsage;
}

export type CompileResult =
  | {
      readonly status: "compiled";
      readonly watch: WatchDefinition;
      /** The document as validated, ready to be written to a universe. */
      readonly document: unknown;
      readonly report: LoopBacktest | null;
      readonly attempts: readonly CompileAttempt[];
      readonly usage: ModelUsage;
    }
  | {
      readonly status: "refused";
      /**
       * The model's own words, for the corpus's owner and the gateway log.
       * A reader with the corpus open writes these, so they never leave the
       * machine — see {@link disclosableCodes}.
       */
      readonly reasons: readonly string[];
      /** The disclosable half: what about the request could not be written. */
      readonly codes: readonly RefusalCode[];
      readonly attempts: readonly CompileAttempt[];
      readonly usage: ModelUsage;
    }
  | {
      readonly status: "failed";
      /** `unparseable` if the last reply was unreadable, else `invalid`. */
      readonly reason: "unparseable" | "invalid";
      readonly diagnostics: readonly WatchDiagnostic[];
      readonly attempts: readonly CompileAttempt[];
      readonly usage: ModelUsage;
    };

export async function compile(
  nlQuery: string,
  context: CompilerContext,
  model: ChatModel,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const maxRepairs = options.maxRepairs ?? 3;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
    throw new Error(`maxRepairs must be a non-negative integer, got ${String(options.maxRepairs)}`);
  }
  if (options.ontologyIsCallers === true) {
    if (options.universe !== undefined) {
      throw new Error(
        "a compile against the caller's ontology has no universe to replay in; pass one or the other",
      );
    }
  } else if (context.ontology.fingerprint !== loadOntology(options.universe).fingerprint) {
    throw new Error(
      "the context's ontology is not the one this universe declares; validation and replay would disagree",
    );
  }
  const policy = options.reachPolicy ?? DEFAULT_REACH_POLICY;

  const messages: ChatMessage[] = [...promptPrefix(context), queryMessage(nlQuery)];
  const attempts: CompileAttempt[] = [];
  let usage = NO_USAGE;
  let cause: CompileAttempt["cause"] = "initial";

  for (let turn = 0; turn <= maxRepairs; turn += 1) {
    const reply = await model.complete(messages);
    usage = addUsage(usage, reply.usage);
    messages.push({ role: "assistant", content: reply.text });

    const parsed = parseReply(reply.text);

    if (parsed.kind === "unparseable") {
      attempts.push({
        turn,
        cause,
        reply: reply.text,
        outcome: "unparseable",
        diagnostics: [],
        usage: reply.usage,
      });
      cause = "unparseable";
      messages.push(unparseableMessage(parsed.detail));
      continue;
    }

    if (parsed.kind === "refusal") {
      attempts.push({
        turn,
        cause,
        reply: reply.text,
        outcome: "refusal",
        diagnostics: [],
        usage: reply.usage,
      });
      return {
        status: "refused",
        reasons: parsed.reasons,
        codes: disclosableCodes(parsed.codes),
        attempts,
        usage,
      };
    }

    let document = stamp(parsed.watch, nlQuery, context.ontology.fingerprint);
    const result = validateWatch(document, context.ontology, {
      docFrequency: context.docFrequency,
    });
    attempts.push({
      turn,
      cause,
      reply: reply.text,
      outcome: "watch",
      diagnostics: result.diagnostics,
      usage: reply.usage,
    });

    if (!result.valid) {
      cause = "diagnostics";
      messages.push(diagnosticsMessage(errorsOf(result.diagnostics)));
      continue;
    }

    let watch = watchDslSchema.parse(document).watch;

    // The second pass, before anything is replayed: the graph is settled and
    // the only question left is what bounds it.
    // Once per compilation, structurally: every path out of this block either
    // returns or falls through to the return below, so the loop does not come
    // back round after a plan has validated.
    let spentTurns = turn;
    if (options.boundsPass === true) {
      spentTurns += 1;
      messages.push(boundsMessage());
      const bounded = await reviseOnce(
        messages,
        messages,
        nlQuery,
        context,
        model,
        options,
        spentTurns,
        { cause: "bounds", skipBacktest: true },
      );
      usage = addUsage(usage, bounded.usage);
      attempts.push(bounded.attempt);
      if (bounded.accepted !== null) {
        watch = bounded.accepted.watch;
        document = bounded.accepted.document;
      }
    }

    // Where the replay comes from, in order of what the caller has. A caller
    // compiling against its own ontology brings its own substrate or has none —
    // this package can only read a universe from files, and a live install is
    // not one.
    const report = await replayFor(watch, options);
    if (report === null) {
      return { status: "compiled", watch, document, report: null, attempts, usage };
    }

    // The request is read only for its cadence, so withholding it withholds
    // that half of the operational-bounds calibration — keeping the two halves
    // on one switch.
    const calibrated = context.operationalBounds !== false || options.boundsPass === true;
    const concern = reachConcern(watch, report, policy, calibrated ? nlQuery : undefined);
    if (concern === null || options.revise === false) {
      return { status: "compiled", watch, document, report, attempts, usage };
    }

    // One revision, and the watch that already validates is the floor: a
    // revision that comes back illegal or unreadable leaves it standing. The
    // reach report is advice, and advice must not cost a working compilation.
    messages.push(reachMessage(formatReport(report), concern));
    const revised = await reviseOnce(
      messages,
      messages,
      nlQuery,
      context,
      model,
      options,
      spentTurns + 1,
    );
    usage = addUsage(usage, revised.usage);
    attempts.push(revised.attempt);
    return revised.accepted === null
      ? { status: "compiled", watch, document, report, attempts, usage }
      : { status: "compiled", ...revised.accepted, attempts, usage };
  }

  const last = attempts.at(-1);
  return {
    status: "failed",
    reason: last?.outcome === "unparseable" ? "unparseable" : "invalid",
    diagnostics: last?.diagnostics ?? [],
    attempts,
    usage,
  };
}

/** A compilation the revision turn produced and the caller may adopt. */
interface AcceptedRevision {
  readonly watch: WatchDefinition;
  readonly document: unknown;
  readonly report: LoopBacktest | null;
}

/**
 * The single revision turn.
 *
 * `accepted` is non-null only when the revision is strictly usable — it parsed,
 * it validated, and it backtested. Anything else leaves it null and the caller
 * keeps the watch it already had. The attempt is recorded either way, so a
 * revision that made things worse is visible in the record rather than lost.
 */
async function reviseOnce(
  messages: readonly ChatMessage[],
  spoken: ChatMessage[],
  nlQuery: string,
  context: CompilerContext,
  model: ChatModel,
  options: CompileOptions,
  turn: number,
  as: { readonly cause: CompileAttempt["cause"]; readonly skipBacktest?: boolean } = {
    cause: "reach",
  },
): Promise<{
  readonly attempt: CompileAttempt;
  readonly usage: ModelUsage;
  readonly accepted: AcceptedRevision | null;
}> {
  const reply = await model.complete(messages);
  spoken.push({ role: "assistant", content: reply.text });
  const parsed = parseReply(reply.text);

  if (parsed.kind !== "watch") {
    return {
      attempt: {
        turn,
        cause: as.cause,
        reply: reply.text,
        outcome: parsed.kind === "refusal" ? "refusal" : "unparseable",
        diagnostics: [],
        usage: reply.usage,
      },
      usage: reply.usage,
      accepted: null,
    };
  }

  const document = stamp(parsed.watch, nlQuery, context.ontology.fingerprint);
  const result = validateWatch(document, context.ontology, { docFrequency: context.docFrequency });
  const attempt: CompileAttempt = {
    turn,
    cause: as.cause,
    reply: reply.text,
    outcome: "watch",
    diagnostics: result.diagnostics,
    usage: reply.usage,
  };
  if (!result.valid) return { attempt, usage: reply.usage, accepted: null };

  const watch = watchDslSchema.parse(document).watch;
  // A bounds turn is followed by the ordinary replay in the caller, so it does
  // not pay for one of its own.
  const report = as.skipBacktest === true ? null : await replayFor(watch, options);
  return { attempt, usage: reply.usage, accepted: { watch, document, report } };
}

/**
 * Fill in the two fields the compiler already knows.
 *
 * The request it was given and the fingerprint it validated against are facts
 * the caller holds; asking a model to copy them can only introduce a typo, and
 * a mistyped fingerprint costs a whole repair turn on a diagnostic about data
 * nobody was guessing at. What the model writes is overwritten rather than
 * checked, because there is no version of this the model knows better.
 */
function stamp(watch: unknown, nlQuery: string, fingerprint: string): unknown {
  if (typeof watch !== "object" || watch === null || Array.isArray(watch)) return { watch };
  return { watch: { ...watch, nl_query: nlQuery, ontology_fingerprint: fingerprint } };
}

/**
 * Where a replay of this candidate comes from.
 *
 * One place, because a revision replayed on a different substrate from the
 * compile it revises would compare two watches measured against two different
 * histories — and the second number is the one that gets recorded.
 *
 * In order of what the caller has: nothing when the caller asked for nothing;
 * the caller's own substrate when it brought one, which is the case for a live
 * install whose ontology is assembled from a running gateway rather than read
 * from a directory; a universe otherwise. A caller compiling against its own
 * ontology with no replay to offer gets none, and is compiled on the strength of
 * the validator alone.
 */
async function replayFor(
  watch: WatchDefinition,
  options: CompileOptions,
): Promise<LoopBacktest | null> {
  if (options.skipBacktest) return null;
  if (options.backtest) return options.backtest(watch);
  if (options.ontologyIsCallers === true) return null;
  return backtestDefinition(watch, { universe: options.universe });
}

function errorsOf(diagnostics: readonly WatchDiagnostic[]): WatchDiagnostic[] {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return errors.length > 0 ? errors : [...diagnostics];
}

/**
 * What is worth saying about a reach report, or null when it looks healthy.
 *
 * Phrased as a concern rather than an instruction: the model is asked to
 * reconsider, not told what to change, because the report cannot distinguish "a
 * filter that is too loose" from "a request that really is about every email".
 */
export function reachConcern(
  watch: WatchDefinition,
  report: LoopBacktest,
  policy: ReachPolicy,
  request?: string,
): string | null {
  const perDay = (count: number) => (report.days > 0 ? count / report.days : count);

  // A watch that threw is not a watch that stayed quiet, and the difference is
  // invisible in the counts: both come back with nothing. The validator
  // deliberately does not catch this class — a column that does not exist
  // surfaces against the real engine, not against a schema — so the trace is
  // the only place it shows, and telling the model to check its filter would
  // send it after the wrong thing entirely.
  const failure = report.failure;
  if (failure) {
    return `This watch threw while replaying, at node '${failure.nodeId}'${failure.detail ? `: ${failure.detail}` : ""}. It validated, so this is something only running it can find — most often a SQL query naming a column that is not on the table it selects from, or an expression over a field the event does not carry.`;
  }

  // One ceiling, under one condition. What a watch reaches per day is the cost
  // of running it, and that reading survives a short window — a rate is a rate
  // however few days it was measured over. What does not survive is a rate
  // measured over a life that is finished: a `once_ever` watch that asked its
  // judge twice and fired on day two costs two model calls, ever, and one a day
  // is a projection of a watch that no longer exists. So a retirement is
  // excused only where the whole of what it cost is small enough not to be
  // worth a revision turn; past that the rate is read exactly as a live watch's
  // would be, because what it reached it really reached.
  const covered = coveredFraction(report);
  const reaches = perDay(report.totalReaches);
  const finished = report.endedEarly !== undefined;
  const wholeLifeWasCheap = finished && report.totalReaches <= policy.minRetiredReaches;
  if (!wholeLifeWasCheap && reaches > policy.maxReachesPerDay) {
    const advice =
      "That is what the judgement costs; consider whether more of the work can be done by the structural filter before the model is asked.";
    // Said as a total for a watch that is finished and as a rate for one that is
    // not, because that is what each number is. A running watch reaches what it
    // reaches per day and goes on doing so; a finished one spent what it spent,
    // and a per-day figure over the days it happened to live is a projection of
    // something that will not happen again.
    return finished
      ? `This reached a model ${report.totalReaches} times over the ${showDays(report.days)} days it ran before it ${report.endedEarly === "fired" ? "fired and retired" : "expired"}. ${advice}`
      : `This would reach a model ${report.totalReaches} times over ${showDays(report.days)} days (${reaches.toFixed(2)} per day). ${advice}`;
  }

  // The request's own cadence replaces the fixed cap rather than sitting beside
  // it. "This fired 13 times" is a number with no scale; the request is the only
  // thing that supplies one, and it moves the line in both directions — down for
  // a request that wants to hear rarely, up for one that asked about every
  // occurrence and should not be talked out of it.
  const band = request ? impliedCadence(request) : null;
  const cap = band?.firingsPerDay ?? policy.maxFiringsPerDay;
  // A watch that fired and retired has no firing *rate* at all. It fired the
  // once it was allowed to and stopped, and the span it consumed is however
  // long that took — so one firing on day two of a season reads as one every
  // two days, which trips any cadence a fire-once request implies. The watch
  // that behaved exactly as asked would be the one sent back to be changed.
  //
  // Only a watch that fired. A horizon passing leaves a denominator that owes
  // nothing to the firings — the watch really did run that whole window at that
  // rate — while a watch that stopped *because* it fired has a span that is an
  // artefact of the firing it is being divided by.
  if (report.endedEarly !== "fired" && perDay(report.firings) > cap) {
    return band
      ? cadenceMessage(band, report.firings, report.days)
      : `This fired ${report.firings} times over ${report.days} days (${perDay(report.firings).toFixed(2)} per day). A watch that fires that often is reporting a condition rather than an exception.`;
  }

  // A watch that stopped because it fired is not a watch that never fired,
  // whatever a policy asking for more than one firing makes of the count.
  const neverFired = report.endedEarly !== "fired" && report.firings < policy.minFirings;

  // A horizon reached inside the replay is a horizon in the past, and a watch
  // whose horizon is in the past retires on the first event it sees. Worth
  // saying whether or not a model decides the firing — a judge under a dead
  // horizon is never asked — and worth saying only while the horizon really did
  // take the watch's window away. One that passed a day before the end took
  // nothing, and naming it there sends the single revision turn at a date that
  // was right. The live replay ends at the present, which is what makes an
  // early end mean "already expired"; a universe replays a fixed stretch of
  // history, where a dated watch is expected to end inside it, and there
  // `covered` is 1 and this never fires.
  if (neverFired && report.endedEarly === "expired" && covered < policy.minWindowFraction) {
    return (
      `This watch reached its horizon ${showDays(report.days)} days into the ${showDays(report.daysRequested ?? report.days)} it was replayed over, and fired nothing before it did. The replay ends at the present, so a horizon inside it is a horizon already past: installed as written, this watch retires on the first event it sees. Check \`expires_at\` against the date the request is about.` +
      (asksAModel(watch)
        ? ""
        : " A filter that cannot match produces the same silence, so check the sources, the metadata paths and the key extractors against the ontology as well.")
    );
  }

  // Silence is only evidence on a watch with nothing gated behind a model, and
  // only over a window the replay could finish. Everything downstream of a judge
  // is held in a replay, so a judged watch firing nothing is the expected result
  // rather than a symptom — and telling it "this watch asks no model" would be a
  // false statement about its own plan, fed back as though it were
  // authoritative. A watch that ended inside the replay reaches here only when
  // it lived most of the window anyway: one whose horizon cut the window short
  // has already been told about the horizon.
  if (!asksAModel(watch) && neverFired && covered >= policy.minWindowFraction) {
    return `The procedural half fired ${report.firings} times over ${showDays(report.days)} days, and this watch asks no model, so that is the whole of it. A watch that never fires usually means a filter that cannot match — check the sources, the metadata paths and the key extractors against the ontology.`;
  }

  return null;
}

/**
 * The span, as a reader should see it.
 *
 * Exact in the report because every rate divides by it, and rounded here: a
 * live window bounded by a millisecond timestamp is a number with a dozen
 * decimal places, none of which mean anything to anyone reading a sentence.
 */
function showDays(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/**
 * How much of the span it asked for the replay reached, as a fraction.
 *
 * One where nothing was asked for: a universe replay covers the journal it has,
 * and there is no shortfall to read into its silence.
 */
function coveredFraction(report: LoopBacktest): number {
  if (report.daysRequested === undefined || report.daysRequested <= 0) return 1;
  return report.days / report.daysRequested;
}

/**
 * Whether any judgement sits in this watch, structurally.
 *
 * Read off the plan rather than off a reach count of zero: a judged watch whose
 * filter matches nothing also reaches nothing, and the two mean opposite things.
 */
function asksAModel(watch: WatchDefinition): boolean {
  return watch.nodes.some(
    (node) => node.type === "llm" || ("judge" in node && node.judge !== undefined),
  );
}
