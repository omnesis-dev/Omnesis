// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read-only observability for the retrospective bootstrap lane.
 *
 * The lane keeps its whole lifecycle in `cognition_engine_state` — six keys the
 * enqueuer reads and writes on every pass — and none of it reached any surface.
 * An install could sit `parked` indefinitely with a backlog it would never
 * touch, and the only evidence was a log line printed once, months earlier.
 * This module turns that state into something a route can serve.
 *
 * Nothing here writes. The lane is not modified, notified, or paced by being
 * observed: every figure is derived from state the enqueuer already maintains
 * for its own reasons.
 *
 * **The cost boundary is the point of the split.** Most of what an operator
 * needs is a handful of key reads and an indexed count — cheap enough to poll.
 * The one figure they want most, "how much is left", is not: it is a scan of
 * the unprocessed half of `documents` with a correlated subquery and a
 * `json_extract` per surviving row, measured at ~6 seconds on a 170k-document
 * corpus. So the backlog probe lives behind {@link CachedScanProbe},
 * which caches it and stamps every answer with when it was computed. A caller
 * that wants a live dashboard gets the cheap half; the expensive half is
 * explicitly a snapshot, and says so on the wire.
 */

import { countBootstrapProcessed, latestSourceCreatedAt } from "./storage/bootstrap.js";
import {
  getCognitionEngineState,
  cognitionBootstrapEnqueuedKey,
  COGNITION_BOOTSTRAP_DRAINED_DAY_KEY,
  COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY,
  COGNITION_BOOTSTRAP_HOLD_SINCE_KEY,
  COGNITION_BOOTSTRAP_STATE_KEY,
  COGNITION_BOOTSTRAP_STARTED_AT_KEY,
  COGNITION_BOOTSTRAP_TOTAL_KEY,
} from "./storage/engine-state.js";
import { countDueAboveBacklogRank } from "./storage/run-queue.js";
import { BOOTSTRAP_BOOT_GRACE_MS, bootstrapReopenReason } from "./rhythm/bootstrap-enqueuer.js";
import { cognitionSpendDay } from "./storage/spend.js";
import {
  PROVIDER_BREAKER_ERROR_KEY,
  PROVIDER_BREAKER_FAILURES_KEY,
  PROVIDER_BREAKER_OPEN_UNTIL_KEY,
} from "./provider-breaker.js";
import { bootstrapWindowOpen, bootstrapWindowOpensAt } from "./bootstrap-window.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The resolved knobs the lane runs under, as an observer needs to see them. */
export interface BootstrapSettingsView {
  enabled: boolean;
  direction: "recent-first" | "oldest-first";
  backlogTarget: number;
  maxRunsPerDay: number;
  maxRuns: number;
  batchSize: number;
  recencyWindowMs: number;
  /** Optional daily window the lane may buy work in; absent means always. */
  activeHours?: { from: string; to: string };
}

/**
 * What the lane is doing, in the vocabulary an operator can act on.
 *
 * `running` / `drained` / `parked` are the enqueuer's own durable states.
 * `off` and `holding` are derived here rather than stored, because the lane
 * has no reason to record either: `off` is simply the knob, and `holding` is a
 * comparison against the boot window that the enqueuer performs inline.
 *
 * `waiting` is the lane quiet on a clock rather than on a decision: either
 * outside its active window, or with the day's allowance spent and nothing
 * left queued. Both resolve themselves without an operator.
 */
export type BootstrapLaneState =
  | "unstarted"
  | "off"
  | "holding"
  | "waiting"
  | "running"
  | "drained"
  | "parked";

