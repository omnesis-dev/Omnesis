// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the validator will and will not accept as a `date_trunc` call.
 *
 * The function's result type is `TIMESTAMP` whatever it is handed, so nothing
 * downstream notices a nonsense call: the runtime returns null for a unit it
 * cannot read and null for a value that is not an instant, and the watch runs
 * for weeks reporting nothing. Refusing the call is the only place that silence
 * can be turned into a sentence.
 *
 * The boundary cuts both ways, and the second direction is the sharper one:
 * every stored definition is re-validated as it runs, and one that fails is
 * paused as drifted. A rule stricter than the runtime therefore stops a watch
 * that has been firing correctly — so the accepting cases below matter as much
 * as the refusing ones.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "./validate.js";

const ontology = loadOntology();

/** A one-node watch whose only interesting part is the expression under test. */
function watchWith(expression: string): unknown {
  return {
    watch: {
      name: "a-watch",
      firing_policy: "stays_active",
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { at: expression },
        },
        {
          id: "gate",
          type: "stateless.transform",
          inputs: { mail: { role: "arm" } },
          query: "SELECT true AS fires",
        },
      ],
      sink: { input: "gate" },
    },
  };
}

function codesFor(expression: string): string[] {
  return validateWatch(watchWith(expression), ontology)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

describe("date_trunc's unit", () => {
  it("accepts every unit the runtime implements", () => {
    for (const unit of ["year", "month", "day", "hour", "minute"]) {
      expect(codesFor(`date_trunc('${unit}', $e.semanticTime)`), unit).toEqual([]);
    }
  });

  it("accepts a unit however it is capitalised, because the runtime does", () => {
    // The one shape of this check that would be a regression rather than a
    // fix: a watch firing correctly on 'Month' must not be paused for it.
    expect(codesFor("date_trunc('Month', $e.semanticTime)")).toEqual([]);
    expect(codesFor("date_trunc('MONTH', $e.semanticTime)")).toEqual([]);
  });

  it("refuses a unit the runtime would silently return nothing for", () => {
    // `week` and `quarter` are legal in the analytics engine's SQL, which is
    // where an author reaches for them; here they are a null forever.
    expect(codesFor("date_trunc('week', $e.semanticTime)")).toContain("EXPRESSION_DATE_TRUNC_UNIT");
    expect(codesFor("date_trunc('quarter', $e.semanticTime)")).toContain(
      "EXPRESSION_DATE_TRUNC_UNIT",
    );
  });

  it("refuses a unit that is not a written-down word", () => {
    for (const unit of ["''", "$e.title", "3", "true"]) {
      expect(codesFor(`date_trunc(${unit}, $e.semanticTime)`), unit).toContain(
        "EXPRESSION_DATE_TRUNC_UNIT",
      );
    }
  });

  it("names what the author wrote rather than an internal category", () => {
    const [diagnostic] = validateWatch(
      watchWith("date_trunc('week', $e.semanticTime)"),
      ontology,
    ).diagnostics.filter((d) => d.code === "EXPRESSION_DATE_TRUNC_UNIT");
    expect(diagnostic?.details).toMatchObject({ got: "week" });
  });
});

describe("date_trunc's value", () => {
  it("accepts the shapes an instant genuinely arrives as", () => {
    // A timestamp; a metadata field, which the ontology types `string`
    // whatever it holds; and a SQL result column, whose type nobody can know
    // without running the query.
    expect(codesFor("date_trunc('day', $e.semanticTime)")).toEqual([]);
    expect(codesFor("date_trunc('day', $e.metadata.extra.threadId)")).toEqual([]);
  });

  it("refuses an id, which never has an instant in it", () => {
    expect(codesFor("date_trunc('day', $e.docId)")).toContain("EXPRESSION_DATE_TRUNC_VALUE");
  });

  it("refuses a value that is not scalar at all", () => {
    expect(codesFor("date_trunc('day', $e.contentChanged)")).toContain(
      "EXPRESSION_DATE_TRUNC_VALUE",
    );
    expect(codesFor("date_trunc('day', $e.changedFields)")).toContain(
      "EXPRESSION_DATE_TRUNC_VALUE",
    );
  });

  it("reads a merge the same way whichever order its branches are written", () => {
    // `coalesce` yields one of its branches, so a merge of an instant and a
    // document id could hand back either and its type is `unknown` — which
    // this check accepts, because unknown is what a SQL column is too.
    //
    // The property worth pinning is that both spellings agree. Typing the
    // merge as its FIRST branch is the alternative, and it makes the argument
    // order decide the verdict: one spelling of a single mistake refused, the
    // other waved through.
    const idFirst = codesFor("date_trunc('day', coalesce($e.docId, $e.semanticTime))");
    const instantFirst = codesFor("date_trunc('day', coalesce($e.semanticTime, $e.docId))");
    expect(idFirst).toEqual(instantFirst);
  });

  it("still accepts a merge whose branches agree", () => {
    expect(codesFor("date_trunc('day', coalesce($e.semanticTime, $e.semanticTime))")).toEqual([]);
  });
});
