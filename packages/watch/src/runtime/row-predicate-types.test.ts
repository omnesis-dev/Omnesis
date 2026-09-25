// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A row that has been through JSON no longer knows what it is.
 *
 * The analytics catalog declares what each column holds — `DECIMAL(18,4)` for a
 * payment amount, `BOOLEAN` for a pending flag — but the row reaches a watch as
 * a journal payload, and JSON has no decimal. A `DECIMAL` arrives as a string,
 * a `BIGINT` past the safe-integer range arrives as a string, and so does
 * anything a driver serializes rather than narrow.
 *
 * The predicate is then evaluated by projecting those values back into a
 * one-row query. Bound bare, a parameter holding `"12.5"` is a VARCHAR, and
 * `amount < 0` is a comparison the binder refuses outright rather than a
 * question it answers wrongly. The node fails, and the watch pauses — over a
 * column whose declared type said exactly what it was the whole time.
 *
 * So each value is cast to its declared type on the way in. These tests hold
 * that line for the types JSON cannot carry, and hold the other half too: a
 * value that genuinely does not fit its column must still fail loudly, because
 * reading it as NULL would answer the predicate `false` and call that a result.
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

/**
 * One payment on the journal, with the row's values supplied verbatim.
 *
 * Deliberately untyped: the point of every test here is what happens when a
 * value arrives as something other than what its column declares.
 */
function rowEvent(table: string, row: Record<string, unknown>): JournalEvent {
  const at = new Date(Date.UTC(2026, 2, 4, 9)).toISOString();
  return {
    seq: 1,
    kind: "analytics.row",
    occurredAt: at,
    observedAt: at,
    payload: {
      op: "inserted",
      table,
      sourceId: "plaid",
      pk: { id: "t-1" },
      row,
    },
  };
}

/** A payment row, its declared values overridable one at a time. */
function payment(row: Record<string, unknown>): JournalEvent {
  return rowEvent("plaid_transactions", {
    id: "t-1",
    account_id: "acct-1",
    date: "2026-03-04",
    amount: "12.5000",
    currency: "GBP",
    merchant_name: "Stellar Sound",
    category: "entertainment",
    pending: false,
    ...row,
  });
}

function watching(predicate: string, table = "plaid_transactions"): unknown {
  return {
    watch: {
      name: "typed-row-predicate",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes: [
        {
          id: "payment",
          type: "source.analytics_row",
          table,
          op: ["inserted"],
          predicate,
          backfill: "include",
          output_map: { id: "$e.row.id" },
        },
      ],
      sink: { input: "payment", output_map: { id: "$n.payment.id" } },
    },
  };
}

/**
 * Run against a **query-only** store, which is the shape the gateway wires.
 *
 * A store built by replaying the journal writes each row in as the engine walks
 * past it, and its insert refuses a value that does not fit its column before
 * any predicate is reached. The live store is not built that way: the rows are
 * already in it, the engine only reads, and the predicate is the first thing
 * the arriving row meets. Running these against the replay store would move
 * every failure upstream of the code under test and prove nothing about it.
 */
async function run(predicate: string, event: JournalEvent): Promise<WatchTrace> {
  if (event.kind !== "analytics.row") throw new Error("these tests are about analytics rows");
  const raw = watching(predicate, event.payload.table);
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
      judge: new CountingJudge(),
      recall: new ScriptedRecall([], 0),
    }).run();
  } finally {
    store.close();
  }
}

