// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Running a watch over a universe.
 *
 * This is the façade the goldens and the backtest both call. It assembles what
 * the engine needs — the journal, a real analytics database, a judge and a
 * recall scorer — runs the watch, and hands back the trace.
 *
 * `WatchEngine` owns the evaluation; everything here is wiring.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateWatch } from "../validator/validate.js";
import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { readJournal } from "../journal/read.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, journalPath, loadOntology, universeDir } from "../universe/paths.js";
import { WatchEngine } from "./engine.js";
import {
  ScriptedJudge,
  ScriptedRecall,
  type JudgeProvider,
  type RecallScorer,
  type ScriptedJudgement,
  type ScriptedScore,
} from "./providers.js";
import type { WatchTrace } from "./trace.js";

export interface RunOptions {
  readonly universe?: string;
  readonly judge?: JudgeProvider;
  readonly recall?: RecallScorer;
  /** Stop after this many journal events. Used to keep a golden readable. */
  readonly through?: number;
}

/**
 * The scripted answers a watch's judges and recall scorer give.
 *
 * A universe carries one of these per watch that needs a model, so a golden
 * trace is reproducible: the procedural half is exercised in full while what a
 * model would decide is written down rather than asked. `note` says what the
 * fixture is arranging, because a reader looking at a trace needs to know which
 * events were meant to matter.
 */
export interface WatchScript {
  readonly note?: string;
  readonly recall?: readonly ScriptedScore[];
  readonly judgements?: readonly ScriptedJudgement[];
}

/** Read a watch's scripted answers, or an empty script when it needs none. */
export function loadScript(name: string, universe?: string): WatchScript {
  const path = join(universeDir(universe), "scripts", `${name}.json`);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as WatchScript;
}

/** Load a watch definition from a universe, validated. */
export function loadWatch(name: string, universe?: string): WatchDefinition {
  const path = join(universeDir(universe), "watches", `${name}.json`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const ontology = loadOntology(universe);

  const result = validateWatch(raw, ontology);
  if (!result.valid) {
    throw new Error(
      `'${name}' does not validate against the '${universe ?? "poc"}' ontology:\n` +
        result.diagnostics.map((d) => `  ${d.code} ${d.path}: ${d.message}`).join("\n"),
    );
  }
  return watchDslSchema.parse(raw).watch;
}

/**
 * Run a watch definition against a universe and return its trace.
 *
 * The corpus is a set of watches worth having, which is not the same set as
 * the shapes worth testing. A test that needs a shape the corpus lacks — a
 * cooldown at an interval no watch declares, an edge wired to prove what
 * happens when it is wrong — builds the definition and runs it here.
 *
 * It still goes through the validator first, because a fixture the validator
 * would reject says nothing about the engine.
 *
 * Note the judge: a definition has no name, so there is no script to read, and
 * an unsupplied judge answers nothing. A definition containing an `llm` node
 * therefore never fires unless the caller passes one — `runWatch` does that
 * from the watch's own script, and a caller re-parameterizing a corpus watch
 * should pass the same.
 */
export async function runDefinition(raw: unknown, options: RunOptions = {}): Promise<WatchTrace> {
  const ontology = loadOntology(options.universe);
  const result = validateWatch(raw, ontology);
  if (!result.valid) {
    // Named from the document rather than from an argument, so a corpus watch
    // and an inline definition both say which one failed.
    const named = (raw as { watch?: { name?: unknown } })?.watch?.name;
    throw new Error(
      `'${typeof named === "string" ? named : "<unnamed>"}' does not validate:\n` +
        result.diagnostics.map((d) => `  ${d.code} ${d.path}: ${d.message}`).join("\n"),
    );
  }

  const journal = readJournal(journalPath(options.universe));
  // Replay populates the store as it goes; only system-owned projections are
  // seeded, because no event carries them.
  const analytics = await AnalyticsDatabase.materialize(
    ontology,
    analyticsDir(options.universe),
    "projections",
  );

  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal: options.through === undefined ? journal : journal.slice(0, options.through),
      analytics,
      // The same types the host gives its engine. A replay that bound values
      // differently would answer differently, and a golden trace taken from it
      // would stop describing what the install does.
      ...(result.types ? { valueTypes: result.types } : {}),
      judge: options.judge ?? new ScriptedJudge({ judgements: [] }),
      recall: options.recall ?? new ScriptedRecall([]),
    }).run();
  } finally {
    analytics.close();
  }
}

/**
 * Run a named watch over a universe and return its trace.
 *
 * Loading is all this adds: the definition from the universe and the scripted
 * answers its judges and recall scorer give. The wiring is `runDefinition`'s,
 * so a corpus watch and an inline definition always run on an
 * identically-configured engine.
 */
export async function runWatch(name: string, options: RunOptions = {}): Promise<WatchTrace> {
  const raw: unknown = JSON.parse(
    readFileSync(join(universeDir(options.universe), "watches", `${name}.json`), "utf8"),
  );
  const script = loadScript(name, options.universe);
  return runDefinition(raw, {
    ...options,
    judge: options.judge ?? new ScriptedJudge({ judgements: script.judgements ?? [] }),
    recall: options.recall ?? new ScriptedRecall(script.recall ?? []),
  });
}
