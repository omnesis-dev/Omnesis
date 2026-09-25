// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runtime resolution of the `brain` config block — the Cognition Steward's
 * operator tunables. Mirrors the resolver convention the rest of the
 * gateway uses (`runtime-settings.ts`, `near-dupes/config.ts`): the zod
 * schema keeps every knob optional, and this module applies the effective
 * defaults, so `@omnesis/config`'s `CONFIG_DEFAULTS.brain` display mirror
 * stays a mirror (a cross-check test in this directory keeps it honest).
 *
 * Every duration resolves to plain milliseconds with no floor — a test can
 * compress the 1-hour conversation debounce or the ~1-month decay cap down
 * to single-digit ms. Time *reading* is likewise injectable via the module's
 * `Clock` contract (see `storage/types.ts`); nothing here touches the wall
 * clock.
 */

import { parseDuration } from "@omnesis/core";
import { ONE_HOP_DEFAULT_FANOUT } from "../domain/DocumentGraphService.js";
import type { BrainSettings } from "@omnesis/config";
import type { CognitionBudgetSettings } from "./cognition/budget.js";

/** Effective defaults, config-shaped (durations as human-readable strings). */
export const BRAIN_DEFAULTS = {
  workerConcurrency: 1,
  conversationDebounce: "1h",
  // Max-defer ceilings are derived from their debounce timescales: 6× the 1h
  // conversation debounce and 8× the 30m document debounce — long enough that a
  // genuinely quiet thread still coalesces into one run, short enough that a
  // forever-active thread is guaranteed claimable within part of a day.
  conversationMaxDefer: "6h",
  documentUpdateDebounce: "30m",
  documentMaxDefer: "4h",
  // Ceiling on the readiness barrier's wait. Matches the document debounce:
  // a datum the agent would already have waited 30m to reason about is not
  // made materially less timely by waiting the same span for its edges.
  derivationBarrier: "30m",
  recencyWindow: "7d",
  decay: {
    backoffBase: "1d",
    backoffCap: "30d",
    datedFloor: "12h",
    datedFraction: 0.5,
  },
  dailyRunHour: 5,
  notesMaxBytes: 8192,
  // The proactive lane. Every producer here is ON: each one earned its default
  // by running continuously against a real corpus, and with them off the Brain
  // reacts to arrivals but never notices anything across them. They all still
  // sit behind the brain gate (experimental mode + an assigned background-agent
  // model), which is where the real decision to spend is made.
  //
  // `push` included: the digest is at most one notification a day, and it is
  // the one thing the engine produces that is worth interrupting for. On an
  // install with no registered device it is a clean no-op; where delivery is
  // configured but broken the send fails, is logged once, and is swallowed
  // rather than failing the run that minted the brief. Operators who do not
  // want it set `brain.digest.push: false`.
  awarenessAxis: true,
  synthesis: { enabled: true, cadenceHours: 24, maxPerDay: 1 },
  collision: {
    enabled: true,
    cadenceHours: 24,
    maxPerSweep: 3,
    timeHorizonDays: 60,
    annotationContradictions: { enabled: true, maxPerSweep: 2 },
  },
  digest: { enabled: true, hour: 7, graceMinutes: 45, push: true },
  // Graduated: durable doc/person annotations are on by default under
  // experimental mode. The knob still lets an operator turn them off.
  // Per-basis ceilings tighten confidence the further a claim reasons from
  // its evidence; the floor refuses claims too weak to persist.
  annotations: {
    enabled: true,
    basisCeilings: { quoted: 0.9, inferred: 0.7, synthesized: 0.55 },
    confidenceFloor: 0.25,
  },
  // The re-verification sweep (annotation correctness, pull half). On, because
  // an annotation store nothing re-checks drifts away from its evidence
  // silently. Throughput = maxPerSweep × batchSize annotations per day, so 72
  // here: enough to work through a real annotation store on the 14-day cycle,
  // and still only a dozen runs a day against a drainer that executes non-daily
  // runs strictly serialized.
  reverification: { enabled: true, intervalDays: 14, maxPerSweep: 12, batchSize: 6 },
  // The provenance-recheck sweep (consumption-provenance teeth). Edge RECORDING
  // is always on (mechanical bookkeeping); this knob gates only the recheck runs
  // it triggers, which are what stop a brief or loop resting on a prior that has
  // since died.
  provenanceRecheck: { enabled: true },
  // The brief judge — the push bar. A separate model pass over every candidate
  // brief (ship/no-ship against the four gates), so only what is new, timely,
  // and consequential interrupts the user. On, because the bar carried only as
  // generation-time guidance is the bar a model grades its own work against.
  // Inert until a `brief-judge` model is assigned — with none, it fails open and
  // briefs ship unjudged, exactly as they did before.
  judge: { enabled: true },
  // Merge adjudication — the background agent's verdict pass over pending
  // person-merge candidates. Bounded by construction: one run per candidate,
  // re-run only if the candidate is re-detected, so it cannot accumulate the
  // way a cadence-driven producer can.
  mergeAdjudication: { enabled: true },
  // The retrospective lane. On by default: it covers exactly the documents
  // the real-time waker does not, so with it off a source's history is
  // reviewed by nobody. It still needs the brain gate (experimental mode + an
  // assigned background-agent model) to spend anything, which is where the
  // operator's real decision is made.
  //
  // Because it is on by default, the pace has to be the thing that binds: the
  // cognition spend budget has no default (absent means unlimited), and
  // `maxRuns` is a lifetime backstop set far above any real corpus, so
  // `maxRunsPerDay` is what stands between enabling the Brain and an unbounded
  // historical sweep. 200 full agent runs a day is a day of catch-up in the
  // same order of cost as a day of live cognition, and matches
  // `backlogTarget` — the lane fills the queue once, then waits for the day.
  bootstrap: {
    enabled: true,
    direction: "recent-first" as "recent-first" | "oldest-first",
    backlogTarget: 200,
    maxRunsPerDay: 200,
    maxRuns: 1000000,
    batchSize: 100,
  },
  // The sweep lane — the six built-in themes plus any the operator has
  // written. On for the same reason as the rest: a sweep that never runs is
  // a prompt nobody reads. Individual themes are toggled per sweep rather
  // than through this switch, which turns the whole lane off.
  sweepsEnabled: true,
} as const;

