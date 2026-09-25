// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening yesterday's install.
 *
 * Every other test in this repo boots a store into a fresh temp file, which is
 * the one thing the operator's install never does. A watch store builds itself
 * with `CREATE TABLE IF NOT EXISTS`: correct on a file that does not exist,
 * and a complete no-op on one that does. So a table that gained a column since
 * it shipped has *two* shapes in the world, and the second one only exists on
 * machines that have already run the software.
 *
 * The fixtures below are the `CREATE TABLE` statements each store actually
 * shipped, taken from this repo's history, oldest first. Each is opened by the
 * current store, and what comes out is held against what the same store builds
 * from nothing. Equality is the whole assertion: a column added to the schema
 * and forgotten in the additive half is present on one side and absent on the
 * other, which is precisely the failure that only ever reaches production.
 *
 * The comparison is of column **names**. It is therefore blind to a primary
 * key, a NOT NULL, a default, a declared type or an index that differs between
 * the two — `watch_judgements` was caught only because its widened key happened
 * to add a column too. A future key change over columns that already exist
 * would pass this and still be wrong.
 *
 * Fixture data is invented — no corpus content.
 */

import SqliteDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { tableColumns } from "@omnesis/watch";
import { WatchDefinitionStore } from "./definitions.js";
import { WatchTraceStore } from "./traces.js";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** One shape a store has been shipped with, and the tables it wrote. */
interface Generation {
  /** What changed in it, for a failure message that names the install. */
  readonly what: string;
  /** The `CREATE TABLE` statements that build of the store executed. */
  readonly sql: string;
  /** The tables it created, whose shape the current store has to reach. */
  readonly tables: readonly string[];
}

/**
 * Every shape `watch_defs` has been shipped with.
 *
 * The current fixture in `definitions.test.ts` covers the last one only, which
 * is the generation immediately behind head — the install least likely to be
 * the one someone is upgrading from.
 */
const DEFINITION_GENERATIONS: readonly Generation[] = [
  {
    what: "the first shape it shipped with",
    tables: ["watch_defs"],
    sql: `CREATE TABLE watch_defs (
            id       TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            status   TEXT NOT NULL,
            dsl_json TEXT NOT NULL,
            added_at TEXT NOT NULL,
            from_seq INTEGER NOT NULL DEFAULT 0,
            note     TEXT
          );`,
  },
  {
    what: "after the compile a watch came out of was recorded",
    tables: ["watch_defs"],
    sql: `CREATE TABLE watch_defs (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            status         TEXT NOT NULL,
            dsl_json       TEXT NOT NULL,
            added_at       TEXT NOT NULL,
            from_seq       INTEGER NOT NULL DEFAULT 0,
            note           TEXT,
            compile_run_id TEXT
          );`,
  },
  {
    what: "after a caller's own key for its request was recorded",
    tables: ["watch_defs"],
    sql: `CREATE TABLE watch_defs (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            status         TEXT NOT NULL,
            dsl_json       TEXT NOT NULL,
            added_at       TEXT NOT NULL,
            from_seq       INTEGER NOT NULL DEFAULT 0,
            note           TEXT,
            compile_run_id TEXT,
            request_key    TEXT
          );`,
  },
  {
    what: "after the ontology slice a watch reads was recorded",
    tables: ["watch_defs"],
    sql: `CREATE TABLE watch_defs (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            status           TEXT NOT NULL,
            dsl_json         TEXT NOT NULL,
            added_at         TEXT NOT NULL,
            from_seq         INTEGER NOT NULL DEFAULT 0,
            note             TEXT,
            compile_run_id   TEXT,
            request_key      TEXT,
            reference_digest TEXT
          );`,
  },
];

