// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The comparison that decides whether a row is news.
 *
 * Both ways of being wrong are silent. Too sensitive and a source's own
 * bookkeeping wakes a watch every time it runs; too blunt and a real change
 * looks like a redelivery and the watch never speaks at all. Neither raises an
 * error, and only the firings — or their absence — would ever show it.
 */

import { describe, expect, it } from "vitest";

import { hashKey, primaryKeyOf, stableRowHash } from "./row-hash.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const SCHEMA: AnalyticsTableSchema = {
  tableName: "example_activities",
  displayName: "Activities",
  description: "One row per activity",
  columns: [
    { name: "id", type: "VARCHAR", description: "identity" },
    { name: "distance_m", type: "DOUBLE", description: "how far" },
    { name: "notes", type: "VARCHAR", description: "free text", nullable: true },
    { name: "summary_hash", type: "VARCHAR", description: "internal digest", volatile: true },
    { name: "detail_fetched_at", type: "TIMESTAMPTZ", description: "stamp", volatile: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
};

const ROW = {
  id: "a-1",
  distance_m: 10_000,
  notes: "morning",
  summary_hash: "abc",
  detail_fetched_at: "2026-03-01T09:00:00.000Z",
};

describe("what counts as a change", () => {
  it("ignores the columns the source declared as bookkeeping", () => {
    // The observed failure: an enrichment pass clears a fetch stamp and
    // repopulates it, and every pass reads as a change. One activity re-woke a
    // watch twenty-two times in three and a half days this way.
    const churned = { ...ROW, summary_hash: "def", detail_fetched_at: "2026-03-02T04:00:00.000Z" };
    expect(
      stableRowHash(churned, SCHEMA),
      "a bookkeeping column moved and the row read as changed",
    ).toBe(stableRowHash(ROW, SCHEMA));
  });

  it("notices a column that means something", () => {
    expect(
      stableRowHash({ ...ROW, distance_m: 10_001 }, SCHEMA),
      "a meaningful column moved and the row read as unchanged",
    ).not.toBe(stableRowHash(ROW, SCHEMA));
  });

  it("includes a column the schema never mentions", () => {
    // Absence is not a declaration. A source that adds a column and forgets to
    // describe it should produce a spurious update — a noisy watch is a bug
    // someone reports, and a quiet one is a bug nobody sees.
    expect(
      stableRowHash({ ...ROW, brandNew: 1 }, SCHEMA),
      "an undeclared column was treated as bookkeeping",
    ).not.toBe(stableRowHash(ROW, SCHEMA));
  });

  it("does not care what order the columns arrived in", () => {
    const reversed = Object.fromEntries(Object.entries(ROW).reverse());
    expect(
      stableRowHash(reversed, SCHEMA),
      "column order changed the hash, so a rebuilt row reads as changed",
    ).toBe(stableRowHash(ROW, SCHEMA));
  });

  it("does not care how a number was spelled", () => {
    // The same reading arriving as `10000` on one page and `1e4` on the next
    // is not a change, and a hash over the JSON text would say it was.
    expect(
      stableRowHash({ ...ROW, distance_m: 1e4 }, SCHEMA),
      "the same number spelled differently read as a change",
    ).toBe(stableRowHash(ROW, SCHEMA));
  });

  it("sorts nested objects too, so a rebuilt blob is not a change", () => {
    const a = { ...ROW, extra: { b: 2, a: 1 } };
    const b = { ...ROW, extra: { a: 1, b: 2 } };
    expect(
      stableRowHash(a, SCHEMA),
      "a nested object rebuilt in another key order read as a change",
    ).toBe(stableRowHash(b, SCHEMA));
  });

  it("hashes every row when no schema is known, rather than pretending to dedup", () => {
    expect(
      stableRowHash(ROW, undefined),
      "with no schema, two different rows hashed the same",
    ).not.toBe(stableRowHash({ ...ROW, notes: "x" }, undefined));
  });
});

describe("identifying a row", () => {
  it("reads the declared primary key", () => {
    expect(primaryKeyOf(ROW, SCHEMA)).toEqual({ id: "a-1" });
  });

  it("refuses a partial key rather than deduping two rows against each other", () => {
    const composite: Pick<AnalyticsTableSchema, "primaryKey"> = { primaryKey: ["id", "leg"] };
    expect(primaryKeyOf({ id: "a-1" }, composite)).toBeNull();
    expect(primaryKeyOf({ id: "a-1", leg: null }, composite)).toBeNull();
    expect(primaryKeyOf({ id: "a-1", leg: 2 }, composite)).toEqual({ id: "a-1", leg: 2 });
  });

  it("refuses a key value that is not a scalar", () => {
    expect(primaryKeyOf({ id: { nested: true } }, SCHEMA)).toBeNull();
  });

  it("gives one key one digest whatever order its parts were built in", () => {
    expect(hashKey({ id: "a-1", leg: 2 }), "key order changed the digest").toBe(
      hashKey({ leg: 2, id: "a-1" }),
    );
    expect(hashKey({ id: "a-1" }), "two different keys collided").not.toBe(hashKey({ id: "a-2" }));
  });
});
