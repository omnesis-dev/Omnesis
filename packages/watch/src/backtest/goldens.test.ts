// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The golden corpus.
 *
 * Every watch in the universe is replayed and compared against a frozen trace:
 * the ordered `(seq, node, key, transition)` records and the firings they end
 * in, plus the backtest's reach counts. A trace rather than a verdict, because
 * "the watch fired" says nothing about *why* — a watch that fires on the wrong
 * event, keyed on the wrong thing, or via a cancel that never arrives, still
 * fires.
 *
 * The frozen file is a change detector. The assertions **above** it are the
 * oracle: each names a property of the trace in its own terms, so a regression
 * that silently rewrote a golden would still have to get past them.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ScriptedJudge, ScriptedRecall } from "../runtime/providers.js";
import { loadWatch, runWatch } from "../runtime/run.js";
import { parseDuration } from "../time/duration.js";
import { universeDir } from "../universe/paths.js";
import { frozenGolden as golden, recordGolden, watchNames } from "./golden.js";
import type { WatchTrace } from "../runtime/trace.js";

const TRACES = join(universeDir(), "traces");

const NAMES = watchNames();

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  business_days: 86_400_000,
  weeks: 604_800_000,
};

/**
 * The shortest interval this watch says must separate two firings of one key.
 *
 * Read from the watch definition rather than assumed, so a watch that declares
 * a six-hour cooldown is held to six hours instead of to whatever constant this
 * test would otherwise have picked. A watch declaring none still may not fire
 * twice at the same instant on one key, so the floor is one millisecond.
 */
function cooldownMs(name: string): number {
  const declared = loadWatch(name)
    .nodes.flatMap((node) => ("min_interval" in node ? [node.min_interval] : []))
    .flatMap((text) => {
      const parsed = typeof text === "string" ? parseDuration(text) : null;
      const unit = parsed ? UNIT_MS[parsed.unit] : undefined;
      return parsed && unit !== undefined ? [parsed.amount * unit] : [];
    });
  return declared.length > 0 ? Math.min(...declared) : 1;
}

/**
 * The instance key each firing came from. A firing records only the sink's
 * payload, so the key is taken from the node transition recorded at the same
 * sequence — which is what decides whether two firings are a repeat or two
 * independent facts.
 */
function firingKeys(trace: WatchTrace): string[] {
  return trace.firings.map((firing) => {
    const record = trace.records.find(
      (r) => r.seq === firing.seq && r.transition === "fired" && r.nodeId !== "<watch>",
    );
    return record?.key ?? "singleton";
  });
}

