// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The classifier decides what a run reports, so it has to be able to be wrong.
 *
 * Every class here is a different piece of work for someone: a reply that would
 * not parse is plumbing, a watch that never validated is the feedback loop
 * failing to converge, and a watch that validated and behaves differently is
 * the one nothing downstream catches. A classifier that collapsed two of them
 * would make the report point at the wrong thing while still adding up to the
 * same total.
 *
 * The pair worth the most attention is refusal. Refusing a request that has an
 * answer and answering one that has none are opposite failures, and both look
 * like a completed compilation from any distance.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { loadOntology, universeDir } from "../universe/paths.js";
import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { loadWatch } from "../runtime/run.js";
import { watchNames } from "../backtest/golden.js";
import { Budget } from "./cost.js";
import { behaviourOf, compareBehaviour } from "./score.js";
import { UNSEEN_PROMPTS } from "./prompts.js";
import {
  OUTCOME_CLASSES,
  WRONG_BUT_VALIDATES,
  classify,
  pairedTasks,
  unmentioned,
  runEvaluation,
  unseenTasks,
  workQueue,
  type EvalTask,
} from "./harness.js";
import type { ChatModel, ModelReply } from "../compiler/model.js";
import type { CompileResult } from "../compiler/compile.js";
import type { Behaviour } from "./score.js";

/**
 * These replay real watches over the corpus journal, which is minutes of work
 * across the file rather than the milliseconds a unit test takes. The suite's
 * 30s default is sized for the latter, and the slower cases here sit close
 * enough to it that ordinary concurrency tips them over — a timeout that reads
 * as a failing assertion and sends whoever is on CI looking for a bug in the
 * change they just made.
 */
vi.setConfig({ testTimeout: 300_000 });

const ontology = loadOntology();

/** The real request, because the subject check reads it. */
function requestOf(name: string): string {
  return loadWatch(name).nl_query!;
}

const PAIRED: EvalTask = {
  id: "important-email-unanswered",
  query: requestOf("important-email-unanswered"),
  reference: "important-email-unanswered",
  expect: null,
  because: "",
};
const MUST_REFUSE: EvalTask = {
  id: "no-such-data",
  query: "anything",
  reference: null,
  expect: "refuses",
  because: "",
};
const MUST_COMPILE: EvalTask = { ...MUST_REFUSE, id: "answerable", expect: "compiles" };

/** A corpus watch with one duration changed, as a compilation of it. */
function compiledWith(name: string, duration: string): Compiled {
  return {
    ...compiled(name),
    watch: variantOf(name, (watch) => {
      const nodes = watch.nodes as { duration?: string }[];
      for (const node of nodes) if (node.duration) node.duration = duration;
    }),
  };
}

/** A corpus watch with one thing changed, still validating. */
function variantOf(
  name: string,
  mutate: (watch: Record<string, unknown>) => void,
): WatchDefinition {
  const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
  const doc = JSON.parse(raw) as { watch: Record<string, unknown> };
  mutate(doc.watch);
  return watchDslSchema.parse(doc).watch;
}

/** Narrowed to the compiled variant, so a caller may override `watch`. */
type Compiled = Extract<CompileResult, { status: "compiled" }>;

function compiled(name: string): Compiled {
  return {
    status: "compiled",
    watch: loadWatch(name),
    document: {},
    report: null,
    attempts: [],
    usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
  };
}

const REFUSED: CompileResult = {
  status: "refused",
  reasons: ["no source produces this"],
  codes: ["unsupported_condition"],
  attempts: [],
  usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
};

function failed(reason: "unparseable" | "invalid"): CompileResult {
  return {
    status: "failed",
    reason,
    diagnostics:
      reason === "invalid"
        ? [{ code: "SOURCE_UNKNOWN", severity: "error", path: "/watch", message: "" }]
        : [],
    attempts: [],
    usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
  };
}