export interface BootstrapStatus {
  settings: BootstrapSettingsView;
  state: BootstrapLaneState;
  /** One sentence naming what would change the state, for a surface to show verbatim. */
  reason: string;
  /** When the current boot hold began, and when it lifts. Null when not holding. */
  holdSince: number | null;
  holdEndsAt: number | null;
  /** What the lane knew when it last went quiet — the two facts that would wake it. */
  drainedDay: string | null;
  drainedSourceWatermark: number | null;
  /** The live source-roster high-water mark; null on an install with no sources. */
  sourceWatermark: number | null;
  /** The local day the counters below are scoped to, and the counters. */
  day: string;
  enqueuedToday: number;
  totalEnqueued: number;
  /** Bootstrap runs by status. The queue is shared, so these are kind-filtered. */
  runs: { pending: number; completed: number; failed: number };
  /**
   * Bootstrap runs that actually completed in the last 24 hours.
   *
   * The drainer works one bootstrap run at a time, so there is a throughput
   * ceiling well below any cap an operator can type — and above it
   * `maxRunsPerDay` stops meaning anything. Measured rather than asserted,
   * because the real figure depends on this install's model, corpus and
   * competing work, and a constant would be wrong on every machine but one.
   */
  completedLast24h: number;
  /** Documents carrying the processed marker, by any of the three paths that set it. */
  processedDocs: number;
  /** The instant the lane would compare a datum against on its next pass. */
  recencyFloor: string;
  /**
   * Runs that are due now and outrank the backlog kinds.
   *
   * While this is non-zero the lane receives no drain capacity: its runs are
   * due and claimable and simply never reached, because the drainer claims
   * strictly by rank. Intended — a backfill must never delay a reaction — but
   * a lane that reports itself as running while completing nothing for hours
   * is a stall an operator cannot otherwise see.
   */
  blockedByHigherPriority: number;
  /**
   * The model backend refusing every call, when the drainer has stopped
   * claiming because of it. Null whenever work can be claimed.
   *
   * Not a property of this lane — the breaker guards every kind of run — but
   * reported here because a stopped backend stops this lane, and a panel that
   * showed a healthy `running` state while nothing could execute would be
   * lying by omission.
   */
  providerOutage: { openUntil: number; consecutiveFailures: number; lastError: string } | null;
}

/**
 * A stored numeric marker, or null when it is absent or unparseable.
 *
 * Distinguishing the two matters: the enqueuer treats an ABSENT source
 * watermark as a reason to re-probe rather than stay quiet, so a surface that
 * reported a garbled value as `0` would imply a quiet lane had a basis for
 * being quiet when it did not.
 */
function finiteOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface RunCountRow {
  status: string;
  n: number;
}

/**
 * Bootstrap runs grouped by status. Served by the kind-leading index plus a
 * per-row fetch and a temp b-tree for the grouping — cheap at this table's
 * size, but not the covering read the `(status, kind)` index would be if the
 * columns were the other way round.
 */
/**
 * Completed bootstrap runs since an instant. Settled rows are pruned past the
 * retention window, so this is only honest over a short horizon — a day is
 * well inside it.
 */
function bootstrapCompletedSince(db: Db, since: number): number {
  return db
    .prepare<
      [number],
      { n: number }
    >("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'bootstrap' AND status = 'completed' AND completed_at >= ?")
    .get(since)!.n;
}

function bootstrapRunCounts(db: Db): { pending: number; completed: number; failed: number } {
  const rows = db
    .prepare<
      [],
      RunCountRow
    >("SELECT status, COUNT(*) AS n FROM cognition_runs WHERE kind = 'bootstrap' GROUP BY status")
    .all();
  const by = new Map(rows.map((r) => [r.status, r.n]));
  return {
    pending: by.get("pending") ?? 0,
    completed: by.get("completed") ?? 0,
    failed: by.get("failed") ?? 0,
  };
}

/**
 * Why the lane is where it is, phrased so the sentence names the thing to
 * change. A state with no actionable cause still gets a sentence: silence is
 * what this whole module exists to remove.
 */
