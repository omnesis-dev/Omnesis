// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the runtime did, in the order it did it.
 *
 * A trace is the golden-corpus artifact: an ordered list of
 * `(seq, node, key, transition)` records ending in sink firings. It exists
 * because "the watch fired" is a poor thing to assert on — it says nothing
 * about *why*, so a watch that fires for the wrong reason still passes. A
 * trace pins the reasoning: which instance armed, on what key, what cancelled
 * it, and which deadline it died on.
 *
 * `key` is the human-readable rendering of the instance key, not its hash,
 * because a golden a reviewer cannot read is a golden nobody checks.
 */

/** What happened to a node instance. */
export const TRANSITIONS = [
  /** An arm input fired and created an instance. */
  "armed",
  /** The node fired: its condition held, and the signal went downstream. */
  "fired",
  /** A cancel input ended a live instance before it could fire. */
  "cancelled",
  /** A deadline passed with the instance still waiting. */
  "expired",
  /** A colliding arm restarted the lifecycle. */
  "reset",
  /**
   * An event reached a node and the node did not take it up.
   *
   * Two ways that happens: a colliding arm discarded because an instance was
   * already live, and a document no recall arm nominated. They share a
   * transition because they are the same fact from the node's side — nothing
   * was armed, nothing was judged — and the `detail` says which.
   */
  "ignored",
  /** An event arrived that no live instance could take, and was discarded. */
  "dropped",
  /** An arm fed a persistent cell that survives firings. */
  "accumulated",
  /** The node evaluated and did not fire. */
  "held",
  /** An arm was refused because the key could not be computed. */
  "quarantined",
  /** Evaluating this instance threw. The watch pauses; the run does not. */
  "failed",
  /** A spawn was refused because the node is already at its instance ceiling. */
  "refused",
  /**
   * An operator moved the watch past something it could not get through.
   *
   * Not a decision the runtime made, and deliberately not silent. A reader has
   * to be able to tell an event that was considered and decided nothing from
   * one that was never looked at; without a record, the two are the same gap.
   */
  "skipped",
  /**
   * The watch fired and the firing was not delivered, because a daily cap on
   * how often it may interrupt a person was already spent.
   *
   * A firing, not a non-firing: the watch was right and said so, and the row
   * and the trace record it exactly as they would any other. What did not
   * happen is the notification — and a cap that dropped one in silence would be
   * indistinguishable from a watch that had stopped firing at all, which is the
   * one thing someone relying on it cannot be left to guess about.
   */
  "suppressed",
  /**
   * An operator fired this watch by hand, to see where a firing goes.
   *
   * Nothing was evaluated: no event was read, no node armed, no judge was
   * asked. What ran is everything *after* a firing — the caps, the transport,
   * the anchor, whatever the delivery block names — which is the half that
   * cannot otherwise be exercised without waiting for the world to produce the
   * condition.
   *
   * Its own transition rather than a `fired` with a note, because the two must
   * never be confused when counting: a watch credited with catching something
   * it never saw is a watch that looks like it works.
   */
  "forced",
] as const;

export type Transition = (typeof TRANSITIONS)[number];

/**
 * What kind of thing went wrong, for a reader who needs to know where to look.
 *
 * A failure's message says what the machine reported; the class says who to ask
 * about it. Those are different questions, and a single free-text field answers
 * neither reliably — "the judge declined" and "the judge was unreachable" are
 * the same string to anything that has to count them.
 */
