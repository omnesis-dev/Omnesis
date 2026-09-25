// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Telling a misreading from a judgement call.
 *
 * When a compilation behaves differently from its reference, that is two very
 * different things wearing one label. "Tell me if that rhythm stops" names no
 * number, so a nine-day wait and a twelve-day wait are both readings of it and
 * they fire on different days. "I haven't replied for 3 days" names one, so a
 * five-day wait is a misreading. Scored together, a compiler that reads
 * requests well and chooses differently where they are silent looks identical
 * to one that cannot read them at all.
 *
 * So a divergence is **defensible** when every parameter the two watches
 * disagree on is one the request left open, and each compiled value sits inside
 * the range that reads the request fairly. It is **structural** otherwise —
 * including when the two agree on every parameter and still behave differently,
 * which means the difference is in the shape rather than the numbers.
 *
 * The ranges come from `free-parameters.ts`, the same declaration the
 * reconstructibility test holds to the request. A watch cannot buy latitude
 * here without declaring it there, where a test checks the request does not in
 * fact name the value.
 *
 * Parameters are matched by **role** — the node's type and the field — not by
 * node id, because a compilation names its own nodes and grading vocabulary is
 * exactly what this whole scorer avoids. `divergence.test.ts` pins that the
 * role key is unique within every corpus watch, which is what makes the match
 * unambiguous.
 */

import { watchDslSchema, type WatchDefinition, type WatchNode } from "../dsl/schema.js";
import { validateWatch } from "../validator/validate.js";
import { loadOntology } from "../universe/paths.js";
import { boundParameters, type BoundParameter } from "./bound-parameters.js";
import { cadenceLatitudeFor, toleranceFor } from "./free-parameters.js";
import { behaviourOf, compareBehaviour } from "./score.js";

type DivergenceKind = "defensible" | "structural";

interface ParameterDifference {
  /** The role, as `<node type>.<field>`. */
  readonly slot: string;
  readonly expected: string;
  readonly actual: string;
  readonly inTolerance: boolean;
  /** For one inside a tolerance, the request's own words on why it is open. */
  readonly because?: string;
  /** The compilation fitted no such bound, and the watch says it need not. */
  readonly absent?: boolean;
}

/** How the reference should be read while a divergence is classified. */
export interface DivergenceReading {
  readonly universe?: string;
  /**
   * Whether a declared rate limiter's *absence* is a defensible reading.
   *
   * Switchable so one code path can report both figures. A rate published
   * "with cadence latitude" and one published without must differ only in this
   * flag, or the comparison between them measures two scorers rather than one
   * allowance.
   */
  readonly cadenceLatitude?: boolean;
}

export interface DivergenceVerdict {
  readonly kind: DivergenceKind;
  /** One line, naming what differed and why it counts as it does. */
  readonly detail: string;
}

/**
 * The role a bound parameter plays: its node's type and the field.
 *
 * Joined with a bar rather than a dot. Both halves contain dots of their own —
 * `stateful.wait`, `recurring.hour` — so a dot cannot be split back apart, and
 * a substitution that guessed wrong would quietly rebuild the reference
 * unchanged and call every divergence defensible.
 */
function slotOf(watch: WatchDefinition, parameter: BoundParameter): string {
  const nodeId = parameter.at.slice(0, parameter.at.indexOf("."));
  const field = parameter.at.slice(nodeId.length + 1);
  const node: WatchNode | undefined = watch.nodes.find((n) => n.id === nodeId);
  return `${node?.type ?? "?"}|${field}`;
}

/**
 * Bound parameters by role.
 *
 * A role that appears twice is dropped rather than silently resolved to
 * whichever came last: two nodes of one type with the same field cannot be
 * told apart, and guessing which is which would decide a verdict on a coin
 * toss. `divergence.test.ts` holds the corpus to one of each; a *compilation*
 * is free to write two, and this is what happens when it does.
 */
