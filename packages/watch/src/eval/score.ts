// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scoring a compilation by what it would have done, not by how it reads.
 *
 * Two watches that select the same moments out of the same journal are the
 * same watch, whatever they called their nodes. That is the only comparison
 * worth making here: a compiler is not being asked to reproduce a file, and
 * grading it on node names or on JSON shape would reward imitation and punish
 * a correct plan expressed differently.
 *
 * So both sides are replayed and compared on their **behaviour**:
 *
 * - the sink firings, as `(sequence, instant, key values)`
 * - the sequences at which a model was reached
 *
 * The second matters as much as the first. In a replay every LLM node is a
 * counter that never fires, so a judged watch fires nothing at all and its
 * firing list is empty on both sides — a comparison that would pass for any
 * two judged watches whatsoever. What distinguishes them is *which events they
 * put in front of a model*, which is exactly what the procedural half decides
 * and exactly what the compiler is being scored on.
 *
 * What this cannot see is the recall query. Recall passes every document, as a
 * backtest's does, so two watches searching for different subjects put the same
 * documents in front of a judge and replay identically. A lexical stand-in was
 * tried and is worse than nothing: a document's title is all the journal
 * carries, and matching topical queries against titles drops three of the
 * corpus's references to zero reaches, which is a different measurement rather
 * than a sharper one. The matched subject is checked against the request in
 * `harness.ts` instead, where it can be compared to the words that were asked.
 *
 * Key **values** are compared, not key names. `{thread_id: "T1"}` and
 * `{thread: "T1"}` route identically — they separate the same instances — and
 * a scorer that failed on the difference would be measuring vocabulary.
 *
 * The sink's **payload** is compared too, on the same principle, and in the
 * same terms. A firing is what the person is handed, not only the moment it
 * arrived: a watch that fires on every right occasion and reports the wrong
 * document is not the watch that was asked for.
 *
 * What is compared is the set of **values**, not the field names. No request
 * names its payload's field names, so asking a compilation to guess `last_call`
 * rather than `last_contact` would be an answer key marking on information it
 * never supplied. And values only where they are identifier-shaped: titles and
 * summaries come out of documents, and two correct watches will word them
 * differently.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readJournal } from "../journal/read.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, journalPath, loadOntology, universeDir } from "../universe/paths.js";
import { WatchEngine } from "../runtime/engine.js";
import {
  ScriptedRecall,
  type JudgeProvider,
  type JudgeRequest,
  type JudgeVerdict,
} from "../runtime/providers.js";
import { latitudesOf, type Latitude, type LatitudeRule } from "./free-parameters.js";
import type { WatchDefinition } from "../dsl/schema.js";
import type { WatchTrace } from "../runtime/trace.js";

/**
 * A judge that agrees with everything, and counts.
 *
 * The backtest's judge never fires, which is right for costing a watch and
 * wrong for comparing two. Everything below a judgement is gated on it, so two
 * watches that differ only beneath one — a missing cancel, a different wait, a
 * key that separates nothing — replay identically and the comparison passes.
 * Verified: removing the cancel from the corpus's email watch leaves a
 * never-firing replay byte-identical to the original.
 *
 * Agreeing with everything makes the whole graph observable instead. It is not
 * a claim about what a model would say; it is a probe, applied to both sides,
 * that turns the procedural skeleton into something a trace can show. The
 * structured output is empty, so a downstream reference to a judged field
 * resolves to nothing — on both sides equally.
 */
class AgreeableJudge implements JudgeProvider {
  private reached = 0;
  private readonly schemas: ReadonlyMap<string, Readonly<Record<string, string>>>;
  private readonly scripted: ProbeOutputs;

  private readonly selective: boolean;
  /**
   * The answer key this replay is being read against.
   *
   * The *reference's* name, never the replayed watch's own. A compilation
   * chooses its own name and none of the recorded ones chose the reference's,
   * so scoping on `request.watch` hands every compilation an empty answer key
   * and grades it on what it called itself — the defect this scorer exists to
   * remove, reintroduced by the field that fixes a different one.
   */
  private readonly reference: string | undefined;

