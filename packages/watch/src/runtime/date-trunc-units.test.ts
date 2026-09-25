// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The units `date_trunc` accepts, asserted across the two halves that have to
 * agree about them.
 *
 * The DSL declares the list so the validator can refuse a unit the runtime
 * would not recognise; the evaluator implements each one. Nothing structural
 * ties the two together, and the drift is dangerous in one direction: a unit
 * declared but not implemented is a watch that validates, runs, and evaluates
 * to null forever — silence indistinguishable from a quiet week. So the
 * agreement is asserted rather than assumed.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { DATE_TRUNC_UNITS } from "../dsl/expression.js";
import { evaluateMap } from "./evaluate.js";

/** One `date_trunc` call over a fixed instant, as a node's output field. */
function truncate(unit: string): unknown {
  return evaluateMap(
    { at: `date_trunc('${unit}', $e.when)` },
    { event: { when: "2026-03-17T09:41:07.000Z" } },
  ).at;
}

describe("the date_trunc units the DSL declares", () => {
  it.each([...DATE_TRUNC_UNITS])("%s is implemented by the evaluator", (unit) => {
    // A declared unit the evaluator does not implement returns null, which the
    // watch carries forward as a field that is simply never set.
    expect(truncate(unit)).not.toBeNull();
  });

  it("truncates to the boundary instant rather than a shortened rendering", () => {
    // The result is compared against SQL's own date_trunc, which yields a date
    // rather than a prefix — `2026-03` is not something a date column can be
    // compared to.
    expect(truncate("year")).toBe("2026-01-01");
    expect(truncate("month")).toBe("2026-03-01");
    expect(truncate("day")).toBe("2026-03-17");
  });

  it("yields nothing for a unit outside the declared set", () => {
    // `week` and `quarter` are legal in the analytics engine's SQL and absent
    // here, which is exactly the mistake the validator's unit check exists to
    // refuse before it becomes a silent null.
    expect(truncate("week")).toBeNull();
    expect(truncate("quarter")).toBeNull();
  });

  it("reads a unit however it is capitalised", () => {
    // The evaluator lowercases before matching. The validator has to accept
    // what the evaluator accepts, or a watch that has been firing correctly is
    // refused — and a refused definition is paused as drifted.
    expect(truncate("Month")).toBe("2026-03-01");
    expect(truncate("MONTH")).toBe("2026-03-01");
  });
});
