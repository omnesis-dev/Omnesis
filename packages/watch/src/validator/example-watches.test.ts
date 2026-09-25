// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The valid-watch corpus.
 *
 * Twelve of these are the seed examples the DSL was designed against — the
 * queries a person actually wants a watch for. The rest exist to reach node
 * types the twelve happen not to use; a node type with no working example is a
 * node type nobody has proven the language can express.
 *
 * Every one must validate with zero errors. When a change to the DSL or the
 * validator breaks one, the question is whether the example or the design is
 * wrong — silently editing the example to match a regression is the failure
 * mode this test exists to prevent.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nodeSchema, type WatchNodeType } from "../dsl/schema.js";
import { loadOntology, universeDir } from "../universe/paths.js";
import { validateWatch } from "./validate.js";

const WATCHES_DIR = join(universeDir(), "watches");

/** The worked examples the language was designed against. */
const SEED_EXAMPLES = [
  "alice-decided-to-leave",
  "alice-declines-dinner",
  "elevated-resting-hr-week",
  "important-email-unanswered",
  "major-life-turning-point",
  "meeting-with-lost-touch",
  "mum-call-rhythm-stopped",
  "proposal-no-reply-5bd",
  "restaurant-budget-500",
  "sleep-materially-worse",
  "tax-loop-closed",
  "trip-vs-passport-expiry",
];

/** Watches added to exercise node types the seed examples do not reach. */
const NODE_COVERAGE_EXAMPLES = [
  "invoice-and-receipt-both-arrived",
  "maya-conversation-lapsed",
  "large-card-spending-streak",
  "quote-accepted-then-invoiced",
  "same-topic-across-two-channels",
  "order-problem-by-number",
];

const ALL_EXAMPLES = [...SEED_EXAMPLES, ...NODE_COVERAGE_EXAMPLES].sort();

function loadWatch(name: string): unknown {
  return JSON.parse(readFileSync(join(WATCHES_DIR, `${name}.json`), "utf8"));
}

function nodeTypesIn(name: string): string[] {
  const watch = loadWatch(name) as { watch: { nodes: { type: string }[] } };
  return watch.watch.nodes.map((node) => node.type);
}

describe("example watches", () => {
  const ontology = loadOntology();

  it("the corpus holds exactly the watches this test knows about", () => {
    const found = readdirSync(WATCHES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(found).toEqual(ALL_EXAMPLES);
  });

  it.each(ALL_EXAMPLES)("%s validates clean", (name) => {
    const result = validateWatch(loadWatch(name), ontology);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  /**
   * Derived from the schema rather than written out, so a node type added to
   * the DSL without a working example fails here instead of going unnoticed.
   */
  it("every node type the DSL defines has a working example", () => {
    const declared = nodeSchema.options
      .map((option) => option.shape.type.value as WatchNodeType)
      .sort();
    const exercised = [...new Set(ALL_EXAMPLES.flatMap(nodeTypesIn))].sort();
    expect(exercised).toEqual(declared);
  });

  it("keeps the twelve seed examples intact", () => {
    expect(SEED_EXAMPLES).toHaveLength(12);
    for (const name of SEED_EXAMPLES) expect(() => loadWatch(name)).not.toThrow();
  });
});
