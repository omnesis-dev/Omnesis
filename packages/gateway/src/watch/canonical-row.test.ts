// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { canonicalizeDeclaredTemporals } from "./canonical-row.js";
import { stableRowHash } from "./row-hash.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * A table declaring one of each temporal type, plus an undeclared-in-schema
 * companion, which is the case the "absence is not a declaration" rule covers.
 */
const schema = {
  columns: [
    { name: "id", type: "BIGINT" },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "local_clock", type: "TIMESTAMP" },
    { name: "on_day", type: "DATE" },
    { name: "label", type: "VARCHAR" },
  ],
} as unknown as Pick<AnalyticsTableSchema, "columns">;

describe("canonicalizing declared temporal columns", () => {
  test("the same instant in two spellings becomes one row", () => {
    // The pair a live install produced: what a provider wrote, and what the
    // store handed back to the phase that re-read it.
    const written = canonicalizeDeclaredTemporals(
      { id: 1, started_at: "2026-07-31T14:09:00Z", label: "x" },
      schema,
    );
    const readBack = canonicalizeDeclaredTemporals(
      { id: 1, started_at: "2026-07-31 15:09:00+01", label: "x" },
      schema,
    );
    expect(readBack.started_at).toBe(written.started_at);
    expect(written.started_at).toBe("2026-07-31T14:09:00.000Z");
  });

  test("so the dedup hash cannot see a change the clock did not make", () => {
    // The property the whole module exists for. Hashing the raw rows is what
    // manufactured an `updated` event out of a re-spelling.
    const raw = [
      { id: 1, started_at: "2026-07-31T14:09:00Z" },
      { id: 1, started_at: "2026-07-31 15:09:00+01" },
    ];
    expect(stableRowHash(raw[0], schema)).not.toBe(stableRowHash(raw[1], schema));
    const canonical = raw.map((row) => canonicalizeDeclaredTemporals(row, schema));
    expect(stableRowHash(canonical[0], schema)).toBe(stableRowHash(canonical[1], schema));
  });

  test("a genuinely different instant still hashes differently", () => {
    // The guard against over-collapsing: if this ever passed, a real change
    // would stop producing an event at all.
    const a = canonicalizeDeclaredTemporals({ id: 1, started_at: "2026-07-31T14:09:00Z" }, schema);
    const b = canonicalizeDeclaredTemporals({ id: 1, started_at: "2026-07-31T14:09:01Z" }, schema);
    expect(stableRowHash(a, schema)).not.toBe(stableRowHash(b, schema));
    const shifted = canonicalizeDeclaredTemporals(
      { id: 1, started_at: "2026-07-31 15:09:00+02" },
      schema,
    );
    expect(shifted.started_at).not.toBe(a.started_at);
  });

  test("a zoneless column keeps its digits and loses the designator", () => {
    // Honouring a designator here would move a wall-clock reading to a
    // different wall clock — the column was declared without a zone.
    const withZ = canonicalizeDeclaredTemporals({ local_clock: "2026-07-31T14:09:00Z" }, schema);
    const bare = canonicalizeDeclaredTemporals({ local_clock: "2026-07-31 14:09:00" }, schema);
    const offset = canonicalizeDeclaredTemporals({ local_clock: "2026-07-31 14:09:00+01" }, schema);
    expect(withZ.local_clock).toBe("2026-07-31T14:09:00.000");
    expect(bare.local_clock).toBe(withZ.local_clock);
    expect(offset.local_clock).toBe(withZ.local_clock);
  });

  test("a day is a day however the store renders it", () => {
    const bare = canonicalizeDeclaredTemporals({ on_day: "2026-07-31" }, schema);
    const withTime = canonicalizeDeclaredTemporals({ on_day: "2026-07-31 00:00:00" }, schema);
    expect(bare.on_day).toBe("2026-07-31");
    expect(withTime.on_day).toBe("2026-07-31");
  });

  test("only declared temporal columns are touched", () => {
    // A string that happens to look like a timestamp in a VARCHAR column is
    // the source's data, not a reading to re-spell.
    const out = canonicalizeDeclaredTemporals(
      { id: 1, label: "2026-07-31 15:09:00+01", undeclared: "2026-07-31 15:09:00+01" },
      schema,
    );
    expect(out.label).toBe("2026-07-31 15:09:00+01");
    expect(out.undeclared).toBe("2026-07-31 15:09:00+01");
  });

  test("an unparseable value is kept, not dropped", () => {
    // Refusing to canonicalize costs a spelling; nulling would cost the reading.
    const out = canonicalizeDeclaredTemporals({ started_at: "sometime last Tuesday" }, schema);
    expect(out.started_at).toBe("sometime last Tuesday");
  });

  test("null and undefined pass through untouched", () => {
    const out = canonicalizeDeclaredTemporals({ started_at: null, local_clock: undefined }, schema);
    expect(out.started_at).toBeNull();
    expect(out.local_clock).toBeUndefined();
  });

  test("a row needing no rewrite is returned as-is", () => {
    // Cheap enough to run on every row of every page only if the common case
    // allocates nothing.
    const row = { id: 1, started_at: "2026-07-31T14:09:00.000Z", label: "x" };
    expect(canonicalizeDeclaredTemporals(row, schema)).toBe(row);
  });

  test("does not mutate the row it was given", () => {
    // The caller keeps the queued entry; rewriting it in place would change
    // what a retry or a later reader sees.
    const row = { id: 1, started_at: "2026-07-31 15:09:00+01" };
    const out = canonicalizeDeclaredTemporals(row, schema);
    expect(row.started_at).toBe("2026-07-31 15:09:00+01");
    expect(out.started_at).toBe("2026-07-31T14:09:00.000Z");
  });

  test("a table with no schema is left alone", () => {
    const row = { started_at: "2026-07-31 15:09:00+01" };
    expect(canonicalizeDeclaredTemporals(row, undefined)).toBe(row);
    expect(canonicalizeDeclaredTemporals(row, { columns: [] })).toBe(row);
  });
});
