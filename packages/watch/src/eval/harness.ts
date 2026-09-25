// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Measuring the compiler by sampling it.
 *
 * A single pass proves nothing. A near-miss compilation fails randomly per
 * attempt — the same request can validate on one try and miss a key extractor
 * on the next — so a run that compiled each request once would report a number
 * with no error bar and a lot of confidence. Every request is therefore
 * attempted several times and reported as a rate.
 *
 * Two sets, measuring different things. The **paired** set is each corpus
 * watch's own request, scored against what the hand-written watch does; the
 * reference is withheld from the prompt, so it measures reconstruction rather
 * than recall. The **unseen** set has no reference, and its point is the
 * requests that should be refused: this ontology cannot answer them, and a
 * compiler that answers anyway has written something the validator will accept
 * and that watches the wrong thing.
 *
 * The taxonomy separates *how* an attempt failed, because the classes mean
 * different things. A reply that would not parse is a plumbing problem. A watch
 * that never validated is the feedback loop failing to converge. A watch that
 * validated and behaves differently — or that was written at all when the
 * honest answer was "I can't" — is the class that matters, because nothing in
 * the system catches it.
 */

import { compile, type CompileResult } from "../compiler/compile.js";
import { examplesFor } from "../compiler/examples.js";
import { loadEvents } from "../compiler/events.js";
import { loadLoops } from "../compiler/loops.js";
import { loadOntology } from "../universe/paths.js";
import { UniverseDocumentFrequency } from "../universe/doc-frequency.js";
import { loadWatch } from "../runtime/run.js";
import { watchNames } from "../backtest/golden.js";
import { behaviourOf, compareBehaviour, type Behaviour } from "./score.js";
import { classifyDivergence, type DivergenceReading } from "./divergence.js";
import { latitudeFor } from "./free-parameters.js";
import { boundContent } from "./bound-parameters.js";
import { sharedStems } from "./named-in-request.js";
import type { WatchDefinition } from "../dsl/schema.js";
import type { Budget } from "./cost.js";
import type { ChatModel, ModelUsage } from "../compiler/model.js";
import type { UnseenPrompt } from "./prompts.js";

export const OUTCOME_CLASSES = [
  /** Compiled, validated, and behaves like its reference — or refused correctly. */
  "ok",
  /** No attempt produced a readable reply. */
  "parse_failure",
  /** Every attempt was rejected by the validator, repairs included. */
  "validator_rejected",
  /** Refused a request that has an answer. */
  "refused_wrongly",
  /**
   * Refused a request that has no answer — correctly — without saying what was
   * missing. A refusal nobody can act on is barely better than a wrong watch:
   * it ends the conversation instead of naming the gap.
   */
  "refused_vaguely",
  /**
   * Validated, and differing only for a reason the request accounts for.
   *
   * Two paths reach here and they mean different things. Either every parameter
   * the two disagree on is one the request left open and the compilation's
   * choice sits inside the range that reads it fairly; or the two differ in the
   * *shape* of an answer — an extra fact, a rounding, a key that separates
   * nothing — inside a latitude that request was found to grant. The report
   * counts the second separately, because it is the one that used to be
   * invisible.
   */
  "divergent_defensible",
  /**
   * Validated, and behaves differently in a way the request does not account
   * for — a value the request named, a parameter that is not there, or the
   * same numbers arranged into a different shape.
   */
  "structural_defect",
  /** Validated, for a request this ontology cannot answer. */
  "compiled_when_it_should_refuse",
  /** The attempt itself blew up — a transport failure, or a watch that hung. */
  "errored",
] as const;

export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * The classes where the validator was satisfied and the answer was wrong.
 *
 * Reported on its own line. Nothing downstream catches these: the watch
 * installs, runs, and quietly watches something else.
 */
export const WRONG_BUT_VALIDATES: readonly OutcomeClass[] = [
  "structural_defect",
  "compiled_when_it_should_refuse",
];

