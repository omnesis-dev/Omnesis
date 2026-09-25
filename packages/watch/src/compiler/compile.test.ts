// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compile loop, driven by a model whose answers are written down.
 *
 * Everything here is scripted. A test that reached a real model would be a test
 * whose result depends on that model's mood, and what deserves testing is the
 * loop itself — that a diagnostic comes back as machine feedback, that repairs
 * are bounded, that a refusal ends the loop rather than being retried, that the
 * revision pass cannot cost a compilation that already works.
 *
 * The watches below are the corpus's own, replayed through the scripted model
 * as if it had written them. That keeps the fixtures honest: they validate
 * because they are real, not because they were trimmed until they did.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadOntology, universeDir } from "../universe/paths.js";
import { loadWatch } from "../runtime/run.js";
import { validateWatch } from "../validator/validate.js";
import { frozenGolden, watchNames } from "../backtest/golden.js";
import { failureFrom, type BacktestReport } from "../backtest/backtest.js";
import { parseReply } from "./parse.js";
import { compile, reachConcern, DEFAULT_REACH_POLICY } from "./compile.js";
import { examplesFor } from "./examples.js";
import { loadLoops } from "./loops.js";
import { ScriptedModel } from "./model.js";
import type { CompilerContext } from "./prompt.js";

const ontology = loadOntology();

const context: CompilerContext = {
  ontology,
  loops: loadLoops(),
  examples: examplesFor(["important-email-unanswered"]),
};

/** A corpus watch, as a model would have to emit it. */
function reply(name: string): string {
  const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
  const watch = (JSON.parse(raw) as { watch: unknown }).watch;
  return "```json\n" + JSON.stringify({ decision: "compile", watch }) + "\n```";
}

/** The same watch with one thing broken, so the validator has something to say. */
function brokenReply(name: string, mutate: (watch: Record<string, unknown>) => void): string {
  const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
  const watch = (JSON.parse(raw) as { watch: Record<string, unknown> }).watch;
  mutate(watch);
  return "```json\n" + JSON.stringify({ decision: "compile", watch }) + "\n```";
}

const REFUSAL =
  '```json\n{"decision":"refuse","reasons":["the ontology declares no card-transaction source"]}\n```';

/**
 * The watch that stands for "a good answer" in these tests.
 *
 * It has to be one the reach policy is quiet about. A watch the policy flags is
 * shown its report and asked to reconsider, which is correct behaviour and makes
 * "the loop stops asking" unobservable: the scripted model runs out of replies
 * and the test fails for a reason that has nothing to do with what it is
 * checking. This one replays three firings and reaches no model at all.
 *
 * The revision pass has its own tests below, which supply the extra reply.
 */
const GOOD = "mum-call-rhythm-stopped";

/**
 * A watch that fires on every email in the journal.
 *
 * No reference fires often enough to trip a cadence band — the bands are aimed
 * at compilations that forgot to bound themselves, not at the answer key. So a
 * test of that path has to supply the loud watch itself.
 */
const LOUD = {
  decision: "compile",
  watch: {
    name: "every-email",
    firing_policy: "stays_active",
    ontology_fingerprint: ontology.fingerprint,
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail" },
  },
};

describe("the request's cadence reaches the revision pass", () => {
  const loud = "```json\n" + JSON.stringify(LOUD) + "\n```";
  // The fixed cap is lifted out of the way so the only thing that can ask for a
  // revision is the cadence the request names. Without that, this would pass on
  // the pre-existing firings check and prove nothing about the calibration.
  const noFixedCap = { reachPolicy: { ...DEFAULT_REACH_POLICY, maxFiringsPerDay: 1000 } };

  it("asks a loud watch to reconsider when the request wanted rarity", async () => {
    const model = new ScriptedModel([loud, loud]);
    await compile("Alert me if the disk fills up", context, model, noFixedCap);

    const revision = model.calls[1];
    expect(revision, "a request naming rarity was never asked to reconsider").toBeDefined();
    expect(revision!.at(-1)!.content).toContain("0.2");
  });

  it("says nothing when the compiler is not calibrated for bounds", async () => {
    // The control arm of the A/B. Same watch, same request, same policy — the
    // one difference is that the request is not read for its cadence.
    const model = new ScriptedModel([loud]);
    await compile(
      "Alert me if the disk fills up",
      { ...context, operationalBounds: false },
      model,
      noFixedCap,
    );

    expect(model.calls, "the control arm received the cadence feedback").toHaveLength(1);
  });
});

