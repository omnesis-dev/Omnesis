// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether the watch layer is doing anything, said so it cannot be misread.
 *
 * The failure this exists for happened: every watch on an install sat paused
 * because the ontology had moved under them, and the report said `0 failed` the
 * whole time — because that number counted watches a *node* had thrown in, and
 * a watch stopped for any other reason was a note on a row nobody reads. The
 * layer was completely inert and every number on the page looked healthy.
 *
 * So the shape here is the point, not the arithmetic. A watch that is not
 * evaluating lands in exactly one bucket by a total function over its state,
 * and the buckets are reported together with the count of everything stopped.
 * There is no longer a single number that can read as "fine" while the layer
 * is dead: `stopped.total` is assembled from the same pass that produces
 * `active`, and any consumer that renders one has the other.
 *
 * The second half is liveness, which answers a different question. A silent
 * install has two explanations that look identical from the outside — nothing
 * happened, or nothing is running — and only one of them is a problem. Saying
 * when the engine last evaluated and how old the journal's newest event is
 * separates them at a glance.
 */

import { assertNever } from "@omnesis/core";
import type { WatchStatus } from "./definitions.js";

/**
 * Why a watch is not evaluating.
 *
 * Exhaustive on purpose: every watch that is not `active` has exactly one of
 * these, so a cause added later cannot quietly fall out of the count. The
 * distinction that matters is `drifted` — a watch stopped because the ontology
 * it validated against moved is stopped through no act of anyone's, and it is
 * the only one of these that an operator will not remember causing.
 */
export type StoppedCause = "failed" | "drifted" | "unarmed" | "held" | "retired";

export const STOPPED_CAUSES: readonly StoppedCause[] = [
  "failed",
  "drifted",
  "unarmed",
  "held",
  "retired",
];

/**
 * The note a watch carries when the ontology moved out from under it.
 *
 * Written and read here rather than composed at the pause site, because the
 * classification below parses it. A reworded note at the writer would have
 * left every drifted watch quietly reclassified as one somebody chose to hold
 * — and `held` alarms only when nothing at all is running, so a half-drifted
 * install would have gone from a loud sentence to complete silence, with every
 * test still green.
 */
export function driftNote(codes: string): string {
  return `${DRIFT_NOTE_PREFIX} ${codes}`;
}

const DRIFT_NOTE_PREFIX = "no longer validates:";

/**
 * The note a watch carries when the ontology moved and it still validates.
 *
 * The other half of drift, and a different sentence because it asks for a
 * different thing. A watch that no longer validates needs rewriting; this one
 * needs a person to look at what moved and say whether it is still the watch
 * they wanted. Re-stamping is how they say yes, so the note says so.
 *
 * Held apart from {@link driftNote} rather than folded into it because the two
 * are indistinguishable in every other operator-visible field — same status,
 * same cause, same absence of a failure record — and one sentence covering
 * both would have to be the vaguer of the two.
 */
export function surfaceNote(why: string): string {
  return `${SURFACE_NOTE_PREFIX} ${why}`;
}

const SURFACE_NOTE_PREFIX = "the ontology it reads has changed:";

/** Something the watch reads is not what it was last validated against. */
export const SURFACE_MOVED = "re-stamp it to accept the surface it now reads";

/**
 * Nothing is recorded about what this watch reads, so nothing can be compared.
 *
 * Every watch installed before the surface was recorded is in this state until
 * its first successful evaluation on this build. Unproven is treated as
 * changed, so it is held rather than re-stamped — and it says which of the two
 * it is, because "we have not checked" and "we checked and it moved" send an
 * operator to different places.
 */
export const SURFACE_UNRECORDED =
  "what it reads was never recorded, so nothing can say whether it moved; re-stamp it to record it";

/** Why a watch is held for review, or null if this note is not that. */
export function surfaceReasonOf(note: string | null): string | null {
  if (note === null || !note.startsWith(SURFACE_NOTE_PREFIX)) return null;
  const why = note.slice(SURFACE_NOTE_PREFIX.length).trim();
  return why.length > 0 ? why : null;
}

/**
 * The diagnostic codes a drift note carries, or null if it is not one.
 *
 * The note is the only place they survive — the validation that produced them
 * ran in an evaluation pass nobody was watching — and a sentence that says a
 * watch stopped without saying what moved leaves the operator to go and find
 * out by re-running it.
 */
export function driftCodesOf(note: string | null): string | null {
  if (note === null || !note.startsWith(DRIFT_NOTE_PREFIX)) return null;
  const codes = note.slice(DRIFT_NOTE_PREFIX.length).trim();
  return codes.length > 0 ? codes : null;
}