function describe(
  state: BootstrapLaneState,
  s: BootstrapSettingsView,
  facts: {
    totalEnqueued: number;
    enqueuedToday: number;
    holdEndsAt: number | null;
    now: number;
    reopen: string | null;
    pendingRuns: number;
    blockedBy: number;
  },
): string {
  switch (state) {
    case "unstarted":
      return "Not started. Reviewing your history is a separate decision from choosing a model, so the lane waits for you to begin it.";
    case "off":
      return "Paused (brain.bootstrap.enabled is off). Resuming picks up exactly where it stopped — nothing already reviewed is re-read.";
    case "holding": {
      const left = Math.max(0, (facts.holdEndsAt ?? facts.now) - facts.now);
      const mins = Math.ceil(left / 60_000);
      return `Holding off after a restart — the first pass runs in about ${mins} minute${mins === 1 ? "" : "s"}. The backfill workers are busiest on the same handle just after a start.`;
    }
    case "parked":
      return `Stopped at its lifetime run backstop (${facts.totalEnqueued.toLocaleString()} of ${s.maxRuns.toLocaleString()}). Raise brain.bootstrap.maxRuns to resume — the ceiling is re-read live, so no restart is needed.`;
    case "drained":
      return "Nothing left to review. The lane reopens on its own when a new local day begins, or when a source is added.";
    case "waiting": {
      // Two conditions make the lane quiet on a clock. The window is the more
      // specific of the two, so it names itself before the allowance does.
      if (bootstrapWindowOpen(s.activeHours, facts.now)) {
        return allowanceSpentReason(s, facts);
      }
      const opensAt = bootstrapWindowOpensAt(s.activeHours, facts.now);
      const mins = opensAt === null ? 0 : Math.ceil(Math.max(0, opensAt - facts.now) / 60_000);
      const when =
        mins >= 120
          ? `in about ${Math.round(mins / 60)} hours`
          : `in about ${mins} minute${mins === 1 ? "" : "s"}`;
      return `Outside its window (${s.activeHours?.from}–${s.activeHours?.to}). It buys work again ${when}. Runs already queued keep executing — the window governs what the lane commits, not what it finishes.`;
    }
    // A lane whose stored state is `drained` but whose reopen condition already
    // holds is reported as `running`, and lands on the branch below.
    case "running":
      if (facts.reopen !== null) {
        return `Reopening — ${facts.reopen}. The next pass will probe the corpus again.`;
      }
      // Queued work it cannot reach outranks every other thing worth saying
      // about a running lane: the pace, the allowance and the backlog are all
      // beside the point while the drainer is never getting to it.
      if (facts.pendingRuns > 0 && facts.blockedBy > 0) {
        return `Waiting for drain capacity — ${facts.blockedBy.toLocaleString()} higher-priority run${facts.blockedBy === 1 ? " is" : "s are"} due ahead of it, and reactions are always claimed first. Its own ${facts.pendingRuns.toLocaleString()} queued run${facts.pendingRuns === 1 ? "" : "s"} resume when that clears.`;
      }
      return facts.enqueuedToday >= s.maxRunsPerDay
        ? allowanceSpentReason(s, facts)
        : "Working through history at its configured pace.";
  }
}

/**
 * The day's allowance, spent.
 *
 * Reached from two states: `waiting`, once the lane has nothing queued and so
 * commits nothing more until the local day turns, and `running`, while runs it
 * committed earlier today are still draining.
 */
function allowanceSpentReason(
  s: { maxRunsPerDay: number },
  facts: { enqueuedToday: number },
): string {
  return `Today's allowance is spent (${facts.enqueuedToday.toLocaleString()} of ${s.maxRunsPerDay.toLocaleString()}). It resumes on the next local day; raise brain.bootstrap.maxRunsPerDay to converge faster.`;
}

/**
 * Assemble the cheap half of the lane's status.
 *
 * Every read here is a key lookup, an indexed count, or a grouped count over
 * the bootstrap runs — safe to poll. `startedAt` is the process start the boot
 * hold is measured against, and `now` comes from the caller so a virtual clock
 * stays authoritative.
 */
