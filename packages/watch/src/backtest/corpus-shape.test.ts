// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Properties of the corpus itself, rather than of any watch in it.
 *
 * A golden corpus is worth only what its scenarios can distinguish. When every
 * watch fires at most once with a single key live, a per-node last-write and
 * correct per-instance state produce identical traces, and every assertion in
 * the corpus passes against either. Concurrency is what separates them.
 *
 * So these tests assert shape: instances stay concurrent, multi-key watches
 * give each firing its own payload, and every transition the runtime can make
 * appears somewhere. A fixture edit that returns the corpus to the
 * indistinguishable shape fails here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TRANSITIONS } from "../runtime/trace.js";
import { universeDir } from "../universe/paths.js";
import type { WatchTrace } from "../runtime/trace.js";

const TRACES = join(universeDir(), "traces");

function traces(): { name: string; trace: WatchTrace }[] {
  return readdirSync(TRACES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      trace: (JSON.parse(readFileSync(join(TRACES, f), "utf8")) as { trace: WatchTrace }).trace,
    }));
}

/**
 * Peak number of distinct keys waiting on one node at the same moment.
 *
 * `accumulated` is deliberately not counted. An accumulating cell survives its
 * own firing by design, so a monthly-total watch adds a key per month and never
 * gives one back — a count that included them would climb on a watch where
 * nothing whatsoever is concurrent, which is the opposite of what this measures.
 */
function peakLiveKeys(trace: WatchTrace, nodeId: string): number {
  const live = new Set<string>();
  let peak = 0;
  for (const record of trace.records) {
    if (record.nodeId !== nodeId) continue;
    if (record.transition === "armed") live.add(record.key);
    else if (["fired", "cancelled", "expired", "dropped"].includes(record.transition)) {
      live.delete(record.key);
    }
    peak = Math.max(peak, live.size);
  }
  return peak;
}

/**
 * The scenario that carries the corpus's concurrency. Several important emails
 * arrive unanswered at once, so this node holds one instance per thread and a
 * firing has to find its own thread's payload rather than the newest one.
 */
const CONCURRENT = { watch: "important-email-unanswered", node: "unanswered_3d" };

/**
 * The one node in the corpus that discards a colliding arm.
 *
 * Named, because `ignored` also covers a document no recall arm nominated and
 * there are hundreds of those — a check on the transition alone would pass on
 * the recall path forever while collision-ignore quietly stopped happening.
 */
const COLLISION_IGNORE = { watch: "proposal-no-reply-5bd", node: "silence_5bd" };

describe("the corpus is shaped to catch things", () => {
  const all = traces();

  it("holds several instances of one node live at once", () => {
    // Named rather than maximised over the corpus. A max says only that
    // something somewhere was concurrent, and stays green while the scenario
    // that earned it is quietly serialised and some other node takes its place.
    const trace = all.find(({ name }) => name === CONCURRENT.watch)?.trace;
    expect(trace, `${CONCURRENT.watch} is missing from the corpus`).toBeDefined();

    // Three is the point at which "the firing instance got the most recent
    // arm's payload" stops looking like correct behaviour.
    expect(peakLiveKeys(trace!, CONCURRENT.node)).toBeGreaterThanOrEqual(3);
  });

  it("has a watch that fires several times, each for its own key", () => {
    // Only watches that are genuinely multi-key: a singleton watch firing twice
    // on a cooldown is allowed to say the same thing twice.
    const multiKey = all.filter(({ trace }) => {
      const keys = new Set(trace.records.filter((r) => r.key !== "singleton").map((r) => r.key));
      return trace.firings.length > 1 && keys.size > 1;
    });
    expect(multiKey.length).toBeGreaterThan(0);

    // Their payloads must differ. Identical ones would mean one instance's data
    // reached every firing — the exact contamination this exists to catch.
    for (const { name, trace } of multiKey) {
      const payloads = trace.firings.map((f) => JSON.stringify(f.payload));
      expect(new Set(payloads).size, name).toBe(payloads.length);
    }
  });

  it("exercises every transition the runtime can make, or says which it cannot", () => {
    const seen = new Set(all.flatMap(({ trace }) => trace.records.map((r) => r.transition)));

    // These need a failing, quarantined or refused instance, which a corpus of
    // watches that are all meant to work cannot produce. `failed` is asserted
    // in `runtime/adversarial.test.ts`; `quarantined` and `refused` have no
    // assertion anywhere in the package yet, and this list is where that gap is
    // recorded rather than left to be discovered.
    //
    // `skipped` is a different kind of absence: the runtime never makes it. It
    // records an operator moving a stopped watch past an event it could not get
    // through, which is written by the host and asserted there.
    // `suppressed` is like `skipped`: the runtime never makes it. A cap on how
    // often a watch may interrupt a person is a host concern, and it is
    // asserted there.
    // `forced` is the same again, and the clearest case of it: an operator
    // firing a watch by hand evaluates no event at all, so no corpus can
    // produce one. The host asserts it.
    const unreachableFromGoldens = new Set([
      "failed",
      "quarantined",
      "refused",
      "skipped",
      "suppressed",
      "forced",
    ]);
    const missing = TRANSITIONS.filter((t) => !seen.has(t) && !unreachableFromGoldens.has(t));
    expect(missing).toEqual([]);
  });

  it("contains a cancelled instance and an expired one", () => {
    // A corpus of successes proves only that success works. The interesting
    // half of a watch is what it does when the thing never happens.
    const seen = new Set(all.flatMap(({ trace }) => trace.records.map((r) => r.transition)));
    expect(seen.has("cancelled")).toBe(true);
    expect(seen.has("expired")).toBe(true);
    expect(seen.has("dropped")).toBe(true);
    // Named by its node, not merely by its transition. A document no recall arm
    // nominated is also `ignored`, and there are hundreds of those — so a bare
    // `seen.has("ignored")` stopped saying anything about collision-ignore, the
    // behaviour this line exists to pin.
    const collisionIgnored = all.some(({ trace }) =>
      trace.records.some((r) => r.transition === "ignored" && r.nodeId === COLLISION_IGNORE.node),
    );
    expect(collisionIgnored, "no watch discards a colliding arm any more").toBe(true);
  });
});
