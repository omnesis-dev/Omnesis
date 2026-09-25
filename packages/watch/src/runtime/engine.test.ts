// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the engine does, checked against the universe it will actually run on.
 *
 * These are behavioural, not structural: each asserts a property of the trace a
 * real watch produces over the real fixture journal. A test that only proved
 * "something fired" would pass for a watch firing on the wrong event, so every
 * assertion here names the event and the key too.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { universeDir } from "../universe/paths.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import { loadScript, runDefinition, runWatch } from "./run.js";
import type { WatchTrace } from "./trace.js";

/** The transitions a node went through, in order. */
function transitionsOf(trace: WatchTrace, nodeId: string): string[] {
  return trace.records.filter((r) => r.nodeId === nodeId).map((r) => r.transition);
}

/**
 * `major-life-turning-point` with a shorter cap and nothing else changed.
 *
 * That watch is the corpus's only cooldown with something to suppress: a
 * weekly investigation whose verdict is scripted true on six boundaries, held
 * to one firing a month. Re-running it at a one-day interval is the
 * counterweight — same journal, same verdicts, same arms, and the only
 * difference is the number the cap is asked to enforce.
 */
const CAPPED = "major-life-turning-point";

function withInterval(name: string, minInterval: string): unknown {
  const raw = JSON.parse(readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8")) as {
    watch: { name: string; nodes: { type: string; min_interval?: string }[] };
  };
  const capped = raw.watch.nodes.filter((node) => node.type === "stateful.cooldown");
  expect(capped, `${name} has no cooldown to re-parameterize`).toHaveLength(1);
  capped[0]!.min_interval = minInterval;
  return raw;
}

/** The judge and recall answers the universe scripts for a watch. */
function scriptedFor(name: string): { judge: ScriptedJudge; recall: ScriptedRecall } {
  const script = loadScript(name);
  return {
    judge: new ScriptedJudge({ judgements: script.judgements ?? [] }),
    recall: new ScriptedRecall(script.recall ?? []),
  };
}

describe("waits and their deadlines", () => {
  it("restarts a heartbeat on every arm and fires when the rhythm stops", async () => {
    const trace = await runWatch("mum-call-rhythm-stopped");

    // Ten calls over the season, in three runs separated by silences. Each call
    // inside a run restarts the countdown; each silence runs it out. A reset
    // records both halves — the instance that ended and the one that replaced
    // it — because a trace that showed only "reset" would not say that the
    // deadline moved.
    //
    // The whole sequence rather than a count of fires: what this is about is
    // that firing does not end the heartbeat, and only the arm *after* each
    // fire shows that.
    expect(transitionsOf(trace, "rhythm_broken")).toEqual([
      // First run: 1st, 8th, 15th of March, then eighteen days of silence.
      "armed",
      "reset",
      "armed",
      "reset",
      "armed",
      "fired",
      // Second: 2nd, 9th, 16th of April, then thirteen days.
      "armed",
      "reset",
      "armed",
      "reset",
      "armed",
      "fired",
      // Third: 29th of April and 6th of May, then twenty.
      "armed",
      "reset",
      "armed",
      "fired",
      // And a last call, still waiting when the journal ends.
      "armed",
    ]);
    expect(trace.firings).toHaveLength(3);
  });

  it("fires a deadline that came due during an outage, at its due time", async () => {
    const trace = await runWatch("mum-call-rhythm-stopped");
    const firing = trace.firings[0]!;

    // The last call was on the 15th; nine days later is the 24th. Nothing was
    // observed between the 22nd and the 25th, so the engine caught it up — and
    // dated it when it was due, not when it noticed.
    expect(firing.firedAt).toBe("2026-03-24T17:45:00.000Z");
    expect(firing.payload.last_call).toBe("2026-03-15T17:45:00.000Z");
  });

  it("fires the caught-up deadline once, not once per missed day", async () => {
    const trace = await runWatch("mum-call-rhythm-stopped");
    // Only the first of the three deadlines fell inside the outage. It is the
    // one at issue: the other two came due with the journal running normally,
    // and counting all three would pass whatever the catch-up did.
    const caughtUp = trace.firings.filter((f) => f.firedAt.startsWith("2026-03-24"));
    expect(caughtUp).toHaveLength(1);
  });
});