export function readBootstrapStatus(
  db: Db,
  settings: BootstrapSettingsView,
  opts: { now: number; startedAt: number },
): BootstrapStatus {
  const { now, startedAt } = opts;
  const stored = getCognitionEngineState(db, COGNITION_BOOTSTRAP_STATE_KEY);
  const holdSinceRaw =
    Number(getCognitionEngineState(db, COGNITION_BOOTSTRAP_HOLD_SINCE_KEY) ?? "0") || 0;
  const day = cognitionSpendDay(now);
  const enqueuedToday =
    Number(getCognitionEngineState(db, cognitionBootstrapEnqueuedKey(day)) ?? "0") || 0;
  const totalEnqueued =
    Number(getCognitionEngineState(db, COGNITION_BOOTSTRAP_TOTAL_KEY) ?? "0") || 0;
  const drainedDay = getCognitionEngineState(db, COGNITION_BOOTSTRAP_DRAINED_DAY_KEY);
  const drainedSourcesRaw = getCognitionEngineState(db, COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY);

  // The hold is bounded by wall clock, the same comparison the enqueuer makes:
  // a pass defers while the process is young AND the stamped hold is younger
  // than the window, so a restart loop cannot extend it indefinitely.
  const holding =
    settings.enabled &&
    now - startedAt < BOOTSTRAP_BOOT_GRACE_MS &&
    (holdSinceRaw === 0 || now - holdSinceRaw < BOOTSTRAP_BOOT_GRACE_MS);

  // Two of these are decided LIVE rather than read from the stored key, for
  // the same reason the enqueuer decides them live: the stored value records
  // what the last pass concluded, and the operator changes the inputs between
  // passes. Reading `bootstrap_state` alone would mean the panel says `parked`
  // for up to a tick after the operator does exactly what it told them to —
  // and says `running` after they lower the ceiling under a lane that is
  // already past it.
  //
  //  - parked: `totalEnqueued >= maxRuns`, the enqueuer's own comparison.
  //  - drained: the stored state AND no reopen reason. A lane whose day has
  //    turned, or whose source roster has grown, will probe on its next pass;
  //    calling that quiet is a lie with a shelf life of one tick.
  //
  // Precedence: `off` and `parked` outrank a hold because both need an
  // operator and both outlive it, while a hold resolves itself. Ranking them
  // the other way would hide the one state that never fixes itself behind one
  // that always does, for ten minutes after every restart. A hold still masks
  // `drained` and `running`, which ask nothing of anyone.
  const runCounts = bootstrapRunCounts(db);
  const blockedByHigherPriority = countDueAboveBacklogRank(db, now);
  const parked = totalEnqueued >= settings.maxRuns;
  const reopen = stored === "drained" ? bootstrapReopenReason(db, day) : null;
  // Outside its window the lane is deliberately quiet, which must read as
  // neither `running` (it is buying nothing) nor a fault. Derived from the
  // clock rather than stored, for the same reason the boot hold is: it is a
  // fact about now, and a stored copy could only disagree with it. It sits
  // below `drained`, because a lane with nothing left to do is quiet for a
  // reason the window does not change.
  const windowShut = settings.enabled && !bootstrapWindowOpen(settings.activeHours, now);
  // The day's allowance is the same kind of quiet as a shut window: the lane
  // has committed everything it may commit today and buys nothing more until
  // the local day turns. Gated on having nothing queued, because the allowance
  // governs what the lane commits, not what it finishes — while its own runs
  // are still draining it is genuinely working, and calling that `waiting`
  // would also hide the drain-capacity diagnosis behind a clock.
  const allowanceSpent =
    settings.enabled && runCounts.pending === 0 && enqueuedToday >= settings.maxRunsPerDay;
  // Never started, which is not the same as paused: one is an install waiting
  // for a decision, the other an operator who made one. Shown ahead of every
  // other state because until it is resolved none of them apply.
  const started = getCognitionEngineState(db, COGNITION_BOOTSTRAP_STARTED_AT_KEY) !== null;
  const state: BootstrapLaneState = !started
    ? "unstarted"
    : !settings.enabled
      ? "off"
      : parked
        ? "parked"
        : holding
          ? "holding"
          : stored === "drained" && reopen === null
            ? "drained"
            : windowShut || allowanceSpent
              ? "waiting"
              : "running";

  // Reported whenever a hold is genuinely in effect, even if `state` shows
  // something more actionable — a surface may still want to say "and it is
  // inside its boot window".
  // Whichever bound arrives first, matching the enqueuer: it defers while the
  // process is young AND the stamp is young, so the hold ends at the earlier
  // of the two windows rather than at the stamped one alone.
  const holdEndsAt = holding
    ? Math.min(
        startedAt + BOOTSTRAP_BOOT_GRACE_MS,
        (holdSinceRaw || startedAt) + BOOTSTRAP_BOOT_GRACE_MS,
      )
    : null;

  return {
    settings,
    state,
    reason: describe(state, settings, {
      totalEnqueued,
      enqueuedToday,
      holdEndsAt,
      now,
      reopen,
      pendingRuns: runCounts.pending,
      blockedBy: blockedByHigherPriority,
    }),
    holdSince: holding && holdSinceRaw !== 0 ? holdSinceRaw : null,
    holdEndsAt,
    drainedDay,
    drainedSourceWatermark: finiteOrNull(drainedSourcesRaw),
    // Null rather than 0 on an install with no sources: the DTO runs this
    // through `iso()`, and a zero would render as 1970 rather than "none".
    sourceWatermark: latestSourceCreatedAt(db) || null,
    day,
    enqueuedToday,
    totalEnqueued,
    runs: runCounts,
    completedLast24h: bootstrapCompletedSince(db, now - 86_400_000),
    processedDocs: countBootstrapProcessed(db),
    recencyFloor: new Date(now - settings.recencyWindowMs).toISOString(),
    providerOutage: readProviderOutage(db, now),
    blockedByHigherPriority,
  };
}