describe("compiling the graph first and bounding it second", () => {
  /** The quiet corpus watch, with its rate limiter taken out. */
  function unbounded(): string {
    const raw = readFileSync(join(universeDir(), "watches", `${GOOD}.json`), "utf8");
    const watch = (JSON.parse(raw) as { watch: Record<string, unknown> }).watch;
    const nodes = watch.nodes as Record<string, unknown>[];
    const wait = nodes.find((n) => n.type === "stateful.wait");
    if (wait !== undefined) wait.duration = "12 days";
    return "```json\n" + JSON.stringify({ decision: "compile", watch }) + "\n```";
  }

  /** The context the harness gives this arm: the checklist arrives on turn two, not one. */
  const firstPassContext = { ...context, operationalBounds: false };

  it("asks a second time, with the checklist and nothing else", async () => {
    const model = new ScriptedModel([unbounded(), reply(GOOD)]);
    const result = await compile("anything", firstPassContext, model, { boundsPass: true });

    // The checklist reaches the model exactly once, and on the second turn —
    // the whole point of splitting it out of the prompt.
    expect(model.calls[0]!.some((m) => m.content.includes("say what you did about each"))).toBe(
      false,
    );

    expect(result.status).toBe("compiled");
    expect(model.calls, "the bounds pass did not happen").toHaveLength(2);

    const second = model.calls[1]!.at(-1)!.content;
    expect(second, "the second turn did not carry the checklist").toContain(
      "say what you did about each",
    );
    expect(second, "the second turn re-describes the plan instead of pointing at it").not.toContain(
      "stateful.wait",
    );
    // Once, not once per turn: a bounds question asked repeatedly would be a
    // different intervention from the one being measured.
    expect(model.calls.filter((c) => c.at(-1)!.content.includes("how often it can"))).toHaveLength(
      1,
    );
    // The plan it is asked to bound is its own previous answer, in the thread.
    expect(model.calls[1]!.some((m) => m.role === "assistant")).toBe(true);
  });

  it("keeps what the second pass wrote", async () => {
    const model = new ScriptedModel([unbounded(), reply(GOOD)]);
    const result = await compile("anything", firstPassContext, model, { boundsPass: true });
    if (result.status !== "compiled") throw new Error("expected a compilation");

    const wait = result.watch.nodes.find((n) => n.type === "stateful.wait");
    expect(wait, "the bounded plan was not the one kept").toMatchObject({ duration: "9 days" });
    expect(result.attempts.map((a) => a.cause)).toContain("bounds");

    // The document travels with the watch. It is what a universe would be
    // written from, so a stale one is a plan nobody compiled.
    const written = (result.document as { watch: { nodes: Record<string, unknown>[] } }).watch;
    expect(written.nodes.find((n) => n.type === "stateful.wait")).toMatchObject({
      duration: "9 days",
    });
  });

  it("keeps the written plan when the second pass comes back unusable", async () => {
    // The floor. A bounds turn that cannot be read leaves the watch that
    // already validated standing, rather than costing the whole compilation.
    const model = new ScriptedModel([unbounded(), "not a watch at all"]);
    const result = await compile("anything", firstPassContext, model, { boundsPass: true });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    const wait = result.watch.nodes.find((n) => n.type === "stateful.wait");
    expect(wait, "an unusable second pass discarded the first").toMatchObject({
      duration: "12 days",
    });
  });

  it("does not happen at all unless asked for", async () => {
    const model = new ScriptedModel([reply(GOOD)]);
    await compile("anything", context, model);
    expect(model.calls).toHaveLength(1);
  });

  it("puts its own answer in the thread before anything else is asked", async () => {
    // A revision turn that never speaks leaves the conversation ending on the
    // plan it replaced. Anything asked afterwards is then asked about a plan
    // the model cannot see, and answered over the one it can.
    const model = new ScriptedModel([unbounded(), reply(GOOD), reply(GOOD)]);
    await compile("anything", firstPassContext, model, {
      boundsPass: true,
      reachPolicy: { ...DEFAULT_REACH_POLICY, minFirings: 100 },
    });

    const afterBounds = model.calls.at(-1)!;
    const plans = afterBounds.filter((m) => m.role === "assistant");
    expect(plans.length, "the bounds turn never entered the thread").toBeGreaterThan(1);
    expect(plans.at(-1)!.content, "the thread ends on the plan the bounds turn replaced").toContain(
      "9 days",
    );
  });
});

describe("a watch that compiles first time", () => {
  it("validates it, backtests it and stops asking", async () => {
    const model = new ScriptedModel([reply(GOOD)]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.watch.name).toBe(GOOD);
    expect(result.report, "a compilation came back without a replay").not.toBeNull();
    expect(result.report?.watch).toBe(GOOD);
    expect(result.attempts.map((a) => [a.turn, a.cause])).toEqual([[0, "initial"]]);
    expect(result.usage, "the turn's tokens were not counted").toEqual(model.claimed);
    expect(model.unused, "the loop asked fewer questions than it was given").toBe(0);
  });

  it("puts the query last, after a prefix it did not touch", async () => {
    const model = new ScriptedModel([reply(GOOD)]);
    await compile("warn me about unanswered mail", context, model);

    const sent = model.calls[0]!;
    expect(sent[0]!.role).toBe("system");
    expect(sent.at(-1)!.content).toContain("warn me about unanswered mail");
    expect(sent[0]!.content).not.toContain("warn me about unanswered mail");
  });
});