/**
 * The note a watch carries when evaluating it threw.
 *
 * A fault, not a decision: it belongs with the node failures rather than with
 * the watches an operator held, even though no failure record names a node —
 * the throw happened outside any one node's evaluation.
 */
export const THREW_NOTE = "evaluating it threw — see the gateway log";

/**
 * The note a watch carries when its wake record could not be created.
 *
 * A fault like the other two, and read here for the same reason: the pause is
 * the machine's, not the operator's. Nothing about the watch is wrong — the
 * subscription store refused, or nothing held the harness it names — and it
 * evaluates nothing until somebody resumes it. Read as a decision it would sit
 * unmarked beside the watches an operator deliberately held.
 *
 * Declared here rather than imported from `authoring.ts`, which imports this
 * module: the note's text is the classification's input, so it belongs beside
 * the classification, and the writer takes it from here.
 */
export const ANCHOR_UNMINTED_NOTE = "its wake record could not be created; resume it to try again";

/**
 * The note a watch carries when the device it wakes is no longer paired.
 *
 * The same class of fault as {@link ANCHOR_UNMINTED_NOTE} and a different
 * cause, so it says the cause. A record is pinned to the device that asked for
 * it rather than to the harness name, because resolving a name picks whichever
 * device holding it paired most recently and waking a sibling agent is the one
 * mistake anchoring must be incapable of. The cost of that pinning is this
 * case: the device goes, and there is no other device this watch may be
 * re-pointed at without somebody saying so. Re-pairing and installing the watch
 * again is what says so.
 */
export const ANCHOR_DEVICE_GONE_NOTE =
  "the device it wakes is no longer paired; install it again from that device";

/**
 * Whether this note says the watch is stopped for want of a wake record.
 *
 * There is more than one reason a record cannot be made and they say different
 * things to the operator, but every reader that asks "is this watch merely
 * unarmed" wants all of them. Asked through one predicate so that a reason
 * added later reaches every such reader at once — a resume that retries the
 * arming, and the classification below, are the two that exist today, and a
 * new note recognised by only one of them is a watch resumed into silence or a
 * fault filed as somebody's decision.
 */
export function isUnarmedNote(note: string | null): boolean {
  return note === ANCHOR_UNMINTED_NOTE || note === ANCHOR_DEVICE_GONE_NOTE;
}

/**
 * Stop a watch that could not be armed, and say why — if that is still the
 * right thing to write.
 *
 * Every path that fails to mint a wake record wants this, and three of them
 * can run over one watch in one request: the anchor module knows *which*
 * failure it was, while the install and resume paths know only that nothing
 * came back. Written from all three unguarded, the last write wins, and the
 * last write is the least specific one — an operator left reading "resume it
 * to try again" about a device that is not coming back, with the sentence that
 * would have told them what to do overwritten microseconds after it appeared.
 *
 * One rule does both jobs: **only a running watch is stopped.** A `retired`
 * watch has finished and a `paused` one is somebody's decision or an earlier
 * fault — a boot-time reconciliation walks every watch that declares a wake,
 * including those, and stopping one again would erase the reason it stopped the
 * first time. And because the first writer is the one that pauses, it is also
 * the one whose note survives: whoever knew the cause got there first.
 *
 * Returns what the watch now says, so a caller reporting the hold reports what
 * was actually written rather than what it asked for.
 */
export function holdUnarmed(
  store: {
    get(id: string): { readonly status: WatchStatus; readonly note: string | null } | null;
    setStatus(id: string, status: WatchStatus, note: string | null): void;
  },
  watchId: string,
  note: string,
): { readonly status: WatchStatus; readonly note: string | null } | null {
  const watch = store.get(watchId);
  if (!watch) return null;
  if (watch.status !== "active") return watch;
  store.setStatus(watchId, "paused", note);
  return { status: "paused", note };
}

/**
 * The note a watch carries when one of its nodes threw, naming the node.
 *
 * The class and the node, and nothing a backend wrote: an error message can
 * quote a value out of the corpus, and a status note is the one part of this
 * that is read on a listing, copied into a report and kept for as long as the
 * watch exists. `watch trace` is where the message lives.
 *
 * Built here, beside the classification that reads it, because the two are one
 * decision written twice: a note reworded at the writer alone would leave every
 * node-failed watch reading as one an operator held.
 */