  constructor(watch: WatchDefinition, scripted: ProbeOutputs, reference?: string) {
    this.scripted = scripted;
    this.reference = reference;
    this.selective = reference !== undefined && scripted.selective.has(reference);
    this.schemas = new Map(
      watch.nodes.flatMap((node) => {
        if (node.type === "llm") return [[node.id, node.output_schema] as const];
        if ("judge" in node && node.judge) {
          return [[node.id, node.judge.output_schema] as const];
        }
        return [];
      }),
    );
  }

  judge(request: JudgeRequest): JudgeVerdict {
    this.reached += 1;
    const shape = stubFor(this.schemas.get(request.nodeId));

    // A scripted verdict where one is declared, keyed by document rather than
    // by node so a compilation that named its nodes differently is handed
    // exactly what the reference was.
    // Scoped to the watch that scripted it. The table is one file for the whole
    // corpus, so without this a document named for the travel watch nominates
    // documents for the invoice watch as readily as its own.
    const asked = request.proposition.toLowerCase();
    const verdict = request.documentIds
      .filter((id) => {
        // Scoped to the answer key this replay is read against. A caller that
        // names no reference is replaying a watch on its own terms — every such
        // caller in the package is replaying a corpus reference — so its own
        // name is the scope. What must never be the scope when an answer key
        // *is* named is the replayed watch's name: a compilation chooses that,
        // and none of the recorded ones chose the reference's.
        const scope = this.reference ?? request.watch;
        const owner = this.scripted.owners.get(id);
        return owner === undefined || owner === scope;
      })
      .map((id) => this.scripted.documents.get(id))
      .find(
        (entry) =>
          entry !== undefined &&
          (entry.answers.length === 0 || entry.answers.some((word) => asked.includes(word))),
      );
    if (verdict) return { fired: verdict.fired, output: { ...shape, ...verdict.output } };

    // No verdict applies — either the document is unnamed, or it is named for
    // another question than the one being asked. On a watch that names its own
    // matches that is a decline; elsewhere the judge agrees, which is what makes
    // an unscripted watch's structure observable at all.
    return { fired: !this.selective, output: shape };
  }

  get total(): number {
    return this.reached;
  }
}

/**
 * A structured output shaped like the one that was asked for.
 *
 * An empty object is not a neutral answer. A judgement whose `fire_when` reads
 * its own verdict never fires with one, so the node holds and then expires —
 * and three of the corpus judgements do exactly that. Worse, a downstream
 * expression over a judged field then computes on null: the travel watch's
 * date arithmetic throws, the watch pauses, and the rest of the journal is
 * never replayed at all. Both make the reference an artifact of the probe.
 *
 * So the stub is built from the node's own declared schema: the affirmative
 * value of each declared type, and the first member of an enum. It is not a
 * claim about what a model would say — it is the shape the plan promised,
 * given identically to both sides.
 */
function stubFor(schema: Readonly<Record<string, string>> | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(schema ?? {})) {
    output[field] = stubValue(type);
  }
  return output;
}

function stubValue(type: string): unknown {
  const enumMembers = /^enum\[(.*)\]$/.exec(type);
  if (enumMembers) return enumMembers[1]!.split(",")[0]!.trim();
  if (type.startsWith("list<")) return [];
  switch (type) {
    case "bool":
      return true;
    case "number":
      return 1;
    case "date":
      return "2026-03-01";
    case "timestamp":
      return "2026-03-01T00:00:00.000Z";
    default:
      return "stub";
  }
}

/**
 * One sink firing: when it happened, for whom, and what it handed back.
 *
 * Split rather than joined into one string because the two halves are compared
 * differently. `at` has to match exactly — a firing on another day, or for
 * another instance, is a different firing. `reported` only has to be *covered*:
 * see `compareBehaviour`.
 */
interface Firing {
  /** `seq:<n>` or `day:<date>` — when it fired. */
  readonly moment: string;
  /** The key values that routed it, sorted. */
  readonly key: string;
  /** What it handed back, with enough provenance to compare it strictly. */
  readonly reported: readonly ReportedValue[];
}

