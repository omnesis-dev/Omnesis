// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The worked examples are the corpus, so the corpus has to stay usable as one.
 *
 * Two things can quietly break that. A watch added without the request it came
 * from teaches shape but not mapping, and `examplesFor` would silently drop it
 * — the prompt would get smaller and nothing would say why. And the shape half
 * of the prompt is generated from the DSL schema, so a hand-copied version of
 * it would drift the moment the schema moved, which is the exact failure the
 * generation exists to prevent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { watchNames } from "../backtest/golden.js";
import { loadOntology, universeDir } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { examplesFor } from "./examples.js";
import { loadLoops } from "./loops.js";
import { promptPrefix } from "./prompt.js";
import { dslSchemaReference } from "./schema-reference.js";

const ontology = loadOntology();

describe("the corpus as a set of worked examples", () => {
  it("says what every watch was asked for", () => {
    const withoutQuery = watchNames().filter((name) => {
      const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
      return !(JSON.parse(raw) as { watch: { nl_query?: string } }).watch.nl_query;
    });
    expect(withoutQuery, "these watches would be dropped from the prompt").toEqual([]);
  });

  it("offers one example per watch", () => {
    expect(examplesFor().map((e) => e.name)).toEqual(watchNames());
  });

  it("shows each watch exactly as the file stores it", () => {
    // The example is the file's text, not a re-serialization of it, so what
    // the model is shown is what a reviewer reading the corpus sees.
    for (const example of examplesFor()) {
      const raw = readFileSync(join(universeDir(), "watches", `${example.name}.json`), "utf8");
      expect(example.dsl, example.name).toBe(raw.trimEnd());
    }
  });

  it("shows only watches that validate", () => {
    // An example the validator would reject teaches the model to write one.
    for (const example of examplesFor()) {
      const result = validateWatch(JSON.parse(example.dsl), ontology);
      expect(result.valid, `${example.name}: ${result.diagnostics.map((d) => d.code).join()}`).toBe(
        true,
      );
    }
  });

  it("names every person its watch binds, so the request is answerable", () => {
    // A paired measurement asks the compiler to rebuild a watch from its
    // request alone. If the request says "my mum" and nothing in the people
    // directory says who that is, the honest answer is a refusal — and the
    // measurement would be scoring the compiler for knowledge the author had
    // and the ontology does not.
    //
    // Two watches failed this when it was first written: one bound a person
    // the request named only by a relationship, and one bound a person the
    // request did not mention at all.
    const people = new Map(ontology.snapshot.people.map((p) => [p.id, p]));
    const unresolvable: string[] = [];

    for (const example of examplesFor()) {
      const query = example.nlQuery.toLowerCase();
      const bound = new Set(
        [...example.dsl.matchAll(/"person": "([0-9a-f-]+)"/g)].map((m) => m[1]!),
      );
      for (const id of bound) {
        const person = people.get(id);
        const names = person ? [person.canonicalName, ...person.aliases] : [];
        const named = names.some(
          (name) =>
            query.includes(name.toLowerCase()) || query.includes(name.split(" ")[0]!.toLowerCase()),
        );
        if (!named) unresolvable.push(`${example.name} binds ${person?.canonicalName ?? id}`);
      }
    }
    expect(unresolvable).toEqual([]);
  });

  it("binds someone somewhere, so the check above is not about an empty set", () => {
    const binding = examplesFor().filter((e) => e.dsl.includes('"person": "'));
    expect(binding.length).toBeGreaterThan(3);
  });

  it("withholds exactly what it is asked to", () => {
    const held = ["restaurant-budget-500", "tax-loop-closed"];
    const kept = examplesFor(held).map((e) => e.name);
    expect(kept).toEqual(watchNames().filter((name) => !held.includes(name)));
  });
});

describe("the schema half of the prompt", () => {
  it("is generated from the DSL schema rather than copied", () => {
    // Asserted by containment of the generated text: a hand-maintained copy
    // would diverge the first time a field moved, and the prompt would then be
    // teaching a grammar the validator does not accept.
    const content = promptPrefix({ ontology, loops: loadLoops(), examples: [] })[0]!.content;
    expect(content).toContain(dslSchemaReference());
  });

  it("carries the fields a model has to write", () => {
    const reference = dslSchemaReference();
    for (const field of ["nl_query", "on_collision", "broadcast", "min_interval", "query"]) {
      expect(reference, field).toContain(`"${field}"`);
    }
  });

  it("carries the metadata predicate shape the validator actually wants", () => {
    // The shape most easily guessed wrong: metadata is a list of predicates,
    // not an object of path-to-value. Prose describing it would be a second
    // copy of the grammar; this one comes from the schema.
    const reference = dslSchemaReference();
    expect(reference).toContain('"op"');
    expect(reference).toContain('"not_in"');
  });
});
