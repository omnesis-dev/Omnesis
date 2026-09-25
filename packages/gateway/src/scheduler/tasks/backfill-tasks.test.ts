// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * People-graph convergence task kick-chaining coverage.
 *
 * When an eval tick applies equivalence changes it must (a) re-sweep
 * collapsed merge candidates (the pre-step ran before the apply, and
 * the portal's cluster-merge flow polls for the swept rows) and
 * (b) kick the interaction-scores and people-counts refreshes so the
 * derived state doesn't wait out its idle backoff. kickPeriodic
 * degrades unknown task names to a log-warn no-op, so a rename of
 * either downstream task would silently regress the chain — these
 * tests pin the kicked names against the real task factories.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { resetUrlGraphRoles, setUrlGraphRoles } from "../../url-graph-roles.js";
import { resetKnownUrlPatterns, setKnownUrlPatterns } from "../../known-url-patterns.js";
import {
  connectCollectorDeclarations,
  resetConnectedCollectorDeclarations,
} from "../../collector-declaration-roster.js";
import {
  markLinkDeclarationBundleReady,
  resetLinkDeclarationBundleReadiness,
  setExpectedLinkDeclarationKeys,
} from "../../link-declaration-readiness.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "../../near-dupes/config.js";
import {
  autoDetectTask,
  linkBackfillTask,
  nearDupAlgoSweepTask,
  linkReconcileTask,
  interactionScoresRefreshTask,
  peopleCountsRefreshTask,
  mergeRulesEvalTask,
  peopleBackfillTask,
  tokenIdentityClassifyTask,
} from "./backfill-tasks.js";
import type { BackfillTaskOptsInternal } from "./backfill.js";
import type { TaskContext } from "../types.js";

beforeEach(() => {
  connectCollectorDeclarations("test");
  markLinkDeclarationBundleReady("test");
});

afterEach(() => {
  resetConnectedCollectorDeclarations();
  resetUrlGraphRoles();
  resetKnownUrlPatterns();
  resetLinkDeclarationBundleReadiness();
});

const log = createLogger("test:backfill-tasks");

const ctx: TaskContext = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

function trackerStub() {
  return {
    recordTick: vi.fn(),
    recordSweepStarted: vi.fn(),
    recordSweepCompleted: vi.fn(),
  };
}

function makeEvalOpts(overrides: {
  meta: { dirtyVersion: number; lastEvaluatedVersion: number };
  applied: { added: number; changed: number; removed: number };
}) {
  const kicked: string[] = [];
  const sweep = vi.fn(async () => ({ swept: 0 }));
  const compute = vi.fn(async () => ({
    equivalences: [],
    dirtyVersion: overrides.meta.dirtyVersion,
  }));
  const opts = {
    writeGate: {
      sweepCollapsedMergeCandidates: sweep,
      upsertMergeEquivalences: vi.fn(async () => overrides.applied),
    },
    ioGate: {
      mergeRulesMeta: vi.fn(async () => overrides.meta),
      mergeEquivalencesData: vi.fn(async () => ({})),
    },
    cpuGate: {
      computeMergeEquivalences: compute,
    },
    log,
    mergeRulesEvalIntervalMs: 60_000,
    mergeRulesEvalIdleDelayMs: 300_000,
    trackers: { mergeRulesEval: trackerStub() },
    kickPeriodic: (name: string) => kicked.push(name),
  } as unknown as BackfillTaskOptsInternal;
  return { opts, kicked, sweep, compute };
}

/** The downstream task names the eval chain must target, straight from the factories. */
function downstreamTaskNames(): string[] {
  const opts = {
    writeGate: {},
    ioGate: {},
    log,
    interactionScoresRefreshIntervalMs: 60_000,
    interactionScoresIdleDelayMs: 300_000,
    peopleCountsRefreshIntervalMs: 600_000,
    trackers: { interactionScoresRefresh: trackerStub(), peopleCountsRefresh: trackerStub() },
  } as unknown as BackfillTaskOptsInternal;
  return [interactionScoresRefreshTask(opts).name, peopleCountsRefreshTask(opts).name];
}

describe("people and auto-detect convergence chain", () => {
  function makeAutoDetectOpts(inserted: number, candidates = 1) {
    const kicked: string[] = [];
    const opts = {
      writeGate: {
        upsertAutoDetectedRules: vi.fn(async () => ({ inserted, skipped: 1 })),
      },
      ioGate: { autoDetectData: vi.fn(async () => ({})) },
      cpuGate: {
        computeAutoDetectedRules: vi.fn(async () =>
          candidates === 0
            ? []
            : [
                {
                  sideA: { aliasType: "email", alias: "maya.reeves@example.com" },
                  sideB: { aliasType: "email", alias: "maya.reeves@example.com" },
                },
              ],
        ),
      },
      log,
      autoDetectIntervalMs: 300_000,
      mergeRulesEvalIntervalMs: 60_000,
      mergeRulesEvalIdleDelayMs: 300_000,
      trackers: { mergeRulesEval: trackerStub() },
      kickPeriodic: (name: string) => kicked.push(name),
    } as unknown as BackfillTaskOptsInternal;
    return { opts, kicked };
  }

  test("auto-detect waits for its write before kicking rule evaluation", async () => {
    const { opts, kicked } = makeAutoDetectOpts(1);
    let resolveWrite!: (result: { inserted: number; skipped: number }) => void;
    let signalWriteEntered!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      signalWriteEntered = resolve;
    });
    const pendingWrite = new Promise<{ inserted: number; skipped: number }>((resolve) => {
      resolveWrite = resolve;
    });
    vi.mocked(opts.writeGate.upsertAutoDetectedRules).mockImplementationOnce(() => {
      signalWriteEntered();
      return pendingWrite;
    });
    const running = autoDetectTask(opts).run(undefined, ctx);

    await writeEntered;
    expect(opts.writeGate.upsertAutoDetectedRules).toHaveBeenCalledOnce();
    expect(kicked).toEqual([]);
    resolveWrite({ inserted: 1, skipped: 0 });
    const outcome = await running;

    expect(outcome).toEqual({
      kind: "done",
      value: { idle: false, successful: true, inserted: 1, mutationGeneration: 1 },
    });
    expect(kicked).toEqual([mergeRulesEvalTask(opts).name]);
  });

  test("an unchanged rule set still evaluates rules dirtied by people resolution", async () => {
    const { opts, kicked } = makeAutoDetectOpts(0);
    const outcome = await autoDetectTask(opts).run(undefined, ctx);

    expect(outcome).toEqual({
      kind: "done",
      value: { idle: false, successful: true, inserted: 0, mutationGeneration: 0 },
    });
    expect(kicked).toEqual([mergeRulesEvalTask(opts).name]);
  });

  test("auto-detect reports mutations from an earlier generation cumulatively", async () => {
    const { opts } = makeAutoDetectOpts(1);
    vi.mocked(opts.writeGate.upsertAutoDetectedRules)
      .mockResolvedValueOnce({ inserted: 1, skipped: 0 })
      .mockResolvedValueOnce({ inserted: 0, skipped: 1 });
    const task = autoDetectTask(opts);

    const first = await task.run(undefined, ctx);
    const trailing = await task.run(undefined, ctx);

    expect(first.kind === "done" && first.value.mutationGeneration).toBe(1);
    expect(trailing).toEqual({
      kind: "done",
      value: { idle: false, successful: true, inserted: 0, mutationGeneration: 1 },
    });
  });

  test("an empty candidate scan still evaluates rules dirtied by people resolution", async () => {
    const { opts, kicked } = makeAutoDetectOpts(0, 0);
    const outcome = await autoDetectTask(opts).run(undefined, ctx);

    expect(outcome).toEqual({
      kind: "done",
      value: { idle: false, successful: true, inserted: 0, mutationGeneration: 0 },
    });
    expect(kicked).toEqual([mergeRulesEvalTask(opts).name]);
    expect(opts.writeGate.upsertAutoDetectedRules).not.toHaveBeenCalled();
  });

  test("an auto-detect failure cannot masquerade as a successful fixed point", async () => {
    const { opts } = makeAutoDetectOpts(0);
    vi.mocked(opts.ioGate.autoDetectData).mockRejectedValueOnce(new Error("reader down"));

    const outcome = await autoDetectTask(opts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(outcome.kind === "done" && outcome.value.successful).not.toBe(true);
  });

  test("people backlog completion kicks a fresh auto-detect scan", async () => {
    const kicked: string[] = [];
    const opts = {
      writeGate: {
        backfillManyPeople: vi
          .fn()
          .mockResolvedValueOnce({ processed: 2, resolved: 2, skipped: 0 })
          .mockResolvedValueOnce({ processed: 0, resolved: 0, skipped: 0 }),
      },
      log,
      peopleBatchSize: 100,
      peopleBatchIntervalMs: 100,
      peopleIdleDelayMs: 30_000,
      trackers: { peopleBackfill: trackerStub() },
      kickPeriodic: (name: string) => kicked.push(name),
      autoDetectIntervalMs: 300_000,
    } as unknown as BackfillTaskOptsInternal;
    const task = peopleBackfillTask(opts);

    const processing = await task.run(undefined, ctx);
    expect(processing).toEqual({ kind: "done", value: { idle: false } });
    expect(kicked).toEqual([]);
    const caughtUp = await task.run(undefined, ctx);
    expect(caughtUp).toEqual({ kind: "done", value: { idle: true } });
    expect(kicked).toEqual([autoDetectTask(opts).name]);
  });

  test("count/name refresh completion kicks another auto-detect fixed-point pass", async () => {
    const kicked: string[] = [];
    const opts = {
      writeGate: {
        upsertPeopleCounts: vi.fn(async () => ({ updated: 0 })),
        zeroPeopleCountsForLosers: vi.fn(async () => undefined),
        recomputeNamePrimaries: vi.fn(async () => undefined),
        advancePeopleCountsWatermark: vi.fn(async () => undefined),
      },
      ioGate: {
        peopleCountsChunk: vi.fn(async () => ({ rows: [], nextCursor: null })),
        peopleCountsMeta: vi.fn(async () => ({
          dirtyVersion: 2,
          lastComputedVersion: 1,
          lastComputedAt: Date.now(),
        })),
        transitiveCollapse: vi.fn(async () => []),
      },
      log,
      peopleCountsRefreshIntervalMs: 600_000,
      autoDetectIntervalMs: 300_000,
      trackers: { peopleCountsRefresh: trackerStub() },
      kickPeriodic: (name: string) => kicked.push(name),
    } as unknown as BackfillTaskOptsInternal;

    const outcome = await peopleCountsRefreshTask(opts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true, successful: true } });
    expect(kicked).toEqual([autoDetectTask(opts).name]);
  });
});