// The expected replay is shared fixture data; each classifier receives its
// own copy so its work cannot mutate another test's expectations.
let pairedReference: Promise<Behaviour> | undefined;

async function references(): Promise<Map<string, Behaviour>> {
  pairedReference ??= behaviourOf(loadWatch("important-email-unanswered"));
  return new Map([["important-email-unanswered", structuredClone(await pairedReference)]]);
}

describe("a compilation that matches on the wrong subject", () => {
  it("is structural even when it behaves identically", async () => {
    // The one thing the replay cannot see. Recall passes every document, so a
    // watch searching for pizza puts exactly the documents in front of a judge
    // that a watch searching for an important email does, and replays the
    // same. The subject is checked against the request instead.
    const wrongSubject = variantOf("important-email-unanswered", (watch) => {
      const json = JSON.stringify(watch).replace(
        /"query":\s*"[^"]*"/g,
        '"query": "pizza delivery receipt"',
      );
      Object.assign(watch, JSON.parse(json) as Record<string, unknown>);
    });
    const same = await behaviourOf(wrongSubject);
    const reference = await behaviourOf(loadWatch("important-email-unanswered"));
    expect(
      compareBehaviour(reference, same).equivalent,
      "the premise is gone — the replay now sees the recall query",
    ).toBe(true);

    const verdict = await classify(
      PAIRED,
      { ...compiled("important-email-unanswered"), watch: wrongSubject },
      await references(),
    );
    expect(verdict.outcome).toBe("structural_defect");
    expect(verdict.detail).toContain("subject the request does not name");
  });
});

describe("classifying a paired attempt", () => {
  it("passes the watch it was asked to rebuild", async () => {
    const verdict = await classify(
      PAIRED,
      compiled("important-email-unanswered"),
      await references(),
    );
    expect(verdict.outcome).toBe("ok");
  });

  it("fails a watch that validates and does something else", async () => {
    // The class that matters: the validator was satisfied and the answer is
    // wrong. Nothing after this point catches it.
    const verdict = await classify(PAIRED, compiled("restaurant-budget-500"), await references());
    expect(verdict.outcome).toBe("structural_defect");
    expect(verdict.detail).toMatch(/firings|model reaches/);
  });

  it("separates a misreading from a judgement call the request left open", async () => {
    // The whole reason the taxonomy splits. Two compilations of
    // `mum-call-rhythm-stopped`, whose request says only "tell me if that
    // rhythm stops": one waits twelve days, which is a reading of it; one waits
    // thirty, which is not. Both behave differently from the reference's nine.
    const task: EvalTask = {
      ...PAIRED,
      id: "mum",
      reference: "mum-call-rhythm-stopped",
      query: requestOf("mum-call-rhythm-stopped"),
    };
    const refs = new Map([
      ["mum-call-rhythm-stopped", await behaviourOf(loadWatch("mum-call-rhythm-stopped"))],
    ]);

    const twelve = await classify(task, compiledWith("mum-call-rhythm-stopped", "12 days"), refs);
    expect(twelve.outcome, twelve.detail).toBe("divergent_defensible");
    expect(twelve.detail, "the reader is not told why it was excused").toContain("rhythm stops");

    const thirty = await classify(task, compiledWith("mum-call-rhythm-stopped", "30 days"), refs);
    expect(thirty.outcome, thirty.detail).toBe("structural_defect");
  });

  it("calls it structural when the numbers agree and the behaviour does not", async () => {
    // Nothing to excuse it with: the difference is a filter, a key or a source,
    // and the free-parameter table has no opinion about any of those.
    const task: EvalTask = {
      ...PAIRED,
      id: "maya",
      reference: "maya-conversation-lapsed",
      query: requestOf("maya-conversation-lapsed"),
    };
    const refs = new Map([
      ["maya-conversation-lapsed", await behaviourOf(loadWatch("maya-conversation-lapsed"))],
    ]);
    const unkeyed = variantOf("maya-conversation-lapsed", (watch) => {
      const nodes = watch.nodes as { inputs?: Record<string, { key?: unknown }> }[];
      for (const node of nodes)
        for (const input of Object.values(node.inputs ?? {})) delete input.key;
    });
    const verdict = await classify(
      task,
      { ...compiled("maya-conversation-lapsed"), watch: unkeyed },
      refs,
    );
    expect(verdict.outcome, verdict.detail).toBe("structural_defect");
  });

  it("separates a reply that would not parse from a watch that would not validate", async () => {
    const refs = await references();
    expect((await classify(PAIRED, failed("unparseable"), refs)).outcome).toBe("parse_failure");
    const invalid = await classify(PAIRED, failed("invalid"), refs);
    expect(invalid.outcome).toBe("validator_rejected");
    expect(invalid.detail, "the diagnosis is lost").toContain("SOURCE_UNKNOWN");
  });

  it("fails a refusal of a request the corpus answers", async () => {
    const verdict = await classify(PAIRED, REFUSED, await references());
    expect(verdict.outcome).toBe("refused_wrongly");
    expect(verdict.detail).toContain("no source produces this");
  });
});

