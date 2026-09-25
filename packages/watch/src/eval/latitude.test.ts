// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Latitude has to be earned from the request and needed by the watch.
 *
 * `free-parameters.ts` declares, per watch, what its request leaves open about
 * the *shape* of an answer — that the alert's contents are not enumerated, that
 * an average has no stated format, that naming which branch fired is the
 * watch's own vocabulary. Each one makes a compilation's life easier, so each
 * one is a subsidy, and a subsidy nobody counts is the thing the previous round
 * was criticised for.
 *
 * Two ways a declaration could be dishonest, and a test for each:
 *
 * - **Unearned** — declared where the watch has no such thing to be lenient
 *   about. `node-names` on a watch whose sink never reads `$fired_by` is a
 *   grant that will one day excuse something it was not written for.
 * - **Undeclared** — relied on without being written down. A watch whose sink
 *   *does* read `$fired_by` and does not declare it is asking the comparison to
 *   grade a node name, which is the defect the declaration exists to record.
 *
 * The structural half is checkable because the sink says what it reports. The
 * `because` half is not, and is held to a lower bar: it has to quote the
 * request. That is weak on its own and is why the declarations are reviewed
 * prose rather than a lookup table.
 */

import { describe, expect, it } from "vitest";

import { watchNames } from "../backtest/golden.js";
import { loadWatch } from "../runtime/run.js";
import { LATITUDES, type LatitudeRule } from "./free-parameters.js";

/** Which latitudes a watch's own structure gives it something to be lenient about. */
function structurallyNeeds(name: string): Set<LatitudeRule> {
  const watch = loadWatch(name);
  const outputMap = watch.sink.output_map ?? {};
  const needs = new Set<LatitudeRule>();

  // Every request in this corpus asks for an occasion and leaves the contents
  // of the notice open, so every watch may be reported alongside further facts.
  needs.add("extra-facts");

  if (Object.values(outputMap).some((expression) => String(expression).includes("$fired_by"))) {
    needs.add("node-names");
  }
  return needs;
}

describe("every declared latitude is one the watch could use", () => {
  it.each(watchNames())("%s declares nothing it has no use for", (name) => {
    const declared = new Set((LATITUDES[name] ?? []).map((l) => l.rule));
    const needs = structurallyNeeds(name);

    // `numeric-precision` and `key-vocabulary` depend on what the watch reports
    // and how it keys at replay time, which `score.test.ts` and the entropy
    // guard cover. What is checkable from the definition alone is the pair that
    // is a property of the sink's own text.
    for (const rule of ["node-names", "extra-facts"] as const) {
      expect(
        declared.has(rule),
        rule === "node-names" && needs.has(rule)
          ? `${name}'s sink reads $fired_by, so the comparison will be asked to grade a node name unless it says so`
          : `${name} declares '${rule}' but has nothing for it to excuse`,
      ).toBe(needs.has(rule));
    }
  });

  it("names a watch whose sink reads $fired_by, so the check above is not vacuous", () => {
    const reading = watchNames().filter((name) => structurallyNeeds(name).has("node-names"));
    expect(reading.length, "no watch reports a node name any more — drop the rule").toBeGreaterThan(
      0,
    );
  });
});

describe("every declaration says why, in the request's words", () => {
  it.each(Object.keys(LATITUDES))("%s", (name) => {
    const request = loadWatch(name).nl_query ?? "";
    for (const latitude of LATITUDES[name]!) {
      expect(latitude.because.length, `${name}/${latitude.rule} explains nothing`).toBeGreaterThan(
        30,
      );
      // Every reason has to quote its request. Without that requirement the
      // loop below runs zero times for a reason that quotes nothing, and a
      // third of the table was in exactly that state — "banana banana banana"
      // passed. A quotation is not a proof that the reading is right, but it
      // does force the writer to find the words and a reader to check them.
      const quoted = [...latitude.because.matchAll(/'([^']{8,})'/g)].map((m) => m[1]!);
      expect(
        quoted.length,
        `${name}/${latitude.rule} quotes nothing from its request, so nothing here is checkable`,
      ).toBeGreaterThan(0);
      for (const phrase of quoted) {
        expect(
          request.toLowerCase().includes(phrase.toLowerCase().replace(/[’]/g, "'")) ||
            request.toLowerCase().includes(phrase.toLowerCase()),
          `${name}/${latitude.rule} quotes "${phrase}", which is not in its request`,
        ).toBe(true);
      }
    }
  });

  it("declares nothing for a watch that does not exist", () => {
    const stale = Object.keys(LATITUDES).filter((name) => !watchNames().includes(name));
    expect(stale, "a declaration outlived its watch").toEqual([]);
  });

  it("covers every watch, so nothing is lenient by omission", () => {
    // A watch absent from the table gets the strict reading, which is the safe
    // default — but silently, and a corpus where most watches are missing would
    // report a subsidy of zero for the wrong reason.
    const missing = watchNames().filter((name) => !(name in LATITUDES));
    expect(missing, "these watches declare no latitude at all").toEqual([]);
  });
});
