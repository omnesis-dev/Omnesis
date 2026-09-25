// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening yesterday's install, for the state store.
 *
 * `CREATE TABLE IF NOT EXISTS` is correct on a file that does not exist and a
 * complete no-op on one that does, so a table that gained a column since it
 * shipped has two shapes in the world — and the second one only exists on
 * machines that have already run the software. Every other test here starts
 * from an empty file; the operator's install never does.
 *
 * The fixtures are the `CREATE TABLE` statements this store actually shipped,
 * oldest first. Each is opened by the current store, and the shape that comes
 * out is held against the shape the same store builds from nothing. A column
 * added to {@link SCHEMA} and forgotten in {@link STATE_COLUMN_ADDITIONS} is
 * present on one side and absent on the other.
 *
 * Fixture data is invented — no corpus content.
 */

import DatabaseConstructor, { type Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { addMissingColumns, tableColumns } from "./schema-additions.js";
import { STATE_COLUMN_ADDITIONS, WatchStateStore } from "./state.js";

/** One shape the store has been shipped with, and the tables it wrote. */
interface Generation {
  readonly what: string;
  readonly sql: string;
}

/**
 * Every shape the two tables that have gained columns were shipped with.
 *
 * Only two, and that is a fact about this store's history rather than a
 * convenience: `watch_firings` and `watch_state` are the only tables whose
 * column set has changed since the store first shipped into a gateway. The
 * other nine were built in their current shape, or changed hours after the file
 * was written and days before anything opened it from disk — so no install
 * holds an older one, and there is no older shape to fixture.
 */
const GENERATIONS: readonly Generation[] = [
  {
    what: "the first shape it shipped with",
    sql: `CREATE TABLE watch_firings (
            watch_id     TEXT NOT NULL,
            seq          INTEGER NOT NULL,
            node_id      TEXT NOT NULL,
            key_hash     TEXT NOT NULL,
            fired_at     TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (watch_id, seq, node_id, key_hash)
          );
          CREATE TABLE watch_state (
            watch_id        TEXT PRIMARY KEY,
            active          INTEGER NOT NULL DEFAULT 1,
            next_timer_seq  INTEGER NOT NULL DEFAULT 0
          );`,
  },
  {
    what: "after a firing recorded when the gateway noticed it",
    sql: `CREATE TABLE watch_firings (
            watch_id     TEXT NOT NULL,
            seq          INTEGER NOT NULL,
            node_id      TEXT NOT NULL,
            key_hash     TEXT NOT NULL,
            fired_at     TEXT NOT NULL,
            noticed_at   TEXT,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (watch_id, seq, node_id, key_hash)
          );
          CREATE TABLE watch_state (
            watch_id        TEXT PRIMARY KEY,
            active          INTEGER NOT NULL DEFAULT 1,
            next_timer_seq  INTEGER NOT NULL DEFAULT 0
          );`,
  },
  {
    what: "after a firing recorded the documents behind it",
    sql: `CREATE TABLE watch_firings (
            watch_id      TEXT NOT NULL,
            seq           INTEGER NOT NULL,
            node_id       TEXT NOT NULL,
            key_hash      TEXT NOT NULL,
            fired_at      TEXT NOT NULL,
            noticed_at    TEXT,
            payload_json  TEXT NOT NULL,
            document_ids  TEXT,
            PRIMARY KEY (watch_id, seq, node_id, key_hash)
          );
          CREATE TABLE watch_state (
            watch_id        TEXT PRIMARY KEY,
            active          INTEGER NOT NULL DEFAULT 1,
            next_timer_seq  INTEGER NOT NULL DEFAULT 0,
            failed_seq      INTEGER,
            failed_node     TEXT,
            failed_class    TEXT
          );`,
  },
];

/** The tables the fixtures pre-create, which are the ones at risk. */
const AT_RISK = ["watch_firings", "watch_state"] as const;

let open: Database[] = [];

function db(): Database {
  const made = new DatabaseConstructor(":memory:");
  open.push(made);
  return made;
}

afterEach(() => {
  for (const handle of open) handle.close();
  open = [];
});

function shapeOf(handle: Database): Map<string, string[]> {
  WatchStateStore.on(handle);
  return new Map(AT_RISK.map((table) => [table, [...tableColumns(handle, table)].sort()]));
}

describe("adding what a table is missing", () => {
  it("adds only the columns that are not there", () => {
    const handle = db();
    handle.exec("CREATE TABLE t (a TEXT)");

    addMissingColumns(handle, "t", { a: "TEXT", b: "INTEGER NOT NULL DEFAULT 0" });

    expect([...tableColumns(handle, "t")].sort()).toEqual(["a", "b"]);
  });

  it("changes nothing on a table that already has them", () => {
    // Run on every open, so it has to be free and safe on a current file.
    const handle = db();
    handle.exec("CREATE TABLE t (a TEXT, b INTEGER NOT NULL DEFAULT 0)");
    handle.prepare("INSERT INTO t (a, b) VALUES ('kept', 7)").run();

    addMissingColumns(handle, "t", { a: "TEXT", b: "INTEGER NOT NULL DEFAULT 0" });

    expect(handle.prepare("SELECT a, b FROM t").all()).toEqual([{ a: "kept", b: 7 }]);
  });
});

describe("a state store opened over a file an older build wrote", () => {
  for (const generation of GENERATIONS) {
    it(`reaches the current shape from ${generation.what}`, () => {
      const old = db();
      old.exec(generation.sql);

      expect(shapeOf(old)).toEqual(shapeOf(db()));
    });
  }

  it("declares no addition the current schema has stopped having", () => {
    // The other direction of the same agreement. An entry for a column that
    // has since been renamed or dropped adds it back on every upgraded file,
    // where nothing writes it and nothing reads it, and the two shapes diverge
    // again — this time with the *fresh* file being the odd one out.
    const fresh = db();
    WatchStateStore.on(fresh);
    for (const [table, additions] of Object.entries(STATE_COLUMN_ADDITIONS)) {
      const present = tableColumns(fresh, table);
      for (const column of Object.keys(additions)) {
        expect(
          present,
          `${table}.${column} is an addition the schema no longer declares`,
        ).toContain(column);
      }
    }
  });

  it("adds retry time to a shipped pending-nomination queue", () => {
    const old = db();
    old.exec(`CREATE TABLE pending_nominations (
      watch_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at_ms INTEGER NOT NULL,
      observed_at TEXT,
      PRIMARY KEY (watch_id, node_id, doc_id)
    );
    INSERT INTO pending_nominations
      (watch_id, node_id, doc_id, seq, at_ms, observed_at)
    VALUES ('legacy-watch', 'judge', 'fictional-doc', 7, 1000, NULL)`);

    const upgraded = WatchStateStore.on(old);

    expect([...tableColumns(old, "pending_nominations")]).toContain("retry_at_ms");
    expect(upgraded.pendingNominations("legacy-watch", 10)).toEqual([
      {
        nodeId: "judge",
        docId: "fictional-doc",
        seq: 7,
        atMs: 1000,
        observedAt: null,
        retryAtMs: 0,
      },
    ]);
  });

  it("still records a firing and a failure after the oldest upgrade", () => {
    // Shapes agreeing is necessary and not sufficient: a write naming a column
    // the upgrade added would pass the comparison and fail on first use.
    const old = db();
    old.exec(GENERATIONS[0]!.sql);
    const store = WatchStateStore.on(old);

    store.begin();
    store.recordFiring(
      "w-1",
      1,
      "mail",
      "singleton",
      "2026-03-01T09:00:00.000Z",
      { thread: "a-parcel" },
      "2026-03-01T09:00:01.000Z",
      ["11111111-2222-4333-8444-555555555555"],
    );
    store.commit();
    store.recordFailure("w-1", { seq: 1, nodeId: "mail", failure: "query" });

    expect(store.firings("w-1")[0]?.noticedAt).toBe("2026-03-01T09:00:01.000Z");
    expect(store.failure("w-1")?.failure).toBe("query");
    expect(store.isActive("w-1")).toBe(false);
  });
});