/**
 * One value a firing handed back, and where it came from.
 *
 * The provenance travels with the value because the comparison needs it twice
 * over: once strictly, ignoring nothing, and once applying exactly the
 * leniencies this watch's request was found to grant. Filtering at extraction
 * time makes the strict reading unavailable, and with it any way to count what
 * the leniencies were worth.
 */
interface ReportedValue {
  /** The value as it stands, at full precision. */
  readonly exact: string;
  /** Its numeric value, when it is a number, so a tolerance can read it. */
  readonly numeric: number | null;
  /** Whether it is one of the watch's own node ids — i.e. `$fired_by`. */
  readonly isNodeName: boolean;
  /** Whether its field was written into the plan as a literal. */
  readonly isConstant: boolean;
}

/** How a firing reads in a message. */
function describeFiring(firing: Firing): string {
  return `${firing.moment}#${firing.key}`;
}

/** What a watch did, in terms that survive a rename. */
export interface Behaviour {
  /** One entry per sink firing. */
  readonly firings: readonly Firing[];
  /** Journal sequences at which some model was reached. Timers excluded. */
  readonly reaches: readonly number[];
  /** Every reach, timer-driven ones included. */
  readonly totalReaches: number;
  /**
   * The journal sequence a failure stopped the replay at, or null.
   *
   * A watch that throws pauses, and everything after that point simply did not
   * happen — so a truncated replay compared as though it were complete says a
   * watch did less rather than that it broke. Recording where it stopped makes
   * the two different: a compilation that dies at the fourteenth event of a
   * journal with a thousand more to come is not a quiet watch, and is never
   * equivalent to one that ran to the end.
   *
   * The validator does not catch this class by design — a query naming a column
   * that is not there surfaces against the engine, not against a schema — so
   * the trace is the only place it shows.
   */
  readonly crashedAt: number | null;
}

/**
 * When a firing happened, in terms two watches can be compared on.
 *
 * A firing caused by a journal event *is* that event, so its sequence is the
 * whole identity — same sequence, same cause. A firing caused by a timer has no
 * such anchor: its sequence is allocated in the order timers came due, so two
 * watches that arm different numbers of timers number the same moment
 * differently. What is comparable there is the day, and only the day: the hour
 * a daily tick runs at is a free choice the request does not constrain, and
 * failing a compilation for picking 08:00 over 09:00 would be grading taste.
 * A day late is still a different watch, and still caught.
 */
function momentOf(seq: number, firedAt: string): string {
  return seq > 0 ? `seq:${seq}` : `day:${firedAt.slice(0, 10)}`;
}

/**
 * The key values a firing carried, names discarded and order fixed.
 *
 * A firing records only the sink's payload, so the key comes from a node
 * transition at the same sequence — and it has to be the *right* one. A source
 * node records its own fire before propagating, always as a singleton, so
 * taking the first record at that sequence returns the trip-wire rather than
 * the instance. Every event-driven firing in the corpus renders `singleton`
 * that way, and a watch keyed on nothing scores identical to one keyed per
 * thread. The sink names the node whose firing *is* the watch's; that is the
 * one to read.
 *
 * Values rather than names: `{thread_id: "T1"}` and `{thread: "T1"}` separate
 * the same instances, and failing on the difference would measure vocabulary.
 * They are sorted for the same reason — the order components were written in
 * is not part of the routing.
 */
function keyValuesAt(trace: WatchTrace, seq: number, sinkInput: string): string {
  const record = trace.records.find(
    (r) => r.seq === seq && r.transition === "fired" && r.nodeId === sinkInput,
  );
  if (!record || record.key === "singleton") return "singleton";
  return record.key
    .split(",")
    .map((component) => component.slice(component.indexOf("=") + 1))
    .sort()
    .join("|");
}

/**
 * Replay a watch and reduce it to what it did.
 *
 * The recall pass passes everything, as a backtest's does: it is a
 * per-document score the compiler does not control, and holding it constant
 * keeps the comparison about the structural filter.
 */
