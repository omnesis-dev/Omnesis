// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Would this watch catch anything at all?
 *
 * The question a person asks before storing a watch, and the one that is
 * hardest to answer afterwards: a watch starts at the journal head, so its
 * first evidence arrives with its first match — and a watch whose filter
 * admits nothing produces the same silence as a quiet week. Months of it.
 *
 * ## Why this runs the real engine
 *
 * Because the alternative is a second evaluator, and a second evaluator that
 * disagrees with the first is worse than no answer. Everything a watch decides
 * — which event kinds a filter admits, how a person reference re-canonicalises
 * through a merge, what a declared metadata key means, how an analytics
 * predicate binds its types, when a deadline fires — lives in `WatchEngine`,
 * and each of those is a place a reimplementation would drift.
 *
 * So this constructs the engine the host constructs, over a slice of the same
 * journal, and reads the answer out of the trace it produces. What differs is
 * only what it is given:
 *
 * - **No store.** The engine defaults to a fresh in-memory one, so no cursor
 *   moves, no instance survives, and nothing is written where a real watch's
 *   state lives.
 * - **A judge that never says yes** (`CountingJudge`). It spends nothing and
 *   counts what would have been asked. That is the honest limit of this
 *   answer: for a node with a judge, a probe reports what *reached* the model,
 *   never what the model would have said.
 * - **Real recall.** A probe that stubbed the scorer would be answering a
 *   question about itself. It is local, and it is the half most likely to be
 *   the reason a watch is silent.
 * - **No delivery.** Delivery is the host's, not the engine's, and this is not
 *   the host: nothing is sent, and nothing could be.
 *
 * ## What it reports, and what it cannot
 *
 * Per node: how many events reached it, how many it took up, how many
 * documents its recall arms nominated, how many times it would have asked a
 * model, and a bounded sample of what it decided with the runtime's own
 * reason attached. A node behind a judged node reports zeroes, because a judge
 * that never fires never lets a signal downstream — that is a true fact about
 * this run, and the report says which nodes it applies to rather than leaving
 * the reader to infer it.
 */

import { createLogger, type Logger } from "@omnesis/core";
import {
  CountingJudge,
  validateWatch,
  WatchEngine,
  type AnalyticsPort,
  type JournalDocument,
  type JournalEvent,
  type Ontology,
  type RecallScorer,
  type TraceRecord,
  type WatchDefinition,
  type WatchNode,
} from "@omnesis/watch";

const log: Logger = createLogger("gateway").child("watch-v2:preflight");

/** How many of a node's decisions to quote back, per node. */
const SAMPLES_PER_NODE = 5;

/** How many journal events one probe may replay, unless the caller says less. */
export const DEFAULT_PREFLIGHT_EVENTS = 500;

/**
 * The most a caller may ask for.
 *
 * A diagnostic, not a backtest — and the cost is not the events, it is what
 * each one does: a recall arm scores every chunk of every candidate document,
 * an analytics predicate is a DuckDB round trip. This path takes no yield
 * deadline, so a run holds the thread start to finish and the ceiling is what
 * keeps that short. Ask in days to replay further; that path yields, and pays
 * for it in wall time.
 */
export const MAX_PREFLIGHT_EVENTS = 2_000;

/**
 * How far back a replay reaches when the caller asks in days rather than
 * events.
 *
 * Ninety, because the question this answers is "would this watch have fired
 * over the last few months" and the conditions worth watching for — a
 * completion, a renewal, an instalment — happen on that scale. The event
 * ceiling above answers a different question ("what does it do with the most
 * recent traffic") and stays where it is.
 */
export const DEFAULT_REPLAY_DAYS = 90;

/**
 * The furthest back a caller may ask.
 *
 * A year, because past it the ontology a watch is validated against has
 * usually moved and the replay would be describing a watch the install could
 * no longer run — a number about a world that no longer exists reads as a
 * number about this one.
 */
export const MAX_REPLAY_DAYS = 365;

/**
 * The most events a day-bounded replay will consume, whatever the days say.
 *
 * A backstop rather than the bound: ninety days is tens of thousands of events
 * on a busy install and a handful on a quiet one, and the caller asked for a
 * span. What this stops is a replay that would run for an unbounded time
 * because the install is far larger than the one this was sized against — the
 * window then reports fewer days than were asked for, which is the honest
 * answer and is why the report says what it *consumed*.
 */