describe("keys and edge detection", () => {
  it("keys a running total by month and fires when it crosses, once", async () => {
    const trace = await runWatch("restaurant-budget-500");
    const gate = trace.records.filter((r) => r.nodeId === "month_over_500");

    // A transaction lands on the key of the month it happened in, and the
    // season spans three of them.
    expect(new Set(gate.map((r) => r.key))).toEqual(
      new Set(["month=2026-03-01", "month=2026-04-01", "month=2026-05-01"]),
    );

    // Within each month the running total is held until it crosses, and then
    // fires once — the total does not carry over, and a month that has already
    // fired does not fire again on its next transaction.
    expect(gate.map((r) => r.transition)).toEqual([
      "held",
      "held",
      "held",
      "fired",
      "held",
      "held",
      "fired",
      "held",
      "held",
      "held",
      "held",
      "fired",
    ]);
    expect(trace.firings.map((f) => f.payload.total)).toEqual([556.15, 520, 505]);
  });

  it("sees only the rows that had arrived, not the month's final total", async () => {
    const trace = await runWatch("restaurant-budget-500");
    // The threshold is crossed by the fourth transaction on the 20th. If the
    // store were seeded whole, the first transaction would already have seen
    // the full month and fired on the 3rd.
    expect(trace.firings[0]!.firedAt).toBe("2026-03-20T21:00:00.000Z");
  });
});

describe("cognitive state", () => {
  it("fires on the transition into a closed state, not on every update", async () => {
    const trace = await runWatch("tax-loop-closed");
    expect(transitionsOf(trace, "became_closed")).toEqual(["held", "fired"]);
    expect(trace.firings[0]!.payload.loop).toBe("File the self-assessment return");
  });
});

describe("recurring time sources", () => {
  it("keeps a daily condition quiet by firing only where it becomes true", async () => {
    const trace = await runWatch("elevated-resting-hr-week");

    // Rising-edge evaluation is what makes this watch quiet, not the cooldown
    // above it: the condition is true on most days of the month and the node
    // fires only where it becomes true. The cap cannot bite here at all — the
    // query's own seven-day window means a broken streak suppresses the node
    // for seven days, so two rising edges can never fall inside a seven-day
    // cooldown. What this watch demonstrates is the edge; the cooldown is
    // exercised below, on a shape where it has something to suppress.
    const evaluated = transitionsOf(trace, "hr_week_check");
    expect(evaluated.filter((t) => t === "held").length).toBeGreaterThan(
      evaluated.filter((t) => t === "fired").length,
    );
    const instants = trace.firings.map((f) => Date.parse(f.firedAt));
    for (let i = 1; i < instants.length; i++) {
      expect(instants[i]! - instants[i - 1]!).toBeGreaterThanOrEqual(7 * 86_400_000);
    }
  });

  it("suppresses the arms that land inside a cooldown", async () => {
    const trace = await runWatch(CAPPED);

    // The cap is doing the work here and can be seen doing it: every arm the
    // node turns away is a `held` record saying why. Asserting the spacing
    // alone would pass on a watch whose arms were already a month apart.
    const arms = transitionsOf(trace, "monthly_cap");
    const suppressed = trace.records.filter(
      (r) => r.nodeId === "monthly_cap" && r.detail === "within the cooldown",
    );
    expect(suppressed.length, "the cooldown turned nothing away").toBeGreaterThan(0);
    // Every arm either fired or was suppressed — nothing was quietly dropped,
    // and nothing reached the sink without passing the cap.
    expect(arms.length - suppressed.length).toBe(trace.firings.length);
  });

  it("lets the same arms through when the interval is short enough", async () => {
    // The counterweight: the suppression above is a property of the declared
    // interval, not of the fixture. Shortening it and leaving the journal, the
    // scripted verdicts and every other node alone must let every arm through.
    const uncapped = await runDefinition(withInterval(CAPPED, "1 days"), scriptedFor(CAPPED));
    const capped = await runWatch(CAPPED);

    const arms = transitionsOf(uncapped, "monthly_cap");
    expect(arms.length, "the re-parameterized watch reached its cap at all").toBeGreaterThan(
      capped.firings.length,
    );
    expect(
      uncapped.records.filter(
        (r) => r.nodeId === "monthly_cap" && r.detail === "within the cooldown",
      ),
      "a one-day cap still turned an arm away",
    ).toEqual([]);
    expect(uncapped.firings.length, "not every arm reached the sink").toBe(arms.length);
  });

  it("joins projected graph tables a watch cannot otherwise reach", async () => {
    const trace = await runWatch("meeting-with-lost-touch");
    // Three of the season's seventeen meetings are with the one person whose
    // last contact is over a year old. The join has to reject the other
    // fourteen, all of which are with people seen that week.
    expect(trace.firings.map((f) => f.payload.people)).toEqual([
      ["Priya Raman"],
      ["Priya Raman"],
      ["Priya Raman"],
    ]);
  });
});