export async function behaviourOf(
  watch: WatchDefinition,
  options: { readonly universe?: string; readonly reference?: string } = {},
): Promise<Behaviour> {
  const ontology = loadOntology(options.universe);
  const analytics = await AnalyticsDatabase.materialize(
    ontology,
    analyticsDir(options.universe),
    "projections",
  );
  // The reference's name selects the probe's treatment, and both sides of a
  // comparison get the same one — a compilation is replayed under exactly the
  // judge its reference was.
  const judge = new AgreeableJudge(watch, loadProbeOutputs(options.universe), options.reference);

  let trace: WatchTrace;
  try {
    trace = await new WatchEngine({
      watch,
      ontology,
      journal: readJournal(journalPath(options.universe)),
      analytics,
      judge,
      recall: new ScriptedRecall([], 1),
    }).run();
  } finally {
    analytics.close();
  }

  // Which events a model saw, taken from the nodes that ask one. Every
  // evaluation leaves exactly one record on such a node — it fired or it held —
  // so the sequences and the counter agree, which `score.test.ts` pins.
  const judged = new Set(
    watch.nodes
      .filter((node) => node.type === "llm" || ("judge" in node && node.judge))
      .map((node) => node.id),
  );
  const evaluations = trace.records.filter(
    (r) => judged.has(r.nodeId) && (r.transition === "fired" || r.transition === "held"),
  );

  // Every name this watch chose for itself. A payload field mapped from
  // `$fired_by` resolves to the id of the node that fired, so the reference
  // hands back a string no compilation could produce whatever its plan is —
  // the same defect as grading field names, one level down.
  const vocabulary = new Set(watch.nodes.map((node) => node.id));

  // Payload fields whose value is written into the plan rather than computed
  // from it. A constant is not an observation: a watch that lists every month
  // it could ever mean, on every firing, reports the right one every time
  // without ever working out which — and under a comparison that asks only
  // whether the reference's values are covered, that would score perfect. So
  // constants count for neither side.
  const constants = new Set(
    Object.entries(watch.sink.output_map ?? {})
      .filter(([, expression]) => isConstant(expression))
      .map(([field]) => field),
  );

  const failure = trace.records.find((record) => record.transition === "failed");
  return {
    crashedAt: failure ? failure.seq : null,
    firings: trace.firings.map((f) => ({
      moment: momentOf(f.seq, f.firedAt),
      key: keyValuesAt(trace, f.seq, watch.sink.input),
      reported: reportedBy(f.payload, vocabulary, constants),
    })),
    // Only the event-driven ones are listed. A timer-driven evaluation has no
    // comparable sequence and no instant recorded against it, so it is counted
    // rather than named — which still catches a watch that judges twice as
    // often, just not which tick it judged on.
    reaches: evaluations
      .map((r) => r.seq)
      .filter((seq) => seq > 0)
      .sort((a, b) => a - b),
    totalReaches: judge.total,
  };
}

export interface BehaviourVerdict {
  readonly equivalent: boolean;
  /** Why not, in one line, when it is not. */
  readonly difference: string | null;
  /**
   * The reference's declared latitudes this equivalence rested on.
   *
   * Empty means the two behaved identically on every axis, read strictly — that
   * is the one reading it is exact about, and the one the counting turns on. A
   * non-empty list means they differed and the difference sat inside something
   * this watch's request was found to leave open, which is a real answer and a
   * weaker one.
   *
   * The membership is indicative, not exact. Rules are tested by withdrawing
   * one at a time, which cannot separate two that are only load-bearing
   * together: those are reported whole when nothing else is necessary, and
   * omitted when something else is. What is exact is whether the list is empty.
   */
  readonly used: readonly LatitudeRule[];
}

/**
 * How to read a comparison.
 *
 * `strict` allows nothing that is declared: exact numbers, keys as written,
 * payload values as they stand including a node's own name. It is not literally
 * everything — constants are dropped under every reading, and prose is compared
 * only as prose — but those are properties of what can be compared at all
 * rather than allowances a request grants. `granted` is the subset of leniencies
 * the reference's request was found to allow, declared in `free-parameters.ts`.
 */
