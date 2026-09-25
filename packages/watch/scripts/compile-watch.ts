#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Compile one request into a watch, against a live model.
 *
 *   WATCHV2_COMPILER_BASE_URL=… WATCHV2_COMPILER_API_KEY=… WATCHV2_COMPILER_MODEL=… \
 *     npx tsx packages/watch/scripts/compile-watch.ts "warn me when …"
 *
 * The three variables are the only way to reach a model: there is no default
 * endpoint and no credential in the tree. Pass `--withhold <name>` to keep a
 * corpus watch out of the worked examples, which is what makes compiling a
 * request the corpus already answers a measurement rather than a lookup.
 *
 * Everything it prints comes back from the compiler: the turns it took, the
 * diagnostics each one drew, the reach report, and the tokens spent. The
 * credential is never printed, and neither is the prompt.
 */

import { compile } from "../src/compiler/compile.js";
import { examplesFor } from "../src/compiler/examples.js";
import { loadEvents } from "../src/compiler/events.js";
import { loadLoops } from "../src/compiler/loops.js";
import { modelFromEnv } from "../src/compiler/model.js";
import { formatReport } from "../src/backtest/backtest.js";
import { loadOntology } from "../src/universe/paths.js";

function parseArgs(argv: readonly string[]): { query: string; withhold: string[] } {
  const withhold: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--withhold") {
      const name = argv[i + 1];
      if (name === undefined) throw new Error("--withhold needs a watch name");
      withhold.push(name);
      i += 1;
    } else {
      rest.push(argv[i]!);
    }
  }
  const query = rest.join(" ").trim();
  if (query === "") throw new Error('usage: compile-watch.ts [--withhold <name>] "<request>"');
  return { query, withhold };
}

async function main(): Promise<void> {
  const { query, withhold } = parseArgs(process.argv.slice(2));
  const ontology = loadOntology();
  const model = modelFromEnv();

  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(
    `compiling against ${model.name}${withhold.length > 0 ? `, withholding ${withhold.join(", ")}` : ""}`,
  );

  const result = await compile(
    query,
    { ontology, loops: loadLoops(), events: loadEvents(), examples: examplesFor(withhold) },
    model,
  );

  for (const attempt of result.attempts) {
    const errors = attempt.diagnostics.filter((d) => d.severity === "error");
    out(
      `  turn ${attempt.turn} (${attempt.cause}) → ${attempt.outcome}` +
        (errors.length > 0 ? `, ${errors.map((d) => d.code).join(" ")}` : ""),
    );
  }

  const { promptTokens, cachedPromptTokens, completionTokens } = result.usage;
  out(
    `  tokens: ${promptTokens} prompt (${cachedPromptTokens} cached), ${completionTokens} completion`,
  );

  if (result.status === "refused") {
    out("\nrefused:");
    for (const reason of result.reasons) out(`  ${reason}`);
    return;
  }
  if (result.status === "failed") {
    out(`\nfailed: ${result.reason}`);
    for (const d of result.diagnostics) out(`  ${d.code} ${d.path}: ${d.message}`);
    process.exitCode = 1;
    return;
  }

  out("");
  if (result.report) out(formatReport(result.report));
  out("");
  out(JSON.stringify(result.document, null, 2));
}

try {
  await main();
} catch (error) {
  // The two errors a person actually hits here — an unconfigured model and a
  // missing request — are one line each, and a stack trace buries both.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