// See #71 — sized against a smaller corpus: on a busy install this is a week,
// not the season a compile-time replay asks for.
export const MAX_REPLAY_EVENTS = 60_000;

/**
 * How long a day-bounded replay may hold the thread before handing it back.
 *
 * A deadline rather than an event count, because an event count bounds nothing
 * anyone cares about: events differ in cost by orders of magnitude — a lexical
 * arm is microseconds, a recall arm scores every chunk of a candidate document,
 * an analytics predicate is a round trip — so "every 250 events" is a
 * millisecond on one watch and seconds on another. Twenty milliseconds is under
 * a frame, which is the bar for staying a guest on a host that is also serving
 * requests and running watches.
 */
export const REPLAY_YIELD_MS = 20;

export interface PreflightDeps {
  /** The live journal — the same events the runtime consumes. */
  readonly journal: {
    head(): number;
    read(afterSeq: number, limit: number): JournalEvent[];
    /**
     * The most recent `doc.event` for a document at or before a sequence.
     *
     * The live host supplies this, and a replay without it answers differently
     * for a `doc.indexed` event: the engine falls back to remembering only the
     * documents it walked past in the slice, so a document last written before
     * the window opened resolves to nothing and its node decides on absence.
     */
    documentAt(docId: string, atSeq: number): JournalDocument | null;
    /** Where a span-bounded window starts. A read, like everything here. */
    firstSeqAtOrAfter(observedAtIso: string): number;
  };
  /**
   * The host's clock, so a span-bounded window is a fact a test can state
   * rather than one it has to wait for.
   */
  readonly now: () => number;
  /** This install's ontology, assembled from the running gateway. */
  readonly ontology: () => Promise<Ontology>;
  /** The analytics surface a row predicate is evaluated against. */
  readonly analytics: () => AnalyticsPort;
  /** The same scorer the runtime nominates on. */
  readonly recall: RecallScorer;
  /**
   * Whether recall can actually score.
   *
   * A probe that cannot measure has to say so. `LiveRecall` answers 0 with no
   * embedder, and every document would look far below every threshold — a
   * confident wrong answer, which for a diagnostic is worse than no answer.
   */
  readonly canScore: () => boolean;
}

/** What one node did over the window. */
export interface PreflightNode {
  readonly nodeId: string;
  readonly type: WatchNode["type"];
  /** Events this node was offered — the denominator. */
  readonly evaluated: number;
  /** Events it took up: armed, accumulated, or fired outright. */
  readonly matched: number;
  /** Events it looked at and let past, with the runtime's own reason. */
  readonly declined: number;
  /**
   * Times a model would have been asked. Never zero-because-cheap: a node with
   * a judge reports what reached it, and the judge said no to all of them.
   */
  readonly wouldAsk: number;
  /** A bounded quotation of what it decided, newest last. */
  readonly samples: readonly PreflightSample[];
  /** What a reader has to know to read the numbers above. */
  readonly diagnostics: readonly string[];
}

export interface PreflightSample {
  readonly seq: number;
  readonly transition: TraceRecord["transition"];
  /** The runtime's own words. May quote the corpus; see the route. */
  readonly detail?: string;
}