/** The `brain` block resolved to concrete runtime values (durations in ms). */
export interface ResolvedBrainSettings {
  /** Queue workers draining in parallel (non-daily runs serialize regardless). */
  workerConcurrency: number;
  /** Quiet period before new conversation messages enqueue one `data` run. */
  conversationDebounceMs: number;
  /**
   * Ceiling on how long a continuously-active conversation's run may be
   * deferred by folding — its `next_attempt_at` is clamped to
   * `cycle_anchor_at + this`, so it becomes claimable within a bounded time.
   * Always ≥ the conversation debounce (resolver clamps it up).
   */
  conversationMaxDeferMs: number;
  /** Per-document quiet period for updatable documents (edits fold into one run). */
  documentUpdateDebounceMs: number;
  /**
   * Ceiling on how long a continuously-edited document's run may be deferred by
   * folding. Always ≥ the document update debounce (resolver clamps it up).
   */
  documentMaxDeferMs: number;
  /** Recency gate: only documents this fresh (source timestamp) wake the agent. */
  recencyWindowMs: number;
  /**
   * Ceiling on how long a `data` run waits for its datum's deterministic
   * derivation to finish. Past it the run is claimed with an incomplete graph
   * picture, which the prompt states and the drain logs.
   */
  derivationBarrierMs: number;
  /** Daily ceilings on background cognition; `null` per dimension = no limit. */
  budget: CognitionBudgetSettings;
  /** First stale-loop status-check delay for an UNDATED loop; doubles each check. */
  decayBackoffBaseMs: number;
  /** Ceiling on the stale-loop status-check back-off. */
  decayBackoffCapMs: number;
  /** Dense status-check floor for a DATED loop near/past its deadline (never backs off). */
  decayDatedFloorMs: number;
  /** Fraction of the remaining time to a future deadline to wait before the next check. */
  decayDatedFraction: number;
  /** Hour of day (gateway machine local time) the daily runs fire. */
  dailyRunHour: number;
  /**
   * Soft byte cap on the agent-notes memory blob — appends may overshoot up
   * to twice this before writes refuse; a background compaction run restores
   * the blob below the cap.
   */
  notesMaxBytes: number;
  /**
   * 1-hop neighbour fanout used to gather a datum's thread/linked-doc
   * reconcile candidates (the identity search's `expandOneHop` per seed doc).
   * Derived — mirrors the graph service's own `ONE_HOP_DEFAULT_FANOUT`.
   */
  reconcileNeighborFanout: number;
  /**
   * Window around a datum's date within which a loop's deadline counts as a
   * reconcile signal. Derived as twice the recency window — a datum landing
   * this close to a tracked deadline is plausibly about that loop.
   */
  reconcileDeadlineWindowMs: number;
  /**
   * Max own-loops the delta-prime block lists on a per-source `daily` or a
   * digest run — a display cap keeping the injected block bounded.
   */
  primeMaxLoops: number;
  /** Max chars of a loop's ledger tail rendered in the delta-prime block. */
  primeLedgerChars: number;
  /** Max recent-decision lines the delta-prime block lists. */
  primeMaxDecisions: number;
  // ── proactive lane ────────────────────────────────────────────────────────
  /**
   * Add a second, non-obligation evaluation axis (connections / trends / gaps
   * worth surfacing even when the user participated) to the `daily` prompt.
   * Off ⇒ the daily prompt carries the obligation axis alone. The `synthesis` pass is
   * an awareness lane by design and always carries the axis when it runs.
   */
  awarenessAxis: boolean;
  /** The periodic synthesis ("Noticing") pass. */
  synthesis: {
    /** Producer runs only when true (checked live per rhythm tick). */
    enabled: boolean;
    /** Minimum hours between synthesis passes. */
    cadenceHours: number;
    /** Hard cap on synthesis passes enqueued per local day. */
    maxPerDay: number;
  };
  /** The cross-loop collision sweep (seeds `synthesis` collision runs). */
  collision: {
    /** Producer runs only when true (checked live per rhythm tick). */
    enabled: boolean;
    /** Minimum hours between collision sweeps. */
    cadenceHours: number;
    /** Max model-costing collision-judge runs enqueued per sweep. */
    maxPerSweep: number;
    /** Forward horizon (days) for temporal-annotation interval collisions. */
    timeHorizonDays: number;
    /** The annotation-contradiction arm (its own gate + per-sweep budget). */
    annotationContradictions: {
      /** Arm runs only when true (checked live per rhythm tick). */
      enabled: boolean;
      /** Max annotation-contradiction judge runs enqueued per sweep. */
      maxPerSweep: number;
    };
  };
  /** The composed morning digest + its push tier. */
  digest: {
    /** Producer runs only when true (checked live per rhythm tick). */
    enabled: boolean;
    /** Local hour (0-23) the digest composes at. */
    hour: number;
    /** Minutes past the hour the readiness barrier waits before composing anyway. */
    graceMinutes: number;
    /** Push the digest to paired iOS devices (at most one per day). */
    push: boolean;
  };
  /** The durable doc-annotation layer. */
  annotations: { enabled: boolean };
  /** The re-verification sweep (annotation correctness, pull half). */
  reverification: {
    /** Producer runs only when true (checked live per rhythm tick). */
    enabled: boolean;
    /** Days after which a verification stamp counts as stale. */
    intervalDays: number;
    /** Max verification runs enqueued per daily sweep. */
    maxPerSweep: number;
    /** Annotations re-checked per run (one store per run). */
    batchSize: number;
  };
  /** The provenance-recheck sweep (consumption-provenance teeth). */
  provenanceRecheck: {
    /** Producer runs only when true (checked live per rhythm tick). */
    enabled: boolean;
  };
  /** The push bar — a ship/no-ship judge pass over every candidate brief. */
  judge: {
    /** The judge runs only when true (read live per brief_create). */
    enabled: boolean;
  };
  /** Background-agent adjudication of pending person-merge candidates. */
  mergeAdjudication: {
    /** The enqueue pass runs only when true (checked live per rhythm tick). */
    enabled: boolean;
  };
  /** The retrospective bootstrap lane (historical temporal-annotation / loop seeding). */
  bootstrap: {
    /** Producer runs only when true (checked live per enqueuer tick). */
    enabled: boolean;
    /** Order the historical corpus is walked. */
    direction: "recent-first" | "oldest-first";
    /** Max pending bootstrap runs kept queued at once. */
    backlogTarget: number;
    /** Daily cap on bootstrap runs enqueued — the lane's pace, and its spend ceiling. */
    maxRunsPerDay: number;
    /** Lifetime run backstop; parks the lane rather than ending it. */
    maxRuns: number;
    /** Documents enqueued per enqueuer tick. */
    batchSize: number;
    /**
     * Optional daily window, local wall-clock, during which the lane may buy
     * work. Absent means always. See `bootstrap-window.ts`.
     */
    activeHours?: { from: string; to: string };
  };
  /** Master switch for the built-in scheduled sweep themes. */
  sweepsEnabled: boolean;
  /**
   * Trailing window (ms) the synthesis "Noticing" pass reflects over and the
   * span of recent annotations surfaced as priors. Derived = the recency
   * window (no operator knob).
   */
  synthesisLookbackMs: number;
  /** Max recent live annotations the synthesis delta-prime lists as priors. */
  primeMaxAnnotations: number;
  /**
   * Hard ceiling on an annotation's confidence — nothing derived is ever
   * certain, so a re-read of one's own past conclusion can never claim more.
   * Applied AFTER the per-basis ceiling (the global cap of the two-stage clamp).
   */
  annotationConfidenceCeiling: number;
  /**
   * Per-claim-basis confidence ceilings — the further a claim reasons from
   * its evidence (quoted → inferred → synthesized), the lower its recorded
   * confidence may go.
   */
  annotationBasisCeilings: { quoted: number; inferred: number; synthesized: number };
  /**
   * Abstention floor: a new annotation whose post-clamp confidence falls
   * below this is refused outright — a claim that weak is not worth keeping
   * as a prior.
   */
  annotationConfidenceFloor: number;
}