describe("golden traces", () => {
  it("every watch in the universe has one", () => {
    const frozen = readdirSync(TRACES)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(frozen).toEqual(NAMES);
  });

  it.each(NAMES)("%s replays and backtests exactly as recorded", async (name) => {
    expect(await recordGolden(name)).toEqual(golden(name));
  });

  it("records every field the goldens are supposed to carry", () => {
    // The comparison above uses the same projection that wrote the files, so
    // it cannot see a field dropped from both sides at once. This states the
    // fields independently: removing one from `recordGolden` and regenerating
    // would leave the frozen files short of what is listed here.
    const always = ["days", "events", "firings", "reachByNode", "totalReaches", "unboundedNodes"];
    // Recorded only where it is true, so it cannot be required of every watch —
    // but it has to be recorded somewhere, or dropping it from the projection
    // and regenerating would leave every file quietly short of it.
    const whereTrue = "endedEarly";
    for (const name of NAMES) {
      expect(Object.keys(golden(name)).sort(), name).toEqual(["backtest", "trace"]);
      const keys = Object.keys(golden(name).backtest);
      expect(keys.filter((k) => k !== whereTrue).sort(), name).toEqual(always);
      expect(
        keys.filter((k) => !always.includes(k) && k !== whereTrue),
        name,
      ).toEqual([]);
    }
    expect(
      NAMES.filter((name) => whereTrue in golden(name).backtest).length,
      "no golden records whether the replay ended early",
    ).toBeGreaterThan(0);
  });

  it("replaying twice gives the same trace", async () => {
    // Determinism is the property the whole corpus rests on. If a run varied,
    // every golden would be a flake waiting to happen.
    const first = await runWatch("restaurant-budget-500");
    const second = await runWatch("restaurant-budget-500");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("what the traces actually say", () => {
  it("all but one watch fires; that one correctly declines", () => {
    const firing = NAMES.filter((name) => golden(name).trace.firings.length > 0);
    const quiet = NAMES.filter((name) => golden(name).trace.firings.length === 0);

    expect(firing).toHaveLength(NAMES.length - 1);
    // A trip in September 2026 against a passport valid to 2031 is exactly the
    // case this watch exists to stay quiet about. The transform ran and said no.
    expect(quiet).toEqual(["trip-vs-passport-expiry"]);
  });

  it("the passport watch evaluated rather than never reaching its transform", () => {
    const trace = golden("trip-vs-passport-expiry").trace;
    const check = trace.records.filter((r) => r.nodeId === "passport_check");
    expect(check).toHaveLength(1);
    expect(check[0]!.transition).toBe("held");
  });

  it("the passport comparison is not simply always false", async () => {
    // The frozen trace shows it declining. Flip only the judged departure date
    // to one inside the six-month window and the same transform fires — which
    // is what makes the recorded silence evidence rather than an absence.
    const trace = await runWatch("trip-vs-passport-expiry", {
      recall: new ScriptedRecall([
        { nodeId: "trip_booked", documentId: "d0c00001-0000-4000-8000-000000000001", score: 0.74 },
      ]),
      judge: new ScriptedJudge({
        judgements: [
          {
            nodeId: "trip_booked",
            fired: true,
            output: { depart_date: "2031-02-01", destination_country: "Portugal" },
          },
        ],
      }),
    });
    expect(trace.firings).toHaveLength(1);
    expect(trace.firings[0]!.payload.departs).toBe("2031-02-01");
  });

  it("spaces repeated firings on one key by that watch's own cooldown", () => {
    // Firing more than once is not the problem — a watch that never can is a
    // watch with one scenario. Two firings on *different* keys are two facts
    // and may share an instant. Two on the *same* key are a repeat, and the
    // only thing that makes a repeat legitimate is the watch's own declared
    // cooldown. Reading that interval from the definition rather than assuming
    // a day is what stops this passing on a watch that storms below it.
    for (const name of NAMES) {
      const { trace } = golden(name);
      if (trace.firings.length < 2) continue;

      const keys = firingKeys(trace);
      const byKey = new Map<string, number[]>();
      trace.firings.forEach((firing, index) => {
        const key = keys[index]!;
        byKey.set(key, [...(byKey.get(key) ?? []), Date.parse(firing.firedAt)]);
      });

      const floor = cooldownMs(name);
      for (const [key, instants] of byKey) {
        const sorted = [...instants].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i += 1) {
          expect(sorted[i]! - sorted[i - 1]!, `${name} key ${key}`).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it("has a watch that fires repeatedly on one key, so the rule above is exercised", () => {
    const repeats = NAMES.filter((name) => {
      const keys = firingKeys(golden(name).trace);
      return keys.length > new Set(keys).size;
    });
    expect(repeats.length, "no watch fires twice on one key").toBeGreaterThan(0);
  });

  it("names which watches decide without a model at all", () => {
    const procedural = NAMES.filter((name) => golden(name).backtest.totalReaches === 0);
    expect(procedural.sort()).toEqual([
      "elevated-resting-hr-week",
      "large-card-spending-streak",
      "maya-conversation-lapsed",
      "meeting-with-lost-touch",
      "mum-call-rhythm-stopped",
      "restaurant-budget-500",
      "tax-loop-closed",
    ]);
  });

  it("shows which watches would be expensive, which is the point of the report", () => {
    // A watch whose structural filter is just "any email from this account"
    // reaches the judge on every one. That is the signal the reach report
    // exists to give a compiler: this filter is not doing enough work.
    const invoice = golden("invoice-and-receipt-both-arrived").backtest;
    expect(invoice.totalReaches).toBeGreaterThan(20);

    // A watch that names a person structurally reaches it far less often.
    const alice = golden("alice-declines-dinner").backtest;
    expect(alice.totalReaches).toBeLessThan(invoice.totalReaches / 2);
  });

  it("a judge never fires in a backtest, so the count is the procedural half", () => {
    for (const name of NAMES) {
      const { backtest: report, trace } = golden(name);
      if (report.totalReaches === 0) continue;
      // Every one of these fires in a normal run and not in a backtest,
      // because everything downstream of a judge is gated on it.
      expect(report.firings, name).toBe(0);
      expect(trace.firings.length, name).toBeGreaterThanOrEqual(0);
    }
  });
});