export interface PreflightReport {
  /** The slice replayed, so a zero can be read against what it was zero of. */
  readonly window: {
    /** Events the engine actually consumed — it may stop before the slice ends. */
    readonly events: number;
    /** Events it was offered. Larger than `events` when the watch stopped early. */
    readonly offered: number;
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly from: string | null;
    readonly to: string | null;
    /**
     * Observed time the replay covered, in milliseconds.
     *
     * Milliseconds rather than days because a rounded day count is a bad
     * denominator and a worse one at the edges: a window of eleven hours
     * rounds to zero, and a reach divided by it is infinite.
     *
     * **Only a denominator when `ended` is absent.** A `once_ever` watch that
     * fires on day two of a ninety-day window consumed two days, and a rate
     * computed from that describes a watch that has already retired.
     */
    readonly observedMs: number;
    /**
     * The event backstop bound the run, so the span is shorter than asked for
     * because of that ceiling rather than because the journal is young.
     *
     * Without it the two are indistinguishable, and they call for opposite
     * conclusions: one means the install is newer than the question, the other
     * means the question was too big for one replay.
     */
    readonly truncated?: true;
    /** What was asked for, when the caller asked in days. */
    readonly daysRequested?: number;
    /** Why it stopped early, when it did: it fired once and was done, or expired. */
    readonly ended?: "fired" | "expired";
  };
  readonly nodes: readonly PreflightNode[];
  /**
   * Sink firings over the window.
   *
   * Zero whenever any node on the path to the sink holds a judge, and that is
   * not a defect: this asks what the *deterministic* half decides. The nodes'
   * `wouldAsk` is where the rest of the answer would come from.
   */
  readonly firings: number;
  /**
   * Nodes that broke, when any did.
   *
   * A candidate that cannot run and one that catches nothing produce the same
   * zero otherwise: the engine contains a node failure and pauses rather than
   * throwing, so the run comes back looking merely quiet.
   */
  readonly failed?: ReadonlyArray<{
    readonly nodeId: string;
    readonly failure: string;
    readonly detail?: string;
  }>;
  /**
   * No firing was reached, and a model was asked for on the way.
   *
   * Run-time rather than structural: it says *this replay* could not reach a
   * firing without a model, which is what a reader needs in order not to read
   * the zero as a verdict on the condition. A watch whose judged node was
   * never reached at all reports false, correctly — nothing was gated because
   * nothing happened.
   */
  readonly judgeGated: boolean;
}

/**
 * A predicate that answers true once the caller has held the thread too long.
 *
 * Closes over the last time it said yes, so "too long" is measured from the
 * previous hand-back rather than from the start of the run.
 */
function heldTooLong(now: () => number, budgetMs: number): () => boolean {
  let since = now();
  return () => {
    if (now() - since < budgetMs) return false;
    since = now();
    return true;
  };
}

/**
 * The span a replay actually covered, in observed time.
 *
 * On `observedAt` for the same reason the window is cut on it: semantic time
 * is the event's own claim and a backfilled year would report a replay of
 * three weeks as one of four hundred days.
 */
function observedSpanMs(events: readonly JournalEvent[]): number {
  // Min and max rather than first and last. `observed_at` is not monotonic in
  // `seq`: a `doc.indexed` event carries the corpus's own indexed-at, so a
  // sweep catching up on a backlog interleaves hours-old stamps with fresh
  // ones. Taking the ends would shrink the span, and a negative one clamped to
  // zero is a denominator nobody can divide by.
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const at = Date.parse(event.observedAt);
    if (!Number.isFinite(at)) continue;
    if (at < low) low = at;
    if (at > high) high = at;
  }
  return Number.isFinite(low) && Number.isFinite(high) ? Math.max(0, high - low) : 0;
}

/** Why a probe could not be run at all. */
export type PreflightRefusal =
  | { readonly reason: "cannot-score" }
  | { readonly reason: "empty-journal" }
  /**
   * The journal holds events; this window holds none.
   *
   * Carries where the window landed, because the two things a reader wants
   * next — how far back the journal really goes, and whether anything has
   * arrived lately — are both answered by the gap between these.
   */
  | { readonly reason: "empty-window"; readonly head: number; readonly afterSeq: number }
  /** This install has no watch runtime at all — a different thing entirely. */
  | { readonly reason: "no-runtime" }
  | { readonly reason: "invalid"; readonly diagnostics: readonly string[] };

export type PreflightOutcome =
  | { readonly outcome: "probed"; readonly report: PreflightReport }
  | { readonly outcome: "refused"; readonly refusal: PreflightRefusal };

/**
 * Replay a candidate over the tail of the journal and report what it decided.
 *
 * The definition need not be stored, and nothing here stores it: this is the
 * question asked *before* there is a watch to name.
 */