/**
 * The breaker's mirrored state, reported only while it is actually holding
 * work back.
 *
 * The keys persist after the breaker closes — nothing prunes them — so an
 * elapsed `openUntil` is the normal resting state and must read as "no
 * outage", not as a stale alarm.
 */
function readProviderOutage(db: Db, now: number): BootstrapStatus["providerOutage"] {
  const openUntil = finiteOrNull(getCognitionEngineState(db, PROVIDER_BREAKER_OPEN_UNTIL_KEY)) ?? 0;
  if (openUntil <= now) return null;
  return {
    openUntil,
    consecutiveFailures:
      finiteOrNull(getCognitionEngineState(db, PROVIDER_BREAKER_FAILURES_KEY)) ?? 0,
    lastError: getCognitionEngineState(db, PROVIDER_BREAKER_ERROR_KEY) ?? "",
  };
}

/**
 * The backlog, and the date-extraction progress that governs it.
 *
 * These two travel together on purpose. A document that has not been
 * date-scanned yet carries no extracted dates, so it cannot satisfy the lane's
 * future-date predicate and is invisible to `remaining`. As the scan drains,
 * previously-invisible documents ENTER the candidate set — so `remaining`
 * rises while `dateScanPending` is non-zero, and a falling `remaining` against
 * a non-zero scan backlog is not progress. Serving one without the other would
 * invite exactly that misreading.
 */
export interface BootstrapBacklog {
  /** Candidates the lane would still buy, at this instant's recency floor. */
  remaining: number;
  /** Documents not yet visited by the deterministic date extractor. */
  dateScanPending: number;
  /** Documents it has visited, whether or not it stored a date for them. */
  dateScanned: number;
  /** When this snapshot was computed. It is a snapshot, not a live figure. */
  computedAt: number;
}

/**
 * A cached backlog probe.
 *
 * The count behind it is the most expensive read in the lane — a scan of the
 * unprocessed half of `documents`, a `json_extract` per surviving row and a
 * correlated subquery into `document_extracted_dates`. The enqueuer itself
 * guards it: both of its room checks sit ahead of the probe, and a drained
 * lane skips it entirely. An observability surface has to be at least as
 * careful, because a portal polling it every minute would spend a tenth of a
 * background worker on a number that changes slowly by nature.
 *
 * So: computed at most once per TTL, shared across callers, and every answer
 * carries `computedAt` so the surface can date it rather than implying it is
 * live. In-flight requests share one promise; a failure is not cached.
 */
export class CachedScanProbe<T extends { computedAt: number }> {
  private cached: T | null = null;
  private inFlight: Promise<T> | null = null;

