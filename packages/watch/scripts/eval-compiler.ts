#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Measure the compiler against a live model.
 *
 *   WATCHV2_COMPILER_BASE_URL=… WATCHV2_COMPILER_API_KEY=… WATCHV2_COMPILER_MODEL=… \
 *     npx tsx packages/watch/scripts/eval-compiler.ts --samples 5
 *
 *   --samples <n>      attempts per request (default 5; one is not a measurement)
 *   --set paired|unseen|both
 *   --only <id>        just this request, repeated — the smoke run
 *   --concurrency <n>  requests in flight (default 6)
 *   --ceiling <usd>    stop when the estimated spend reaches this (default 15)
 *   --out <path>       also write the report here
 *   --arms current|ab  `ab` compiles each request under both prompts in one run
 *
 * Every run writes itself to `eval-runs/<timestamp>.md` regardless — the per
 * request failure modes are the part worth keeping, and the first measured
 * sweep of this compiler lost them because nobody passed `--out`.
 *
 * Start with `--only <id> --samples 1` and read the cost line before running
 * the sweep. The estimate scales linearly, so a smoke run that costs more than
 * a few cents means the sweep will cost more than a few dollars, and the thing
 * to change is the prompt rather than the ceiling.
 *
 * The credential is read from the environment and never printed.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnswerLog } from "../src/eval/answer-log.js";
import { PUBLISHED_PRICES, Budget } from "../src/eval/cost.js";
import { UNSEEN_PROMPTS } from "../src/eval/prompts.js";
import { formatSummary, reasonsFor } from "../src/eval/report.js";
import {
  pairedTasks,
  runEvaluation,
  unseenTasks,
  type EvalTask,
  type PromptArm,
} from "../src/eval/harness.js";
import { modelFromEnv } from "../src/compiler/model.js";
import { parseEvalArgs, type Arms } from "../src/eval/args.js";

/**
 * How far runs of one unchanged setup drift, in percentage points.
 *
 * Measured rather than assumed, and measured on the arm it describes: three
 * sweeps of the paired set under the un-calibrated prompt, nothing changed
 * between them, scored 78.9%, 83.3% and 84.4% structural defect — a spread of
 * 5.6 points around a mean of 82.2, standard deviation 2.9.
 *
 * Rounded up rather than down. It is the floor under any claim that an
 * intervention moved the rate, and a floor set optimistically would license
 * exactly the conclusion it exists to prevent. Re-measure it when the corpus,
 * the model or the scorer changes; a band inherited across any of those is
 * folklore again.
 */
const NOISE_POINTS = 6;

/**
 * What each arm actually got through, when they are not the same.
 *
 * A stopped run leaves the queue truncated. The arms are interleaved so the
 * counts stay within one of each other, but "within one" is a claim worth
 * printing rather than trusting, and unequal denominators under two rates
 * presented side by side is exactly the thing a reader cannot see.
 */
function armCounts(outcomes: readonly { arm?: string }[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.arm !== undefined) counts.set(o.arm, (counts.get(o.arm) ?? 0) + 1);
  }
  const sizes = [...counts.values()];
  const even = sizes.every((n) => n === sizes[0]);
  const detail = [...counts].map(([arm, n]) => `${arm} ${n}`).join(", ");
  return even
    ? `Attempts per arm: ${detail}.`
    : `**The arms are not the same size** (${detail}) — the run was cut short, so the two rates above are over different denominators.`;
}

/**
 * The prompts each `--arms` setting compiles under.
 *
 * `undefined` means one unlabelled arm: the compiler as it is configured by
 * default, which is what an ordinary sweep measures. A named list makes the
 * arm explicit in every outcome, so a run can be told apart from another run
 * of a different arm after the fact.
 */
const ARMS_UNDER: Record<Arms, readonly PromptArm[] | undefined> = {
  current: undefined,
  control: ["without-bounds"],
  ab: ["without-bounds", "with-bounds"],
  // The calibrated single-pass compiler against the same instruction split
  // across two turns. The control here carries the checklist, so what separates
  // the arms is when the model is asked rather than whether.
  "two-pass": ["with-bounds", "two-pass"],
};