/**
 * The classes a run is judged on.
 *
 * `divergent_defensible` is deliberately absent: a compilation that read the
 * request correctly and chose differently where it was silent is not a defect,
 * and counting it as one is what made the first measured rate mean three things
 * at once. It is reported on its own line instead.
 */
export const DEFECT_CLASSES: readonly OutcomeClass[] = [
  "parse_failure",
  "validator_rejected",
  "refused_wrongly",
  "refused_vaguely",
  "structural_defect",
  "compiled_when_it_should_refuse",
  "errored",
];

/** Which prompt an attempt was compiled under, when a run measures both. */
/**
 * Which compiler an attempt was made by.
 *
 * `two-pass` is not a third prompt but a different shape of compilation: the
 * plan is written under the un-calibrated prompt and the checklist is put in a
 * turn of its own, over the plan the model has just written.
 */
export type PromptArm = "with-bounds" | "without-bounds" | "two-pass";

export interface SampleOutcome {
  readonly prompt: string;
  readonly sample: number;
  readonly outcome: OutcomeClass;
  readonly detail: string;
  readonly turns: number;
  readonly usage: ModelUsage;
  /**
   * The watch this attempt produced, when it produced one.
   *
   * Kept so a sweep can be scored again without being paid for again. A scorer
   * change is otherwise unauditable: the run that motivated it is gone, the
   * next run draws different answers from the model, and "the rate moved" is
   * indistinguishable from "the model had a better day". With the answers on
   * disk, the same attempts can be put through both rules and the difference
   * attributed to the rule.
   */
  readonly compiled?: WatchDefinition;
  /** Set only on a run that measured both prompts. */
  readonly arm?: PromptArm;
}

export interface EvalTask {
  readonly id: string;
  readonly query: string;
  /** Groups of alternatives a correct refusal must draw one word from each of. */
  readonly refusalMustMention?: readonly (readonly string[])[];
  /** Worked examples this request must not be shown. */
  readonly withholdExamples?: readonly string[];
  /** The corpus watch this request came from, withheld and compared against. */
  readonly reference: string | null;
  /** For a reference-less request, what the right answer is. */
  readonly expect: "compiles" | "refuses" | null;
  readonly because: string;
}

/** Every corpus watch's own request, each scored against itself. */
export function pairedTasks(universe?: string): EvalTask[] {
  return watchNames().map((name) => {
    const watch = loadWatch(name, universe);
    if (!watch.nl_query) {
      throw new Error(`'${name}' has no nl_query, so it cannot be a paired task`);
    }
    return {
      id: name,
      query: watch.nl_query,
      reference: name,
      expect: null,
      because: "the corpus answers this request, so a compilation should behave the same way",
    };
  });
}

export function unseenTasks(prompts: readonly UnseenPrompt[]): EvalTask[] {
  return prompts.map((p) => ({
    id: p.id,
    query: p.query,
    reference: null,
    expect: p.expect,
    because: p.because,
    ...(p.refusalMustMention ? { refusalMustMention: p.refusalMustMention } : {}),
    ...(p.withholdExamples ? { withholdExamples: p.withholdExamples } : {}),
  }));
}

/**
 * The groups a refusal drew no word from.
 *
 * Each group is a set of alternatives, so a reason may use whichever
 * vocabulary it likes — "response status", "RSVP", "what they answered" — and
 * still has to be about the right absence. Matching is case-insensitive
 * substring, which is loose on purpose: the check is that the refusal is about
 * the missing thing, not that it phrases it a particular way.
 */
export function unmentioned(
  reasons: string,
  required: readonly (readonly string[])[],
): (readonly string[])[] {
  const text = reasons.toLowerCase();
  return required.filter((group) => !group.some((word) => text.includes(word.toLowerCase())));
}

/**
 * What each referenced watch does, computed once.
 *
 * The reference side of a comparison does not change between samples, and
 * replaying seventeen watches five times over would be five times the work for
 * the same answer.
 */