interface Reading {
  readonly granted: readonly Latitude[];
}

const STRICT: Reading = { granted: [] };

/**
 * Do two watches select the same moments out of the same journal?
 *
 * Compared strictly first. Only if that fails are the reference's declared
 * latitudes applied, and the verdict then carries which of them the answer
 * rested on — indicatively, since withdrawing one rule at a time cannot
 * separate two that are only load-bearing together. What it is exact about is
 * the distinction that gets counted: an empty list means the strict reading
 * passed. Nothing is lenient by default — a caller that names no watch gets the
 * strict reading.
 */
export function compareBehaviour(
  expected: Behaviour,
  actual: Behaviour,
  options: { readonly reference?: string } = {},
): BehaviourVerdict {
  const strict = readBehaviour(expected, actual, STRICT);
  if (strict.equivalent) return { ...strict, used: [] };

  const granted = options.reference ? latitudesOf(options.reference) : [];
  if (granted.length === 0) return { ...strict, used: [] };

  const lenient = readBehaviour(expected, actual, { granted });
  if (!lenient.equivalent) return { ...lenient, used: [] };

  // Which of them the answer actually needed. Withdraw one at a time and see
  // whether the equivalence survives; the ones it does not survive are the ones
  // doing the work. Reporting the whole grant would overstate the subsidy on
  // every attempt that happened to rely on one of three.
  const needed = granted
    .filter(
      (latitude) =>
        !readBehaviour(expected, actual, {
          granted: granted.filter((other) => other.rule !== latitude.rule),
        }).equivalent,
    )
    .map((latitude) => latitude.rule);

  // Withdrawing one rule at a time cannot separate two that are only necessary
  // together: each is individually removable, so neither is reported, and an
  // empty list is the sentinel for "matched with nothing allowed". That would
  // count a subsidised attempt as an exact one — the overstatement this whole
  // reading exists to remove. When the strict pass failed, the answer rested on
  // something, so the grant is reported whole rather than not at all.
  return { ...lenient, used: needed.length > 0 ? needed : granted.map((l) => l.rule) };
}

function readBehaviour(
  expected: Behaviour,
  actual: Behaviour,
  reading: Reading,
): { equivalent: boolean; difference: string | null } {
  if (expected.crashedAt !== actual.crashedAt) {
    return { equivalent: false, difference: describeCrash(expected.crashedAt, actual.crashedAt) };
  }

  const firings = compareFirings(expected.firings, actual.firings, reading);
  if (firings) return { equivalent: false, difference: firings };

  const reaches = compareLists(
    "model reaches",
    expected.reaches.map(String),
    actual.reaches.map(String),
  );
  if (reaches) return { equivalent: false, difference: reaches };

  if (expected.totalReaches !== actual.totalReaches) {
    return {
      equivalent: false,
      difference: `model reaches: expected ${expected.totalReaches} in total, got ${actual.totalReaches}`,
    };
  }

  return { equivalent: true, difference: null };
}

/**
 * Same firings, read as the reading says to read them.
 *
 * The moment always has to match exactly. The instance key matches exactly too,
 * unless the reference's request was found to name no instance dimension — then
 * it is read as the partition it induces, because a key with one value
 * throughout separates nothing whatever it is spelled.
 *
 * What a firing *says* is compared as a set, and equally in both directions
 * unless `extra-facts` is granted; where it is, the reference's values only have
 * to be *covered*, and anything further the compilation adds is not held against
 * it. That grant exists because no request in this corpus enumerates its
 * payload — a watch reporting the last contact *and* which channel it came by
 * has not misread "tell me if that rhythm stops". What either direction still
 * catches is the case that matters: report the wrong thread, the wrong person or
 * the wrong month and the reference's own identifier is missing.
 */