/** Every shape the trace store has been shipped with. */
const TRACE_GENERATIONS: readonly Generation[] = [
  {
    what: "the first shape it shipped with",
    tables: ["watch_traces"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            at          TEXT NOT NULL
          );`,
  },
  {
    what: "after a failure's class was kept beside its message",
    tables: ["watch_traces"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );`,
  },
  {
    what: "after the noise floor was counted rather than kept",
    tables: ["watch_traces", "watch_trace_class_counts"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );
          CREATE TABLE watch_trace_class_counts (
            watch_id   TEXT NOT NULL,
            transition TEXT NOT NULL,
            seen       INTEGER NOT NULL,
            PRIMARY KEY (watch_id, transition)
          );`,
  },
  {
    what: "while the judge's answers were a running total",
    tables: ["watch_traces", "watch_trace_class_counts"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );
          CREATE TABLE watch_trace_class_counts (
            watch_id   TEXT NOT NULL,
            transition TEXT NOT NULL,
            seen       INTEGER NOT NULL,
            PRIMARY KEY (watch_id, transition)
          );
          CREATE TABLE watch_judge_counts (
            watch_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            seen     INTEGER NOT NULL,
            PRIMARY KEY (watch_id, decision)
          );`,
  },
  {
    what: "while a judgement was keyed on its subject alone",
    tables: ["watch_traces", "watch_trace_class_counts", "watch_judgements"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );
          CREATE TABLE watch_trace_class_counts (
            watch_id   TEXT NOT NULL,
            transition TEXT NOT NULL,
            seen       INTEGER NOT NULL,
            PRIMARY KEY (watch_id, transition)
          );
          CREATE TABLE watch_judgements (
            watch_id TEXT NOT NULL,
            node_id  TEXT NOT NULL,
            subject  TEXT NOT NULL,
            decision TEXT NOT NULL,
            at       TEXT NOT NULL,
            PRIMARY KEY (watch_id, node_id, subject)
          );`,
  },
  {
    what: "while a judgement was keyed on its subject and carried a sticky match",
    tables: ["watch_traces", "watch_trace_class_counts", "watch_judgements"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );
          CREATE TABLE watch_trace_class_counts (
            watch_id   TEXT NOT NULL,
            transition TEXT NOT NULL,
            seen       INTEGER NOT NULL,
            PRIMARY KEY (watch_id, transition)
          );
          CREATE TABLE watch_judgements (
            watch_id     TEXT NOT NULL,
            node_id      TEXT NOT NULL,
            subject      TEXT NOT NULL,
            decision     TEXT NOT NULL,
            at           TEXT NOT NULL,
            ever_matched INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (watch_id, node_id, subject)
          );`,
  },
  {
    what: "after the instance key joined a judgement's identity",
    tables: ["watch_traces", "watch_trace_class_counts", "watch_judgements"],
    sql: `CREATE TABLE watch_traces (
            rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id    TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            node_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            transition  TEXT NOT NULL,
            detail      TEXT,
            failure     TEXT,
            at          TEXT NOT NULL
          );
          CREATE TABLE watch_trace_class_counts (
            watch_id   TEXT NOT NULL,
            transition TEXT NOT NULL,
            seen       INTEGER NOT NULL,
            PRIMARY KEY (watch_id, transition)
          );
          CREATE TABLE watch_judgements (
            watch_id TEXT NOT NULL,
            node_id  TEXT NOT NULL,
            key      TEXT NOT NULL,
            subject  TEXT NOT NULL,
            decision TEXT NOT NULL,
            at       TEXT NOT NULL,
            PRIMARY KEY (watch_id, node_id, key, subject)
          );`,
  },
];

/** One generation by what it was, so inserting another cannot shift a case. */
function generation(all: readonly Generation[], what: string): Generation {
  const found = all.find((entry) => entry.what === what);
  if (!found) throw new Error(`no generation described as '${what}'`);
  return found;
}

let open: Db[] = [];

function db(): Db {
  const made = new SqliteDatabase(":memory:");
  open.push(made);
  return made;
}

afterEach(() => {
  for (const handle of open) handle.close();
  open = [];
});

/** The tables-to-columns map the current store builds from nothing. */
function freshShape(build: (db: Db) => void, tables: readonly string[]): Map<string, string[]> {
  const fresh = db();
  build(fresh);
  return new Map(tables.map((table) => [table, [...tableColumns(fresh, table)].sort()]));
}

/** The same map, from a file the named generation left behind. */
function upgradedShape(
  build: (db: Db) => void,
  generation: Generation,
  tables: readonly string[],
): Map<string, string[]> {
  const old = db();
  old.exec(generation.sql);
  build(old);
  return new Map(tables.map((table) => [table, [...tableColumns(old, table)].sort()]));
}