export function nodeFailedNote(nodeId: string, failure: string | null): string {
  return `${NODE_FAILED_NOTE_PREFIX}${nodeId}' failed (${failure ?? "internal"}) — see \`watch trace\``;
}

const NODE_FAILED_NOTE_PREFIX = "node '";

/**
 * The note a watch carries when the operator stopped it themselves.
 *
 * The one paused note that is a decision rather than a fault, and the only one
 * that reads as `held`. Here with the others so `stoppedCause` and every writer
 * take the same string, and so `health.test.ts` can hold the whole set against
 * the classification in one place.
 */
export const HELD_BY_OPERATOR = "held by an operator";

/**
 * What stopped this watch, or null while it is running.
 *
 * `failed` outranks `drifted` when a watch carries both: a node that threw is
 * the more specific fact, and the failure record names the node and the class,
 * which a note cannot.
 */
export function stoppedCause(
  watch: { readonly status: WatchStatus; readonly note: string | null },
  hasNodeFailure: boolean,
): StoppedCause | null {
  switch (watch.status) {
    case "active":
      return null;
    case "retired":
      return "retired";
    case "paused":
      // The note alone has to be enough. `hasNodeFailure` is a second reading
      // of the same fact from the state store, and it is the one that goes
      // missing: a watch whose failure record was pruned, or read on a surface
      // that does not carry one, would otherwise fall through to `held` and be
      // listed among the watches somebody stopped on purpose.
      if (
        hasNodeFailure ||
        watch.note === THREW_NOTE ||
        (watch.note?.startsWith(NODE_FAILED_NOTE_PREFIX) ?? false)
      ) {
        return "failed";
      }
      if (isUnarmedNote(watch.note)) return "unarmed";
      // Both drift notes, because both say the same thing about the install:
      // the ontology moved and this watch stopped for it, which is nobody's
      // decision. They differ in what the operator does next, not in what
      // stopped the watch.
      return watch.note?.startsWith(DRIFT_NOTE_PREFIX) ||
        watch.note?.startsWith(SURFACE_NOTE_PREFIX)
        ? "drifted"
        : "held";
    default:
      return assertNever(watch.status);
  }
}

/** How the engine and its journal are moving. */
export interface WatchLayerLiveness {
  /** When the engine last consumed journal events, or null since boot. */
  readonly lastEvaluatedAt: string | null;
  /** Milliseconds since then. Null when it has not evaluated since boot. */
  readonly lastEvaluatedAgeMs: number | null;
  /** The journal's newest sequence, and when that event was observed. */
  readonly journalHead: number;
  readonly journalHeadAt: string | null;
  readonly journalHeadAgeMs: number | null;
  /**
   * How long the engine may go without evaluating before that is a fact worth
   * reporting rather than an idle install.
   */
  readonly staleAfterMs: number;
  /** Whether it has gone longer than that with a journal ahead of it. */
  readonly stalled: boolean;
}

export interface WatchLayerHealth {
  readonly active: number;
  readonly stopped: { readonly total: number } & Readonly<Record<StoppedCause, number>>;
  readonly liveness: WatchLayerLiveness;
  /**
   * One sentence naming what is wrong, or null when nothing is. Null is the
   * only reading that means healthy — which is what makes a healthy-looking
   * report impossible to produce while the layer is stopped.
   */
  readonly alarm: string | null;
}

/**
 * How many idle evaluation intervals may pass before the engine not having
 * evaluated is a fact rather than a lull.
 *
 * Derived from the configured cadence rather than fixed, so an install that
 * evaluates rarely on purpose does not alarm on its own settings. Ten of them
 * is long enough that a slow tick, a restart, or a busy writer cannot trip it,
 * and short enough that a stopped engine is noticed the same day.
 */
const STALE_EVALUATION_INTERVALS = 10;

export function stalenessBoundMs(idleEvaluateIntervalMs: number): number {
  return idleEvaluateIntervalMs * STALE_EVALUATION_INTERVALS;
}

export interface LayerHealthInput {
  readonly watches: readonly {
    readonly status: WatchStatus;
    readonly note: string | null;
    readonly hasNodeFailure: boolean;
  }[];
  readonly lastEvaluatedAtMs: number | null;
  /**
   * When this process started reading.
   *
   * A gateway that has not evaluated yet has not stopped evaluating, and the
   * two are indistinguishable without knowing how long it has been up. Without
   * this, every restart reported a stalled engine until the first event
   * happened to arrive — a red line on a healthy install, which is how a
   * reader learns to skip the line.
   */
  readonly startedAtMs: number;
  readonly journalHead: number;
  readonly journalHeadAtMs: number | null;
  /** The sequence the engine has evaluated up to across every live watch. */
  readonly evaluatedThroughSeq: number;
  readonly idleEvaluateIntervalMs: number;
  readonly now: number;
}