function compareFirings(
  expected: readonly Firing[],
  actual: readonly Firing[],
  reading: Reading,
): string | null {
  const mine = ordered(expected);
  const theirs = ordered(actual);
  if (mine.length !== theirs.length) {
    return `firings: expected ${mine.length}, got ${theirs.length}`;
  }

  const asPartition = granted(reading, "key-vocabulary") !== null;
  const myGroups = partitionOf(mine);
  const theirGroups = partitionOf(theirs);

  for (let i = 0; i < mine.length; i += 1) {
    if (mine[i]!.moment !== theirs[i]!.moment) {
      return `firings: expected ${describeFiring(mine[i]!)}, got ${describeFiring(theirs[i]!)}`;
    }
    // A key is read as the partition it induces only where the request was
    // found to name no instance dimension. Where it does name one — "for the
    // same job", "in the current calendar month" — the key is what carries it,
    // and the values themselves are the answer.
    if (!asPartition && mine[i]!.key !== theirs[i]!.key) {
      return `firings: at ${mine[i]!.moment} the reference keyed on ${mine[i]!.key}, this one on ${theirs[i]!.key}`;
    }
    if (myGroups[i] !== theirGroups[i]) {
      return (
        `firings: at ${mine[i]!.moment} the reference groups this with firing ` +
        `${myGroups[i]} and this one with ${theirGroups[i]} — the keys separate different things`
      );
    }
  }

  // Payloads are matched within a moment rather than paired off by position.
  // Several instances can fire at one instant — five do, on the corpus's
  // busiest request — and there is nothing to sort them by that both sides
  // agree on: the key is spelled differently by design, and sorting on it pairs
  // the reference's first firing with whichever of the compilation's happens to
  // sort first. That reads as a wrong payload when the two are simply in a
  // different order.
  const extraFacts = granted(reading, "extra-facts") !== null;
  for (const [moment, ours] of byMoment(mine)) {
    const available = [...(byMoment(theirs).get(moment) ?? [])];
    for (const firing of ours) {
      const required = valuesOf(firing.reported, reading);
      const match = available.findIndex((candidate) =>
        extraFacts
          ? covers(valuesOf(candidate.reported, reading), required)
          : sameValues(valuesOf(candidate.reported, reading), required),
      );
      if (match < 0) {
        return (
          `firings: at ${moment} the reference reported ${required.join(", ") || "nothing"}, ` +
          `which no firing of this one ${extraFacts ? "covers" : "matches"} (they reported ` +
          `${available.map((c) => valuesOf(c.reported, reading).join(", ") || "nothing").join(" / ")})`
        );
      }
      available.splice(match, 1);
    }
  }
  return null;
}

/** Whether one firing hands back everything another did. */
function covers(reported: readonly string[], required: readonly string[]): boolean {
  const has = new Set(reported);
  return required.every((value) => has.has(value));
}

/** Whether two firings hand back the same things, no more and no fewer. */
function sameValues(reported: readonly string[], required: readonly string[]): boolean {
  return reported.length === required.length && covers(reported, required);
}

/** The latitude of this rule the reading grants, or null. */
function granted(reading: Reading, rule: LatitudeRule): Latitude | null {
  return reading.granted.find((latitude) => latitude.rule === rule) ?? null;
}

/**
 * A firing's values, read as the reading says to read them.
 *
 * Constants are dropped whatever the reading, and on both sides. That is not a
 * latitude granted to a reference — no corpus reference writes one — but a
 * restriction on a compilation: a watch that lists every month it could ever
 * mean, on every firing, reports the right one every time without ever working
 * out which, and covering alone would score that perfect.
 */
function valuesOf(reported: readonly ReportedValue[], reading: Reading): string[] {
  const names = granted(reading, "node-names") !== null;
  const precision = granted(reading, "numeric-precision");
  return reported
    .filter((value) => !value.isConstant)
    .filter((value) => !(names && value.isNodeName))
    .map((value) =>
      precision && value.numeric !== null
        ? atPlaces(value.numeric, precision.places ?? 1)
        : value.exact,
    )
    .sort();
}

function atPlaces(value: number, places: number): string {
  const scale = 10 ** places;
  return (Math.round(value * scale) / scale).toString();
}

