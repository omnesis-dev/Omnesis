// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { defineCommand } from "citty";
import { RunOutput, type QueryResult, type QueryRunResult } from "@omnesis/eval";
import { c, CliError, EXIT_USER_ERROR, isJSON } from "../utils.js";

/**
 * Pretty-print one or more queries from a run output. The default
 * action prints every query; `--query <id>` narrows to one. Shows the
 * resolved expected document ids, the top-10 retrieved with score
 * breakdowns, per-stage timing + candidate counts, and the hit/miss
 * verdict.
 */
export const evalShowCommand = defineCommand({
  meta: {
    name: "show",
    description: "Pretty-print a run output: retrieved docs, score breakdowns, per-stage timing",
  },
  args: {
    run: {
      type: "positional",
      required: false,
      description:
        "Path to run output JSON. Defaults to the most recent run under ~/.config/omnesis/evals/runs/",
    },
    query: {
      type: "string",
      description: "Show only the query with this id",
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const runPath = resolveRunPath(ctx.args.run as string | undefined);
    let run: RunOutput;
    try {
      run = RunOutput.parse(JSON.parse(readFileSync(runPath, "utf-8")));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Failed to parse ${runPath}: ${msg}`, EXIT_USER_ERROR);
    }

    const queryFilter = ctx.args.query as string | undefined;
    const queries = queryFilter ? run.queries.filter((q) => q.id === queryFilter) : run.queries;
    if (queries.length === 0) {
      throw new CliError(
        `No query matched id="${queryFilter}". Available: ${run.queries.map((q) => q.id).join(", ")}`,
        EXIT_USER_ERROR,
      );
    }
    if (isJSON || ctx.args.json) {
      console.log(
        JSON.stringify(
          {
            run_id: run.run_id,
            queries: queries.map((q) => ({
              id: q.id,
              query_text: q.query_text,
              type: q.type,
              difficulty: q.difficulty,
              expected_url_groups: q.expected_url_groups,
              resolved_doc_id_groups: q.resolved_doc_id_groups,
              result: q.result,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`${c.bold}Run${c.reset}: ${run.run_id}  ${c.dim}(${runPath})${c.reset}`);
    console.log(`${c.dim}Fixture${c.reset}: ${run.fixture_path}`);
    console.log("");

    for (const q of queries) {
      renderQuery(q);
    }
  },
});

function resolveRunPath(arg: string | undefined): string {
  if (arg) return isAbsolute(arg) ? arg : pathResolve(process.cwd(), arg);
  const dir = join(
    process.env["OMNESIS_CONFIG_DIR"] ?? join(homedir(), ".config/omnesis"),
    "evals",
    "runs",
  );
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new CliError(
      `No run directory at ${dir}. Pass a run output path explicitly.`,
      EXIT_USER_ERROR,
    );
  }
  const candidates = entries.filter((e) => e.endsWith(".json")).sort();
  if (candidates.length === 0) {
    throw new CliError(`No run output files in ${dir}. Pass a path explicitly.`, EXIT_USER_ERROR);
  }
  return join(dir, candidates[candidates.length - 1]!);
}

function renderQuery(q: QueryResult): void {
  console.log(`${c.bold}${c.cyan}[${q.id}]${c.reset}  ${q.query_text}`);
  if (q.type || q.difficulty) {
    const tags = [q.type && `type=${q.type}`, q.difficulty && `difficulty=${q.difficulty}`]
      .filter(Boolean)
      .join("  ");
    console.log(`${c.dim}${tags}${c.reset}`);
  }
  if (q.notes) console.log(`${c.dim}notes${c.reset}: ${q.notes}`);
  const expectedSummary = q.resolved_doc_id_groups
    .map((g, i) => {
      const urlGroup = q.expected_url_groups[i] ?? [];
      const url = urlGroup[0] ?? "(none)";
      const ids = g.length > 0 ? g.map((id) => id.slice(0, 8)).join(",") : "(unresolved)";
      return `  ${i + 1}. ${url}  ${c.dim}[${ids}]${c.reset}`;
    })
    .join("\n");
  console.log(`${c.dim}expected${c.reset}:`);
  console.log(expectedSummary);

  renderResult(q.result, q);
  console.log("");
}

function renderResult(r: QueryRunResult, q: QueryResult): void {
  const verdict = r.hit_any
    ? `${c.green}HIT${c.reset} @ rank ${r.best_rank}`
    : `${c.red}MISS${c.reset}`;
  console.log(`  ${verdict}  ${c.dim}latency=${Math.round(r.metrics.latency_ms)}ms${c.reset}`);

  const t = r.stage_timings;
  const c_ = r.stage_candidates;
  const timingParts: string[] = [];
  if (t.bm25_ms !== undefined)
    timingParts.push(`bm25=${Math.round(t.bm25_ms)}ms(${c_.bm25 ?? "?"})`);
  if (t.vector_ms !== undefined)
    timingParts.push(`vec=${Math.round(t.vector_ms)}ms(${c_.vector ?? "?"})`);
  if (t.fusion_ms !== undefined) timingParts.push(`fusion=${Math.round(t.fusion_ms)}ms`);
  if (t.boost_ms !== undefined) timingParts.push(`boost=${Math.round(t.boost_ms)}ms`);
  if (t.ref_count_ms !== undefined) timingParts.push(`ref=${Math.round(t.ref_count_ms)}ms`);
  if (timingParts.length > 0)
    console.log(`    ${c.dim}stages${c.reset}: ${timingParts.join("  ")}`);

  if (r.model_state) {
    console.log(`    ${c.dim}model${c.reset}: vector=${r.model_state.vector ?? "n/a"}`);
  }

  // Top retrieved — flag those that match an expected doc.
  const expectedIds = new Set(q.resolved_doc_id_groups.flat());
  console.log(`    ${c.dim}top retrieved${c.reset}:`);
  const topN = Math.min(r.retrieved.length, 10);
  if (topN === 0) {
    console.log(`      ${c.dim}(none)${c.reset}`);
    return;
  }
  for (let i = 0; i < topN; i++) {
    const d = r.retrieved[i]!;
    const isMatch = expectedIds.has(d.document_id);
    const marker = isMatch ? `${c.green}★${c.reset}` : " ";
    // Titles get truncated for layout — they aren't load-bearing for navigation.
    // URLs go on their own line, full length, so the user can click through.
    const title = (d.title ?? "").slice(0, 80);
    const url = d.source_url ?? "(no url)";
    const score = d.score !== undefined ? `${d.score.toFixed(3)}` : "—";
    console.log(
      `    ${marker} ${String(d.rank).padStart(2)}. ${c.dim}score=${score.padEnd(6)}${c.reset} ${title}`,
    );
    console.log(`         ${c.dim}url${c.reset}: ${url}`);
    if (isMatch && d.score_breakdown) {
      const parts: string[] = [];
      const bd = d.score_breakdown;
      if (bd["bm25Rank"] !== undefined) parts.push(`bm25Rank=${bd["bm25Rank"]}`);
      if (bd["vectorRank"] !== undefined) parts.push(`vectorRank=${bd["vectorRank"]}`);
      if (bd["rrfScore"] !== undefined) parts.push(`rrf=${bd["rrfScore"]!.toFixed(3)}`);
      if (bd["rankBonus"] !== undefined && bd["rankBonus"] !== 0)
        parts.push(`rankBonus=${bd["rankBonus"]!.toFixed(3)}`);
      if (bd["typeBoost"] !== undefined) parts.push(`type=${bd["typeBoost"]!.toFixed(3)}`);
      if (bd["relevanceBoost"] !== undefined)
        parts.push(`relevance=${bd["relevanceBoost"]!.toFixed(3)}`);
      if (bd["finalScore"] !== undefined) parts.push(`final=${bd["finalScore"]!.toFixed(3)}`);
      if (parts.length > 0) console.log(`         ${c.dim}↳ ${parts.join("  ")}${c.reset}`);
    }
  }
}