async function referenceBehaviours(
  tasks: readonly EvalTask[],
  universe?: string,
): Promise<Map<string, Behaviour>> {
  const behaviours = new Map<string, Behaviour>();
  for (const task of tasks) {
    if (task.reference === null || behaviours.has(task.reference)) continue;
    behaviours.set(
      task.reference,
      await behaviourOf(loadWatch(task.reference, universe), {
        universe,
        reference: task.reference,
      }),
    );
  }
  return behaviours;
}

/**
 * Score attempts that were already paid for, under the scorer as it stands.
 *
 * Only the attempts that produced a watch are re-run through `classify`;
 * refusals, unparseable replies and errors have no compilation to score and are
 * carried through as they were. The classification is the same code path the
 * live run takes, deliberately — a rescore that used its own reimplementation
 * would be measuring the reimplementation.
 */
export async function rescore(
  tasks: readonly EvalTask[],
  outcomes: readonly SampleOutcome[],
  universe?: string,
  reading: ScoringReading = {},
): Promise<SampleOutcome[]> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const references = await referenceBehaviours(tasks, universe);
  const rescored: SampleOutcome[] = [];

  for (const outcome of outcomes) {
    const task = byId.get(outcome.prompt);
    if (!task || !outcome.compiled) {
      rescored.push(outcome);
      continue;
    }
    const { outcome: kind, detail } = await classify(
      task,
      {
        status: "compiled",
        watch: outcome.compiled,
        document: null,
        report: null,
        attempts: [],
        usage: outcome.usage,
      },
      references,
      universe,
      reading,
    );
    rescored.push({ ...outcome, outcome: kind, detail });
  }
  return rescored;
}

/**
 * Which allowances a scoring pass grants.
 *
 * Carried rather than fixed so one run of the scorer can be repeated under a
 * different allowance and the two rates compared. Anything published as "with
 * and without X" has to vary only in this, or it compares two scorers.
 */
export type ScoringReading = Omit<DivergenceReading, "universe">;

/** Classify one compilation against what the task expected. */
export async function classify(
  task: EvalTask,
  result: CompileResult,
  references: ReadonlyMap<string, Behaviour>,
  universe?: string,
  reading: ScoringReading = {},
): Promise<{ outcome: OutcomeClass; detail: string }> {
  if (result.status === "failed") {
    return result.reason === "unparseable"
      ? { outcome: "parse_failure", detail: "no readable reply after every repair" }
      : {
          outcome: "validator_rejected",
          detail: result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => d.code)
            .join(" "),
        };
  }

  if (result.status === "refused") {
    const reasons = result.reasons.join("; ");
    if (task.expect !== "refuses") return { outcome: "refused_wrongly", detail: reasons };

    // Refusing was right. Whether the refusal is worth anything depends on
    // whether it names the thing that is missing.
    const missing = unmentioned(reasons, task.refusalMustMention ?? []);
    return missing.length === 0
      ? { outcome: "ok", detail: reasons }
      : {
          outcome: "refused_vaguely",
          detail: `refused without naming ${missing.map((g) => g.join("/")).join(" and ")} — ${reasons}`,
        };
  }

  if (task.expect === "refuses") {
    return {
      outcome: "compiled_when_it_should_refuse",
      detail: `wrote '${result.watch.name}' for a request that has no answer here`,
    };
  }

  if (task.reference === null) return { outcome: "ok", detail: result.watch.name };

  const expected = references.get(task.reference);
  if (!expected) throw new Error(`no reference behaviour for '${task.reference}'`);
  const actual = await behaviourOf(result.watch, { universe, reference: task.reference });
  const verdict = compareBehaviour(expected, actual, { reference: task.reference });

  // The subject is checked before the behaviour, because the behaviour cannot
  // see it: the replay passes every document to recall, so a watch searching
  // for the wrong thing puts the same documents in front of a judge and
  // replays identically to one searching for the right thing.
  const offSubject = subjectsNotInRequest(result.watch, task.query);
  if (offSubject.length > 0) {
    return {
      outcome: "structural_defect",
      detail: `matches on a subject the request does not name: ${offSubject.join("; ")}`,
    };
  }

  if (verdict.equivalent && verdict.used.length === 0) {
    return {
      outcome: "ok",
      detail: `${actual.firings.length} firings, ${actual.totalReaches} reaches`,
    };
  }

  // Equivalent, but only once the reference's request was read as leaving
  // something open. That is a weaker answer than an exact match and says so:
  // it is reported as a divergence, naming the latitude it rested on and the
  // request's own words for why the request leaves it open. Folding it into
  // `ok` is what made the subsidy uncountable.
  if (verdict.equivalent) {
    const because = verdict.used
      .map((rule) => `${rule} — ${latitudeFor(task.reference!, rule)?.because ?? ""}`)
      .join("; ");
    return {
      outcome: "divergent_defensible",
      detail: `differs only inside declared latitude: ${because}`,
    };
  }

  // They behave differently. Whether that is a misreading or a judgement call
  // depends on which parameters they disagree on and what the request said
  // about them.
  const reference = loadWatch(task.reference, universe);
  const divergence = await classifyDivergence(task.reference, reference, result.watch, {
    universe,
    ...reading,
  });
  return divergence.kind === "defensible"
    ? {
        outcome: "divergent_defensible",
        detail: `${verdict.difference ?? ""} — ${divergence.detail}`,
      }
    : {
        outcome: "structural_defect",
        detail: `${verdict.difference ?? ""} — ${divergence.detail}`,
      };
}

