// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A value binds as what the definition says it is, not as what it looks like.
 *
 * Everything a watch carries between nodes has crossed a journal encoded as
 * JSON, and JSON has no decimal, no date and no interval. So a `DECIMAL(18,4)`
 * column reaches a downstream `sql` node as the string `"-250.7500"`, binds
 * VARCHAR, and `abs($n.spend.amount)` is refused by the binder:
 *
 *     Could not choose a best candidate function for the function call
 *     "abs(STRING_LITERAL)"
 *
 * Refused, not answered wrongly — the node fails and the watch stops, over a
 * column whose declared type said exactly what it was the whole time. The
 * author's only recourse was to cast in their own SQL, which asks them to know
 * that a value which is a decimal in the catalog, in the store, and everywhere
 * they can see it, is text by the time their query binds it.
 *
 * The types were never missing, only unavailable: the validator computes one
 * for every node output in order to check that references resolve. Carrying
 * them into the runtime is the whole fix.
 *
 * The shape of a value is still the fallback, and has to be. A judge returns
 * whatever its `output_schema` declares and a SQL node's own result columns are
 * untyped by the analyzer, so many references genuinely resolve to `unknown` —
 * and the date-shape sniff is what gets a judge's `depart_date` bound as an
 * instant. Where the validator knows, it wins; where it does not, nothing
 * changed.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { CountingJudge, ScriptedRecall } from "./providers.js";
import type { AnalyticsPort } from "./engine.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();

/** One payment on the journal, its values verbatim — as JSON left them. */
function payment(row: Record<string, unknown>): JournalEvent {
  const at = new Date(Date.UTC(2026, 2, 4, 9)).toISOString();
  return {
    seq: 1,
    kind: "analytics.row",
    occurredAt: at,
    observedAt: at,
    payload: {
      op: "inserted",
      table: "plaid_transactions",
      sourceId: "plaid",
      pk: { id: "t-1" },
      row: {
        id: "t-1",
        account_id: "acct-1",
        date: "2026-03-04",
        amount: "-250.7500",
        currency: "GBP",
        merchant_name: "Stellar Sound",
        category: "entertainment",
        pending: false,
        ...row,
      },
    },
  };
}

/**
 * A payment passed through a row node's `output_map` into a `sql` node.
 *
 * The indirection is the point. A row node's own predicate has the table and
 * the column to hand and casts on that basis; one step downstream, all that is
 * left is a field name in an `output_map`, and only the validator's record of
 * what that field resolved to still says it was a decimal.
 */
function spendWatch(query: string): unknown {
  return {
    watch: {
      name: "typed-sql-binding",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes: [
        {
          id: "spend",
          type: "source.analytics_row",
          table: "plaid_transactions",
          op: ["inserted"],
          backfill: "include",
          output_map: { amount: "$e.row.amount", pending: "$e.row.pending", day: "$e.row.date" },
        },
        {
          id: "large",
          type: "sql",
          inputs: { spend: { role: "arm" } },
          query,
          output_map: {},
        },
      ],
      sink: { input: "large", output_map: {} },
    },
  };
}

/**
 * Run against a query-only store, which is the shape the gateway wires: the
 * rows are already there, and the engine only reads.
 */
async function run(query: string, event = payment({}), typed = true): Promise<WatchTrace> {
  const raw = spendWatch(query);
  const result = validateWatch(raw, ontology);
  expect(
    result.valid,
    `fixture must validate: ${result.diagnostics.map((d) => d.code).join(", ")}`,
  ).toBe(true);

  const store = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const readOnly: AnalyticsPort = { query: (sql, values) => store.query(sql, values) };
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal: [event],
      analytics: readOnly,
      // `typed: false` is the runtime as it was — no carriage, every reference
      // bound on its shape. Kept so the tests can show the difference rather
      // than assert the fix against nothing.
      ...(typed && result.types ? { valueTypes: result.types } : {}),
      judge: new CountingJudge(),
      recall: new ScriptedRecall([], 0),
    }).run();
  } finally {
    store.close();
  }
}