function byRole(watch: WatchDefinition): Map<string, BoundParameter> {
  const seen = new Map<string, BoundParameter | null>();
  for (const parameter of boundParameters(watch)) {
    const role = slotOf(watch, parameter);
    seen.set(role, seen.has(role) ? null : parameter);
  }
  return new Map([...seen].flatMap(([role, p]) => (p === null ? [] : [[role, p] as const])));
}

/**
 * Why two watches that behave differently do.
 *
 * Called only when the behaviours have already diverged: this does not decide
 * *whether* they differ, only what kind of difference it is.
 *
 * The test is not "did they disagree on anything structural" — that reads the
 * absence of a *bound-parameter* difference as the absence of any difference,
 * and a watch reading the wrong table binds no parameter at all. It is
 * whether the reference, **rebuilt with the compilation's own choices for the
 * parameters its request left open**, behaves the way the compilation does. If
 * it does, the free parameters explain the whole divergence and nothing else
 * is going on. If it still differs, something the request did name is wrong.
 */
export async function classifyDivergence(
  referenceName: string,
  reference: WatchDefinition,
  compiled: WatchDefinition,
  options: DivergenceReading = {},
): Promise<DivergenceVerdict> {
  const differences = parameterDifferences(referenceName, reference, compiled, options);
  const outside = differences.filter((d) => !d.inTolerance);
  if (outside.length > 0) {
    return {
      kind: "structural",
      detail: outside.map((d) => `${d.slot}: expected ${d.expected}, got ${d.actual}`).join("; "),
    };
  }

  if (differences.length === 0) {
    return {
      kind: "structural",
      detail:
        "behaves differently while binding the same values, so the difference is in the shape",
    };
  }

  // Every disagreement is inside a declared tolerance. That is necessary and
  // not sufficient: rebuild the reference with those choices and see whether
  // the divergence goes away.
  // Rebuilding drops nodes and rewires what read them, which the schema alone
  // cannot police: an expression still naming a dropped node parses and fails
  // the validator. A reference the scorer has broken would grade every
  // compilation against a watch nobody wrote, so a rebuild that does not
  // validate withdraws the allowance instead of being replayed.
  const normalised = withParameters(reference, differences);
  const rebuiltIsSound = validateWatch(
    { watch: normalised },
    loadOntology(options.universe),
  ).diagnostics.every((d) => d.severity !== "error");
  if (!rebuiltIsSound) {
    return {
      kind: "structural",
      detail:
        "the reference could not be rebuilt on this compilation's open choices without breaking it, " +
        "so the divergence cannot be attributed to those choices",
    };
  }

  const rebuilt = await behaviourOf(normalised, { ...options, reference: referenceName });
  const theirs = await behaviourOf(compiled, { ...options, reference: referenceName });
  const verdict = compareBehaviour(rebuilt, theirs, { reference: referenceName });

  const explained = differences
    .map((d) => `${d.slot}: ${d.expected} vs ${d.actual} — ${d.because ?? ""}`)
    .join("; ");

  return verdict.equivalent
    ? { kind: "defensible", detail: explained }
    : {
        kind: "structural",
        detail:
          `${verdict.difference ?? "still differs"} — with the reference rebuilt on the same ` +
          `open choices (${explained}), so the difference is not those choices`,
      };
}

