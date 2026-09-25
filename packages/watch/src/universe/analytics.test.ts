// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { prepareQuery } from "./analytics.js";

describe("prepareQuery", () => {
  it("rewrites a dotted reference into a name DuckDB will accept", () => {
    const prepared = prepareQuery("SELECT * FROM t WHERE m = $key.month AND d = $n.trip.depart");
    expect(prepared.sql).toBe("SELECT * FROM t WHERE m = $p_key__month AND d = $p_n__trip__depart");
    expect(prepared.parameters.map((p) => p.reference)).toEqual(["$key.month", "$n.trip.depart"]);
  });

  it("casts the evaluation clock so a watch can do interval arithmetic on it", () => {
    const prepared = prepareQuery(
      "SELECT * FROM t WHERE at > $now - INTERVAL 1 YEAR AND d = $today",
    );
    expect(prepared.sql).toContain("CAST($p_now AS TIMESTAMPTZ)");
    expect(prepared.sql).toContain("CAST($p_today AS DATE)");
  });

  it("honours an explicit type hint over the default", () => {
    const prepared = prepareQuery("SELECT $key.day AS d", { "$key.day": "DATE" });
    expect(prepared.sql).toBe("SELECT CAST($p_key__day AS DATE) AS d");
  });

  it("binds a repeated reference once", () => {
    const prepared = prepareQuery("SELECT $today AS a, $today AS b");
    expect(prepared.parameters).toHaveLength(1);
  });

  it("leaves a dollar sign inside a string literal alone", () => {
    const sql = "SELECT * FROM t WHERE note = '$today is not a parameter'";
    const prepared = prepareQuery(sql);
    expect(prepared.sql).toBe(sql);
    expect(prepared.parameters).toEqual([]);
  });

  it("leaves a dollar sign inside a comment alone", () => {
    const sql = "SELECT 1 AS fires -- $now is prose here\nFROM t /* and $today here */";
    const prepared = prepareQuery(sql);
    expect(prepared.parameters).toEqual([]);
  });

  it("survives an unterminated literal without looping", () => {
    expect(() => prepareQuery("SELECT * FROM t WHERE note = 'unterminated")).not.toThrow();
  });

  it("refuses a cast type outside the closed set — it is the one interpolation", () => {
    // The type is the only thing this module puts into a query as text, so a
    // compile-time union is not enough: the hint comes from a caller.
    expect(() => prepareQuery("SELECT $x AS v", { $x: "VARCHAR) OR 1=1 --" as never })).toThrow(
      /not a bindable SQL type/,
    );
    expect(() => prepareQuery("SELECT $x AS v", { $x: "INTEGER" as never })).toThrow();
  });

  it("leaves a dollar-quoted string alone", () => {
    for (const sql of [
      "SELECT $$hello $today world$$ AS s",
      "SELECT $tag$ $today $tag$ AS s",
      "SELECT $$it's fine$$ AS s",
    ]) {
      const prepared = prepareQuery(sql);
      expect(prepared.sql, sql).toBe(sql);
      expect(prepared.parameters, sql).toEqual([]);
    }
  });

  it("leaves a quoted identifier alone, and does not desync on a quote inside one", () => {
    expect(prepareQuery(`SELECT "my$today" FROM t`).parameters).toEqual([]);
    // The apostrophe inside the identifier must not put the lexer into string
    // mode, or the real reference after it would be left un-rewritten.
    const prepared = prepareQuery(`SELECT "a'b" AS x, $today AS d`);
    expect(prepared.parameters.map((p) => p.reference)).toEqual(["$today"]);
    expect(prepared.sql).toContain("CAST($p_today AS DATE)");
  });
});