describe("compiling against an ontology that is not on disk", () => {
  // A live install assembles its ontology from the running gateway. It can
  // satisfy the invariant the universe check protects — one ontology for both
  // compiling and validating — but it can never match a file, so the file
  // comparison is the wrong way to ask.

  it("compiles against the caller's own ontology", async () => {
    const model = new ScriptedModel([reply(GOOD)]);
    const result = await compile("anything", context, model, { ontologyIsCallers: true });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.watch.name).toBe(GOOD);
  });

  it("reports no replay, because there is no journal to replay against", async () => {
    // Silence would be worse than a null: a caller reading a report that was
    // never run would believe the reach had been measured.
    const model = new ScriptedModel([reply(GOOD)]);
    const result = await compile("anything", context, model, { ontologyIsCallers: true });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.report, "a compile with nothing to replay claimed a report").toBeNull();
  });

  it("replays on the caller's own substrate when it brings one", async () => {
    // The half of the loop a live install never got. Its ontology comes from a
    // running gateway rather than a directory, so the replay has to come from
    // there too — and until it did, the only substrate anyone runs watches on
    // was the one substrate no watch was measured against before install.
    const model = new ScriptedModel([reply(GOOD)]);
    const seen: string[] = [];
    const result = await compile("anything", context, model, {
      ontologyIsCallers: true,
      backtest: (watch) => {
        seen.push(watch.name);
        return Promise.resolve({
          watch: watch.name,
          events: 4_200,
          days: 90,
          firings: 3,
          reachByNode: {},
          totalReaches: 0,
        });
      },
    });

    expect(seen, "the caller brought a replay and the loop did not use it").toEqual([GOOD]);
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.report?.firings).toBe(3);
  });

  it("asks the model to reconsider a watch its own history says never fires", async () => {
    // The same concern for either substrate: a caller that brings its own replay
    // gets the reach report and the revision a universe compile gets.
    // One revision, and the validated watch is the floor — a revision that comes
    // back unusable leaves it standing, because advice must not cost a working
    // compilation.
    const model = new ScriptedModel([reply(GOOD), reply(GOOD)]);
    const result = await compile("anything", context, model, {
      ontologyIsCallers: true,
      backtest: () =>
        Promise.resolve({
          watch: GOOD,
          events: 4_200,
          days: 90,
          firings: 0,
          reachByNode: {},
          totalReaches: 0,
        }),
    });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    const reachTurn = result.attempts.find((attempt) => attempt.cause === "reach");
    expect(reachTurn, "a watch that never fired was not put back to the model").toBeDefined();
  });

  it("withholds the whole intervention when told to skip the replay", async () => {
    // The switch the latency measurement turns, and the property that makes the
    // measurement mean anything. Withholding only the *report* would leave the
    // revision turn running off whatever the loop still computed, so a compile
    // with the switch on would be a different compiler rather than the same one
    // without its replay — and the two arms would not be comparable.
    //
    // Only one scripted reply: a second turn has nothing to answer it, so a
    // revision that ran would fail loudly here rather than pass quietly.
    const model = new ScriptedModel([reply(GOOD)]);
    let replayed = 0;
    const result = await compile("anything", context, model, {
      ontologyIsCallers: true,
      skipBacktest: true,
      backtest: () => {
        replayed += 1;
        return Promise.resolve({
          watch: GOOD,
          events: 4_200,
          days: 90,
          firings: 0,
          reachByNode: {},
          totalReaches: 0,
        });
      },
    });

    expect(replayed, "the replay ran on a compile that asked to skip it").toBe(0);
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.report, "a skipped replay still reported something").toBeNull();
    expect(
      result.attempts.find((attempt) => attempt.cause === "reach"),
      "the revision ran without a replay to justify it",
    ).toBeUndefined();
  });

  it("keeps the compile when the caller's replay says nothing", async () => {
    // An empty journal is not a watch that matches nothing, and spending a
    // repair turn on the difference would repair a watch that is fine.
    const model = new ScriptedModel([reply(GOOD)]);
    const result = await compile("anything", context, model, {
      ontologyIsCallers: true,
      backtest: () => Promise.resolve(null),
    });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.report).toBeNull();
    expect(result.attempts.some((attempt) => attempt.cause === "reach")).toBe(false);
  });

  it("refuses to be handed both a universe and the caller's ontology", async () => {
    // The two answer the same question differently. Taking one silently would
    // validate against one substrate and replay against another, which is
    // exactly what the original check exists to prevent.
    const model = new ScriptedModel([reply(GOOD)]);

    await expect(
      compile("anything", context, model, { ontologyIsCallers: true, universe: "poc" }),
    ).rejects.toThrow(/one or the other/);
  });

  it("still refuses an ontology that does not match the universe it names", async () => {
    // The original guard, unchanged for every caller that does not opt out.
    const model = new ScriptedModel([reply(GOOD)]);
    const foreign = { ...context, ontology: { ...context.ontology, fingerprint: "not-the-one" } };

    await expect(compile("anything", foreign as typeof context, model)).rejects.toThrow(
      /validation and replay would disagree/,
    );
  });
});