describe("mergeRulesEvalTask — downstream kick chain", () => {
  test("an apply that moved equivalences re-sweeps candidates and kicks scores + counts", async () => {
    const { opts, kicked, sweep } = makeEvalOpts({
      meta: { dirtyVersion: 5, lastEvaluatedVersion: 4 },
      applied: { added: 1, changed: 0, removed: 0 },
    });
    const task = mergeRulesEvalTask(opts);
    const outcome = await task.run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: false } });
    expect(kicked).toEqual(downstreamTaskNames());
    // Pre-step sweep + post-apply re-sweep.
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  test("a dirty no-op apply still refreshes scores and counts", async () => {
    const { opts, kicked, sweep } = makeEvalOpts({
      meta: { dirtyVersion: 5, lastEvaluatedVersion: 4 },
      applied: { added: 0, changed: 0, removed: 0 },
    });
    const task = mergeRulesEvalTask(opts);
    const outcome = await task.run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: false } });
    expect(kicked).toEqual(downstreamTaskNames());
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  test("a caught-up tick neither computes nor kicks", async () => {
    const { opts, kicked, compute } = makeEvalOpts({
      meta: { dirtyVersion: 4, lastEvaluatedVersion: 4 },
      applied: { added: 1, changed: 0, removed: 0 },
    });
    const task = mergeRulesEvalTask(opts);
    const outcome = await task.run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(kicked).toEqual([]);
    // The OCC gate — not a swallowed error — must be what short-
    // circuited the tick (runBackfillTick converts throws into the
    // same idle outcome).
    expect(compute).not.toHaveBeenCalled();
  });
});