function byMoment(firings: readonly Firing[]): Map<string, Firing[]> {
  const grouped = new Map<string, Firing[]>();
  for (const firing of firings) {
    grouped.set(firing.moment, [...(grouped.get(firing.moment) ?? []), firing]);
  }
  return grouped;
}

/**
 * Firings in a canonical order: by moment, and otherwise as the engine emitted
 * them.
 *
 * The tie-break is deliberately absent. Sorting same-moment firings on their key
 * would order each side by its own vocabulary, and the comparator has to be
 * consistent — returning a non-zero value for two firings that compare equal is
 * undefined behaviour in a sort, and makes the verdict depend on the order the
 * trace happened to append them in.
 */
function ordered(firings: readonly Firing[]): Firing[] {
  return [...firings].sort((a, b) => (a.moment < b.moment ? -1 : a.moment > b.moment ? 1 : 0));
}

/**
 * Which firings a watch's keys put together, as group numbers.
 *
 * A key is compared as a partition rather than as a string, because separating
 * instances is the whole of what a key does. A watch scoped to one person by
 * its filter and then keyed on that person has a key with one value throughout:
 * it separates nothing, and behaves exactly like the same watch with no key at
 * all. Grading `singleton` against that person's id would fail a compilation
 * for declining to write a key that does nothing — which is the request's
 * vocabulary again, in the one place the scorer is supposed to be reading
 * structure.
 *
 * What survives is the structure that matters: a watch holding one instance per
 * thread groups its firings differently from one holding a single instance, and
 * that shows here whatever either called its key.
 */
function partitionOf(firings: readonly Firing[]): number[] {
  const groups = new Map<string, number>();
  return firings.map((firing) => {
    const seen = groups.get(firing.key);
    if (seen !== undefined) return seen;
    groups.set(firing.key, groups.size);
    return groups.size - 1;
  });
}