describe("a watch that does not validate", () => {
  it("hands the diagnostics back and takes the repair", async () => {
    const model = new ScriptedModel([
      brokenReply(GOOD, (watch) => {
        (watch.nodes as { filter?: { source?: string } }[])[0]!.filter!.source = "not-a-source";
      }),
      reply(GOOD),
    ]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.diagnostics.map((d) => d.code)).toContain("SOURCE_UNKNOWN");
    expect(result.attempts[1]!.cause).toBe("diagnostics");

    // The feedback is the code and the pointer, not a retelling of the error.
    const feedback = model.calls[1]!.at(-1)!.content;
    expect(feedback).toContain("SOURCE_UNKNOWN");
    expect(feedback).toContain("/watch/nodes/0/filter/source");
  });

  it("repairs three times before giving up, unless told otherwise", async () => {
    // The default is part of the contract: a harness measuring how often the
    // feedback loop converges is measuring it over this many turns.
    const broken = brokenReply(GOOD, (watch) => {
      (watch.nodes as { filter?: { source?: string } }[])[0]!.filter!.source = "not-a-source";
    });
    const model = new ScriptedModel([broken, broken, broken, broken]);
    const result = await compile("anything", context, model);
    expect(result.attempts.map((a) => a.turn)).toEqual([0, 1, 2, 3]);
    expect(model.unused).toBe(0);
  });

  it("refuses a repair budget that is not a count", async () => {
    // A negative budget skips the loop entirely and returns 'failed' with no
    // attempts and no diagnostics — a verdict about a model that was never
    // asked anything.
    const model = new ScriptedModel([]);
    await expect(compile("anything", context, model, { maxRepairs: -1 })).rejects.toThrow(
      /non-negative/,
    );
    expect(model.calls).toHaveLength(0);
  });

  it("gives up after the repair budget and says what was still wrong", async () => {
    const broken = brokenReply(GOOD, (watch) => {
      (watch.nodes as { filter?: { source?: string } }[])[0]!.filter!.source = "not-a-source";
    });
    const model = new ScriptedModel([broken, broken]);
    const result = await compile("anything", context, model, { maxRepairs: 1 });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("invalid");
    expect(result.diagnostics.map((d) => d.code)).toContain("SOURCE_UNKNOWN");
    expect(result.attempts).toHaveLength(2);
    expect(model.unused).toBe(0);
  });

  it("sends only the errors, not the lints, so the repair has one job", async () => {
    // A warning is advice; a watch that validates with warnings is a watch.
    // Mixing them into the repair message invites the model to rewrite a plan
    // that was already legal. The fixture has to earn a lint as well as an
    // error, or the assertion is about a string nothing was going to print —
    // so it breaks the cooldown's interval and makes the judgement unbounded.
    const named = "alice-decided-to-leave";
    const broken = brokenReply(named, (watch) => {
      const nodes = watch.nodes as {
        type: string;
        deadline?: string;
        filter?: { source?: string };
      }[];
      for (const node of nodes) {
        if (node.type === "llm") node.deadline = "infinite";
        if (node.filter?.source) node.filter.source = "not-a-source";
      }
    });
    // Validated as the compiler will see it: the reply's envelope carries a
    // `decision` beside the watch, and passing that whole object in would trip
    // the schema's strictness and stop before any lint could be reached.
    const parsed = parseReply(broken);
    expect(parsed.kind).toBe("watch");
    const diagnostics = validateWatch(
      { watch: parsed.kind === "watch" ? parsed.watch : null },
      ontology,
    ).diagnostics;
    expect(
      diagnostics.filter((d) => d.severity === "warning").map((d) => d.code),
      "the fixture draws no lint, so this asserts nothing",
    ).toContain("LINT_INFINITE_DEADLINE");
    expect(diagnostics.filter((d) => d.severity === "error").length).toBeGreaterThan(0);

    // The broken reply is the one that has to draw both a lint and an error;
    // what the loop accepts afterwards only has to end the loop.
    const model = new ScriptedModel([broken, reply(GOOD)]);
    await compile("anything", context, model);
    const feedback = model.calls[1]!.at(-1)!.content;
    expect(feedback).toContain("SOURCE_UNKNOWN");
    expect(feedback, "a lint was sent back as though it were a failure").not.toContain("LINT_");
  });
});

describe("a reply that cannot be read", () => {
  it("says what was wrong with it and asks again", async () => {
    const model = new ScriptedModel([
      "I think you want a watch on gmail but I am not sure.",
      reply(GOOD),
    ]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    expect(result.attempts[0]!.outcome).toBe("unparseable");
    expect(model.calls[1]!.at(-1)!.content).toContain("could not be read");
  });

  it("is distinguishable from an invalid watch when the budget runs out", async () => {
    // The evaluation counts these separately: a model that never produced JSON
    // failed differently from one whose JSON was wrong.
    const model = new ScriptedModel(["no.", "still no."]);
    const result = await compile("anything", context, model, { maxRepairs: 1 });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("unparseable");
  });
});

describe("a refusal", () => {
  it("ends the loop rather than being argued with", async () => {
    const model = new ScriptedModel([REFUSAL]);
    const result = await compile("what were my restaurant categories", context, model);

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reasons).toEqual(["the ontology declares no card-transaction source"]);
    expect(model.unused, "the loop asked again after a refusal").toBe(0);
  });
});

describe("the revision pass on the reach report", () => {
  /** A watch that validates and then does nothing, which is the first concern. */
  const SILENT = {
    name: "silent-watch",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          metadata: [{ path: "extra.threadId", op: "eq", value: "no-thread-has-this-id" }],
        },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail", output_map: { doc: "$n.mail.doc_id" } },
  };
  const silentReply =
    "```json\n" + JSON.stringify({ decision: "compile", watch: SILENT }) + "\n```";

  it("asks once when the watch never fires, and takes a better answer", async () => {
    const model = new ScriptedModel([silentReply, reply(GOOD)]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.watch.name, "the revision was not adopted").toBe(GOOD);
    expect(result.attempts.map((a) => [a.turn, a.cause])).toEqual([
      [0, "initial"],
      [1, "reach"],
    ]);
    expect(result.usage, "the revision turn's tokens were not counted").toEqual(model.claimed);
    expect(model.calls.at(-1)!.at(-1)!.content).toContain("fired 0 times");
  });

  it("asks once and no more", async () => {
    // Two watches that both fire nothing. The second is accepted anyway: a
    // model shown its own reach report repeatedly optimises the number rather
    // than the meaning, so the pass is bounded at one by construction.
    const model = new ScriptedModel([silentReply, silentReply]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    expect(model.unused).toBe(0);
  });

  it("keeps the working watch when the revision comes back illegal", async () => {
    const model = new ScriptedModel([
      silentReply,
      brokenReply(GOOD, (watch) => {
        (watch.nodes as { filter?: { source?: string } }[])[0]!.filter!.source = "not-a-source";
      }),
    ]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.watch.name, "a bad revision replaced a good watch").toBe("silent-watch");
    // The attempt is still recorded, so a revision that made things worse is
    // visible rather than lost.
    expect(result.attempts.at(-1)!.diagnostics.map((d) => d.code)).toContain("SOURCE_UNKNOWN");
  });

  it("keeps the working watch when the revision cannot be read", async () => {
    const model = new ScriptedModel([silentReply, "sorry, I have nothing better"]);
    const result = await compile("anything", context, model);

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.watch.name).toBe("silent-watch");
  });

  it("does not run at all when the watch behaves", async () => {
    const model = new ScriptedModel([reply("restaurant-budget-500")]);
    const result = await compile("anything", context, model);
    expect(result.status).toBe("compiled");
    expect(result.attempts).toHaveLength(1);
  });
});

