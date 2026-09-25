// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  compareRuns,
  pickImprovements,
  pickRegressions,
  RunOutput,
  type CompareReport,
  type QueryDelta,
  type SummaryDelta,
} from "@omnesis/eval";
import { c, CliError, EXIT_USER_ERROR, isJSON } from "../utils.js";

export const evalCompareCommand = defineCommand({
  meta: {
    name: "compare",
    description: "Diff two eval run outputs and report per-query + aggregate deltas",
  },
  args: {
    "run-a": {
      type: "positional",
      required: true,
      description: "Path to first run output JSON",
    },
    "run-b": {
      type: "positional",
      required: true,
      description: "Path to second run output JSON",
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const pathA = resolve(process.cwd(), ctx.args["run-a"] as string);
    const pathB = resolve(process.cwd(), ctx.args["run-b"] as string);
    let runA: RunOutput;
    let runB: RunOutput;
    try {
      runA = RunOutput.parse(JSON.parse(readFileSync(pathA, "utf-8")));
      runB = RunOutput.parse(JSON.parse(readFileSync(pathB, "utf-8")));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Failed to parse run output: ${msg}`, EXIT_USER_ERROR);
    }

    const report = compareRuns(runA, runB, { a: pathA, b: pathB });

    if (isJSON || ctx.args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    renderHuman(report);
  },
});

function renderHuman(r: CompareReport): void {
  console.log(`${c.bold}A${c.reset}: ${r.run_a.path ?? r.run_a.run_id}`);
  console.log(`${c.bold}B${c.reset}: ${r.run_b.path ?? r.run_b.run_id}`);
  if (!r.fixture_match) {
    console.log(
      `${c.yellow}⚠${c.reset}  Fixture SHA256 differs between runs — comparisons may be apples-to-oranges.`,
    );
  }
  if (r.only_in_a.length || r.only_in_b.length) {
    if (r.only_in_a.length)
      console.log(`${c.yellow}only in A${c.reset}: ${r.only_in_a.join(", ")}`);
    if (r.only_in_b.length)
      console.log(`${c.yellow}only in B${c.reset}: ${r.only_in_b.join(", ")}`);
  }
  console.log("");

  console.log(`${c.bold}Aggregate Δ (B − A)${c.reset}`);
  console.log(`  ${fmtAggregate(r.overall)}`);
  console.log("");

  const regressions = pickRegressions(r);
  const improvements = pickImprovements(r);
  if (regressions.length === 0 && improvements.length === 0) return;
  console.log(`${c.bold}Per-query Δ${c.reset}`);
  if (regressions.length > 0) {
    console.log(`  ${c.red}Regressions (${regressions.length})${c.reset}`);
    for (const q of regressions) printQueryLine(q, c.red);
  }
  if (improvements.length > 0) {
    console.log(`  ${c.green}Improvements (${improvements.length})${c.reset}`);
    for (const q of improvements) printQueryLine(q, c.green);
  }
  console.log("");
}

function fmtAggregate(d: SummaryDelta): string {
  return (
    `hit@1 ${pctDelta(d.hit_at_1_mean)}  ` +
    `hit@10 ${pctDelta(d.hit_at_10_mean)}  ` +
    `recall ${pctDelta(d.recall_at_10_mean)}  ` +
    `mrr ${signed(d.mrr_mean, 3)}  ` +
    `p50 ${msDelta(d.latency_p50)}  ` +
    `p95 ${msDelta(d.latency_p95)}`
  );
}

function printQueryLine(q: QueryDelta, color: string): void {
  const d = q.metrics;
  console.log(
    `    ${color}${q.query_id}${c.reset}  ` +
      `hit@1 ${signed(d.hit_at_1, 0)}  ` +
      `hit@10 ${signed(d.hit_at_10, 0)}  ` +
      `recall ${pctDelta(d.recall_at_10)}  ` +
      `mrr ${signed(d.mrr, 3)}  ` +
      `rank ${d.best_rank_a ?? "—"}→${d.best_rank_b ?? "—"}  ` +
      `lat ${msDelta(d.latency_ms)}  ${c.dim}"${q.query_text}"${c.reset}`,
  );
}

function pctDelta(v: number): string {
  const pct = v * 100;
  if (Math.abs(pct) < 0.05) return "±0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function signed(v: number, digits: number): string {
  if (Math.abs(v) < Math.pow(10, -digits - 1)) return "0";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function msDelta(v: number): string {
  if (Math.abs(v) < 0.5) return "±0ms";
  return `${v > 0 ? "+" : ""}${Math.round(v)}ms`;
}
