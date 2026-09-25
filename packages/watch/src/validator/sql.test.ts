// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { analyzeSql } from "./sql.js";

describe("analyzeSql", () => {
  it("names the tables a simple query reads", () => {
    const analysis = analyzeSql(
      "SELECT sum(amount) > 500 AS fires, sum(amount) AS total FROM plaid_transactions WHERE category LIKE '%Restaurants%'",
    );
    expect(analysis.tables).toEqual(["plaid_transactions"]);
    expect(analysis.outputColumns).toEqual(["fires", "total"]);
    expect(analysis.unaliasedOutputCount).toBe(0);
    expect(analysis.hasFrom).toBe(true);
  });

  it("names every table across a join chain", () => {
    const analysis = analyzeSql(
      "SELECT count(*) > 0 AS fires FROM google_calendar_events e JOIN google_calendar_attendees a ON a.event_id = e.id JOIN people p ON p.id = a.person_id WHERE NOT p.is_self",
    );
    expect(analysis.tables).toEqual([
      "google_calendar_events",
      "google_calendar_attendees",
      "people",
    ]);
  });

  it("does not mistake a CTE name for a catalog table", () => {
    const analysis = analyzeSql(
      "WITH daily AS (SELECT date_trunc('day', start_time) AS day, avg(value) AS rhr FROM health_vitals GROUP BY 1) SELECT count(*) = 7 AS fires, round(avg(rhr), 1) AS avg_hr FROM daily",
    );
    expect(analysis.cteNames).toEqual(["daily"]);
    expect(analysis.tables).toEqual(["health_vitals"]);
    // The outermost SELECT is the node's projection, not the CTE's.
    expect(analysis.outputColumns).toEqual(["fires", "avg_hr"]);
  });

  it("reads the outermost projection across several CTEs", () => {
    const analysis = analyzeSql(
      "WITH nightly AS (SELECT 1 AS a FROM health_sleep), recent AS (SELECT avg(a) AS d FROM nightly), base AS (SELECT avg(a) AS d FROM nightly) SELECT (recent.d < base.d) AS fires, recent.d AS recent_duration FROM recent, base",
    );
    expect(analysis.cteNames).toEqual(["nightly", "recent", "base"]);
    expect(analysis.tables).toEqual(["health_sleep"]);
    expect(analysis.outputColumns).toEqual(["fires", "recent_duration"]);
  });

  it("counts a projected item that declares no alias", () => {
    const analysis = analyzeSql("SELECT avg(value) > 70, avg(value) AS avg_hr FROM health_vitals");
    expect(analysis.unaliasedOutputCount).toBe(1);
    expect(analysis.outputColumns).toEqual(["avg_hr"]);
  });

  it("lets a lone column reference name itself", () => {
    expect(analyzeSql("SELECT fires, t.total FROM t").outputColumns).toEqual(["fires", "total"]);
  });

  it("collects bound parameters without inlining them", () => {
    const analysis = analyzeSql(
      "SELECT sum(amount) > 500 AS fires FROM plaid_transactions WHERE date_trunc('month', date) = $key.month AND date > $today AND account_id = $n.acct.id",
    );
    expect(analysis.parameters.map((p) => p.text)).toEqual(["$key.month", "$today", "$n.acct.id"]);
  });

  it("does not see a dollar sign inside a string literal", () => {
    const analysis = analyzeSql(
      "SELECT true AS fires FROM t WHERE note = '$today is not a parameter'",
    );
    expect(analysis.parameters).toEqual([]);
  });

  it("sees through comments", () => {
    const analysis = analyzeSql(
      "SELECT true AS fires -- FROM documents\nFROM health_vitals /* nor from people */",
    );
    expect(analysis.tables).toEqual(["health_vitals"]);
  });

  it("recognises a FROM-less expression", () => {
    const analysis = analyzeSql(
      "SELECT ($const.passport_expiry < ($n.trip.depart + INTERVAL 6 MONTH)) AS fires",
    );
    expect(analysis.hasFrom).toBe(false);
    expect(analysis.tables).toEqual([]);
    expect(analysis.outputColumns).toEqual(["fires"]);
  });

  it.each([
    ["SELECT 'unterminated AS fires", "unterminated string literal"],
    ["SELECT (1 AS fires", "unbalanced '('"],
    ["SELECT 1) AS fires", "unbalanced ')'"],
    ["SELECT /* unterminated AS fires", "unterminated block comment"],
  ])("reports %s as unparseable", (sql, problem) => {
    expect(analyzeSql(sql).problem).toBe(problem);
  });

  it("keeps reading the FROM list past a subquery item", () => {
    // The `)` closing a subquery is not the end of the FROM clause; a table
    // named after it must still be checked against the catalog.
    expect(analyzeSql("SELECT 1 AS fires FROM (SELECT 1 AS x) a, health_vitals t").tables).toEqual([
      "health_vitals",
    ]);
    expect(
      analyzeSql("SELECT 1 AS fires FROM health_vitals h, (SELECT 1 AS x) a, people c").tables,
    ).toEqual(["health_vitals", "people"]);
  });

  it("sees a CTE declared inside another CTE", () => {
    const analysis = analyzeSql(
      "WITH o AS (WITH i AS (SELECT 1 AS x) SELECT x AS x FROM i) SELECT x > 0 AS fires FROM o",
    );
    expect(analysis.cteNames).toEqual(["o", "i"]);
    expect(analysis.tables).toEqual([]);
  });

  it("sees a CTE that declares a column list", () => {
    const analysis = analyzeSql(
      "WITH t(a, b) AS (SELECT 1 AS a, 2 AS b) SELECT a > 0 AS fires FROM t",
    );
    expect(analysis.cteNames).toEqual(["t"]);
    expect(analysis.tables).toEqual([]);
  });

  it("skips the RECURSIVE modifier rather than binding it as a name", () => {
    const analysis = analyzeSql("WITH RECURSIVE t AS (SELECT 1 AS x) SELECT x > 0 AS fires FROM t");
    expect(analysis.cteNames).toEqual(["t"]);
    expect(analysis.tables).toEqual([]);
  });

  it("names the table, not the schema it is qualified by", () => {
    expect(analyzeSql("SELECT count(*) > 0 AS fires FROM main.health_vitals").tables).toEqual([
      "health_vitals",
    ]);
  });

  it("does not split a projected item on a comma inside a list or struct", () => {
    expect(
      analyzeSql("SELECT [1, 2] AS tags, count(*) > 0 AS fires FROM health_vitals"),
    ).toMatchObject({ outputColumns: ["tags", "fires"], unaliasedOutputCount: 0 });
    expect(
      analyzeSql("SELECT {'a': 1, 'b': 2} AS s, count(*) > 0 AS fires FROM health_vitals"),
    ).toMatchObject({ outputColumns: ["s", "fires"], unaliasedOutputCount: 0 });
  });

  it("reports a statement that is not a SELECT", () => {
    expect(analyzeSql("DELETE FROM health_vitals").problem).toBe("no top-level SELECT");
  });
});

describe("the determinism denylist cannot be stepped around", () => {
  it("sees a quoted function name as the function it calls", () => {
    // `"now"()` and `now()` invoke the same thing. A denylist that reads only
    // bare words would pass the quoted spelling — worse than no denylist,
    // because the query then looks checked.
    expect(analyzeSql(`SELECT "now"() AS fires`).functions).toContain("now");
    expect(analyzeSql("SELECT now() AS fires").functions).toContain("now");
  });

  it("does not treat a quoted identifier as a bare-word pseudo-function", () => {
    // `current_date` bare is a clock read; quoted it is a column name.
    expect(analyzeSql(`SELECT "current_date" FROM t`).functions).not.toContain("current_date");
    expect(analyzeSql("SELECT current_date FROM t").functions).toContain("current_date");
  });

  it("does not invent functions from the object prototype", () => {
    // These resolve on a plain object's prototype chain. The names are real SQL
    // a query could legally use as a quoted identifier.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(analyzeSql(`SELECT "${name}"() AS fires`).functions).toContain(name.toLowerCase());
    }
  });
});
