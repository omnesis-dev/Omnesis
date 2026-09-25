// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A restart must not change what a watch decided.
 *
 * This is the property that forces the durability machinery to be real. A
 * cursor nobody reads and a mutation that commits outside its transaction both
 * look correct in a single continuous run, and both show up here.
 *
 * The comparison is the **persisted** firings rather than a trace: a resumed
 * run's trace covers only what that run did, while the firings table is the
 * durable record the watch is judged on. Comparing traces would pass while a
 * firing from the first half was being silently discarded.
 *
 * Firing identity — two concurrent firings colliding on one row — is a
 * neighbouring durability property that this file does not reach, because both
 * halves of a split still write through the same uniqueness constraint. It is
 * covered in `../runtime/adversarial.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readJournal } from "../journal/read.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, journalPath, loadOntology } from "../universe/paths.js";
import { WatchEngine } from "../runtime/engine.js";
import { ScriptedJudge, ScriptedRecall } from "../runtime/providers.js";
import { loadScript, loadWatch } from "../runtime/run.js";
import { WatchStateStore } from "../runtime/state.js";
import { frozenGolden, watchNames } from "./golden.js";
import type { JudgeProvider } from "../runtime/providers.js";

const ontology = loadOntology();
const journal = readJournal(journalPath());
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-v2-resume-"));
  temps.push(dir);
  return join(dir, "watch.db");
}

/** Replay a slice of the journal against a store that persists between runs. */
async function replay(name: string, through: number, path: string): Promise<void> {
  const script = loadScript(name);
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const store = new WatchStateStore(path);
  try {
    await new WatchEngine({
      watch: loadWatch(name),
      ontology,
      journal: journal.slice(0, through),
      analytics,
      judge: new ScriptedJudge({ judgements: script.judgements ?? [] }),
      recall: new ScriptedRecall(script.recall ?? []),
      store,
    }).run();
  } finally {
    store.close();
    analytics.close();
  }
}

/**
 * Everything a restart is supposed to preserve.
 *
 * The firings are the durable record the watch is judged on, but comparing
 * only them lets a watch that legitimately fires nothing pass this lane while
 * exercising no durability at all. The cells, the outstanding timers and the
 * cursor are the state the resumed run had to pick up in order to reach the
 * same firings, and a watch that never fires still has all three.
 */
function persistedState(path: string, name: string): Record<string, unknown> {
  const store = new WatchStateStore(path);
  try {
    const cells = loadWatch(name)
      .nodes.flatMap((node) => store.cellsFor(name, node.id))
      .map((c) => `${c.nodeId} ${c.keyHash}#${c.instance} ${c.state} armed=${c.armedAtMs}`)
      .sort();
    const timers = store
      .dueTimers(name, Number.MAX_SAFE_INTEGER)
      .map((t) => `${t.nodeId} ${t.keyHash}#${t.instance} ${t.kind}@${t.dueAtMs}`)
      .sort();
    return {
      firings: store.firings(name).map((f) => f.payload),
      cells,
      timers,
      cursor: store.cursor(name),
      active: store.isActive(name),
    };
  } finally {
    store.close();
  }
}

function persistedFirings(path: string, watch: string): unknown[] {
  const store = new WatchStateStore(path);
  try {
    return store.firings(watch).map((f) => f.payload);
  } finally {
    store.close();
  }
}

const NAMES = watchNames();

/**
 * Budget for the lanes that replay the journal dozens of times.
 *
 * The boundary sweep alone is a dozen cuts, each a pair of runs, over a journal
 * that spans a season — and these files run alongside the rest of the package.
 * On an unloaded developer machine the slowest lane lands near a minute, and
 * well past that when the pool is busy; a tighter budget is a flake waiting for
 * a slower runner rather than a signal.
 */
const REPLAY_HEAVY_MS = 600_000;

/**
 * Watches whose state actually spans a restart: each holds a live instance for
 * days, so a crash lands in the middle of one rather than between them.
 */
const SPANNING = ["important-email-unanswered", "restaurant-budget-500", "mum-call-rhythm-stopped"];

/**
 * Where a restart would land inside this watch's own work.
 *
 * A cut only tests durability if the watch is holding something when it
 * happens, and every watch is busy over a different stretch of the journal.
 * Its own trace says which stretch. Two kinds of anchor, because watches come
 * in two kinds: the sequence at which a watch recorded a transition, for the
 * ones the journal drives directly, and the journal position its clock had
 * reached when it fired, for the ones a timer drives — a timer is not a
 * journal event and records no sequence, but the journal's instants are what
 * move the clock that made it due.
 *
 * A split chosen as a fraction of the journal's length lands inside that
 * stretch only by luck: a watch that arms once, late, is missed by every such
 * split.
 *
 * Cuts land one event *after* an anchor, so the state that anchor created is
 * already committed when the run ends. `splitEndsWithItsAnchor` below pins
 * that, since the resume comparison itself holds at any cut and would not
 * notice the offset drifting.
 */
