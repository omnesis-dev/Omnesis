// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { sourceIdAddresses } from "@omnesis/types";
import { sourcePrefixPredicate, sourceMatchesAnyPrefix } from "./source-addressing.js";

/**
 * Every id in this corpus is a name one half could plausibly get wrong: a type
 * that is a string-prefix of another, an account holding LIKE's two wildcards,
 * an account holding the separator the rule splits on, and the escape
 * character itself.
 */
const IDS = [
  "gmail",
  "gmail:someone@example.com",
  "gmail:a_b@example.com",
  "gmail:100%@example.com",
  "gmail:back\\slash@example.com",
  "gmail:someone@example.com:extra",
  "gmail-archive",
  "gmail-archive:someone@example.com",
  "gmailx:someone@example.com",
  "web",
  "web:local",
];

function evaluateInSqlite(prefixes: readonly string[], ids: readonly string[]): Set<string> {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE documents (source_id TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO documents (source_id) VALUES (?)");
  for (const id of ids) insert.run(id);
  const predicate = sourcePrefixPredicate("source_id", prefixes);
  const rows = db
    .prepare<
      unknown[],
      { source_id: string }
    >(`SELECT source_id FROM documents WHERE ${predicate.sql}`)
    .all(...predicate.params);
  db.close();
  return new Set(rows.map((row) => row.source_id));
}

describe("sourcePrefixPredicate", () => {
  it("selects in SQLite exactly what the in-memory rule selects", () => {
    // Every id is also used as a name, so each of the two halves is asked
    // about every pairing the other is asked about.
    for (const prefix of IDS) {
      const selected = evaluateInSqlite([prefix], IDS);
      const expected = new Set(IDS.filter((id) => sourceIdAddresses(prefix, id)));
      expect(selected, `naming ${prefix}`).toEqual(expected);
    }
  });

  it("agrees with its in-memory twin on a multi-name list", () => {
    const prefixes = ["gmail", "web:local", "gmail-archive:someone@example.com"];
    const selected = evaluateInSqlite(prefixes, IDS);
    const expected = new Set(IDS.filter((id) => sourceMatchesAnyPrefix(id, prefixes)));
    expect(selected).toEqual(expected);
    // Spelled out, so the test states the rule rather than only cross-checking
    // two implementations that could drift together.
    expect(selected).toEqual(
      new Set([
        "gmail",
        "gmail:someone@example.com",
        "gmail:a_b@example.com",
        "gmail:100%@example.com",
        "gmail:back\\slash@example.com",
        "gmail:someone@example.com:extra",
        "web:local",
        "gmail-archive:someone@example.com",
      ]),
    );
  });

  it("names nothing when given no names, rather than everything", () => {
    expect(evaluateInSqlite([], IDS)).toEqual(new Set());
    expect(sourcePrefixPredicate("source_id", []).sql).toBe("0");
  });

  it("does not let a qualified name reach a sibling account", () => {
    // `gmail:someone@example.com:extra` is account `someone@example.com:extra`
    // — a different account — so naming the shorter id must not select it.
    const selected = evaluateInSqlite(["gmail:someone@example.com"], IDS);
    expect(selected).toEqual(new Set(["gmail:someone@example.com"]));
  });

  it("stays one term when spliced after AND", () => {
    // The caller writes `WHERE <something> AND <clause>`. An unbracketed
    // `a OR b` binds as `(<something> AND a) OR b` there, and the second name
    // then selects rows the caller's own filter excluded.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE documents (source_id TEXT NOT NULL, kept INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO documents (source_id, kept) VALUES (?, ?)");
    insert.run("gmail:someone@example.com", 1);
    insert.run("web:local", 0);
    const predicate = sourcePrefixPredicate("source_id", ["gmail", "web:local"]);
    const rows = db
      .prepare<
        unknown[],
        { source_id: string }
      >(`SELECT source_id FROM documents WHERE kept = 1 AND ${predicate.sql}`)
      .all(...predicate.params);
    db.close();

    expect(rows.map((row) => row.source_id)).toEqual(["gmail:someone@example.com"]);
  });

  it("does not let a name's own wildcards widen it", () => {
    const ids = ["a_b", "a_b:one@example.com", "axb:one@example.com", "a%c:one@example.com"];
    expect(evaluateInSqlite(["a_b"], ids)).toEqual(new Set(["a_b", "a_b:one@example.com"]));
  });
});