export const FAILURE_CLASSES = [
  /** An analytics query would not bind or would not run. The watch's own SQL. */
  "query",
  /** A judge or recall backend refused, timed out, or was unreachable. */
  "provider",
  /** One event needed more rounds of off-host answers than are allowed. */
  "budget",
  /** Anything the runtime could not attribute — a defect until proven otherwise. */
  "internal",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface TraceRecord {
  /** The journal event that caused this — including a journaled timer. */
  readonly seq: number;
  readonly nodeId: string;
  /** The instance key, rendered readably. `singleton` when the node has none. */
  readonly key: string;
  /**
   * Which instance of that key. Omitted for the common case of one, so a trace
   * for a node that never spawns reads the way it always did.
   */
  readonly instance?: number;
  readonly transition: Transition;
  /** Why, when the transition alone does not say. */
  readonly detail?: string;
  /**
   * Which kind of failure this was, on the records where something failed.
   *
   * Always present on `failed`. Also present on a `held` the runtime did not
   * decide — a judge that was over budget or could not run holds the instance
   * without judging it, and the class is what separates that from a judgement
   * of no. Only `failed` pauses the watch; a classed `held` is a retry.
   *
   * The class is what a watch's status note is allowed to carry: it names a
   * category the runtime chose, where `detail` is whatever a backend said and
   * may quote a value out of the corpus.
   */
  readonly failure?: FailureClass;
}

export interface WatchFiring {
  readonly seq: number;
  /**
   * The node that fired, and the key-instance it fired for.
   *
   * These two complete the firing's durable identity: the store is unique on
   * `(watch, seq, node, key)`, because a broadcast arm re-judges every live
   * cell at the tick's own sequence number — so several distinct firings, with
   * different evidence behind them, share one `seq`. Anything that must tell
   * one firing from another has to carry all four.
   */
  readonly nodeId: string;
  readonly keyHash: string;
  /**
   * The same key, rendered — `singleton` for a node with none.
   *
   * Carried beside the hash rather than derived from it, because a hash cannot
   * be turned back into a key. Anything downstream that has to *say* which key
   * a firing belonged to reads this: a trace record written about a firing
   * names the key the way every other record on that node names it, so the
   * cell it lands in is the cell the firing came from.
   */
  readonly key: string;
  /** Semantic time of the event that caused the firing. */
  readonly firedAt: string;
  /** The sink's payload, after its `output_map`. */
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * The documents that made this firing true, oldest link first.
   *
   * Read off the provenance chain rather than the payload: a payload holds
   * whatever the author's `output_map` named, which need not mention a
   * document at all, while the chain records what each node actually fired on.
   * Empty for a watch driven by rows or by the clock, which is not a gap — a
   * firing with no document behind it has none to offer.
   */
  readonly documentIds: readonly string[];
}

export interface WatchTrace {
  readonly watch: string;
  readonly records: readonly TraceRecord[];
  readonly firings: readonly WatchFiring[];
  /**
   * How the watch ended, when it ended.
   *
   * `fired` is a watch that got what it was waiting for and was asked for
   * nothing more. `expired` is a watch whose question stopped being worth
   * asking — the dinner it was bound to has happened. The distinction is what a
   * reader of the ledger needs: one of them was answered and the other was
   * simply overtaken, and a watch that quietly vanished at its horizon would
   * look like one that never fired.
   *
   * Absent while the watch is still live — and absent, too, from a run that
   * finds the watch already retired, because this records what *this* run
   * observed rather than what the store remembers. The durable fact is the
   * watch's active flag; this is the trace saying which transition it saw.
   */
  readonly ended?: "fired" | "expired";
}

/** The `singleton` key, for a node that has none. */
export const SINGLETON_KEY = "singleton";

/**
 * Render an instance key readably and deterministically. Components are sorted
 * by name so two runs that built the same key in a different order produce the
 * same string.
 */
export function renderKey(key: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(key);
  if (entries.length === 0) return SINGLETON_KEY;
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${renderValue(value)}`)
    .join(",");
}

/**
 * Values are JSON-encoded so that a component whose value contains the
 * separators (`a=b,c=d`) cannot render to the same string as a genuinely
 * different key. A trace is read by people, but an ambiguous rendering would
 * make two instances look like one.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" && !/[=,"]/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * A position in a trace, so an abandoned attempt can be taken back out of it.
 *
 * Evaluating an event is retried when it turns out to need an answer that has
 * to be fetched from off the host — the attempt is rolled back, the answer is
 * fetched, and the event is evaluated again from the same state. The trace has
 * to be rolled back with it, or a reader would see each retried event's
 * transitions twice and conclude the runtime had done the work twice.
 */
export interface TraceMark {
  readonly records: number;
  readonly firings: number;
  readonly ended: "fired" | "expired" | null;
}

export class TraceRecorder {
  private ended: "fired" | "expired" | null = null;
  private readonly records: TraceRecord[] = [];
  private readonly firings: WatchFiring[] = [];

  /** Where the trace stands now, to come back to. */
  mark(): TraceMark {
    return { records: this.records.length, firings: this.firings.length, ended: this.ended };
  }

  /** Take the trace back to a mark, discarding everything recorded since. */
  rewind(mark: TraceMark): void {
    this.records.length = mark.records;
    this.firings.length = mark.firings;
    this.ended = mark.ended;
  }

  /**
   * Take back what an abandoned attempt *did*, and keep the account of it.
   *
   * The two halves of a trace are not the same kind of thing. Records are the
   * log of a pass — what armed, what was ignored, what broke — and they are
   * worth keeping even for a pass that was rolled back, because they are the
   * only explanation of why it was. Firings are effects: the host reads them
   * and notifies somebody.
   *
   * So an attempt whose transaction was rolled back must lose its firings and
   * keep its records. Anything else notifies a person about a firing that has
   * no row behind it — and then notifies them again when the event is re-read.
   */
  rewindEffects(mark: TraceMark): void {
    this.firings.length = mark.firings;
    this.ended = mark.ended;
  }

  /**
   * Record how the watch ended, the first time it does.
   *
   * First writer wins: a watch that fired and was retired for it did not also
   * expire, whatever its horizon says afterwards.
   */
  end(how: "fired" | "expired"): void {
    this.ended ??= how;
  }

  constructor(private readonly watch: string) {}

  record(
    seq: number,
    nodeId: string,
    key: string,
    transition: Transition,
    detail?: string,
    instance = 0,
  ): void {
    this.records.push({
      seq,
      nodeId,
      key,
      ...(instance === 0 ? {} : { instance }),
      transition,
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * Record an instance held because no judgement was made.
   *
   * A hold like any other from the node's side — nothing fired, the instance
   * stays live — but carrying the class so a reader can tell it from a judge
   * that considered the evidence and said no. Without that, a model outage and
   * a precision judgement are the same line, and a shadow period measuring
   * precision would count one as the other.
   */
  unanswered(
    seq: number,
    nodeId: string,
    key: string,
    failure: FailureClass,
    detail: string,
    instance = 0,
  ): void {
    this.records.push({
      seq,
      nodeId,
      key,
      ...(instance === 0 ? {} : { instance }),
      transition: "held",
      detail,
      failure,
    });
  }

  /** Record a failure, the transition that pauses the watch. */
  fail(
    seq: number,
    nodeId: string,
    key: string,
    failure: FailureClass,
    detail: string,
    instance = 0,
  ): void {
    this.records.push({
      seq,
      nodeId,
      key,
      ...(instance === 0 ? {} : { instance }),
      transition: "failed",
      detail,
      failure,
    });
  }

  fire(
    seq: number,
    nodeId: string,
    keyHash: string,
    key: string,
    firedAt: string,
    payload: Readonly<Record<string, unknown>>,
    documentIds: readonly string[] = [],
  ): void {
    this.firings.push({ seq, nodeId, keyHash, key, firedAt, payload, documentIds });
  }

  finish(): WatchTrace {
    return {
      watch: this.watch,
      records: [...this.records],
      firings: [...this.firings],
      ...(this.ended === null ? {} : { ended: this.ended }),
    };
  }
}
