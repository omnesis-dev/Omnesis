// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Worked examples, drawn from the corpus rather than written for the prompt.
 *
 * The corpus watches are hand-written, validated, and replayed against frozen
 * traces every time the suite runs, so they are the only DSL in the tree that
 * is *known* to be both legal and meaningful. Writing a second set of examples
 * for the prompt would create a second thing to keep correct, and the first
 * time the DSL moved the prompt would start teaching a dialect the validator
 * rejects.
 *
 * Each carries the request it came from — the watch's own `nl_query` — because
 * an example without its request teaches shape but not mapping.
 *
 * **Hold-out.** When the compiler is measured on a request the corpus already
 * answers, the answer must not be in the prompt. `examplesFor` takes the names
 * to withhold; the evaluation passes the watch it is about to score, and a
 * watch withheld this way is scored on whether the compiler can reach it from
 * the ontology and the remaining examples alone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { watchNames } from "../backtest/golden.js";
import { universeDir } from "../universe/paths.js";

export interface WorkedExample {
  /** The corpus watch this came from. */
  readonly name: string;
  readonly nlQuery: string;
  /** The watch document, formatted as it is stored. */
  readonly dsl: string;
}

/**
 * Examples in a fixed order, with `withhold` removed.
 *
 * The order is the corpus's own — sorted by name — so the prompt prefix is
 * byte-identical between runs. A prefix that reordered its examples would be a
 * different prefix to a cache.
 */
export function examplesFor(withhold: readonly string[] = [], universe?: string): WorkedExample[] {
  const excluded = new Set(withhold);
  return watchNames()
    .filter((name) => !excluded.has(name))
    .map((name) => loadExample(name, universe))
    .filter((example): example is WorkedExample => example !== null);
}

/**
 * One example, or null when the watch does not say what it was asked for.
 *
 * A watch with no `nl_query` cannot teach the mapping the prompt is for, and
 * `corpus.test.ts` asserts the corpus has none, so this is a guard rather than
 * a tolerated case.
 */
function loadExample(name: string, universe?: string): WorkedExample | null {
  const raw = readFileSync(join(universeDir(universe), "watches", `${name}.json`), "utf8");
  const parsed = JSON.parse(raw) as { watch?: { nl_query?: string } };
  const nlQuery = parsed.watch?.nl_query;
  if (!nlQuery) return null;
  return { name, nlQuery, dsl: raw.trimEnd() };
}