describe("what counts as a concern", () => {
  const PROCEDURAL = loadWatch("restaurant-budget-500");
  const JUDGED = loadWatch("important-email-unanswered");

  function report(over: Partial<BacktestReport>): BacktestReport {
    return {
      watch: "w",
      events: 100,
      from: "",
      to: "",
      days: 30,
      firings: 3,
      reachByNode: {},
      totalReaches: 0,
      unboundedNodes: [],
      peakInstancesByNode: {},
      trace: { watch: "w", records: [], firings: [] },
      ...over,
    };
  }

  it("says nothing about a watch that fires sometimes and asks no model", () => {
    expect(reachConcern(PROCEDURAL, report({}), DEFAULT_REACH_POLICY)).toBeNull();
  });

  it("moves the firing cap to the cadence the request names", () => {
    // The request is the only thing that says what rate is too high. Passed in,
    // it replaces the fixed cap in both directions; withheld, the fixed cap
    // stands. Dropping the argument at the call site turns the calibration off
    // without turning anything red anywhere else, which is what this pins.
    const busy = report({ firings: 90, days: 90 });

    // Tighter: a request wanting to hear only when something is wrong is over
    // its band at one a day, where the fixed cap is not.
    expect(reachConcern(PROCEDURAL, busy, DEFAULT_REACH_POLICY)).toBeNull();
    expect(
      reachConcern(PROCEDURAL, busy, DEFAULT_REACH_POLICY, "Warn me if the disk fills up"),
      "a rarity request was not held to its own cadence",
    ).toContain("0.2");

    // Looser: a request asking about every occurrence is not talked out of it.
    const flood = report({ firings: 270, days: 90 });
    expect(reachConcern(PROCEDURAL, flood, DEFAULT_REACH_POLICY)).toContain("fired 270 times");
    expect(
      reachConcern(PROCEDURAL, flood, DEFAULT_REACH_POLICY, "Tell me every time a file appears"),
      "a per-occurrence request was told to fire less than it asked for",
    ).toBeNull();
  });

  it("names silence only for a watch that asks no model", () => {
    // A judged watch reports zero firings in every backtest, by construction:
    // the judge is a counter that never fires and everything below it is gated
    // on that. The distinction is read off the plan, not off a reach count of
    // zero — a judged watch whose filter matches nothing also reaches nothing,
    // and telling it "this watch asks no model" would be false.
    expect(reachConcern(PROCEDURAL, report({ firings: 0 }), DEFAULT_REACH_POLICY)).toContain(
      "fired 0 times",
    );
    expect(
      reachConcern(JUDGED, report({ firings: 0, totalReaches: 0 }), DEFAULT_REACH_POLICY),
      "a judged watch was told it asks no model",
    ).toBeNull();
  });

  it("names cost per day rather than in total", () => {
    // Thirty reaches over thirty days is one a day; the same thirty over a
    // year is not the same watch, and a total alone cannot tell them apart.
    expect(reachConcern(JUDGED, report({ totalReaches: 30 }), DEFAULT_REACH_POLICY)).toContain(
      "1.00 per day",
    );
    expect(
      reachConcern(JUDGED, report({ totalReaches: 30, days: 365 }), DEFAULT_REACH_POLICY),
    ).toBeNull();
  });

  it("names a watch that fires on everything, judged or not", () => {
    // The firing ceiling is not gated on the reach count. A watch with a
    // judgement on a branch that does not gate the sink can reach a model
    // rarely and still fire hundreds of times, and that is the failure this
    // ceiling exists for.
    expect(reachConcern(PROCEDURAL, report({ firings: 300 }), DEFAULT_REACH_POLICY)).toContain(
      "reporting a condition rather than an exception",
    );
    expect(
      reachConcern(JUDGED, report({ firings: 300, totalReaches: 4 }), DEFAULT_REACH_POLICY),
      "a judged watch firing on everything was let through",
    ).toContain("reporting a condition");
  });

  it("does not read a watch that fired and retired as firing too often", () => {
    // A `once_ever` watch that fires on day two of a ninety-day replay consumed
    // two days and retired. It fired the once it was allowed to, and one firing
    // over two days reads as one every two days — above any cadence a fire-once
    // request implies. The watch that behaved exactly as asked would be the one
    // sent back to be changed.
    //
    // "alert me" reads as exceptional — a fifth of a firing a day — and the one
    // firing this watch is allowed lands two days into the replay. Half a firing
    // a day against a cap of 0.2 is the flood this would be called.
    const retired = report({ firings: 1, days: 2, totalReaches: 0, endedEarly: "fired" as const });
    expect(
      reachConcern(PROCEDURAL, retired, DEFAULT_REACH_POLICY, "alert me when the sale closes"),
      "a watch that fired once and retired was reported as firing too often",
    ).toBeNull();
    // Without the retirement, the same numbers are a real concern — which is
    // what makes the assertion above about retiring rather than about the cap.
    expect(
      reachConcern(
        PROCEDURAL,
        report({ firings: 1, days: 2, totalReaches: 0 }),
        DEFAULT_REACH_POLICY,
        "alert me when the sale closes",
      ),
    ).toContain("This would speak");
  });

  it("still charges a retired watch for everything it reached before retiring", () => {
    // The discriminating case, and the one a blanket exemption gets wrong.
    // Retiring says nothing about the reaches already paid for — a watch that
    // asked a model dozens of times across a season before it finally fired is
    // expensive, and it is expensive whether or not it is still running.
    const expensive = report({
      firings: 1,
      days: 90,
      totalReaches: 46,
      reachByNode: { chats: 22, mail: 24 },
      endedEarly: "fired" as const,
    });
    expect(
      reachConcern(JUDGED, expensive, DEFAULT_REACH_POLICY),
      "a retired watch was excused the reaches it had already paid for",
    ).toContain("what the judgement costs");
  });

  it("does not read silence over a window the replay could not finish", () => {
    // Measured on a real install: a ninety-day request came back covering eight,
    // because the replay stops at sixty thousand events and that install
    // produces them in a week. Nothing a monthly condition does is visible in
    // eight days, so a watch that stayed quiet through them has shown nothing —
    // and the loop would spend its one revision telling a correct watch to
    // change, which is worse than saying nothing at all.
    const cut = report({ firings: 0, days: 8, daysRequested: 90, totalReaches: 0 });
    expect(
      reachConcern(PROCEDURAL, cut, DEFAULT_REACH_POLICY),
      "a watch was called unmatchable on a tenth of the window it asked for",
    ).toBeNull();
  });

  it("still reads silence over a window the replay did finish", () => {
    // The discriminating half, and the reason this is a fraction rather than a
    // switch: a replay that covered most of what it asked for still says
    // something about a condition that never occurred.
    const most = report({ firings: 0, days: 80, daysRequested: 90, totalReaches: 0 });
    expect(
      reachConcern(PROCEDURAL, most, DEFAULT_REACH_POLICY),
      "a watch quiet through almost a full season was told nothing",
    ).toContain("check the sources");
  });

  it("still tells an expired watch its filter may never have matched on the live path", () => {
    // The universe shape asks for no span, so the coverage gate never sees one
    // there. The live substrate always asks for ninety days, and an expired
    // watch arrives having consumed only its own short life — three days of a
    // ninety-day request, three percent covered. Read as a window the replay
    // could not finish, that suppresses the one thing worth saying about a
    // watch that expired in silence. The replay covered the watch's whole life;
    // there was never any more of it to cover.
    const expired = report({
      firings: 0,
      days: 3,
      daysRequested: 90,
      totalReaches: 0,
      endedEarly: "expired" as const,
    });
    expect(
      reachConcern(PROCEDURAL, expired, DEFAULT_REACH_POLICY),
      "an expired watch on the live path was told nothing about a filter that may never match",
    ).toContain("check the sources");
  });

  it("does not read a watch that fired and retired as reaching too often", () => {
    // The cost half of the retirement, and the same mistake as the firing rate:
    // a `once_ever` watch that asked its judge twice and fired on day two has a
    // lifetime cost of two model calls, ever. Divided by the two days it lived
    // that reads as one a day against a ceiling of half — a rate describing a
    // watch that no longer exists.
    const retired = report({
      firings: 1,
      days: 2,
      totalReaches: 2,
      reachByNode: { mail: 2 },
      endedEarly: "fired" as const,
    });
    expect(
      reachConcern(JUDGED, retired, DEFAULT_REACH_POLICY),
      "a watch that retired after two reaches was reported as an ongoing cost",
    ).toBeNull();
    // What is excused is a small whole life, not a short one. The same two-day
    // life that costs dozens of model calls is charged in full, on either
    // substrate — the live one, which asks about a season, and the universe one,
    // which asks about nothing.
    const expensive = (over: Partial<BacktestReport>) =>
      report({
        firings: 1,
        days: 1.5,
        totalReaches: 35,
        reachByNode: { mail: 35 },
        endedEarly: "fired" as const,
        ...over,
      });
    expect(
      reachConcern(JUDGED, expensive({ daysRequested: 90 }), DEFAULT_REACH_POLICY),
      "a watch that judged thirty-five documents in a day and a half was excused for retiring",
    ).toContain("what the judgement costs");
    expect(
      reachConcern(JUDGED, expensive({}), DEFAULT_REACH_POLICY),
      "the same watch was read differently by the substrate that asked for no span",
    ).toContain("what the judgement costs");

    // The floor is on the whole life, and it is a floor rather than a ceiling:
    // ten calls ever is under it, eleven is not, and both are far above the
    // per-day ceiling over so short a life.
    const lifetime = (total: number) =>
      reachConcern(
        JUDGED,
        report({
          firings: 1,
          days: 2,
          totalReaches: total,
          reachByNode: { mail: total },
          endedEarly: "fired" as const,
        }),
        DEFAULT_REACH_POLICY,
      );
    expect(lifetime(10), "a ten-call lifetime was worth a revision turn").toBeNull();
    expect(lifetime(11), "an eleven-call lifetime was excused").toContain(
      "what the judgement costs",
    );
    // Either way of finishing, not just the one that fired. This one spoke once
    // and then its horizon passed, so nothing here is about a watch that never
    // fired — only about what its judging cost while it lived.
    const expiredCheaply = report({
      firings: 1,
      days: 4.333333333333333,
      daysRequested: 90,
      totalReaches: 8,
      reachByNode: { mail: 8 },
      endedEarly: "expired" as const,
    });
    expect(
      reachConcern(JUDGED, expiredCheaply, DEFAULT_REACH_POLICY),
      "a watch that expired having asked a model eight times was charged an ongoing rate",
    ).toBeNull();

    // And what a finished watch is told is a total. Sixteen calls over four days
    // is nearly four a day, a rate for a watch that will never pay it again —
    // and the span it ran is a live window bounded by a millisecond timestamp,
    // which is a dozen decimal places nobody reading a sentence can use.
    const charged = reachConcern(
      JUDGED,
      { ...expiredCheaply, totalReaches: 16, reachByNode: { mail: 16 } },
      DEFAULT_REACH_POLICY,
    );
    expect(charged).toContain("reached a model 16 times over the 4.3 days");
    expect(charged, "a finished watch was told a rate it will never pay").not.toContain("per day");
    expect(charged, "a raw millisecond span reached the model").not.toContain("4.3333");

    // And the floor is a retirement's alone. A watch still running that has
    // reached a model five times in two days will go on reaching it, and a small
    // total so far says nothing about what it will cost.
    expect(
      reachConcern(
        JUDGED,
        report({ days: 2, totalReaches: 5, reachByNode: { mail: 5 } }),
        DEFAULT_REACH_POLICY,
      ),
      "a running watch was excused its rate because it had not spent much yet",
    ).toContain("what the judgement costs");
  });

  it("does not let the request's phrasing decide whether a short window counts", () => {
    // The request calibrates the firing cap, and it is the only thing that could
    // be mistaken for an answer to a different question: how long a window has
    // to be before silence in it means anything. It cannot answer that.
    // `firingsPerDay` is a ceiling on how often a watch may speak, not an
    // estimate of how often its condition occurs, and read as the second it
    // inverts — the looser the phrasing the shorter the window it would accept.
    // Nine days of a requested ninety is too little either way, and production
    // always passes the request, so a gate that consulted it would fire here.
    const nine = report({ firings: 0, days: 9, daysRequested: 90, totalReaches: 0 });
    for (const request of [
      undefined,
      "Tell me every time an invoice arrives",
      "Tell me every morning what is due",
      "Alert me if the disk fills up",
    ]) {
      expect(
        reachConcern(PROCEDURAL, nine, DEFAULT_REACH_POLICY, request),
        `a tenth of the requested window was read as silence for: ${request ?? "no request"}`,
      ).toBeNull();
    }
    // The discriminating half: the same phrasings over a window that was covered
    // still get the concern, so the loop above is about the span and not about
    // the request being present at all.
    const most = report({ firings: 0, days: 80, daysRequested: 90, totalReaches: 0 });
    expect(
      reachConcern(PROCEDURAL, most, DEFAULT_REACH_POLICY, "Tell me every time an invoice arrives"),
    ).toContain("check the sources");
  });

  it("names the horizon of a watch that expired near the start of its replay", () => {
    // The live replay ends at the present, so a horizon reached inside it is a
    // horizon already past: installed as written, the watch retires on the first
    // event it sees. `expires_at` is compiler-authored, which makes this a
    // failure the compiler can commit and nothing else checks — the validator
    // demands a horizon for a dated request and never reads the date.
    const expired = (over: Partial<BacktestReport> = {}) =>
      report({
        firings: 0,
        days: 3,
        daysRequested: 90,
        totalReaches: 0,
        endedEarly: "expired" as const,
        ...over,
      });
    expect(reachConcern(PROCEDURAL, expired(), DEFAULT_REACH_POLICY)).toContain("expires_at");
    expect(
      reachConcern(PROCEDURAL, expired(), DEFAULT_REACH_POLICY),
      "an expired watch was told about its horizon and not about its filter",
    ).toContain("check the sources");

    // A judged watch reaches this too, and it is the one that needs it most: a
    // judge under a dead horizon is never asked, so every other reading of the
    // report is a zero that means nothing, and before this it drew no concern
    // of any kind.
    const judged = reachConcern(JUDGED, expired({ totalReaches: 2 }), DEFAULT_REACH_POLICY);
    expect(judged, "a judged watch with a dead horizon compiled in silence").toContain(
      "expires_at",
    );
    expect(judged, "a judged watch was sent after its filter").not.toContain("check the sources");

    // The discriminating half, and the reason this is not simply "it expired":
    // a horizon a day before the end of the window took nothing away, and
    // naming it would spend the one revision turn on a date that is right.
    expect(
      reachConcern(PROCEDURAL, expired({ days: 89 }), DEFAULT_REACH_POLICY),
      "a horizon that cost the replay a single day was blamed for the silence",
    ).not.toContain("expires_at");
    expect(
      reachConcern(
        PROCEDURAL,
        report({ firings: 0, days: 80, daysRequested: 90 }),
        DEFAULT_REACH_POLICY,
      ),
      "a running watch was told to check a horizon",
    ).not.toContain("expires_at");
  });

  it("still tells an expired watch its filter may never have matched", () => {
    // The other half of the same mistake. A horizon passing is not evidence the
    // watch was right to say nothing — a filter that cannot match produces the
    // same silence, and that is the one thing worth saying about it.
    const expired = report({
      firings: 0,
      days: 3,
      totalReaches: 0,
      endedEarly: "expired" as const,
    });
    expect(
      reachConcern(PROCEDURAL, expired, DEFAULT_REACH_POLICY),
      "an expired watch that never fired was told nothing at all",
    ).toContain("check the sources");
  });

  it("names a watch that threw rather than diagnosing its filter", () => {
    // A watch that crashed comes back with the same counts as one that stayed
    // quiet, and the validator does not catch this class at all — a query
    // naming a column that is not there surfaces only against the engine. Every
    // substrate that can replay reports it, in the one field the loop reads.
    const crashed = report({
      firings: 0,
      failure: { nodeId: "spend", detail: "no such column" },
    });
    const concern = reachConcern(PROCEDURAL, crashed, DEFAULT_REACH_POLICY);
    expect(concern).toContain("threw while replaying");
    expect(concern).toContain("spend");
    expect(concern, "a crash was diagnosed as a filter that cannot match").not.toContain(
      "check the sources",
    );
  });

  it("reads every bound from the policy rather than a constant", () => {
    const strict = {
      minFirings: 5,
      maxFiringsPerDay: 0.01,
      maxReachesPerDay: 0.1,
      minRetiredReaches: 1,
      minWindowFraction: 0.5,
    };
    expect(reachConcern(PROCEDURAL, report({ firings: 3 }), strict)).toContain("fired 3 times");
    expect(reachConcern(JUDGED, report({ firings: 3, totalReaches: 5 }), strict)).toContain(
      "per day",
    );
    expect(reachConcern(PROCEDURAL, report({ firings: 30 }), strict)).toContain(
      "reporting a condition",
    );
    // A retirement reads its floor from the policy too: a two-call lifetime is
    // under the default floor of ten and over a floor of one.
    const retired = report({
      firings: 1,
      days: 2,
      totalReaches: 2,
      reachByNode: { mail: 2 },
      endedEarly: "fired" as const,
    });
    expect(reachConcern(JUDGED, retired, strict)).toContain("what the judgement costs");

    // A policy that wants several firings before it believes a watch works still
    // must not call a `once_ever` watch silent for having fired exactly the once
    // it was allowed. Under the defaults the question never arises, because one
    // firing is already enough — so the strict policy is the only place this
    // distinction is visible at all.
    expect(
      reachConcern(
        PROCEDURAL,
        report({ firings: 1, days: 30, totalReaches: 0, endedEarly: "fired" as const }),
        strict,
      ),
      "a watch that fired the once it was allowed was told it never fires",
    ).toBeNull();
    // The discriminating half: the same watch still running has genuinely not
    // reached the bar the policy sets.
    expect(reachConcern(PROCEDURAL, report({ firings: 1, days: 30 }), strict)).toContain(
      "fired 1 times",
    );

    // The same reports are unremarkable under the defaults, so the assertions
    // above are reading the policy and not a coincidence.
    expect(reachConcern(PROCEDURAL, report({ firings: 3 }), DEFAULT_REACH_POLICY)).toBeNull();
    expect(
      reachConcern(JUDGED, report({ firings: 3, totalReaches: 5 }), DEFAULT_REACH_POLICY),
    ).toBeNull();
    expect(reachConcern(JUDGED, retired, DEFAULT_REACH_POLICY)).toBeNull();
  });

  it("classifies a corpus watch that threw by the crash rather than by its counts", () => {
    // What the corpus test's report is built from. The frozen shape carries the
    // counts and not the failure, which is lifted out of the trace — so a report
    // assembled from the frozen fields alone would read a watch whose replay
    // throws as one that stayed quiet, and send a reader after a filter when a
    // column name is the fault. No corpus watch throws today; this is the
    // fixture that says the wiring would notice if one did.
    const name = "restaurant-budget-500";
    const frozen = frozenGolden(name);
    const trace = {
      ...frozen.trace,
      records: [
        ...frozen.trace.records,
        { seq: 9_999, nodeId: "spend", key: "singleton", transition: "failed", failure: "query" },
      ],
    } as typeof frozen.trace;
    const crashed = {
      ...(frozen.backtest as unknown as BacktestReport),
      watch: name,
      trace,
      ...failureFrom(trace),
    };
    expect(reachConcern(loadWatch(name), crashed, DEFAULT_REACH_POLICY)).toContain(
      "threw while replaying, at node 'spend'",
    );
  });

  it("holds the whole corpus, minus the watches the report exists to flag", () => {
    // The policy is only useful if it is quiet about hand-written watches that
    // are correct and loud about the ones that put every event in front of a
    // model. The six named below are the corpus's expensive ones: every watch
    // whose semantic filter admits one person's whole correspondence, plus the
    // two AND-gates that judge both sides of every thread.
    //
    // The dinner watch is not among them. It is bound to a dated occasion and
    // declares a horizon, so it stops asking a day after the dinner rather than
    // running the length of the journal, and what it costs while live is under
    // the policy's ceiling. A watch that knows when its question ends is cheap
    // without anyone having to make its filter narrower.
    //
    // That the procedural watches are all quiet is the half that matters. A
    // policy that flagged those would be telling a correct plan to change.
    const flagged = watchNames().filter((name) => {
      const frozen = frozenGolden(name).backtest;
      const trace = frozenGolden(name).trace;
      // `failure` is the one field the policy reads that the frozen shape does
      // not carry, and it is lifted out of the trace rather than stored — so a
      // report built from the frozen fields alone would classify a corpus watch
      // whose replay throws by its counts — the blindness the frozen `endedEarly`
      // field closes for the other one.
      const report = {
        ...(frozen as unknown as BacktestReport),
        watch: name,
        trace,
        ...failureFrom(trace),
      };
      return reachConcern(loadWatch(name), report, DEFAULT_REACH_POLICY) !== null;
    });
    expect(flagged.sort()).toEqual([
      "alice-decided-to-leave",
      "important-email-unanswered",
      "invoice-and-receipt-both-arrived",
      "quote-accepted-then-invoiced",
      "same-topic-across-two-channels",
      "trip-vs-passport-expiry",
    ]);
  });
});