describe("classifying an attempt with no reference", () => {
  it("passes a refusal of a request that has no answer", async () => {
    expect((await classify(MUST_REFUSE, REFUSED, new Map())).outcome).toBe("ok");
  });

  it("grades the refusal's reason, not just the fact of it", async () => {
    // A refusal is only worth something if it names what is missing. Both of
    // these refuse the same unanswerable request; one tells you what to build.
    const task: EvalTask = {
      ...MUST_REFUSE,
      refusalMustMention: [["attendee"], ["not retained", "no column"]],
    };
    const vague: CompileResult = { ...REFUSED, reasons: ["I cannot express this request."] };
    const specific: CompileResult = {
      ...REFUSED,
      reasons: ["the attendee table has no column for what each invitee answered"],
    };

    const bad = await classify(task, vague, new Map());
    expect(bad.outcome).toBe("refused_vaguely");
    expect(bad.detail, "the report does not say what was missing from it").toContain("attendee");

    expect((await classify(task, specific, new Map())).outcome).toBe("ok");
  });

  it("requires a word from every group, not just one group", async () => {
    // Two groups means two things the refusal has to be about. Half-right is
    // not right: naming the table without saying what is absent from it reads
    // as a refusal about the wrong thing.
    const task: EvalTask = {
      ...MUST_REFUSE,
      refusalMustMention: [["attendee"], ["not retained", "no column"]],
    };
    const half: CompileResult = { ...REFUSED, reasons: ["the attendee join is awkward here"] };
    expect((await classify(task, half, new Map())).outcome).toBe("refused_vaguely");
  });

  it("accepts whichever wording a refusal reaches for", () => {
    // The groups are alternatives so the grade is about the absence and not
    // about vocabulary.
    const groups = [["rsvp", "response_status", "what they answered"]];
    expect(unmentioned("the RSVP of other invitees is not kept", groups)).toEqual([]);
    expect(unmentioned("response_status is the user's own", groups)).toEqual([]);
    expect(unmentioned("that is not something I can do", groups)).toEqual(groups);
  });

  it("fails a watch written for a request that has no answer", async () => {
    // The other half of the class that matters, and the one the paired set
    // cannot reach: it validates, it runs, and the request was unanswerable.
    const verdict = await classify(MUST_REFUSE, compiled("restaurant-budget-500"), new Map());
    expect(verdict.outcome).toBe("compiled_when_it_should_refuse");
    expect(WRONG_BUT_VALIDATES).toContain(verdict.outcome);
  });

  it("fails a refusal of a request that does have an answer", async () => {
    expect((await classify(MUST_COMPILE, REFUSED, new Map())).outcome).toBe("refused_wrongly");
  });

  it("passes any watch for an answerable request, because there is nothing to compare", async () => {
    // Stated rather than hidden: with no reference, "it compiled" is all this
    // half can say, and the report's headline number should be read knowing it.
    const verdict = await classify(MUST_COMPILE, compiled("restaurant-budget-500"), new Map());
    expect(verdict.outcome).toBe("ok");
  });
});