function anchorsFor(name: string): number[] {
  const { trace } = frozenGolden(name);
  const recorded = trace.records.map((r) => r.seq).filter((seq) => seq > 0);
  const fired = trace.firings.map((firing) => journalPositionAt(firing.firedAt));
  return [...new Set([...recorded, ...fired])].filter((seq) => seq > 0).sort((a, b) => a - b);
}

/** The sequence of the last journal event at or before an instant. */
function journalPositionAt(instant: string): number {
  const atMs = Date.parse(instant);
  let seq = 0;
  for (const event of journal) {
    if (Date.parse(event.occurredAt) > atMs) break;
    seq = event.seq;
  }
  return seq;
}

function activeSplits(name: string, count: number): number[] {
  const anchors = anchorsFor(name);
  if (anchors.length === 0) return [];

  const picked = Array.from(
    { length: count },
    (_, i) => anchors[Math.floor(((i + 1) * anchors.length) / (count + 1))]!,
  );
  const splits = picked.map((seq) => journal.findIndex((event) => event.seq === seq) + 1);
  return [...new Set(splits)].filter((split) => split > 0 && split < journal.length);
}

/**
 * Split points chosen from the journal's own structure rather than as
 * fractions of its length.
 *
 * A document and its index sit on two different clocks, so every
 * `doc.event` immediately followed by its `doc.indexed` is a place where a
 * crash separates a document from the event that indexes it. Those boundaries
 * are where a projection held only in memory goes missing, and a split chosen
 * by fraction hits one only by luck.
 *
 * Sampled rather than exhaustive: every seam is the same kind of cut, so the
 * hundred-and-first tells you what the first dozen did while costing two more
 * replays of a season-long journal. Taking all of them ties the lane's runtime
 * to the corpus's size for coverage that stopped improving long before.
 *
 * Sampled *within each watch's own live window*, though, and not evenly across
 * the journal. A watch is busy over one stretch of a season and idle either
 * side of it, so an even stride spends most of its cuts restarting a watch that
 * has already finished — which passes for any implementation, correct or not.
 * `holds something at a cut it is actually tested at` below is what keeps that
 * honest.
 */
const BOUNDARY_SAMPLES = 12;

const ALL_BOUNDARIES = journal
  .map((event, index) => ({ event, next: journal[index + 1] }))
  .filter(
    ({ event, next }) =>
      event.kind === "doc.event" && next !== undefined && next.kind === "doc.indexed",
  )
  .map(({ event }) => journal.findIndex((e) => e.seq === event.seq) + 1);

/** The document/index seams that fall inside this watch's own working stretch. */
function boundariesFor(name: string): number[] {
  const anchors = anchorsFor(name);
  if (anchors.length === 0) return [];
  const from = anchors[0]!;
  const to = anchors.at(-1)!;
  const inWindow = ALL_BOUNDARIES.filter((split) => {
    const seq = journal[split - 1]!.seq;
    return seq >= from && seq <= to;
  });
  const stride = Math.max(1, Math.ceil(inWindow.length / BOUNDARY_SAMPLES));
  return inWindow.filter((_, index) => index % stride === 0);
}