export async function preflight(
  deps: PreflightDeps,
  watch: WatchDefinition,
  opts: { events?: number; days?: number } = {},
): Promise<PreflightOutcome> {
  // Only a candidate that actually scores needs a scorer. `LiveRecall` answers
  // 0 with no embedder, so a semantic arm would look far below every threshold
  // — a confident wrong answer, which for a diagnostic is worse than none. A
  // candidate with no semantic arm never calls it, and refusing that one would
  // withhold the whole feature from an install with no embedder for no reason.
  const scores = watch.nodes.some(
    (node) => node.type === "source.document_event" && node.recall?.semantic !== undefined,
  );
  if (scores && !deps.canScore()) {
    return { outcome: "refused", refusal: { reason: "cannot-score" } };
  }
  // Before the ontology, which is a corpus scan, a person-directory read and a
  // catalog round trip per analytics table. An install whose journal is empty
  // gets its answer for the price of one `SELECT MAX(seq)`.
  const head = deps.journal.head();
  if (head === 0) return { outcome: "refused", refusal: { reason: "empty-journal" } };

  const ontology = await deps.ontology();
  // The same validation the store does, for the same reason: a candidate that
  // does not hold against this install's ontology cannot be evaluated against
  // it, and the diagnostics are more useful than any number would be.
  const checked = validateWatch({ watch }, ontology);
  if (!checked.valid) {
    return {
      outcome: "refused",
      refusal: {
        reason: "invalid",
        diagnostics: checked.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => d.code ?? d.message ?? "invalid"),
      },
    };
  }

  // Two bounds, and the caller picks which question they are asking. `days`
  // asks what the watch would have done over a span — the question an operator
  // means by "would this have fired last month", and the one a measurement of
  // reach needs. `events` asks what it does with the most recent traffic, which
  // is the cheap diagnostic and stays the default.
  const asked = opts.days;
  const byDays = asked !== undefined;
  const days = byDays ? Math.min(Math.max(1, Math.floor(asked)), MAX_REPLAY_DAYS) : 0;
  const wanted = byDays
    ? MAX_REPLAY_EVENTS
    : Math.min(
        Math.max(1, Math.floor(opts.events ?? DEFAULT_PREFLIGHT_EVENTS)),
        MAX_PREFLIGHT_EVENTS,
      );
  // For a span, the journal answers where the window starts; for a count,
  // `head - wanted` is arithmetic on a sequence that can have holes, so it is
  // an approximation of "the most recent N" rather than a promise of one. The
  // read's own LIMIT bounds the work either way, and the window reports what
  // actually came back.
  const spanStart = byDays
    ? deps.journal.firstSeqAtOrAfter(new Date(deps.now() - days * 86_400_000).toISOString())
    : Math.max(0, head - wanted);
  // When the backstop binds it has to cut the OLD end. Reading forward from the
  // start of the span would hand back the oldest 60,000 events and stop — so a
  // ninety-day request on a busy install would cover days 90 to 36 and never
  // see the last five weeks, while reporting a shortfall that reads exactly
  // like a journal that does not go back that far. The recent end is the half
  // an operator asking "would this have fired" cares about.
  const afterSeq = byDays ? Math.max(spanStart, head - wanted) : spanStart;
  const truncated = byDays && afterSeq > spanStart;
  const journal = deps.journal.read(afterSeq, wanted);
  // An install whose watch layer was only just enabled has an empty journal —
  // the materializer seeds its checkpoint at the newest document rather than
  // replaying the corpus. "Nothing to evaluate" and "this catches nothing" are
  // opposite answers and must not share a zero.
  if (journal.length === 0) {
    // Not the same answer as an empty journal, and the difference is the whole
    // of what the caller should do next. A collector that has been down for
    // four days makes every short window empty while the journal holds tens of
    // thousands of events; telling its owner the journal is empty sends them to
    // investigate the wrong subsystem entirely.
    return {
      outcome: "refused",
      refusal: byDays ? { reason: "empty-window", head, afterSeq } : { reason: "empty-journal" },
    };
  }

  const judge = new CountingJudge();
  const engine = new WatchEngine({
    watch,
    ontology,
    journal,
    analytics: deps.analytics(),
    ...(checked.types ? { valueTypes: checked.types } : {}),
    judge,
    recall: deps.recall,
    // The same bounded lookup the host gives the engine. Without it a
    // `doc.indexed` event for a document written before the window opened
    // resolves to nothing, and the node decides on an absence the live
    // runtime would not have seen.
    lookupDocument: (docId, atSeq) => deps.journal.documentAt(docId, atSeq),
    // A span-bounded replay is tens of thousands of events and would otherwise
    // starve the process it runs in — including the live watch engine on the
    // same host. The count-bounded probe is small enough not to need it.
    // The clock lives here, not in the engine: that package reads none, so a
    // replay stays deterministic and the deadline is the host's business.
    ...(byDays ? { shouldYield: heldTooLong(deps.now, REPLAY_YIELD_MS) } : {}),
    // No `store`: the engine builds a fresh in-memory one, so this leaves no
    // cursor, no live instance and no firing behind. No `serializeWrites`
    // either — there is no shared file to take a turn on.
  });
  const trace = await engine.run();
  const reaches = judge.reachCounts();

  // The slice the engine actually RAN over, not the slice that was read. A
  // `once_ever` watch retires when it fires, an expired one stops at its
  // horizon, and a broken one stops where it broke — so reporting the read
  // window would describe a watch's behaviour over a stretch it never saw.
  const ran = journal.slice(0, engine.eventsConsumed);
  const nodes = watch.nodes.map((node) =>
    summariseNode(node, trace.records, reaches[node.id] ?? 0),
  );
  // A candidate that BROKE must never read as a candidate that caught nothing.
  // The engine contains a node failure and pauses rather than throwing, so
  // without this the two come back as the same zero.
  const failures = trace.records
    .filter((record) => record.transition === "failed")
    .map((record) => ({
      nodeId: record.nodeId,
      failure: record.failure ?? "internal",
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    }));
  log.info(
    `preflight over ${journal.length} event(s) for a candidate: ${nodes.reduce((n, node) => n + node.matched, 0)} match(es), ${judge.total} model reach(es)`,
  );

  return {
    outcome: "probed",
    report: {
      window: {
        events: ran.length,
        offered: journal.length,
        fromSeq: ran[0]?.seq ?? afterSeq,
        toSeq: ran[ran.length - 1]?.seq ?? head,
        from: ran[0]?.occurredAt ?? null,
        to: ran[ran.length - 1]?.occurredAt ?? null,
        // Observed span, and the number a reach is read against. Reported from
        // what the replay CONSUMED rather than from what was asked for: a
        // ninety-day request against a journal that only goes back three weeks
        // is a three-week answer, and a caller told "90" would divide by the
        // wrong denominator and call a healthy watch quiet.
        observedMs: observedSpanMs(ran),
        ...(truncated ? { truncated: true as const } : {}),
        ...(byDays ? { daysRequested: days } : {}),
        ...(trace.ended === undefined ? {} : { ended: trace.ended }),
      },
      nodes,
      firings: trace.firings.length,
      ...(failures.length > 0 ? { failed: failures } : {}),
      judgeGated: judge.total > 0 && trace.firings.length === 0,
    },
  };
}