describe("the two sets", () => {
  it("pairs every corpus watch with the request it was written from", () => {
    const tasks = pairedTasks();
    expect(tasks.map((t) => t.id)).toEqual(watchNames());
    for (const task of tasks) {
      expect(task.reference, task.id).toBe(task.id);
      expect(task.query.length, task.id).toBeGreaterThan(10);
    }
  });

  it("carries enough unseen requests, and enough of them refusals", () => {
    const tasks = unseenTasks(UNSEEN_PROMPTS);
    expect(tasks.length).toBeGreaterThanOrEqual(15);
    expect(tasks.filter((t) => t.expect === "refuses").length).toBeGreaterThanOrEqual(4);
    expect(new Set(tasks.map((t) => t.id)).size, "two requests share an id").toBe(tasks.length);
  });

  it("says why each unseen request has the answer it has", () => {
    // Printed beside a failure. A prompt whose expected answer nobody can
    // justify is a prompt that will be argued with rather than fixed.
    for (const prompt of UNSEEN_PROMPTS) {
      expect(prompt.because.length, prompt.id).toBeGreaterThan(20);
    }
  });

  it("asks nothing that the ontology quietly does answer", () => {
    // A refusal prompt is only honest if the thing really is absent. These are
    // the two that name a table and a column by implication.
    expect(ontology.tableNames()).not.toContain("workouts");
    const attendees = ontology.table("google_calendar_attendees")!;
    expect(
      attendees.columns.map((c) => c.name),
      "per-attendee RSVP exists after all, so that refusal is wrong",
    ).toEqual(["event_id", "person_id"]);
  });
});

describe("the outcome classes", () => {
  it("names the two where the validator was satisfied and the answer was wrong", () => {
    expect(WRONG_BUT_VALIDATES.every((c) => OUTCOME_CLASSES.includes(c))).toBe(true);
    expect(WRONG_BUT_VALIDATES).not.toContain("ok");
  });
});