export function layerHealth(input: LayerHealthInput): WatchLayerHealth {
  const stopped: Record<StoppedCause, number> = {
    failed: 0,
    drifted: 0,
    unarmed: 0,
    held: 0,
    retired: 0,
  };
  let active = 0;
  for (const watch of input.watches) {
    const cause = stoppedCause(watch, watch.hasNodeFailure);
    if (cause === null) active += 1;
    else stopped[cause] += 1;
  }
  const total = STOPPED_CAUSES.reduce((sum, cause) => sum + stopped[cause], 0);

  const staleAfterMs = stalenessBoundMs(input.idleEvaluateIntervalMs);
  const lastEvaluatedAgeMs =
    input.lastEvaluatedAtMs === null ? null : Math.max(0, input.now - input.lastEvaluatedAtMs);
  // How long it has been since it last read anything — or, if it never has,
  // how long it has been up. Both answer the same question: is it going?
  const quietForMs = lastEvaluatedAgeMs ?? Math.max(0, input.now - input.startedAtMs);
  // Behind, not merely quiet. An engine that has evaluated everything there is
  // has nothing to do, and calling that stalled would alarm on every idle
  // install — so the journal must actually hold something it has not reached.
  // Behind, not merely quiet, and with something that ought to be reading it.
  // An install with no live watch has nothing to evaluate, so a journal that
  // runs ahead of it is the system working — alarming there would put a red
  // line on every healthy install that has not written a watch yet, and train
  // the reader to skip the one line this exists to make them read.
  const behind = input.journalHead > input.evaluatedThroughSeq;
  const stalled = behind && active > 0 && quietForMs > staleAfterMs;

  const liveness: WatchLayerLiveness = {
    lastEvaluatedAt: input.lastEvaluatedAtMs === null ? null : iso(input.lastEvaluatedAtMs),
    lastEvaluatedAgeMs,
    journalHead: input.journalHead,
    journalHeadAt: input.journalHeadAtMs === null ? null : iso(input.journalHeadAtMs),
    journalHeadAgeMs:
      input.journalHeadAtMs === null ? null : Math.max(0, input.now - input.journalHeadAtMs),
    staleAfterMs,
    stalled,
  };

  return {
    active,
    stopped: { total, ...stopped },
    liveness,
    alarm: layerAlarm({ active, stopped: { total, ...stopped }, liveness }),
  };
}

/**
 * The one sentence a person needs, or null.
 *
 * Ordered by how badly it is wrong rather than by how many watches it affects:
 * an install with nothing running is worse news than one where a watch stopped,
 * and an operator reading one line should be told the worst thing first.
 */
export function layerAlarm(health: Omit<WatchLayerHealth, "alarm">): string | null {
  const running = health.active;
  const { drifted, failed, held } = health.stopped;
  // Retirement is a watch finishing its job. An install whose watches have all
  // retired is not broken, and saying otherwise would make every one-shot watch
  // a permanent alarm.
  const stoppedByFault = health.stopped.total - health.stopped.retired;
  if (running === 0 && stoppedByFault > 0) {
    return `no watch is evaluating — ${describeStopped(health.stopped)}`;
  }
  if (health.liveness.stalled) {
    const age = health.liveness.lastEvaluatedAgeMs;
    const since = age === null ? "since this gateway started" : `for ${Math.round(age / 1000)}s`;
    return `the engine has not evaluated ${since} while the journal is ahead of it at seq ${health.liveness.journalHead}`;
  }
  if (drifted > 0) {
    // Named separately from every other pause because nobody chose it. A watch
    // stops here when the schema it was written against moves, and it goes on
    // being silent in a way that reads exactly like a week with nothing in it.
    return `${drifted} watch(es) stopped because the ontology moved under them — they are silent until re-stamped`;
  }
  if (failed > 0) return `${failed} watch(es) stopped on a node failure`;
  if (held > 0 && running === 0) return `${held} watch(es) are held and none is running`;
  return null;
}

function describeStopped(stopped: WatchLayerHealth["stopped"]): string {
  const parts = STOPPED_CAUSES.filter((cause) => stopped[cause] > 0).map(
    (cause) => `${stopped[cause]} ${cause}`,
  );
  return parts.length > 0 ? parts.join(", ") : "nothing is installed";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
