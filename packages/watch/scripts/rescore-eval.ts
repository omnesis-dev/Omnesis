#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Score a sweep that has already been paid for, again.
 *
 *   npx tsx packages/watch/scripts/rescore-eval.ts eval-runs/<run>.attempts.json
 *
 * A scorer change is otherwise unauditable. The run that motivated it is gone,
 * the next run draws different answers from the same model, and a rate that
 * moved cannot be told from a model that had a better day — which matters most
 * when the change makes the scoring *more* permissive, because that is the
 * direction where "it looks better now" is the expected result either way.
 *
 * So the runner writes every compiled watch beside its report, and this puts
 * those same answers through whatever the scorer currently says. Comparing its
 * output to the report next to it attributes the difference to the rule rather
 * than to the draw.
 *
 * It reaches no model and costs nothing. Refusals, parse failures and errors
 * are carried through unchanged: there is no watch to re-score.
 */

import { readFileSync } from "node:fs";

import { attemptKey, type KeptRun } from "../src/eval/answer-log.js";
import { formatSummary } from "../src/eval/report.js";
import { DEFECT_CLASSES, rescore } from "../src/eval/harness.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: rescore-eval.ts <run>.attempts.json");

  const kept = JSON.parse(readFileSync(path, "utf8")) as KeptRun;
  const out = (line: string) => process.stdout.write(`${line}\n`);

  // The same answers put through the scorer twice, differing only in whether a
  // declared cadence latitude is granted. Both figures come from one code path
  // so the comparison between them is the allowance and nothing else.
  const rescored = await rescore(kept.tasks, kept.outcomes, undefined, {});
  const strict = await rescore(kept.tasks, kept.outcomes, undefined, { cadenceLatitude: false });

  const pairedIds = new Set(kept.tasks.filter((t) => t.reference !== null).map((t) => t.id));
  const paired = rescored.filter((o) => pairedIds.has(o.prompt));

  out(`# ${kept.model} — rescored from ${path}`);
  out("");

  // A run with arms is two measurements that share a file. Pooling them prints
  // the mean of a control and a treatment under a title that reads as neither.
  const arms = [...new Set(paired.map((o) => o.arm))].filter((a) => a !== undefined);
  if (arms.length > 1) {
    for (const arm of arms.sort()) {
      out(
        formatSummary(
          `Paired — ${arm}`,
          paired.filter((o) => o.arm === arm),
          "The same attempts as the report beside this file, put through the scorer as it stands now.",
        ),
      );
      out("");
    }
  } else {
    out(
      formatSummary(
        "Paired — the corpus's own requests, reference withheld",
        paired,
        "The same attempts as the report beside this file, put through the scorer as it stands now.",
      ),
    );
  }
  out("");
  out("## What the cadence latitude is worth");
  out("");
  out(
    "A rate limiter a request never asked for is the reference's own choice. These two rates " +
      "differ only in whether a compilation that fitted none is read as having misread the " +
      "request. Everything else about the scoring is identical.",
  );
  out("");
  // Both figures, and both classes. The allowance can only ever move an attempt
  // out of `structural_defect`, so quoting the aggregate defect rate as though
  // it were the structural one overstates the level while getting the movement
  // right — a reader comparing it to a headline elsewhere would be comparing
  // two different measurements.
  for (const [label, set] of [
    ["without cadence latitude", strict],
    ["with cadence latitude", rescored],
  ] as const) {
    const mine = set.filter((o) => pairedIds.has(o.prompt));
    const structural = mine.filter((o) => o.outcome === "structural_defect").length;
    const defects = mine.filter((o) => DEFECT_CLASSES.includes(o.outcome)).length;
    const pct = (n: number) => (mine.length === 0 ? "0" : ((100 * n) / mine.length).toFixed(0));
    out(
      `- **${label}:** ${structural}/${mine.length} (${pct(structural)}%) structural defect; ` +
        `${defects}/${mine.length} (${pct(defects)}%) counting every defect class`,
    );
  }
  out("");
  // Zipped by position: `rescore` returns one outcome per input in order, so
  // index i is the same attempt in both passes.
  const excused = rescored.flatMap((o, i) =>
    pairedIds.has(o.prompt) && strict[i]!.outcome !== o.outcome
      ? [`- \`${attemptKey(o)}\`: ${strict[i]!.outcome} → ${o.outcome}`]
      : [],
  );
  out(`${excused.length} paired attempts change class when the latitude is granted.`);
  for (const line of excused) out(line);

  out("");
  out("## What moved");
  out("");
  const before = new Map(kept.outcomes.map((o) => [attemptKey(o), o.outcome]));
  const moved = rescored.filter((o) => before.get(attemptKey(o)) !== o.outcome);
  out(`${moved.length} of ${rescored.length} attempts changed class.`);
  out("");
  for (const o of moved) {
    out(`- \`${attemptKey(o)}\`: ${before.get(attemptKey(o))} → ${o.outcome}`);
  }
}

await main();