describe("a definitions store opened over a file an older build wrote", () => {
  const build = (handle: Db): void => {
    new WatchDefinitionStore(handle as unknown as EncryptedSqliteDatabase);
  };
  const tables = ["watch_defs"];

  for (const generation of DEFINITION_GENERATIONS) {
    it(`reaches the current shape from ${generation.what}`, () => {
      expect(upgradedShape(build, generation, tables)).toEqual(freshShape(build, tables));
    });
  }

  it("still stores and reads a watch after the oldest upgrade", () => {
    // The shape agreeing is necessary and not sufficient: a store whose writes
    // name a column the upgrade added would pass the comparison and fail on the
    // first use.
    const old = db();
    old.exec(generation(DEFINITION_GENERATIONS, "the first shape it shipped with").sql);
    const store = new WatchDefinitionStore(old as unknown as EncryptedSqliteDatabase);
    store.put({
      id: "w-1",
      name: "a-parcel-arrives",
      status: "active",
      dsl: { watch: { name: "a-parcel-arrives" } },
      addedAt: "2026-03-01T09:00:00.000Z",
      fromSeq: 0,
      note: null,
      compileRunId: "run-1",
      requestKey: "device\u0000their-own-key",
      referenceDigest: null,
    });
    // Written through the column the upgrade added, and read back through it:
    // the shape comparison above cannot tell a column that exists from one the
    // store's own statements can actually use.
    store.recordReferenceDigest("w-1", "surface-1");

    expect(store.list().map((watch) => watch.id)).toEqual(["w-1"]);
    expect(store.get("w-1")?.referenceDigest).toBe("surface-1");
    expect(store.findByRequestKey("device\u0000their-own-key")?.id).toBe("w-1");
  });
});

describe("a trace store opened over a file an older build wrote", () => {
  const build = (handle: Db): void => {
    new WatchTraceStore(handle as unknown as EncryptedSqliteDatabase);
  };
  // Every table any shipped generation wrote, so a comparison covers the ones
  // that generation had as well as the ones the current schema adds.
  const tables = ["watch_traces", "watch_trace_class_counts", "watch_judgements"];

  for (const generation of TRACE_GENERATIONS) {
    it(`reaches the current shape from ${generation.what}`, () => {
      expect(upgradedShape(build, generation, tables)).toEqual(freshShape(build, tables));
    });
  }

  it("carries a judgement across the key it was written without", () => {
    // The subject-keyed generation cannot be widened by an `ALTER TABLE` — the
    // key is `NOT NULL` and part of the primary key — so the table is rebuilt.
    // Its rows come with it: discarding them would reset a watch's judge
    // history to nothing, which is the count both silence-reading verdicts
    // gate on.
    const old = db();
    old.exec(generation(TRACE_GENERATIONS, "while a judgement was keyed on its subject alone").sql);
    old
      .prepare(
        `INSERT INTO watch_judgements (watch_id, node_id, subject, decision, at) VALUES
           ('w-1', 'mail', 'doc-1', 'matched',  '2026-02-01T09:00:00Z'),
           ('w-1', 'mail', 'doc-2', 'declined', '2026-02-01T09:00:00Z')`,
      )
      .run();

    const store = new WatchTraceStore(old as unknown as EncryptedSqliteDatabase);

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 1 });
    // And the next judgement about a document already carried across settles
    // on the row it is already in, rather than counting it a second time.
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-2",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });
    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 1 });
  });

  it("carries a sticky match across the rebuild rather than recomputing it", () => {
    // The shape an install that booted the last two builds holds: subject-keyed
    // and already carrying `ever_matched`. A rebuild that derived the bit from
    // the last answer would clear it on exactly the row it exists for — a
    // document the judge admitted and later declined — and put the watch back
    // to reading as one whose judge refused every one.
    const old = db();
    old.exec(
      generation(
        TRACE_GENERATIONS,
        "while a judgement was keyed on its subject and carried a sticky match",
      ).sql,
    );
    old
      .prepare(
        `INSERT INTO watch_judgements
           (watch_id, node_id, subject, decision, at, ever_matched)
         VALUES ('w-1', 'mail', 'doc-1', 'declined', '2026-02-01T09:00:00Z', 1)`,
      )
      .run();

    const store = new WatchTraceStore(old as unknown as EncryptedSqliteDatabase);

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
  });

  it("still records a trace and a judgement after the oldest upgrade", () => {
    const old = db();
    old.exec(generation(TRACE_GENERATIONS, "the first shape it shipped with").sql);
    const store = new WatchTraceStore(old as unknown as EncryptedSqliteDatabase);

    store.record(
      {
        watch: "w-1",
        firings: [],
        records: [
          {
            seq: 1,
            nodeId: "mail",
            key: "singleton",
            transition: "failed",
            detail: "the query refused to bind",
            failure: "query",
          },
        ],
      } as never,
      "2026-03-01T09:00:00Z",
    );
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });

    expect(store.recent("w-1")[0]?.failure).toBe("query");
    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 0, declined: 1 });
  });
});