describe("a sql node reading a value an upstream node carried", () => {
  it("does arithmetic on a decimal without the author casting it", async () => {
    // The live failure, exactly. `abs()` over a value bound as text has no
    // candidate the binder can choose.
    const trace = await run("SELECT abs($n.spend.amount) > 100 AS fires");
    expect(
      trace.records.some((r) => r.transition === "failed"),
      "the node failed",
    ).toBe(false);
    expect(trace.firings.length, "the query did not fire on a 250.75 spend").toBe(1);
  });

  it("cannot answer the same query untyped", async () => {
    // The same watch and the same row with the type carriage withheld, so the
    // test above cannot pass for some reason other than the one it claims.
    const trace = await run("SELECT abs($n.spend.amount) > 100 AS fires", payment({}), false);
    const failure = trace.records.find((r) => r.transition === "failed");
    expect(failure, "an untyped binding no longer fails, so this proves nothing").toBeDefined();
    expect(failure?.failure).toBe("query");
  });

  it("compares by magnitude rather than by lexicographic order", async () => {
    // As text "-9.5000" sorts after "-250.7500"; as numbers it does not. A
    // binding that merely stopped throwing could still answer this wrongly.
    const small = await run(
      "SELECT abs($n.spend.amount) > 100 AS fires",
      payment({ amount: "-9.5000" }),
    );
    expect(small.firings.length, "9.5 was read as larger than 100").toBe(0);
    expect(
      small.records.some((r) => r.transition === "failed"),
      "the silence came from a failed node rather than from a decision",
    ).toBe(false);
  });

  it("leaves an author's own cast working", async () => {
    // The workaround this replaces is in live watch files, and must keep
    // working — a fix that forces every author to go back and edit is a
    // migration, not a fix.
    const trace = await run("SELECT abs(CAST($n.spend.amount AS DECIMAL(18,4))) > 100 AS fires");
    expect(trace.firings.length).toBe(1);
  });

  it("binds a boolean as one, so a bare reference is a condition", async () => {
    const held = await run("SELECT $n.spend.pending AS fires", payment({ pending: false }));
    expect(held.firings.length).toBe(0);
    const fired = await run("SELECT $n.spend.pending AS fires", payment({ pending: true }));
    expect(fired.firings.length, "a declared boolean did not bind as one").toBe(1);
  });

  it("binds a date as one, so interval arithmetic works on it", async () => {
    // `DATE` is the other type JSON cannot carry, and the one a windowed watch
    // reaches for constantly.
    const trace = await run("SELECT $n.spend.day + INTERVAL 1 DAY > DATE '2026-03-04' AS fires");
    expect(trace.firings.length, "a declared date did not bind as one").toBe(1);
  });

  it("carries a null through as the type it would have held", async () => {
    // A column may legitimately be absent from a row. Binding NULL with its
    // declared type keeps the query answerable — the comparison is unknown, the
    // node holds, and nothing fails.
    const trace = await run(
      "SELECT abs($n.spend.amount) > 100 AS fires",
      payment({ amount: null }),
    );
    expect(
      trace.records.some((r) => r.transition === "failed"),
      "a null broke the query",
    ).toBe(false);
    expect(trace.firings.length).toBe(0);
  });
});

describe("a reference the validator could not type", () => {
  it("still binds on its shape, which is all there is to go on", async () => {
    // A SQL node's own result columns are untyped by the analyzer, so a
    // reference into one resolves to `unknown`. The date-shape sniff is the
    // only thing that gets those bound as instants, and removing it would have
    // broken every watch that compares one.
    const raw = {
      watch: {
        name: "untyped-reference",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "spend",
            type: "source.analytics_row",
            table: "plaid_transactions",
            op: ["inserted"],
            backfill: "include",
            output_map: { when: "$e.row.date" },
          },
          {
            id: "judged",
            type: "llm",
            mode: "judge",
            inputs: { spend: { role: "arm" } },
            proposition: "This payment is worth asking about",
            output_schema: { depart_date: "string" },
            on_collision: "reset",
            deadline: "1 days",
          },
          {
            id: "soon",
            type: "sql",
            inputs: { judged: { role: "arm" } },
            query: "SELECT $n.judged.depart_date < DATE '2027-01-01' AS fires",
            output_map: {},
          },
        ],
        sink: { input: "soon", output_map: {} },
      },
    };
    const result = validateWatch(raw, ontology);
    expect(
      result.valid,
      `fixture must validate: ${result.diagnostics.map((d) => d.code).join(", ")}`,
    ).toBe(true);

    const store = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const readOnly: AnalyticsPort = { query: (sql, values) => store.query(sql, values) };
    try {
      const trace = await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        ontology,
        journal: [payment({})],
        analytics: readOnly,
        ...(result.types ? { valueTypes: result.types } : {}),
        judge: {
          judge: () => ({ fired: true, output: { depart_date: "2026-06-01" } }),
        },
        recall: new ScriptedRecall([], 0),
      }).run();
      expect(
        trace.records.some((r) => r.transition === "failed"),
        "a date declared only as a string stopped binding as a date",
      ).toBe(false);
      expect(trace.firings.length).toBe(1);
    } finally {
      store.close();
    }
  });
});