describe("semantic match", () => {
  // Two emails from the season, by their anchored ids — see the ANCHORS list in
  // the universe generator for why these do not move when the corpus grows.
  // Nobody answers the first; the second is replied to on the fourth.
  const CONTRACT_EMAIL = "d0c00001-0000-4000-8000-000000000007";
  const ANSWERED_EMAIL = "d0c00001-0000-4000-8000-000000000011";

  const recall = new ScriptedRecall([
    { nodeId: "inbound_email", documentId: CONTRACT_EMAIL, score: 0.71 },
  ]);

  it("declines when nothing is scripted, rather than firing for no stated reason", async () => {
    // Explicitly unscripted — the universe ships a script for this watch, and
    // the point here is what happens without one.
    const trace = await runWatch("important-email-unanswered", {
      judge: new ScriptedJudge({ judgements: [] }),
      recall: new ScriptedRecall([]),
    });
    expect(trace.firings).toEqual([]);
    // `ignored` where no arm nominated, never `fired`. A document the recall
    // pass did not surface has not been judged, and the trace says which of the
    // two happened.
    expect(transitionsOf(trace, "inbound_email").every((t) => t === "ignored")).toBe(true);
  });

  it("stops at recall when the score is below the threshold", async () => {
    const trace = await runWatch("important-email-unanswered", {
      recall: new ScriptedRecall([
        { nodeId: "inbound_email", documentId: CONTRACT_EMAIL, score: 0.2 },
      ]),
      judge: new ScriptedJudge({
        judgements: [
          { nodeId: "inbound_email", fired: true, output: { importance_reason: "signature" } },
        ],
      }),
    });
    const notNominated = trace.records.filter(
      (r) => r.nodeId === "inbound_email" && r.transition === "ignored",
    );
    expect(notNominated.some((r) => r.detail?.includes("semantic 0.20 below"))).toBe(true);
    expect(trace.firings).toEqual([]);
  });

  it("runs recall then the judge, and only fires when both pass", async () => {
    const trace = await runWatch("important-email-unanswered", {
      recall,
      judge: new ScriptedJudge({
        judgements: [
          {
            nodeId: "inbound_email",
            documentId: CONTRACT_EMAIL,
            fired: true,
            output: { importance_reason: "a contract needs signing before Friday" },
          },
        ],
      }),
    });

    // The email arms the wait; nothing answers that thread, so three days later
    // the wait elapses and the watch fires.
    expect(transitionsOf(trace, "unanswered_3d")).toEqual(["armed", "fired"]);
    expect(trace.firings).toHaveLength(1);
    expect(trace.firings[0]!.payload.why).toBe("a contract needs signing before Friday");
    expect(trace.firings[0]!.firedAt).toBe("2026-03-05T09:00:00.000Z");
  });

  it("cancels the wait when a reply lands on the same thread", async () => {
    const trace = await runWatch("important-email-unanswered", {
      // A different thread — one the fixture does answer, on the fourth.
      recall: new ScriptedRecall([
        { nodeId: "inbound_email", documentId: ANSWERED_EMAIL, score: 0.8 },
      ]),
      judge: new ScriptedJudge({
        judgements: [
          { nodeId: "inbound_email", fired: true, output: { importance_reason: "venue" } },
        ],
      }),
    });

    expect(transitionsOf(trace, "unanswered_3d")).toEqual(["armed", "cancelled"]);
    expect(trace.firings).toEqual([]);
  });

  it("reports a scripted judgement nobody reached", async () => {
    const judge = new ScriptedJudge({
      judgements: [{ nodeId: "no_such_node", fired: true }],
    });
    await runWatch("important-email-unanswered", { judge, recall });
    expect(judge.unusedJudgements().map((j) => j.nodeId)).toEqual(["no_such_node"]);
  });
});