function compareLists(
  what: string,
  expected: readonly string[],
  actual: readonly string[],
): string | null {
  const a = [...expected].sort();
  const b = [...actual].sort();
  if (a.length !== b.length) return `${what}: expected ${a.length}, got ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return `${what}: expected ${a[i]}, got ${b[i]}`;
  }
  return null;
}

/**
 * A firing's payload, reduced to what two watches can be compared on.
 *
 * The values, sorted, with the field names discarded — a compilation chooses
 * those itself and no request names them. Identifier-shaped values are compared
 * as themselves; prose is compared only as prose, because a title drawn from a
 * document is transcription rather than a decision. What survives is whether
 * the watch handed back the right thread, the right month, the right person,
 * and the right number of things.
 *
 * A value that is one of the watch's own node ids is dropped. `$fired_by`
 * resolves to the name of the node that fired, so a reference using it reports
 * a string that belongs to its own vocabulary — `alice_email_decline` — and no
 * compilation can produce it however correctly it read the request. Comparing
 * it is grading node names through the payload, which is the one thing this
 * scorer sets out not to do.
 */
function reportedBy(
  payload: Readonly<Record<string, unknown>>,
  vocabulary: ReadonlySet<string>,
  constants: ReadonlySet<string>,
): ReportedValue[] {
  return Object.entries(payload)
    .map(([field, value]) => ({
      exact: comparableValue(value),
      numeric: typeof value === "number" ? value : null,
      isNodeName: vocabulary.has(comparableValue(value)),
      isConstant: constants.has(field),
    }))
    .sort((a, b) => (a.exact < b.exact ? -1 : a.exact > b.exact ? 1 : 0));
}

/** A sink expression that is a literal: a quoted string, a number, or a boolean. */
function isConstant(expression: string): boolean {
  return /^\s*('[^']*'|-?\d+(\.\d+)?|true|false|null)\s*$/i.test(expression);
}

/**
 * Identifier-shaped values are compared; prose is compared only by its type.
 *
 * Numbers are compared to one decimal place. A reference reporting
 * `round(avg(rhr), 1)` and a compilation reporting the same average unrounded
 * are reporting one fact, and the request said nothing about how to present it
 * — 72.7 against 72.71428571428571 is grading formatting.
 *
 * A fixed place rather than a count of significant figures, so the tolerance
 * does not grow with the number. Three figures reads as a tenth at 72 and as
 * five pounds at ten thousand, and a total five pounds out is not a difference
 * in presentation; "more than £500 on restaurants" names a magnitude.
 */
function comparableValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value !== "string") return "{}";
  return value.length <= 40 && !value.includes(" ") ? value : "<text>";
}

/** Judged outputs the probe hands back for named documents. */
interface ProbeVerdict {
  readonly fired: boolean;
  readonly output: Readonly<Record<string, unknown>>;
  /**
   * Which question this document is an answer to, as words.
   *
   * A watch can ask two questions of the same stream — "is this an invoice" and
   * "is this its receipt" — and a verdict keyed only by document answers both,
   * so one invoice satisfies both arms of its own thread and the pairing the
   * watch is named for is never exercised. Matching on the judge's proposition
   * separates them without grading node names: the words are the question, and
   * a compilation that asks for a receipt writes "receipt" in asking.
   */
  readonly answers: readonly string[];
}

interface Probe {
  /** Per-document verdicts, keyed by document id. */
  readonly documents: ReadonlyMap<string, ProbeVerdict>;
  /**
   * Watches whose judge declines anything the probe does not name.
   *
   * A judge that agrees with everything makes a semantic watch fire on all the
   * traffic its filter admits — the invoice reference fired seventy-seven times
   * over a season in which two invoices were actually paired. That reference
   * describes the corpus's volume rather than its own scenario, and a
   * compilation is then graded on reproducing the volume. Naming the documents
   * that genuinely match, and declining the rest, gives the reference its
   * scenario back.
   *
   * Listed per watch rather than made the default, because the agreeing judge
   * is what makes an unscripted watch's structure observable at all: everything
   * below a judgement is gated on it, so a blanket decline would return most of
   * the corpus to firing nothing.
   */
  readonly selective: ReadonlySet<string>;
  /** Which watch each scripted document belongs to, when it names one. */
  readonly owners: ReadonlyMap<string, string>;
}

type ProbeOutputs = Probe;

const probeCache = new Map<string, Probe>();

/**
 * A universe's probe outputs, or an empty table when it declares none.
 *
 * A condition that computes on a judged value — a date compared against a
 * frozen constant — comes out the same way every time when the judged value is
 * a constant stub. The comparison is then never exercised, and a compilation
 * with it inverted, or missing entirely, replays identically to one that has it
 * right. Naming a document's output here is what makes such a condition
 * load-bearing in the measurement.
 *
 * Cached: the file does not change within a run, and a sweep reads it once per
 * attempt per side.
 */
function loadProbeOutputs(universe?: string): ProbeOutputs {
  const key = universe ?? "";
  const cached = probeCache.get(key);
  if (cached) return cached;

  const path = join(universeDir(universe), "probe.json");
  const documents = new Map<string, ProbeVerdict>();
  const owners = new Map<string, string>();
  let selective = new Set<string>();

  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      judgedOutputs?: Record<
        string,
        { fired?: boolean; output?: Record<string, unknown>; watch?: string; answers?: string[] }
      >;
      selective?: string[];
    };
    for (const [documentId, entry] of Object.entries(parsed.judgedOutputs ?? {})) {
      documents.set(documentId, {
        fired: entry.fired ?? true,
        output: entry.output ?? {},
        answers: (entry.answers ?? []).map((word) => word.toLowerCase()),
      });
      if (entry.watch !== undefined) owners.set(documentId, entry.watch);
    }
    selective = new Set(parsed.selective ?? []);
  }

  const probe: Probe = { documents, selective, owners };
  probeCache.set(key, probe);
  return probe;
}

/** Which side stopped early, and where. Both may have. */
function describeCrash(expected: number | null, actual: number | null): string {
  if (expected !== null && actual !== null) {
    return `both threw, the reference at sequence ${expected} and the compiled watch at ${actual}`;
  }
  return actual !== null
    ? `the compiled watch threw at sequence ${actual} and stopped there; the reference ran to the end`
    : `the reference threw at sequence ${expected} and the compiled watch did not`;
}