describe("a predicate over a row whose types JSON could not carry", () => {
  it("compares a DECIMAL that arrived as a string", async () => {
    // The live shape: a `DECIMAL(18,4)` serialized to preserve its precision.
    // Bound bare this is a VARCHAR, and the binder refuses `< 100` on it.
    const trace = await run("amount < 100", payment({ amount: "12.5000" }));
    expect(trace.firings.length, "a stringified decimal did not compare as a number").toBe(1);
  });

  it("decides a DECIMAL comparison by magnitude, not by lexicographic order", async () => {
    // As text, "900.0000" and "9.0000" order the same way; as numbers they do
    // not. Asserted as a firing rather than a silence, because a node that
    // failed also produces no firing — a test that only counted zero would
    // score the feature's absence as a pass.
    const large = await run("amount > 100", payment({ amount: "900.0000" }));
    expect(large.firings.length, "a stringified decimal did not compare as a number").toBe(1);

    const small = await run("amount > 100", payment({ amount: "9.0000" }));
    expect(small.firings.length, "9 was read as greater than 100").toBe(0);
    expect(
      small.records.some((r) => r.transition === "failed"),
      "the silence came from a failed node rather than from a decision",
    ).toBe(false);
  });

  it("compares an INTEGER that arrived as a string", async () => {
    // The live case this stands for: a call that was never picked up, whose
    // `duration_seconds` a driver handed over as text. An ordering comparison
    // rather than an equality one — DuckDB will equate '0' with 0 uncast, so
    // only the ordering says whether the value is a number here.
    const trace = await run(
      "duration_seconds < 30",
      rowEvent("apple_call_log", {
        id: "c-1",
        counterparty: "+15550100999",
        direction: "incoming",
        start_time: new Date(Date.UTC(2026, 2, 4, 9)).toISOString(),
        duration_seconds: "0",
      }),
    );
    expect(trace.firings.length, "a stringified integer did not compare as a number").toBe(1);
  });

  it("reads a BOOLEAN that arrived as a string", async () => {
    const trace = await run("pending = false", payment({ pending: "false" }));
    expect(trace.firings.length, "a stringified boolean did not read as a boolean").toBe(1);
  });

  it("reads a BOOLEAN that arrived as a number", async () => {
    // The quietest of these: bound bare, `pending` is the number 1, the
    // predicate evaluates to 1 rather than to `true`, and a firing that turns
    // on `fires === true` never happens. No error, no trace, no watch — just a
    // condition that is never met.
    const trace = await run("pending", payment({ pending: 1 }));
    expect(trace.firings.length, "a numeric boolean did not read as true").toBe(1);
  });

  it("compares a DATE that arrived as a string", async () => {
    const trace = await run("date < DATE '2026-04-01'", payment({ date: "2026-03-04" }));
    expect(trace.firings.length, "a stringified date did not compare as a date").toBe(1);
  });

  it("still compares a value that arrived with its type intact", async () => {
    // A value that needs no repair must come through unchanged.
    const trace = await run("amount < 100", payment({ amount: 12.5 }));
    expect(trace.firings.length, "casting broke a value that needed no casting").toBe(1);
  });

  it("casts by column name, not by the order the row's keys arrive in", async () => {
    // A journal row is JSON, and its key order is whatever the source emitted —
    // a record that omits an optional field shifts every key after it. Reading
    // the declared types positionally would work on every fixture written in
    // declared order and mis-type the first real row that was not.
    const trace = await run(
      "amount < 100",
      rowEvent("plaid_transactions", {
        amount: "12.5000",
        id: "t-1",
        account_id: "acct-1",
        date: "2026-03-04",
        currency: "GBP",
        merchant_name: "Stellar Sound",
        category: "entertainment",
        pending: false,
      }),
    );
    expect(trace.firings.length, "the declared type was read by position").toBe(1);
  });
});

describe("a row that omits a declared column", () => {
  it("can still be asked about that column", async () => {
    // Records are written under the keys the first one carried, so a record
    // that left an optional field out reaches the journal with no such key.
    // Projecting only what is present leaves the predicate unable to bind —
    // and an unbindable predicate fails the node and pauses the watch for as
    // long as that column stays absent.
    const partial = payment({});
    if (partial.kind !== "analytics.row") throw new Error("fixture must be an analytics row");
    delete (partial.payload.row as Record<string, unknown>).merchant_name;

    const trace = await run("merchant_name IS NULL AND amount < 100", partial);
    expect(trace.firings.length, "an absent declared column did not read as NULL").toBe(1);
    expect(
      trace.records.some((r) => r.transition === "failed"),
      "the predicate could not bind the column the row omitted",
    ).toBe(false);
  });
});

describe("the statement the projection builds", () => {
  it("casts every declared column to its declared type, by name", async () => {
    // Asserted directly rather than through its effect: the tests above sample
    // the behaviour one type at a time, and this pins the whole contract —
    // which columns are projected, what each is cast to, and that the aliases
    // are quoted.
    let statement = "";
    const store = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const spy: AnalyticsPort = {
      query: (sql, values) => {
        statement = sql;
        return store.query(sql, values);
      },
    };
    const raw = watching("amount < 100");
    try {
      await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        ontology,
        journal: [payment({})],
        analytics: spy,
        judge: new CountingJudge(),
        recall: new ScriptedRecall([], 0),
      }).run();
    } finally {
      store.close();
    }

    expect(statement).toContain(`CAST($c3 AS DECIMAL(18,4)) AS "amount"`);
    expect(statement).toContain(`CAST($c0 AS VARCHAR) AS "id"`);
    expect(statement).toContain(`CAST($c2 AS DATE) AS "date"`);
    expect(statement).toContain(`CAST($c7 AS BOOLEAN) AS "pending"`);
  });
});

describe("a row that disagrees with its declared column type", () => {
  it("fails the node rather than reading the value as absent", async () => {
    // TRY_CAST would make this NULL, the predicate false, and the watch silent
    // — a wrong answer presented as a decision. A watch that pauses with the
    // cast error is one whose operator finds out.
    const trace = await run("amount < 100", payment({ amount: "not-a-number" }));
    expect(trace.firings.length, "an uncastable value was quietly read as no match").toBe(0);
    const failure = trace.records.find((r) => r.transition === "failed");
    expect(failure?.detail ?? "", "the failure did not name the conversion that broke").toContain(
      "DECIMAL(18,4)",
    );
    // A watch may hold several row nodes over different tables, so the record
    // has to say which one to go and look at.
    expect(failure?.nodeId, "the failure did not name the node it happened in").toBe("payment");
  });
});

describe("a column the table does not declare", () => {
  it("is still projected, so a predicate may be about it", async () => {
    // There is no declared type to cast to, so the value is bound as it
    // arrives. The ontology is a snapshot refreshed on an interval, so a row
    // can legitimately carry a column newer than the snapshot describing it.
    const trace = await run("extra_note = 'flagged'", payment({ extra_note: "flagged" }));
    expect(trace.firings.length, "an undeclared column stopped being projected").toBe(1);
  });
});