/** Apply defaults to an operator's (possibly absent) `brain` config block. */
export function resolveBrainSettings(settings?: BrainSettings): ResolvedBrainSettings {
  const conversationDebounceMs = parseDuration(
    settings?.conversationDebounce ?? BRAIN_DEFAULTS.conversationDebounce,
  );
  const documentUpdateDebounceMs = parseDuration(
    settings?.documentUpdateDebounce ?? BRAIN_DEFAULTS.documentUpdateDebounce,
  );
  const recencyWindowMs = parseDuration(settings?.recencyWindow ?? BRAIN_DEFAULTS.recencyWindow);
  const derivationBarrierMs = parseDuration(
    settings?.derivationBarrier ?? BRAIN_DEFAULTS.derivationBarrier,
  );
  // Absent = no ceiling. There is no default budget: inventing one would
  // silently stop an operator's Brain at a number nobody chose.
  const budget = {
    dailyTokens: settings?.budget?.dailyTokens ?? null,
    dailyRuns: settings?.budget?.dailyRuns ?? null,
  };
  return {
    workerConcurrency: settings?.workerConcurrency ?? BRAIN_DEFAULTS.workerConcurrency,
    conversationDebounceMs,
    // A ceiling below its debounce is nonsensical (it would clamp the very
    // first fold below the intended quiet period) — floor each up to its
    // debounce so the guarantee is always "≥ debounce, ≤ ceiling".
    conversationMaxDeferMs: Math.max(
      conversationDebounceMs,
      parseDuration(settings?.conversationMaxDefer ?? BRAIN_DEFAULTS.conversationMaxDefer),
    ),
    documentUpdateDebounceMs,
    documentMaxDeferMs: Math.max(
      documentUpdateDebounceMs,
      parseDuration(settings?.documentMaxDefer ?? BRAIN_DEFAULTS.documentMaxDefer),
    ),
    recencyWindowMs,
    derivationBarrierMs,
    budget,
    decayBackoffBaseMs: parseDuration(
      settings?.decay?.backoffBase ?? BRAIN_DEFAULTS.decay.backoffBase,
    ),
    decayBackoffCapMs: parseDuration(
      settings?.decay?.backoffCap ?? BRAIN_DEFAULTS.decay.backoffCap,
    ),
    decayDatedFloorMs: parseDuration(
      settings?.decay?.datedFloor ?? BRAIN_DEFAULTS.decay.datedFloor,
    ),
    decayDatedFraction: settings?.decay?.datedFraction ?? BRAIN_DEFAULTS.decay.datedFraction,
    dailyRunHour: settings?.dailyRunHour ?? BRAIN_DEFAULTS.dailyRunHour,
    notesMaxBytes: settings?.notesMaxBytes ?? BRAIN_DEFAULTS.notesMaxBytes,
    // Derived (no operator knob): the neighbour fanout mirrors the graph
    // service's default, the deadline window is twice the recency gate.
    reconcileNeighborFanout: ONE_HOP_DEFAULT_FANOUT,
    reconcileDeadlineWindowMs: recencyWindowMs * 2,
    // Derived delta-prime display caps (no operator knob) — bound the "your
    // current model" block injected into the low-frequency runs to a few hundred
    // prompt tokens, consistent with the other fixed display caps.
    primeMaxLoops: 12,
    primeLedgerChars: 160,
    primeMaxDecisions: 10,
    // ── proactive lane ──────────────────────────────────────────────────────
    awarenessAxis: settings?.awarenessAxis ?? BRAIN_DEFAULTS.awarenessAxis,
    synthesis: {
      enabled: settings?.synthesis?.enabled ?? BRAIN_DEFAULTS.synthesis.enabled,
      cadenceHours: settings?.synthesis?.cadenceHours ?? BRAIN_DEFAULTS.synthesis.cadenceHours,
      maxPerDay: settings?.synthesis?.maxPerDay ?? BRAIN_DEFAULTS.synthesis.maxPerDay,
    },
    collision: {
      enabled: settings?.collision?.enabled ?? BRAIN_DEFAULTS.collision.enabled,
      cadenceHours: settings?.collision?.cadenceHours ?? BRAIN_DEFAULTS.collision.cadenceHours,
      maxPerSweep: settings?.collision?.maxPerSweep ?? BRAIN_DEFAULTS.collision.maxPerSweep,
      timeHorizonDays:
        settings?.collision?.timeHorizonDays ?? BRAIN_DEFAULTS.collision.timeHorizonDays,
      annotationContradictions: {
        enabled:
          settings?.collision?.annotationContradictions?.enabled ??
          BRAIN_DEFAULTS.collision.annotationContradictions.enabled,
        maxPerSweep:
          settings?.collision?.annotationContradictions?.maxPerSweep ??
          BRAIN_DEFAULTS.collision.annotationContradictions.maxPerSweep,
      },
    },
    digest: {
      enabled: settings?.digest?.enabled ?? BRAIN_DEFAULTS.digest.enabled,
      hour: settings?.digest?.hour ?? BRAIN_DEFAULTS.digest.hour,
      graceMinutes: settings?.digest?.graceMinutes ?? BRAIN_DEFAULTS.digest.graceMinutes,
      push: settings?.digest?.push ?? BRAIN_DEFAULTS.digest.push,
    },
    annotations: {
      enabled: settings?.annotations?.enabled ?? BRAIN_DEFAULTS.annotations.enabled,
    },
    annotationBasisCeilings: {
      quoted:
        settings?.annotations?.basisCeilings?.quoted ??
        BRAIN_DEFAULTS.annotations.basisCeilings.quoted,
      inferred:
        settings?.annotations?.basisCeilings?.inferred ??
        BRAIN_DEFAULTS.annotations.basisCeilings.inferred,
      synthesized:
        settings?.annotations?.basisCeilings?.synthesized ??
        BRAIN_DEFAULTS.annotations.basisCeilings.synthesized,
    },
    annotationConfidenceFloor:
      settings?.annotations?.confidenceFloor ?? BRAIN_DEFAULTS.annotations.confidenceFloor,
    reverification: {
      enabled: settings?.reverification?.enabled ?? BRAIN_DEFAULTS.reverification.enabled,
      intervalDays:
        settings?.reverification?.intervalDays ?? BRAIN_DEFAULTS.reverification.intervalDays,
      maxPerSweep:
        settings?.reverification?.maxPerSweep ?? BRAIN_DEFAULTS.reverification.maxPerSweep,
      batchSize: settings?.reverification?.batchSize ?? BRAIN_DEFAULTS.reverification.batchSize,
    },
    provenanceRecheck: {
      enabled: settings?.provenanceRecheck?.enabled ?? BRAIN_DEFAULTS.provenanceRecheck.enabled,
    },
    judge: {
      enabled: settings?.judge?.enabled ?? BRAIN_DEFAULTS.judge.enabled,
    },
    mergeAdjudication: {
      enabled: settings?.mergeAdjudication?.enabled ?? BRAIN_DEFAULTS.mergeAdjudication.enabled,
    },
    bootstrap: {
      enabled: settings?.bootstrap?.enabled ?? BRAIN_DEFAULTS.bootstrap.enabled,
      direction: settings?.bootstrap?.direction ?? BRAIN_DEFAULTS.bootstrap.direction,
      backlogTarget: settings?.bootstrap?.backlogTarget ?? BRAIN_DEFAULTS.bootstrap.backlogTarget,
      maxRunsPerDay: settings?.bootstrap?.maxRunsPerDay ?? BRAIN_DEFAULTS.bootstrap.maxRunsPerDay,
      maxRuns: settings?.bootstrap?.maxRuns ?? BRAIN_DEFAULTS.bootstrap.maxRuns,
      batchSize: settings?.bootstrap?.batchSize ?? BRAIN_DEFAULTS.bootstrap.batchSize,
      // No default: absent means the lane may buy at any hour, which is not a
      // window with wide bounds but the absence of one — a distinction the
      // surfaces rely on to say "no restriction" rather than "00:00-00:00".
      ...(settings?.bootstrap?.activeHours ? { activeHours: settings.bootstrap.activeHours } : {}),
    },
    sweepsEnabled: settings?.sweepsEnabled ?? BRAIN_DEFAULTS.sweepsEnabled,
    // Derived (no operator knob): the noticing pass reflects over the recency
    // window; the annotation prime and confidence ceiling are fixed caps.
    synthesisLookbackMs: recencyWindowMs,
    primeMaxAnnotations: 12,
    annotationConfidenceCeiling: 0.9,
  };
}