/** What each arm is, said once, where a reader of the report meets it. */
const ARM_MEANS: Record<PromptArm, string> = {
  "without-bounds":
    "The un-calibrated compiler: no operational-bounds checklist, and a revision pass that reports reach without reading the cadence the request implies.",
  "with-bounds":
    "The calibrated compiler, single pass: the compilation is asked to consider cadence, cooldowns, schedules and instance ceilings and to say what it decided, and its revision pass compares what the plan did to the cadence the request implies.",
  "two-pass":
    "The same calibration, split in two: the plan is written under the un-calibrated prompt, and the checklist is put to the model afterwards over the plan it has just written. Tests whether the omissions are a capacity limit rather than an instruction gap.",
};

/** Where every run is kept. Gitignored; the summary is committed by hand. */
const RUN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-runs");

async function main(): Promise<void> {
  const runAt = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const args = parseEvalArgs(process.argv.slice(2));
  const model = modelFromEnv();
  const budget = new Budget(PUBLISHED_PRICES[model.name], args.ceiling);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const paired = args.set === "unseen" ? [] : pairedTasks();
  const unseen = args.set === "paired" ? [] : unseenTasks(UNSEEN_PROMPTS);
  const keep = (t: EvalTask) => args.only === null || t.id === args.only;
  const tasks = [...paired, ...unseen].filter(keep);
  if (tasks.length === 0) throw new Error(`no request matches --only ${args.only}`);

  out(
    `${model.name}: ${tasks.length} requests × ${args.samples} samples, ` +
      `${args.concurrency} in flight, ceiling $${args.ceiling.toFixed(2)}`,
  );
  if (!PUBLISHED_PRICES[model.name]) {
    out(`  no published price for '${model.name}' — tokens will be reported, cost will not`);
  }

  // The answers, kept as they land rather than once at the end. `rescore-eval.ts`
  // reads this file; a run that dies still holds everything it paid for.
  const answers = join(RUN_DIRECTORY, `${runAt}.attempts.json`);
  const log = new AnswerLog(answers, model.name, tasks);

  let done = 0;
  // Every arm's attempts count towards the total a reader watches.
  const arms = ARMS_UNDER[args.arms];
  const total = tasks.length * args.samples * (arms?.length ?? 1);
  const { outcomes, stopped } = await runEvaluation(tasks, model, budget, {
    samples: args.samples,
    concurrency: args.concurrency,
    ...(arms === undefined ? {} : { arms }),
    onSample: (sample) => {
      done += 1;
      log.append(sample);
      const why = sample.outcome === "ok" ? "" : ` — ${sample.detail}`;
      // The arm belongs on the line: attempts land out of order under
      // concurrency, so position says nothing about which prompt produced one.
      const arm = sample.arm === undefined ? "" : ` [${sample.arm}]`;
      out(
        `  [${done}/${total}] ${sample.prompt} #${sample.sample}${arm} → ${sample.outcome}` +
          ` (${sample.turns} turns)${why}`,
      );
      if (done % 10 === 0) out(`      spent: ${budget.describe()}`);
    },
  });

  const pairedIds = new Set(paired.map((t) => t.id));

  // A comparison is reported as one summary per arm over the same requests, and
  // the caveat travels with the numbers: repeated sweeps of one unchanged setup
  // differ by about six points on this corpus, so a movement smaller than that
  // is not evidence of anything.
  const comparing = arms !== undefined && arms.length > 1;

  // The caveat is printed, not merely known. A rate on a page is read as a
  // measurement, and the movement between these two is smaller than the
  // movement between two runs of one unchanged setup — which is the single
  // fact a reader needs in order not to over-read them.
  const NOISE = `**Both rates carry draw noise.** Three sweeps of one unchanged setup on this corpus spanned about ${NOISE_POINTS} percentage points, so a movement smaller than that is not evidence of anything. Read the difference between the arms against that band, not against zero.`;

  const armSections = comparing
    ? [
        "",
        "## The comparison",
        "",
        NOISE,
        ...arms.flatMap((arm) => [
          "",
          formatSummary(
            `Paired — ${arm}`,
            outcomes.filter((o) => o.arm === arm && pairedIds.has(o.prompt)),
            ARM_MEANS[arm],
          ),
        ]),
        "",
        armCounts(outcomes.filter((o) => pairedIds.has(o.prompt))),
      ]
    : [];
  const refusalIds = new Set(unseen.filter((t) => t.expect === "refuses").map((t) => t.id));
  const failures = outcomes.filter((o) => o.outcome !== "ok");
  const report = [
    `# ${model.name} — ${args.samples} samples, ${tasks.length} requests` +
      (comparing ? `, ${arms.length} arms` : ""),
    "",
    ...armSections,
    "",
    ...(comparing
      ? [
          "## Pooled over both arms",
          "",
          "Every section below averages the two prompts together. In an A/B that is not a measurement of either one — it is the mean of a control and a treatment, and the arm sections above are what the run was for. Kept because the per-class failure lists underneath are worth reading whole.",
          "",
        ]
      : []),
    formatSummary(
      "Paired — the corpus's own requests, reference withheld",
      outcomes.filter((o) => pairedIds.has(o.prompt)),
      "Scored against what the hand-written watch does: the same moments, the same instance keys, the same model reaches. " +
        "This is agreement with one particular answer, not correctness — where a request leaves a choice open (how long a " +
        "silence has to last, which day of the week to look), a defensible compilation that chose differently is counted " +
        "as a mismatch. Read it as a lower bound, and read the differences below for which kind each one was.",
    ),
    "",
    formatSummary(
      "Unseen, must refuse — requests this ontology cannot answer",
      outcomes.filter((o) => refusalIds.has(o.prompt)),
      "Scored: refusing is the right answer here, and writing a watch anyway is the failure nothing downstream catches.",
    ),
    "",
    formatSummary(
      "Unseen, should compile — requests with no reference to compare against",
      outcomes.filter((o) => !pairedIds.has(o.prompt) && !refusalIds.has(o.prompt)),
      "**Not a correctness rate.** With no reference watch there is nothing to compare behaviour against, so this measures only that something validated — a watch on the wrong source counts here as readily as the right one.",
    ),
    "",
    "## Why each class happened",
    "",
    "`errored` is an attempt that threw rather than answering — a provider failure, a",
    "socket reset, or a replay that could not finish. It is counted as a defect because",
    "the run cannot tell whether the compilation was any good.",
    "",
    ...(
      [
        "structural_defect",
        "compiled_when_it_should_refuse",
        "divergent_defensible",
        "validator_rejected",
        "parse_failure",
        "refused_wrongly",
        "refused_vaguely",
        "errored",
      ] as const
    ).flatMap((outcome) => {
      const reasons = reasonsFor(outcomes, outcome);
      return reasons.length === 0 ? [] : [`**${outcome}**`, ...reasons.map((r) => `- ${r}`), ""];
    }),
    `Spend: ${budget.describe()}`,
    ...(stopped === null ? [] : ["", `**Run stopped early:** ${stopped}`]),
    "",
    "## Every attempt that was not exact",
    "",
    "The list, not a sample of it. A rate says how often; only this says what.",
    "",
    ...(failures.length === 0
      ? ["(none)"]
      : failures.map(
          (o) =>
            `- \`${o.prompt}\` #${o.sample}${o.arm ? ` [${o.arm}]` : ""} — **${o.outcome}** (${o.turns} turns) — ${o.detail}`,
        )),
  ].join("\n");

  out("");
  out(report);

  // Always kept, whatever the caller asked for. `runAt` is stamped by the
  // caller rather than read here so the file name matches the run a person
  // started, not the moment it finished.
  const kept = join(RUN_DIRECTORY, `${runAt}.md`);
  writeFileSync(kept, `${report}\n`);
  out(`\nkept at ${kept}`);

  out(`answers at ${answers}`);
  if (args.out) {
    writeFileSync(args.out, `${report}\n`);
    out(`written to ${args.out}`);
  }
  if (stopped !== null) process.exitCode = 1;
}

await main();