export interface RunOptions {
  readonly samples: number;
  readonly universe?: string;
  readonly concurrency?: number;
  /** Called as each sample lands, so a long run says what it is doing. */
  readonly onSample?: (outcome: SampleOutcome) => void;
  /**
   * Prompts to measure. Omitted, the run uses the prompt as it stands.
   *
   * Given both, every request is compiled under each in one interleaved queue —
   * same provider, same cache, same hour — so the difference between them is
   * the prompt rather than the conditions.
   */
  readonly arms?: readonly PromptArm[];
}

/**
 * Run every task `samples` times.
 *
 * The budget is checked before each attempt rather than after, so a run stops
 * as soon as the estimate reaches the ceiling. It is a stopping rule, not a
 * hard cap: a compilation already in flight finishes, and there are as many in
 * flight as the concurrency allows, so the real overshoot is the ceiling plus
 * roughly one round of attempts.
 *
 * When it stops, what has already landed is returned. A partial measurement is
 * still a measurement, and throwing away an hour of samples to report a clean
 * failure helps nobody — which is also why a failing attempt is recorded as one
 * rather than thrown.
 */
/** One unit of work: a request, which sample of it, and under which prompt. */
export interface WorkItem {
  readonly task: EvalTask;
  readonly sample: number;
  readonly arm?: PromptArm;
}

/**
 * Every attempt a run will make, in the order it will make them.
 *
 * The arms sit adjacent rather than blocked. Interleaving in a single queue
 * rather than running two sweeps is what makes the comparison fair — both
 * prompts meet the same provider, the same cache and the same hour — and
 * adjacency is what makes it survive an early stop: a queue that ran one arm to
 * completion before starting the other would end, when the budget trips, with
 * two rates over different denominators and nothing saying so.
 */
export function workQueue(
  tasks: readonly EvalTask[],
  samples: number,
  arms?: readonly PromptArm[],
): WorkItem[] {
  const under: readonly (PromptArm | undefined)[] = arms ?? [undefined];
  return tasks.flatMap((task) =>
    Array.from({ length: samples }, (_, sample) => sample).flatMap((sample) =>
      under.map((arm) => ({ task, sample, ...(arm === undefined ? {} : { arm }) })),
    ),
  );
}