describe("every watch replayed in two halves", () => {
  it.each(NAMES)(
    "%s reaches the same state as one continuous run",
    async (name) => {
      const continuous = tempPath();
      await replay(name, journal.length, continuous);
      const expected = persistedState(continuous, name);

      const splits = activeSplits(name, 2);
      expect(splits.length, `${name} has nowhere to be cut`).toBeGreaterThan(0);
      for (const split of splits) {
        const path = tempPath();
        await replay(name, split, path);
        await replay(name, journal.length, path);
        expect(persistedState(path, name), `${name} split at ${split}`).toEqual(expected);
      }
    },
    REPLAY_HEAVY_MS,
  );

  it(
    "has watches whose surviving cells and timers the comparison can see",
    async () => {
      // Firings alone would make this lane vacuous for the watch that correctly
      // stays quiet, and thin for every watch that ends with nothing live. The
      // comparison covers cells, timers and the cursor for that reason — but it
      // is only worth more than a firing count if the corpus actually leaves
      // some behind, so that is measured rather than assumed.
      //
      // The quiet watch is the honest exception: it holds nothing at the end, so
      // for it this lane says only that a restart neither fires nor rewinds.
      const holding: string[] = [];
      for (const name of NAMES) {
        const path = tempPath();
        await replay(name, journal.length, path);
        const state = persistedState(path, name) as { cells: string[]; timers: string[] };
        if (state.cells.length + state.timers.length > 0) holding.push(name);
      }
      expect(holding.length, "no watch ends a run holding anything").toBeGreaterThan(4);
    },
    REPLAY_HEAVY_MS,
  );

  it("ends each split with the event that anchored it", () => {
    // The resume comparison holds at any cut in range, so it cannot notice the
    // offset drifting. This is what says the cut lands *after* its anchor: the
    // slice a split produces must end with the anchor event, not before it.
    for (const name of NAMES) {
      const anchors = new Set(anchorsFor(name));
      for (const split of activeSplits(name, 2)) {
        expect(anchors, `${name} split at ${split} ends on a non-anchor`).toContain(
          journal[split - 1]!.seq,
        );
      }
    }
  });

  it("derives the cuts per watch rather than from the journal", () => {
    // The lane above is only worth its runtime if the cuts differ per watch;
    // split points derived from the journal alone would be identical
    // everywhere. Stated as a ceiling on sharing rather than a count of
    // distinct values, because the failure this guards against is a derivation
    // that collapses — and a collapse shows up as one string held by many
    // watches long before it shows up in a total. Two watches whose traces
    // genuinely coincide are not a collapse.
    const shared = new Map<string, number>();
    for (const name of NAMES) {
      const key = activeSplits(name, 2).join(",");
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
    const worst = [...shared.entries()].sort((a, b) => b[1] - a[1])[0]!;
    expect(worst[1], `${worst[1]} watches are all cut at ${worst[0]}`).toBeLessThanOrEqual(2);
  });
});

describe("a watch replayed at every document/index boundary", () => {
  it.each(SPANNING)(
    "%s decides the same as one continuous run",
    async (name) => {
      const continuous = tempPath();
      await replay(name, journal.length, continuous);
      const expected = persistedFirings(continuous, name);
      expect(expected.length, `${name} should fire at least once`).toBeGreaterThan(0);

      const splits = boundariesFor(name);
      expect(splits.length, `${name} has no seam inside its own working stretch`).toBeGreaterThan(
        1,
      );

      // A cut only tests durability if the watch was holding something when it
      // happened. Restarting a watch that has already finished is the same
      // assertion for every implementation, right or wrong.
      let everLive = 0;
      for (const split of splits) {
        const path = tempPath();
        await replay(name, split, path);
        const held = persistedState(path, name);
        if ((held.cells as string[]).length + (held.timers as string[]).length > 0) everLive += 1;
        await replay(name, journal.length, path);
        expect(persistedFirings(path, name), `${name} split at ${split}`).toEqual(expected);
      }
      expect(
        everLive,
        `every cut of ${name} landed where it held nothing, so this asserted only that a ` +
          `finished watch stays finished`,
      ).toBeGreaterThan(0);
    },
    REPLAY_HEAVY_MS,
  );

  it("splits where a document is separated from its index", () => {
    // If the corpus ever stopped putting an index straight after its document,
    // the sweep above would still pass while testing nothing in particular.
    expect(ALL_BOUNDARIES.length).toBeGreaterThan(10);
  });

  it("spreads each watch's cuts across the stretch it is busy over", () => {
    // A sample bunched at one end tests one moment repeatedly. What this asks
    // is that consecutive cuts are not further apart than an even spread over
    // the window would put them, which no clustered sample satisfies.
    for (const name of SPANNING) {
      const splits = boundariesFor(name);
      const span = splits.at(-1)! - splits[0]!;
      const widest = Math.max(...splits.slice(1).map((split, i) => split - splits[i]!));
      expect(widest, `${name}'s cuts are bunched`).toBeLessThanOrEqual((2 * span) / splits.length);
    }
  });

  it("resumes rather than restarting", async () => {
    const name = "important-email-unanswered";
    const path = tempPath();
    await replay(name, journal.length, path);
    const once = persistedFirings(path, name);
    expect(once.length).toBeGreaterThan(0);

    // The cursor is what makes a second run continue rather than start over.
    // Replaying the same journal against the same store must therefore be a
    // no-op; a run that ignored the cursor would redo every event and record
    // each firing a second time.
    await replay(name, journal.length, path);
    expect(persistedFirings(path, name)).toEqual(once);
  });

  it("names watches that still exist in the corpus", () => {
    // A renamed watch would otherwise drop silently out of this sweep, leaving
    // the boundary lane running over two watches while claiming three.
    for (const name of SPANNING) expect(NAMES, name).toContain(name);
  });
});

describe("a run that crashed before its first event committed", () => {
  it("decides the same as a run that never crashed", async () => {
    // The store keeps the boundaries the first attempt fired while its cursor
    // stays at zero, because no event ever committed, so the resumed run
    // re-enters the initial arming path.
    //
    // This asserts the outcome, not the mechanism. Winding the tick back would
    // make those boundaries come due a second time, but the firings table is
    // unique on (watch, sequence, node, key) and absorbs the repeats, so this
    // scenario cannot tell the two apart on its own — it passes with and
    // without `setTimerIfAbsent`. Distinguishing them needs a case where the
    // re-fired boundary carries a different sequence, which is not covered
    // here.
    const name = "elevated-resting-hr-week";
    const path = tempPath();

    // Far enough in that cron boundaries have actually fired — a slice too
    // short to reach one would compare nothing and pass regardless.
    await replay(name, Math.floor(journal.length * 0.6), path);
    const afterCrash = persistedFirings(path, name);
    expect(afterCrash.length, "the crashed run fired no boundaries").toBeGreaterThan(0);

    const store = new WatchStateStore(path);
    try {
      // A crash: the effects are durable, the cursor never advanced.
      store.advanceCursor(name, 0);
    } finally {
      store.close();
    }

    await replay(name, journal.length, path);
    const resumed = persistedFirings(path, name);

    const continuous = tempPath();
    await replay(name, journal.length, continuous);
    expect(resumed).toEqual(persistedFirings(continuous, name));
  });
});

/** A judge that fails until it is repaired. */
class BreakingJudge implements JudgeProvider {
  constructor(private broken: boolean) {}
  repair(): void {
    this.broken = false;
  }
  judge(): { fired: boolean; output: Record<string, unknown> } {
    if (this.broken) throw new Error("judge backend unavailable");
    return { fired: true, output: {} };
  }
}

/**
 * A wait whose deadline elapses into a judge. `ignore` rather than `reset` so a
 * later arm cannot restart the countdown — under `reset` the deadline would
 * never come due and this would test nothing.
 */
const OWED_DEADLINE = {
  name: "owed-deadline-survives-a-failure",
  firing_policy: "stays_active",
  ontology_fingerprint: "poc-ontology-1",
  nodes: [
    {
      id: "mail",
      type: "source.document_event",
      filter: { source: "gmail", event: ["created"], documentType: "email" },
      output_map: { doc_id: "$e.docId" },
    },
    {
      id: "held",
      type: "stateful.wait",
      inputs: { mail: { role: "arm" } },
      on_collision: "ignore",
      duration: "2 days",
      output_map: { doc_id: "$n.mail.doc_id" },
    },
    {
      id: "verdict",
      type: "llm",
      mode: "judge",
      inputs: { held: { role: "arm" } },
      proposition: "Worth surfacing",
      output_schema: { decision: "bool" },
      on_collision: "reset",
      deadline: "infinite",
      output_map: { doc_id: "$n.held.doc_id" },
    },
  ],
  sink: { input: "verdict", output_map: { doc: "$n.verdict.doc_id" } },
};

async function runOwed(path: string, judge: JudgeProvider): Promise<void> {
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const store = new WatchStateStore(path);
  try {
    await new WatchEngine({
      watch: OWED_DEADLINE as never,
      ontology,
      journal: journal.slice(0, 60),
      analytics,
      judge,
      recall: new ScriptedRecall([]),
      store,
    }).run();
  } finally {
    store.close();
    analytics.close();
  }
}

describe("a watch that failed while a deadline was coming due", () => {
  it("still owes that deadline once it is repaired", async () => {
    // The wait elapses during a drain and the judge downstream throws, so the
    // event is taken back and the watch pauses. Repairing the fault and
    // re-activating is what pausing exists for, and the deadline the watch owed
    // has to survive that.
    //
    // This asserts recovery, which a later arm can also deliver. The test
    // below is the one that shows the instance survived rather than being
    // rebuilt.
    const path = tempPath();
    const judge = new BreakingJudge(true);

    await runOwed(path, judge);
    expect(persistedFirings(path, OWED_DEADLINE.name), "paused run fired anyway").toEqual([]);

    // Repair the fault and re-activate, which is what pausing exists for.
    judge.repair();
    const reopened = new WatchStateStore(path);
    try {
      reopened.setActive(OWED_DEADLINE.name, true);
    } finally {
      reopened.close();
    }
    await runOwed(path, judge);

    expect(
      persistedFirings(path, OWED_DEADLINE.name).length,
      "the repaired watch never fired the deadline it owed",
    ).toBeGreaterThan(0);
  });

  it("keeps the instance and its timer through the failure", async () => {
    // The recovery above can be reached a second way — a later arm re-creates
    // the wait — so it does not on its own show that anything survived. This
    // asserts the survival directly: expiring an instance consumes its timer
    // and drops its cell, and outside the event's transaction those are
    // durable. The rolled-back run must still be holding both.
    const path = tempPath();
    await runOwed(path, new BreakingJudge(true));

    const store = new WatchStateStore(path);
    try {
      expect(store.isActive(OWED_DEADLINE.name), "the failure did not pause the watch").toBe(false);
      expect(
        store.cellsFor(OWED_DEADLINE.name, "held").length,
        "the instance was destroyed by a failure it should have survived",
      ).toBe(1);
      expect(
        store.dueTimers(OWED_DEADLINE.name, Number.MAX_SAFE_INTEGER).length,
        "the deadline the watch still owes was lost",
      ).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});

/** Every tick is a firing, so a wound-back tick shows up as a repeat. */
const TICKS_ONLY = {
  name: "ticks-only",
  firing_policy: "stays_active",
  ontology_fingerprint: "poc-ontology-1",
  nodes: [{ id: "daily", type: "source.time", recurring: "0 12 * * *" }],
  sink: { input: "daily", output_map: {} },
};

async function runTicks(path: string, through: number): Promise<void> {
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const store = new WatchStateStore(path);
  try {
    await new WatchEngine({
      watch: TICKS_ONLY as never,
      ontology,
      journal: journal.slice(0, through),
      analytics,
      judge: new ScriptedJudge({ judgements: [] }),
      recall: new ScriptedRecall([]),
      store,
    }).run();
  } finally {
    store.close();
    analytics.close();
  }
}

describe("a recurring tick after a crash before the first commit", () => {
  it("is not wound back, so its boundaries do not fire twice", async () => {
    // The crashed run's tick firings are durable while its cursor never moved,
    // so the resumed run re-enters the initial arming path and must still agree
    // with a run that never crashed.
    //
    // The agreement is what is asserted. More than one thing in the engine
    // holds it — the arming guard that leaves a persisted tick alone, and the
    // firings table's uniqueness, which would absorb a repeated boundary even
    // if the tick did move — so this passing does not by itself say which.
    const path = tempPath();
    await runTicks(path, 60);

    const store = new WatchStateStore(path);
    try {
      // A slice that reached no boundary would compare nothing and pass anyway.
      expect(
        store.firings(TICKS_ONLY.name).length,
        "the crashed run fired no boundaries",
      ).toBeGreaterThan(0);
      store.advanceCursor(TICKS_ONLY.name, 0);
    } finally {
      store.close();
    }

    await runTicks(path, journal.length);

    const reference = tempPath();
    await runTicks(reference, journal.length);
    const resumed = new WatchStateStore(path);
    const clean = new WatchStateStore(reference);
    try {
      const at = (s: WatchStateStore) =>
        s
          .firings(TICKS_ONLY.name)
          .map((f) => f.firedAt)
          .sort();
      expect(at(resumed)).toEqual(at(clean));
    } finally {
      resumed.close();
      clean.close();
    }
  });
});

describe("a recurring tick across a restart", () => {
  it("is not wound back to where a fresh run would start it", async () => {
    // A run that crashed before its first event committed leaves fired
    // boundaries behind with the cursor still at zero, so the resumed run
    // re-enters the initial arming path. The tick it finds there must stand:
    // moving it back to the first boundary after the journal's start would
    // bring every boundary in between due a second time.
    //
    // This pins the property rather than one line of the implementation. The
    // arming guard is not the only reason the tick stands, so it is defence in
    // depth here, not the sole thing under test.
    const path = tempPath();
    await runTicks(path, 60);

    const before = new WatchStateStore(path);
    let held: number[];
    try {
      held = before.dueTimers(TICKS_ONLY.name, Number.MAX_SAFE_INTEGER).map((t) => t.dueAtMs);
      expect(held.length, "the partial run left no tick to preserve").toBeGreaterThan(0);
      before.advanceCursor(TICKS_ONLY.name, 0);
    } finally {
      before.close();
    }

    await runTicks(path, 1);

    const after = new WatchStateStore(path);
    try {
      expect(
        after.dueTimers(TICKS_ONLY.name, Number.MAX_SAFE_INTEGER).map((t) => t.dueAtMs),
        "the tick was wound back on restart",
      ).toEqual(held);
    } finally {
      after.close();
    }
  });
});
