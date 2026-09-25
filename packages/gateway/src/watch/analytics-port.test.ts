// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The port the runtime actually queries through, held to the contract.
 *
 * There are two implementations of `AnalyticsPort` in the tree: the package's
 * own, over a DuckDB file, and this one, over the gateway's analytics sandbox.
 * They must agree about what a bound value means, because the same watch runs
 * on both — a replay reaching a different answer than the host is the property
 * every golden trace rests on.
 *
 * The one that is easy to get wrong is the type. A value that has crossed the
 * journal has been through JSON, which has no decimal and no date, so a
 * `DECIMAL(18,4)` arrives as a string. The engine says what it should bind as
 * by wrapping it; a port that unwraps the wrapper and keeps only the value
 * emits a statement with no cast, and the binder refuses arithmetic on text.
 * That is invisible from the engine's side and invisible from a suite that
 * exercises the other implementation.
 */

import { describe, expect, it } from "vitest";

import { analyticsPortFor } from "./engine-task.js";
import type { AnalyticsDb } from "../analytics-db.js";

/** An analytics store that records the statement it was handed. */
function recordingDb(): { db: AnalyticsDb; statements: string[] } {
  const statements: string[] = [];
  const db = {
    executeQuery: (sql: string) => {
      statements.push(sql);
      return Promise.resolve({ columns: ["fires"], rows: [[true]] });
    },
  } as unknown as AnalyticsDb;
  return { db, statements };
}

describe("a value the engine typed", () => {
  it("reaches the store with the cast it asked for", async () => {
    // The motivating case: `abs()` over a decimal that arrived as a string.
    // Without the cast DuckDB has no candidate to choose and refuses outright,
    // which stops the watch rather than answering it wrongly.
    const { db, statements } = recordingDb();
    await analyticsPortFor(db).query("SELECT abs($n.spend.amount) > 100 AS fires", {
      "$n.spend.amount": { sqlType: "DOUBLE", value: "-250.7500" },
    });

    expect(statements[0], "the type the engine asked for was discarded").toContain("AS DOUBLE");
  });

  it("still binds the value rather than writing it into the statement", async () => {
    // The cast must not become a second way for corpus content to reach SQL
    // text. Only the type name is interpolated; the value is a parameter.
    const { db, statements } = recordingDb();
    await analyticsPortFor(db).query("SELECT $n.spend.merchant = 'x' AS fires", {
      "$n.spend.merchant": "'; DROP TABLE plaid_transactions; --",
    });

    expect(statements[0]).not.toContain("DROP TABLE");
  });

  it("leaves an untyped value alone", async () => {
    // A judge's output and a SQL node's own result columns are untyped, and
    // casting them to something would be inventing a type nobody declared.
    const { db, statements } = recordingDb();
    await analyticsPortFor(db).query("SELECT $n.judged.note = 'x' AS fires", {
      "$n.judged.note": "anything",
    });

    expect(statements[0]).not.toContain("CAST");
  });

  it("gives the evaluation clock its own types without being told", async () => {
    const { db, statements } = recordingDb();
    await analyticsPortFor(db).query("SELECT $today > DATE '2026-01-01' AS fires", {
      $today: "2026-03-04",
    });

    expect(statements[0]).toContain("AS DATE");
  });

  it("refuses a query whose binding nothing supplied", async () => {
    // Silently binding null would answer the predicate rather than refusing it,
    // and a watch would report a decision made against a value it never had.
    const { db } = recordingDb();
    await expect(
      analyticsPortFor(db).query("SELECT $n.spend.amount > 1 AS fires", {}),
    ).rejects.toThrow(/nothing supplied it/);
  });

  it("says so when the install has no analytics store at all", async () => {
    await expect(analyticsPortFor(null).query("SELECT 1 AS fires", {})).rejects.toThrow(
      /no analytics database/,
    );
  });
});