export async function runEvaluation(
  tasks: readonly EvalTask[],
  model: ChatModel,
  budget: Budget,
  options: RunOptions,
): Promise<{ outcomes: SampleOutcome[]; stopped: string | null }> {
  const ontology = loadOntology(options.universe);
  const loops = loadLoops(options.universe);
  // Without this a compilation cannot resolve a request that points at a dated
  // occasion, and the measurement would be of a compiler denied the substrate
  // the reference was written against.
  const events = loadEvents(options.universe);
  const references = await referenceBehaviours(tasks, options.universe);
  const docFrequency = new UniverseDocumentFrequency(options.universe);
  const outcomes: SampleOutcome[] = [];
  let stopped: string | null = null;

  const work = workQueue(tasks, options.samples, options.arms);

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = work[index];
      if (item === undefined || stopped !== null) return;

      try {
        budget.check();
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        return;
      }

      const context = {
        ontology,
        loops,
        events,
        // Without this the distinctiveness rule never runs during a real
        // compilation: `compile` forwards `context.docFrequency` faithfully and
        // it was always undefined, so a flood-prone lexical term would have
        // validated clean in the one place the measurement looks.
        docFrequency,
        // The two-pass arm writes its plan without the checklist and meets it
        // on the second turn, so its first prompt is the control's prompt.
        ...(item.arm === undefined ? {} : { operationalBounds: item.arm === "with-bounds" }),
        // A paired request must never be shown its own answer, and an unseen
        // one must not be shown an example that names the absence it turns on.
        examples: examplesFor(
          [
            ...(item.task.reference ? [item.task.reference] : []),
            ...(item.task.withholdExamples ?? []),
          ],
          options.universe,
        ),
      };

      // Contained per attempt. A five-hundred from the provider, a socket
      // reset, a model-authored watch whose replay throws — any of those
      // escaping here would reject the `Promise.all` below, discard every
      // sample already collected, and leave the other workers running against
      // a paid API after the report had printed.
      let landed: SampleOutcome;
      try {
        const result = await compile(item.task.query, context, model, {
          universe: options.universe,
          ...(item.arm === "two-pass" ? { boundsPass: true } : {}),
        });
        budget.add(result.usage);
        const { outcome, detail } = await classify(item.task, result, references, options.universe);
        landed = {
          prompt: item.task.id,
          sample: item.sample,
          outcome,
          detail,
          turns: result.attempts.length,
          usage: result.usage,
          ...(item.arm === undefined ? {} : { arm: item.arm }),
          ...(result.status === "compiled" ? { compiled: result.watch } : {}),
        };
      } catch (error) {
        landed = {
          prompt: item.task.id,
          sample: item.sample,
          outcome: "errored",
          detail: error instanceof Error ? error.message : String(error),
          ...(item.arm === undefined ? {} : { arm: item.arm }),
          turns: 0,
          usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
        };
      }
      outcomes.push(landed);
      options.onSample?.(landed);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, () => worker()));
  return { outcomes, stopped };
}

/**
 * Matched subjects that share nothing with the request.
 *
 * The same rule the corpus's own references are held to, turned around: a
 * reference may not match on a subject its request never names, and neither may
 * a compilation. It is checked textually because it cannot be checked any other
 * way — the replay passes every document to recall, so a recall query is dead
 * text to the behaviour and a watch searching for pizza replays exactly like
 * one searching for a house move.
 *
 * The bar is one shared stem, which is the bar the references meet. It asks
 * that the subject be the one that was asked for, not that it be worded the
 * same way.
 */
function subjectsNotInRequest(watch: WatchDefinition, request: string): string[] {
  return boundContent(watch)
    .filter((content) => sharedStems(content.text, request).length === 0)
    .map((content) => `${content.at} "${content.text.slice(0, 50)}"`);
}