/** Transitions that mean the node took the event up. */
const TOOK_IT_UP: ReadonlySet<TraceRecord["transition"]> = new Set([
  "armed",
  "accumulated",
  "fired",
  "reset",
]);

/** Transitions that mean it looked and let it past. */
const LET_IT_PAST: ReadonlySet<TraceRecord["transition"]> = new Set([
  "ignored",
  "dropped",
  "held",
  "quarantined",
]);

function summariseNode(
  node: WatchNode,
  records: readonly TraceRecord[],
  wouldAsk: number,
): PreflightNode {
  const mine = records.filter((record) => record.nodeId === node.id);
  const matched = mine.filter((record) => TOOK_IT_UP.has(record.transition)).length;
  const declined = mine.filter((record) => LET_IT_PAST.has(record.transition)).length;
  const diagnostics: string[] = [];

  // The three things a reader needs in order not to misread a zero.
  if (mine.length === 0) {
    diagnostics.push(
      "no event in this window reached this node — its filter admitted nothing, or nothing upstream fired",
    );
  }
  if (wouldAsk > 0) {
    diagnostics.push(
      `${wouldAsk} document(s) reached the judge; a probe never asks a model, so nothing downstream of this node fired`,
    );
  }
  if (node.type === "source.document_event" && node.recall?.lexical) {
    // Worth saying every time: a lexical arm reads the journal event's title,
    // and the journal carries no bodies. A zero here means the term is absent
    // from titles, which is a much narrower claim than absent from the corpus.
    diagnostics.push(
      "its lexical arm matches the event title only — the journal carries no bodies",
    );
  }

  return {
    nodeId: node.id,
    type: node.type,
    evaluated: mine.length,
    matched,
    declined,
    wouldAsk,
    samples: mine.slice(-SAMPLES_PER_NODE).map((record) => ({
      seq: record.seq,
      transition: record.transition,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    })),
    diagnostics,
  };
}