  constructor(
    private readonly compute: () => Promise<T>,
    /** Public so a response can tell a client when asking again would recompute. */
    readonly ttlMs: number,
    private readonly clock: () => number,
  ) {}

  /** The cached snapshot if it is inside the TTL, else null. */
  peek(): T | null {
    if (!this.cached) return null;
    return this.clock() - this.cached.computedAt < this.ttlMs ? this.cached : null;
  }

  /** The snapshot, recomputing only when the cache has expired. */
  async get(): Promise<T> {
    const fresh = this.peek();
    if (fresh) return fresh;
    // Collapse concurrent misses onto one computation: two portal tabs opening
    // together must not both pay for the scan.
    this.inFlight ??= this.compute()
      .then((value) => {
        this.cached = value;
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/**
 * The io-worker slice this module needs. Declared here rather than importing
 * the whole gate so the module stays testable with a two-line fake.
 */
export interface BootstrapTimelineReader {
  bootstrapCorpusByMonth(
    recencyFloor: string,
    todayIso: string,
  ): Promise<BootstrapTimeline["months"]>;
}

/**
 * Read the corpus month by month, off the main event loop for the same reason
 * the backlog is: it is a grouped scan of the same population.
 *
 * `computedAt` is stamped on completion, like the backlog's, so a scan slower
 * than its own cache TTL cannot produce a snapshot that is already stale when
 * stored.
 */
export async function readBootstrapTimeline(
  io: BootstrapTimelineReader,
  opts: { now: () => number; recencyWindowMs: number },
): Promise<BootstrapTimeline> {
  const recencyFloor = new Date(opts.now() - opts.recencyWindowMs).toISOString();
  // The "still relevant" test the lane itself applies: a date at or after
  // today. Passed in rather than left to SQL's `date('now')` so a virtual
  // clock stays authoritative here too.
  const todayIso = new Date(opts.now()).toISOString().slice(0, 10);
  const months = await io.bootstrapCorpusByMonth(recencyFloor, todayIso);
  return { months, computedAt: opts.now() };
}

export interface BootstrapBacklogReader {
  bootstrapBacklog(recencyFloor: string): Promise<{
    remaining: number;
    dateScanPending: number;
    corpusTotal: number;
  }>;
}

/**
 * Read the backlog and the scan progress that qualifies it — off the main
 * event loop, because the count is a corpus scan and the caller is observing
 * a lane that runs on that same loop.
 *
 * `computedAt` is stamped on COMPLETION, not on entry. Stamping at entry would
 * mean a scan slower than the cache's TTL produced a snapshot already expired
 * when stored, and one poller would then hold the worker in a permanent scan
 * loop — precisely on the large, encrypted installs where the scan is slowest.
 */
export async function readBootstrapBacklog(
  io: BootstrapBacklogReader,
  opts: { now: () => number; recencyWindowMs: number },
): Promise<BootstrapBacklog> {
  const recencyFloor = new Date(opts.now() - opts.recencyWindowMs).toISOString();
  const r = await io.bootstrapBacklog(recencyFloor);
  return {
    remaining: r.remaining,
    dateScanPending: r.dateScanPending,
    // Derived, because counting the scanned side directly is a full table
    // scan: the partial indexes cover only `dates_extracted_at IS NULL`.
    dateScanned: Math.max(0, r.corpusTotal - r.dateScanPending),
    computedAt: opts.now(),
  };
}

/** The backlog count, cached — a `CachedScanProbe` over {@link BootstrapBacklog}. */
export type BootstrapBacklogProbe = CachedScanProbe<BootstrapBacklog>;

/** One month-by-month snapshot of the corpus, dated like every other scan. */
export interface BootstrapTimeline {
  months: Array<{
    month: string;
    unscanned: number;
    discarded: number;
    owed: number;
    reviewed: number;
    failed: number;
  }>;
  computedAt: number;
}

/** The month-by-month scan, cached. */
export type BootstrapTimelineProbe = CachedScanProbe<BootstrapTimeline>;