/** Every bound value the two disagree on, and whether the request allows it. */
function parameterDifferences(
  referenceName: string,
  reference: WatchDefinition,
  compiled: WatchDefinition,
  options: DivergenceReading = {},
): ParameterDifference[] {
  const expected = byRole(reference);
  const actual = byRole(compiled);
  const differences: ParameterDifference[] = [];

  for (const [slot, mine] of expected) {
    const theirs = actual.get(slot);
    if (theirs === undefined) {
      // A bound the compilation did not fit at all. Defensible only where the
      // watch has declared that its request asks for no such bound — and even
      // then only if rebuilding the reference without it explains the whole
      // divergence, which the caller goes on to check.
      const cadence =
        options.cadenceLatitude === false ? null : cadenceLatitudeFor(referenceName, slot);
      differences.push({
        slot,
        expected: mine.written,
        actual: "(absent)",
        inTolerance: cadence !== null,
        ...(cadence ? { because: cadence.because, absent: true } : {}),
      });
      continue;
    }
    if (theirs.value === mine.value) continue;

    const tolerance = toleranceFor(referenceName, mine.at);
    const inside =
      tolerance !== null && theirs.value >= tolerance.from && theirs.value <= tolerance.to;
    differences.push({
      slot,
      expected: mine.written,
      actual: theirs.written,
      inTolerance: inside,
      ...(inside ? { because: tolerance.because } : {}),
    });
  }

  for (const [slot, theirs] of actual) {
    if (!expected.has(slot)) {
      differences.push({ slot, expected: "(absent)", actual: theirs.written, inTolerance: false });
    }
  }
  return differences;
}

/**
 * The reference, rewritten to make the choices the compilation made.
 *
 * Only the fields the differences name, and only by their written form, so the
 * rebuilt watch is the reference in every other respect. It goes back through
 * the schema because a watch that no longer parses is not a watch, and a
 * substitution that produced one would otherwise fail somewhere less obvious.
 */
function withParameters(
  reference: WatchDefinition,
  differences: readonly ParameterDifference[],
): WatchDefinition {
  const document = JSON.parse(JSON.stringify({ watch: reference })) as {
    watch: { nodes: Record<string, unknown>[] };
  };
  for (const difference of differences) {
    const bar = difference.slot.indexOf("|");
    const type = difference.slot.slice(0, bar);
    const field = difference.slot.slice(bar + 1);
    if (difference.absent === true) {
      dropNodesOfType(document.watch, type);
      continue;
    }
    for (const node of document.watch.nodes) {
      if (node.type !== type) continue;
      if (field === "recurring.hour") {
        // The hour is the only part of a schedule declared free; the rest of
        // the expression is what the request means by "weekly" or "nightly".
        node.recurring = String(node.recurring).replace(
          /^(\S+)\s+\S+/,
          (_m, minute: string) => `${minute} ${hourOf(difference.actual)}`,
        );
        continue;
      }
      node[field] = numericField(field) ? Number(difference.actual) : difference.actual;
    }
  }
  return watchDslSchema.parse(document).watch;
}

/**
 * The reference with a whole node taken out, and its consumers rewired past it.
 *
 * A bound whose field is required by the schema cannot be dropped on its own —
 * "no rate limit" is a watch with no limiter node, not one holding a limiter
 * with nothing in it. Every node of the type is removed and anything that read
 * it is pointed at what it read, so the graph still ends where it ended.
 */
function dropNodesOfType(watch: { nodes: Record<string, unknown>[] }, type: string): void {
  const doomed = watch.nodes.filter((n) => n.type === type);
  for (const node of doomed) {
    const inputs = (node.inputs ?? {}) as Record<string, unknown>;
    const upstream = Object.keys(inputs)[0];
    if (upstream === undefined) continue;
    const id = String(node.id);
    // Anything naming the doomed node now names what fed it. The sink is a
    // field rather than a node, so it is rewired by the same pass over the
    // document rather than separately.
    const rewire = (value: unknown): unknown => {
      if (value === id) return upstream;
      if (Array.isArray(value)) return value.map(rewire);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k === id ? upstream : k,
            rewire(v),
          ]),
        );
      }
      return value;
    };
    const rewired = rewire({ ...watch, nodes: watch.nodes.filter((n) => n !== node) }) as {
      nodes: Record<string, unknown>[];
    };
    Object.assign(watch, rewired);
  }
}

function numericField(field: string): boolean {
  return field === "min_events" || field === "n" || field === "max_live_instances";
}

/** The hour out of a cron expression written `<minute> <hour> …`. */
function hourOf(cron: string): string {
  return cron.split(/\s+/)[1] ?? "0";
}