describe("the order a sweep works in", () => {
  const task = (id: string): EvalTask => ({ ...PAIRED, id, reference: id, query: `ask ${id}` });
  const TWO = [task("first"), task("second")];

  it("runs one attempt per request per sample when there are no arms", () => {
    const queue = workQueue(TWO, 3);
    expect(queue).toHaveLength(6);
    expect(queue.every((item) => item.arm === undefined)).toBe(true);
    expect(queue.filter((i) => i.task.id === "first").map((i) => i.sample)).toEqual([0, 1, 2]);
  });

  it("keeps the arms within one of each other at every point in the queue", () => {
    // The property that matters is not the final tally — it is that truncating
    // the queue anywhere leaves the arms comparable, because a run that stops on
    // its budget stops mid-queue and still gets both rates printed.
    const queue = workQueue(TWO, 5, ["without-bounds", "with-bounds"]);
    expect(queue).toHaveLength(20);

    for (let taken = 0; taken <= queue.length; taken += 1) {
      const head = queue.slice(0, taken);
      const without = head.filter((i) => i.arm === "without-bounds").length;
      const with_ = head.filter((i) => i.arm === "with-bounds").length;
      expect(Math.abs(without - with_), `arms diverge after ${taken} attempts`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("gives every request the same number of attempts under each arm", () => {
    const queue = workQueue(TWO, 4, ["without-bounds", "with-bounds"]);
    for (const item of TWO) {
      for (const arm of ["without-bounds", "with-bounds"] as const) {
        expect(queue.filter((i) => i.task.id === item.id && i.arm === arm)).toHaveLength(4);
      }
    }
  });
});

describe("running an evaluation", () => {
  /** A model that answers with the same watch every time, in any order. */
  class SteadyModel implements ChatModel {
    readonly name = "steady";
    calls = 0;
    constructor(private readonly reply: string) {}
    complete(): Promise<ModelReply> {
      this.calls += 1;
      return Promise.resolve({
        text: this.reply,
        usage: { promptTokens: 10, cachedPromptTokens: 4, completionTokens: 2 },
      });
    }
  }

  function replyWith(name: string): string {
    const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
    const watch = (JSON.parse(raw) as { watch: unknown }).watch;
    return "```json\n" + JSON.stringify({ decision: "compile", watch }) + "\n```";
  }

  /**
   * The corpus watch these fixtures answer with.
   *
   * A watch the reach policy would flag is shown its report and asked once to
   * reconsider — correct behaviour, and it costs a second model call per
   * attempt, which turns "one call per attempt" into a statement about the
   * policy rather than about the scheduler. This one reaches no model at all.
   */
  const QUIET = "mum-call-rhythm-stopped";

  const TASKS: EvalTask[] = [
    { ...PAIRED, id: QUIET, reference: QUIET, query: requestOf(QUIET) },
    { ...MUST_REFUSE, id: "unanswerable", query: requestOf(QUIET) },
  ];

  it("gives each arm the prompt its label names", async () => {
    // The line that makes the experiment mean what it says is a single
    // comparison against the string "with-bounds". Inverted, every rate in the
    // report swaps places and nothing else in the suite notices — so the arm
    // label is checked against the prompt the model was actually handed.
    // Keyed by what the prompt contains rather than by call order: a fixture
    // that ever needs a repair turn would make one attempt two calls, and an
    // index-zip would then attribute a prompt to the wrong arm — quietly
    // turning the test that guards the labels into one that reports a shift.
    const withChecklist: string[] = [];
    const withoutChecklist: string[] = [];
    const model: ChatModel = {
      name: "recording",
      complete: (messages) => {
        const system = messages[0]!.content;
        const request = messages.at(-1)!.content;
        (system.includes("say what you did about each") ? withChecklist : withoutChecklist).push(
          request,
        );
        return Promise.resolve({
          text: replyWith(QUIET),
          usage: { promptTokens: 10, cachedPromptTokens: 4, completionTokens: 2 },
        });
      },
    };
    const { outcomes } = await runEvaluation([TASKS[0]!], model, new Budget(undefined, null), {
      samples: 1,
      concurrency: 1,
      arms: ["without-bounds", "with-bounds"],
    });

    expect(outcomes.map((o) => o.arm).sort()).toEqual(["with-bounds", "without-bounds"]);
    expect(withChecklist, "exactly one arm should carry the checklist").toHaveLength(1);
    expect(withoutChecklist, "exactly one arm should lack it").toHaveLength(1);
  });

  it("attempts every request the asked-for number of times", async () => {
    const model = new SteadyModel(replyWith(QUIET));
    const budget = new Budget(undefined, null);
    const { outcomes, stopped } = await runEvaluation(TASKS, model, budget, {
      samples: 3,
      concurrency: 4,
    });

    expect(stopped).toBeNull();
    expect(outcomes).toHaveLength(6);
    expect(model.calls, "work was dropped or done twice").toBe(6);
    // Each request appears exactly `samples` times, and the sample numbers are
    // the ones asked for rather than whatever order the workers finished in.
    for (const task of TASKS) {
      const mine = outcomes.filter((o) => o.prompt === task.id);
      expect(mine.map((o) => o.sample).sort(), task.id).toEqual([0, 1, 2]);
    }
  });

  it("scores each request against what that request expected", async () => {
    const model = new SteadyModel(replyWith(QUIET));
    const { outcomes } = await runEvaluation(TASKS, model, new Budget(undefined, null), {
      samples: 1,
      concurrency: 1,
    });

    // The same answer is right for the paired request and wrong for the one
    // that had no answer — which is the whole reason the two sets exist.
    expect(outcomes.find((o) => o.prompt === QUIET)!.outcome).toBe("ok");
    expect(outcomes.find((o) => o.prompt === "unanswerable")!.outcome).toBe(
      "compiled_when_it_should_refuse",
    );
  });

  it("counts what the run spent", async () => {
    const model = new SteadyModel(replyWith(QUIET));
    const budget = new Budget(undefined, null);
    await runEvaluation(TASKS, model, budget, { samples: 2, concurrency: 2 });
    expect(budget.spent).toEqual({
      promptTokens: 40,
      cachedPromptTokens: 16,
      completionTokens: 8,
    });
  });

  it("stops at its ceiling and keeps what it already measured", async () => {
    // A partial measurement is still a measurement. Throwing away the samples
    // that already landed to report a clean failure helps nobody.
    const model = new SteadyModel(replyWith(QUIET));
    const budget = new Budget({ cachedInput: 0, uncachedInput: 1_000_000, output: 0 }, 0.001);
    const { outcomes, stopped } = await runEvaluation(TASKS, model, budget, {
      samples: 5,
      concurrency: 1,
    });

    expect(stopped, "the run went past its ceiling").toContain("ceiling");
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.length).toBeLessThan(10);
  });

  it("reports each sample as it lands rather than in a batch at the end", async () => {
    // A run takes hours. Called at the end instead, the callback still sees
    // every sample and tells the operator nothing while it is happening — so
    // what is asserted is that the callback fires before the run returns.
    const seen: string[] = [];
    let returned = false;
    const model = new SteadyModel(replyWith(QUIET));
    const running = runEvaluation(TASKS, model, new Budget(undefined, null), {
      samples: 1,
      concurrency: 1,
      onSample: (sample) => {
        expect(returned, "samples were reported after the run had finished").toBe(false);
        seen.push(sample.prompt);
      },
    });
    await running;
    returned = true;
    expect(seen).toHaveLength(2);
  });

  it("withholds the reference from the prompt it actually sends", async () => {
    // The premise of the whole paired set: a request must not be shown its own
    // answer. Asserted on the prompt the run sends, not on the helper that
    // builds it — the helper being correct says nothing about whether the run
    // calls it.
    class SpyModel implements ChatModel {
      readonly name = "spy";
      readonly prompts: string[] = [];
      constructor(private readonly reply: string) {}
      complete(messages: readonly { content: string }[]): Promise<ModelReply> {
        this.prompts.push(messages[0]!.content);
        return Promise.resolve({
          text: this.reply,
          usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
        });
      }
    }

    const model = new SpyModel(replyWith(QUIET));
    await runEvaluation(TASKS, model, new Budget(undefined, null), {
      samples: 1,
      concurrency: 1,
    });

    expect(model.prompts).toHaveLength(2);
    const [paired, unseen] = model.prompts;
    expect(paired, "the paired request was shown its own answer").not.toContain(
      `"name": "${QUIET}"`,
    );
    // Another watch is still there, so withholding did not empty the prompt.
    expect(paired).toContain('"name": "restaurant-budget-500"');
    // A request with no reference has nothing to withhold, so it keeps them all.
    expect(unseen).toContain(`"name": "${QUIET}"`);
  });

  it("records an attempt that blew up rather than losing the run", async () => {
    // A five-hundred from the provider, a socket reset, a replay that throws:
    // any of them escaping would discard every sample already collected and
    // leave the other workers running against a paid API.
    class BrokenModel implements ChatModel {
      readonly name = "broken";
      complete(): Promise<ModelReply> {
        return Promise.reject(new Error("upstream went away"));
      }
    }

    const { outcomes, stopped } = await runEvaluation(
      TASKS,
      new BrokenModel(),
      new Budget(undefined, null),
      { samples: 2, concurrency: 2 },
    );
    expect(stopped).toBeNull();
    expect(outcomes).toHaveLength(4);
    expect(outcomes.every((o) => o.outcome === "errored")).toBe(true);
    expect(outcomes[0]!.detail).toContain("upstream went away");
  });
});