/**
 * Token-identity classifier — provider lifecycle and what gets persisted.
 *
 * The task builds a completion provider per sweep and owns it, so the two
 * things worth pinning are that it never builds one it doesn't need and always
 * releases the one it does. The third is that a batch the model never answered
 * leaves its tokens unlabeled: writing a placeholder would take them out of
 * `selectTokensNeedingClassification` and they would never be reconsidered.
 */
describe("tokenIdentityClassifyTask", () => {
  function makeClassifyOpts(opts: {
    candidates: Array<{ token: string; domainSpread: number }>;
    /** Tokens the model answers for; anything omitted goes unanswered. */
    answers?: Record<string, string>;
    provider?: "none" | "stub";
    upsertRejects?: boolean;
    /** Model call fails outright — the batch goes unanswered. */
    completeRejects?: boolean;
  }) {
    const dispose = vi.fn(async () => {});
    const complete = vi.fn(async () => {
      if (opts.completeRejects) throw new Error("backend timed out");
      return Object.entries(opts.answers ?? {})
        .map(([token, label]) => `${token}: ${label}`)
        .join("\n");
    });
    const getCompletionProvider = vi.fn(() =>
      opts.provider === "none" ? null : { name: "stub", modelId: "stub-model", complete, dispose },
    );
    const upsertTokenLabels = vi.fn(async (rows: Array<{ token: string }>) =>
      opts.upsertRejects ? Promise.reject(new Error("writer down")) : { upserted: rows.length },
    );
    const tracker = trackerStub();
    const taskOpts = {
      ioGate: {
        selectTokensNeedingClassification: vi.fn(async () => opts.candidates),
      },
      writeGate: { upsertTokenLabels },
      log,
      getCompletionProvider,
      trackers: { tokenIdentityClassify: tracker },
    } as unknown as BackfillTaskOptsInternal;
    return { taskOpts, getCompletionProvider, dispose, upsertTokenLabels, tracker };
  }

  test("no candidates → never builds a provider", async () => {
    const { taskOpts, getCompletionProvider } = makeClassifyOpts({ candidates: [] });
    const outcome = await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(getCompletionProvider).not.toHaveBeenCalled();
  });

  test("no classifier assigned → idles without recording a sweep", async () => {
    const { taskOpts, tracker, upsertTokenLabels } = makeClassifyOpts({
      candidates: [{ token: "reservations", domainSpread: 9 }],
      provider: "none",
    });
    const outcome = await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(tracker.recordSweepStarted).not.toHaveBeenCalled();
    expect(upsertTokenLabels).not.toHaveBeenCalled();
  });

  test("labels the answered tokens and releases the provider", async () => {
    const { taskOpts, dispose, upsertTokenLabels } = makeClassifyOpts({
      candidates: [
        { token: "reservations", domainSpread: 9 },
        { token: "okafor", domainSpread: 7 },
      ],
      answers: { reservations: "role_generic", okafor: "personal_name" },
    });
    const outcome = await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: false } });
    expect(upsertTokenLabels).toHaveBeenCalledWith([
      { token: "reservations", label: "role_generic", domainSpread: 9 },
      { token: "okafor", label: "personal_name", domainSpread: 7 },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("a token answered around is recorded ambiguous, not re-asked forever", async () => {
    const { taskOpts, upsertTokenLabels } = makeClassifyOpts({
      candidates: [
        { token: "reservations", domainSpread: 9 },
        { token: "okafor", domainSpread: 7 },
      ],
      // The model replied, but skipped a line. That is a verdict of sorts —
      // it saw the token and had nothing to say — so it is persisted.
      answers: { reservations: "role_generic" },
    });
    await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    expect(upsertTokenLabels).toHaveBeenCalledWith([
      { token: "reservations", label: "role_generic", domainSpread: 9 },
      { token: "okafor", label: "ambiguous", domainSpread: 7 },
    ]);
  });

  test("a batch the model never answered persists nothing", async () => {
    const { taskOpts, upsertTokenLabels, dispose } = makeClassifyOpts({
      candidates: [
        { token: "reservations", domainSpread: 9 },
        { token: "okafor", domainSpread: 7 },
      ],
      completeRejects: true,
    });
    await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    // A timeout is not a verdict. Persisting a placeholder would drop these
    // tokens out of `selectTokensNeedingClassification` permanently, so a
    // transient outage would silently cost the suppression veto forever.
    expect(upsertTokenLabels).toHaveBeenCalledWith([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("releases the provider even when the write fails", async () => {
    const { taskOpts, dispose } = makeClassifyOpts({
      candidates: [{ token: "okafor", domainSpread: 7 }],
      answers: { okafor: "personal_name" },
      upsertRejects: true,
    });
    // runBackfillTick converts a thrown tick into the same idle outcome.
    const outcome = await tokenIdentityClassifyTask(taskOpts).run(undefined, ctx);

    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("people counts sweep — merge chains are flattened first", () => {
  function makeCountsOpts(chains: Array<{ personId: string; rootId: string }>) {
    const order: string[] = [];
    const opts = {
      log,
      writeGate: {
        upsertTransitiveCollapse: vi.fn(async (rows: unknown[]) => {
          order.push("upsertTransitiveCollapse");
          return { collapsed: (rows as unknown[]).length };
        }),
        upsertPeopleCounts: vi.fn(async () => {
          order.push("upsertPeopleCounts");
          return { updated: 0 };
        }),
        zeroPeopleCountsForLosers: vi.fn(async () => ({ updated: 0 })),
        recomputeNamePrimaries: vi.fn(async () => ({ updated: 0 })),
        advancePeopleCountsWatermark: vi.fn(async () => undefined),
      },
      ioGate: {
        peopleCountsMeta: vi.fn(async () => ({
          dirtyVersion: 2,
          lastComputedVersion: 1,
          lastComputedAt: Date.now(),
        })),
        transitiveCollapse: vi.fn(async () => {
          order.push("transitiveCollapse");
          return chains;
        }),
        peopleCountsChunk: vi.fn(async () => {
          order.push("peopleCountsChunk");
          return { rows: [], nextCursor: null };
        }),
      },
      kickPeriodic: vi.fn(),
      peopleCountsRefreshIntervalMs: 600_000,
      trackers: { peopleCountsRefresh: trackerStub() },
    } as unknown as BackfillTaskOptsInternal;
    return { opts, order };
  }

  // The counts query follows `merged_into` a single hop, so A→B→C credits
  // A's documents to B — a loser, in no batch — and C stays short until the
  // chain is flattened. This sweep is where the flattening pass runs,
  // because it is the reader that depends on the result.
  test("collapses transitive chains before it counts anything", async () => {
    const { opts, order } = makeCountsOpts([{ personId: "A", rootId: "C" }]);
    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);

    expect(opts.ioGate.transitiveCollapse).toHaveBeenCalled();
    expect(opts.writeGate.upsertTransitiveCollapse).toHaveBeenCalledWith([
      { personId: "A", rootId: "C" },
    ]);
    // Order is the point: counting first would count the broken shape.
    expect(order.indexOf("transitiveCollapse")).toBeLessThan(order.indexOf("peopleCountsChunk"));
    expect(order.indexOf("upsertTransitiveCollapse")).toBeLessThan(
      order.indexOf("peopleCountsChunk"),
    );
  });

  function metaOpts(meta: {
    dirtyVersion: number;
    lastComputedVersion: number;
    lastComputedAt: number | null;
  }) {
    const opts = {
      log,
      writeGate: {
        upsertTransitiveCollapse: vi.fn(async () => ({ collapsed: 0 })),
        upsertPeopleCounts: vi.fn(async () => ({ updated: 0 })),
        zeroPeopleCountsForLosers: vi.fn(async () => ({ updated: 0 })),
        recomputeNamePrimaries: vi.fn(async () => ({ updated: 0 })),
        advancePeopleCountsWatermark: vi.fn(async () => undefined),
      },
      ioGate: {
        transitiveCollapse: vi.fn(async () => []),
        peopleCountsChunk: vi.fn(async () => ({ rows: [], nextCursor: null })),
        peopleCountsMeta: vi.fn(async () => meta),
      },
      kickPeriodic: vi.fn(),
      peopleCountsRefreshIntervalMs: 600_000,
      trackers: { peopleCountsRefresh: trackerStub() },
    } as unknown as BackfillTaskOptsInternal;
    return opts;
  }

  // Every ten minutes, whether or not anything had changed, this swept
  // fifty chunks. It now asks first — and still asks eventually, because a
  // dirty mark is a list of call sites and a missed one must cost a delay,
  // not permanently wrong numbers.
  test("skips the sweep when the people graph has not moved", async () => {
    const opts = metaOpts({
      dirtyVersion: 7,
      lastComputedVersion: 7,
      lastComputedAt: Date.now(),
    });
    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);
    expect(opts.ioGate.peopleCountsChunk).not.toHaveBeenCalled();
  });

  test("sweeps when the graph has moved since the last pass", async () => {
    const opts = metaOpts({
      dirtyVersion: 8,
      lastComputedVersion: 7,
      lastComputedAt: Date.now(),
    });
    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);
    expect(opts.ioGate.peopleCountsChunk).toHaveBeenCalled();
    // Stamped with the version the sweep computed against, so a change
    // during the sweep still leaves dirty ahead of it.
    expect(opts.writeGate.advancePeopleCountsWatermark).toHaveBeenCalledWith(8);
  });

  test("sweeps anyway once the counts are old enough", async () => {
    const opts = metaOpts({
      dirtyVersion: 7,
      lastComputedVersion: 7,
      lastComputedAt: Date.now() - 7 * 60 * 60 * 1_000,
    });
    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);
    expect(opts.ioGate.peopleCountsChunk).toHaveBeenCalled();
  });

  test("writes nothing when there are no chains to repair", async () => {
    const { opts } = makeCountsOpts([]);
    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);

    expect(opts.ioGate.transitiveCollapse).toHaveBeenCalled();
    expect(opts.writeGate.upsertTransitiveCollapse).not.toHaveBeenCalled();
  });

  /**
   * The OCC watermark is what lets the next tick skip. Stamping it with a
   * version read AFTER the sweep would claim to have accounted for a merge
   * that landed while the sweep was mid-flight but was never counted, and
   * the wrong numbers would then sit on the People page until something
   * else dirtied the job.
   */
  test("stamps the watermark with the version captured before the first chunk", async () => {
    const { opts } = makeCountsOpts([]);
    let metaReads = 0;
    // Reads 1 and 2 are the gate and the sweep's own capture; anything after
    // that models the graph moving while the sweep is still walking chunks.
    opts.ioGate.peopleCountsMeta = vi.fn(async () => {
      metaReads += 1;
      return metaReads <= 2
        ? { dirtyVersion: 5, lastComputedVersion: 1, lastComputedAt: Date.now() }
        : { dirtyVersion: 9, lastComputedVersion: 1, lastComputedAt: Date.now() };
    });
    // Two chunks, so there is a window between capture and apply.
    let chunks = 0;
    opts.ioGate.peopleCountsChunk = vi.fn(async () => {
      chunks += 1;
      return chunks === 1 ? { rows: [], nextCursor: "p1" } : { rows: [], nextCursor: null };
    });

    const task = peopleCountsRefreshTask(opts);
    await task.run(task.initialArgs, ctx);
    await task.run(task.initialArgs, ctx);

    expect(chunks).toBe(2);
    expect(opts.writeGate.advancePeopleCountsWatermark).toHaveBeenCalledWith(5);
  });
});

/**
 * The link drip's own wiring.
 *
 * Resolution is a phase of the task, not a property of any one function:
 * the cpu worker has no database handle, so the batch it produces carries
 * no targets, and it is the task that must hand that batch to a read
 * handle before the writer sees it. Nothing about the four functions
 * composing correctly says the task calls them in that order — so this
 * pins the task, which is the seam the suite was missing when every link
 * reached the writer unresolved.
 */
describe("link backfill — the writer receives resolved links", () => {
  function makeLinkOpts(docs: Array<{ id: string; sourceId: string }>) {
    const calls: string[] = [];
    const written: Array<Record<string, unknown>> = [];
    const opts = {
      log,
      ioGate: {
        collectorRosterSnapshot: vi.fn(async () => ({ revision: 8 })),
        fetchLinksForBatch: vi.fn(async (batchSize: number) => {
          calls.push(`fetch(${batchSize})`);
          return docs.map((d) => ({
            id: d.id,
            source_id: d.sourceId,
            external_id: d.id,
            content: `See https://example.com/${d.id}`,
            content_hash: `h-${d.id}`,
            metadata: "{}",
          }));
        }),
        resolveExtractedLinks: vi.fn(
          async (
            entries: Array<{ docId: string }>,
            prefixes: string[],
            referencePrefixes: string[],
            rolesReady: boolean,
            knownPatternSources: string[],
            knownPatternsReady: boolean,
          ) => {
            calls.push(`resolve(${entries.length})`);
            calls.push(`fallbacks(${prefixes.join(",")})`);
            calls.push(`references(${referencePrefixes.join(",")})`);
            calls.push(`rolesReady(${String(rolesReady)})`);
            calls.push(`knownPatterns(${knownPatternSources.join(",")})`);
            calls.push(`knownPatternsReady(${String(knownPatternsReady)})`);
            // Stands in for the read handle finding a target for every link.
            // The op returns targets alone; the task folds them back in.
            return entries.map((e) => ({
              docId: e.docId,
              resolvedTargets: { found: "target-doc" },
            }));
          },
        ),
      },
      cpuGate: {
        extractLinksFromDocs: vi.fn(async (rows: Array<{ id: string; source_id: string }>) => {
          calls.push(`extract(${rows.length})`);
          // What the cpu worker can produce: links, and no targets, because
          // it has no database in which to look them up.
          return rows.map((row) => ({
            docId: row.id,
            contentHash: `h-${row.id}`,
            sourceId: row.source_id,
            links: [
              {
                type: "url",
                rawTarget: "https://example.com/x",
                normalizedTarget: "https://example.com/x",
              },
            ],
          }));
        }),
      },
      writeGate: {
        upsertExtractedLinksBatch: vi.fn(async (rows: Array<Record<string, unknown>>) => {
          calls.push(`write(${rows.length})`);
          written.push(...rows);
          return { applied: rows.length, skipped: 0, extracted: rows.length };
        }),
      },
      linkBackfillIntervalMs: 1_000,
      linkIdleDelayMs: 30_000,
      trackers: { linkBackfill: trackerStub() },
    } as unknown as BackfillTaskOptsInternal;
    return { opts, calls, written };
  }

  test("resolves between the cpu phase and the write, never skipping it", async () => {
    setUrlGraphRoles("test", ["test-traversal-hub"], ["test-url-capture"], ["test-url-reference"]);
    setKnownUrlPatterns("test", [{ regex: "example[.]com" }]);
    const { opts, calls, written } = makeLinkOpts([
      { id: "doc-1", sourceId: "notion:user@example.com" },
      { id: "doc-2", sourceId: "notion:user@example.com" },
    ]);
    const task = linkBackfillTask(opts);
    await task.run(task.initialArgs, ctx);

    // The order is the contract. A write that happens before the resolve,
    // or without one at all, hands the writer links whose targets nothing
    // has looked for.
    expect(calls).toEqual([
      "fetch(5)",
      "extract(1)",
      "extract(1)",
      "resolve(2)",
      "fallbacks(web,test-url-capture)",
      "references(test-url-reference)",
      "rolesReady(true)",
      "knownPatterns(example[.]com)",
      "knownPatternsReady(true)",
      "write(2)",
    ]);
    expect(written).toHaveLength(2);
    for (const row of written) {
      expect(row.resolvedTargets, `${String(row.docId)} reached the writer unresolved`).toEqual({
        found: "target-doc",
      });
    }
  });

  test("resolves the whole batch in one call, so within-batch pairs can be found", async () => {
    // `shares-phone` resolves against other documents' links, so a pair
    // mentioning the same number is found only when both are in scope
    // together. Resolving one document at a time would silently lose them.
    const { opts, calls } = makeLinkOpts([
      { id: "doc-1", sourceId: "apple-call-log:user@example.com" },
      { id: "doc-2", sourceId: "apple-call-log:user@example.com" },
      { id: "doc-3", sourceId: "apple-call-log:user@example.com" },
    ]);
    const task = linkBackfillTask(opts);
    await task.run(task.initialArgs, ctx);

    expect(calls.filter((c) => c.startsWith("resolve"))).toEqual(["resolve(3)"]);
  });

  test("does no work and reports idle when nothing needs extraction", async () => {
    const { opts, calls } = makeLinkOpts([]);
    const task = linkBackfillTask(opts);
    const outcome = await task.run(task.initialArgs, ctx);

    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.value.idle).toBe(true);
    expect(calls).toEqual(["fetch(5)"]);
  });
});

/**
 * The near-duplicate sweep tick's shape.
 *
 * The tick reclaims two things at different rates. A stale ALGO is left by
 * a bump: rare, and the pass that finds it is guarded so that proving there
 * is none costs a primary-key seek. A superseded GENERATION is owed after
 * every rebuild, and its chunks are primary-key range deletes, so the tick
 * repeats those and only those.
 *
 * The bound on the repetition matters as much as the repetition: each chunk
 * is a writer op on the background lane, which the indexer shares.
 */
describe("near-dup sweep tick — the expensive pass runs once", () => {
  function makeSweepOpts(opts: { algoCleared: number; genChunks: number; stepsPerTick: number }) {
    const calls: string[] = [];
    let genRemaining = opts.genChunks;
    const config = {
      ...DEFAULT_NEAR_DUP_CONFIG,
      enabled: true,
      scheduler: {
        ...DEFAULT_NEAR_DUP_CONFIG.scheduler,
        algoSweepStepsPerTick: opts.stepsPerTick,
      },
    };
    const internal = {
      log,
      writeGate: {
        nearDupAlgoSweepStep: vi.fn(async () => {
          calls.push("algo");
          return { cleared: opts.algoCleared, done: opts.algoCleared === 0 };
        }),
        nearDupGenerationSweepStep: vi.fn(async () => {
          calls.push("generation");
          if (genRemaining <= 0) return { cleared: 0, done: true };
          genRemaining -= 1;
          return { cleared: 100, done: false };
        }),
      },
      getNearDupConfig: () => config,
      trackers: { nearDupAlgoSweep: trackerStub() },
    } as unknown as BackfillTaskOptsInternal;
    return { opts: internal, calls };
  }

  test("reads the table once however many generation chunks it reclaims", async () => {
    const { opts, calls } = makeSweepOpts({ algoCleared: 0, genChunks: 10, stepsPerTick: 4 });
    const task = nearDupAlgoSweepTask(opts);
    await task.run(task.initialArgs, ctx);

    // One expensive pass, then the cheap one up to its bound.
    expect(calls.filter((c) => c === "algo")).toHaveLength(1);
    expect(calls.filter((c) => c === "generation")).toHaveLength(4);
    expect(calls[0]).toBe("algo");
  });

  test("stops reclaiming as soon as there is nothing left", async () => {
    const { opts, calls } = makeSweepOpts({ algoCleared: 0, genChunks: 1, stepsPerTick: 4 });
    const task = nearDupAlgoSweepTask(opts);
    await task.run(task.initialArgs, ctx);

    // One chunk cleared something, the next found nothing and ended the loop.
    expect(calls.filter((c) => c === "generation")).toHaveLength(2);
  });

  test("stays awake when the algo pass still has rows to retire", async () => {
    // The tick seeds `done` from the algo pass. A tick that reported idle
    // with stale-algo rows outstanding would sleep out the idle backoff
    // with them still on disk.
    const { opts } = makeSweepOpts({ algoCleared: 5000, genChunks: 0, stepsPerTick: 4 });
    const task = nearDupAlgoSweepTask(opts);
    const outcome = await task.run(task.initialArgs, ctx);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.value.idle).toBe(false);
  });

  test("reports idle only when both halves are clean", async () => {
    const clean = makeSweepOpts({ algoCleared: 0, genChunks: 0, stepsPerTick: 4 });
    const cleanTask = nearDupAlgoSweepTask(clean.opts);
    const cleanOutcome = await cleanTask.run(cleanTask.initialArgs, ctx);
    expect(cleanOutcome.kind).toBe("done");
    if (cleanOutcome.kind === "done") expect(cleanOutcome.value.idle).toBe(true);

    // Work left in the generation half must keep the task awake, or the
    // reclaim waits out the idle backoff while the table carries a whole
    // superseded generation.
    const dirty = makeSweepOpts({ algoCleared: 0, genChunks: 10, stepsPerTick: 2 });
    const dirtyTask = nearDupAlgoSweepTask(dirty.opts);
    const dirtyOutcome = await dirtyTask.run(dirtyTask.initialArgs, ctx);
    expect(dirtyOutcome.kind).toBe("done");
    if (dirtyOutcome.kind === "done") expect(dirtyOutcome.value.idle).toBe(false);
  });
});

describe("link reconcile — URL ownership waits for complete fallback-representation metadata", () => {
  function makeOpts() {
    const linkResolutions = vi.fn(
      async (
        _limit: number,
        _prefixes: string[],
        _referencePrefixes: string[],
        _rolesReady: boolean,
        _knownPatternSources: string[],
        _knownPatternsReady: boolean,
      ) => ({
        resolutions: [],
        scannedMaxId: 0,
        deletableLinkIds: [],
      }),
    );
    const opts = {
      log,
      ioGate: {
        collectorRosterSnapshot: vi.fn(async () => ({ revision: 8 })),
        linkResolutions,
      },
      writeGate: {
        upsertLinkResolutions: vi.fn(async () => ({ updated: 0, deleted: 0, retargeted: 0 })),
        drainPendingEdges: vi.fn(async () => ({ promoted: 0, dropped: 0, retried: 0 })),
      },
      linkReconcileIntervalMs: 1_000,
      linkReconcileBatchSize: 50,
      trackers: { linkReconcile: trackerStub() },
    } as unknown as BackfillTaskOptsInternal;
    return { opts, linkResolutions };
  }

  test("passes no ownership prefixes before declaration, then the complete merged set", async () => {
    const { opts, linkResolutions } = makeOpts();
    const task = linkReconcileTask(opts);

    await task.run(task.initialArgs, ctx);
    expect(linkResolutions).toHaveBeenLastCalledWith(50, [], [], false, [], false, 8);

    setUrlGraphRoles("test", ["test-traversal-hub"], ["test-url-capture"], ["test-url-reference"]);
    setKnownUrlPatterns("test", [{ regex: "code[.]example[.]org" }]);
    await task.run(task.initialArgs, ctx);
    expect(linkResolutions).toHaveBeenLastCalledWith(
      50,
      ["web", "test-url-capture"],
      ["test-url-reference"],
      true,
      ["code[.]example[.]org"],
      true,
      8,
    );
  });

  test("does no reader or writer work while any collector bundle is incomplete", async () => {
    resetLinkDeclarationBundleReadiness();
    setExpectedLinkDeclarationKeys(["test", "late-collector"]);
    markLinkDeclarationBundleReady("test");
    const { opts, linkResolutions } = makeOpts();
    opts.ioGate.collectorRosterSnapshot = vi.fn(async () => ({ revision: 8 }));
    const task = linkReconcileTask(opts);

    const outcome = await task.run(task.initialArgs, ctx);

    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.value.idle).toBe(true);
    expect(linkResolutions).not.toHaveBeenCalled();
    expect(opts.writeGate.upsertLinkResolutions).not.toHaveBeenCalled();
  });
});
