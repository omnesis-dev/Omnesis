// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { buildInMemoryDfFromTable, readLiveDfTable } from "./NearDupDfService.js";
import { fetchNearDupDfData } from "./NearDupComputeService.js";
import { buildDfSab } from "./df-sab.js";
import { publishDfGeneration } from "./meta.js";
import type { Db } from "../data/types.js";

const ALGO = "synth-algo-v1";
let dir: string;
let db: Db;
let other: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-df-live-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  db.exec("PRAGMA journal_mode = WAL");
  runSchemaSetup(db);
  runMigrations(db);
  other = new Database(join(dir, "omnesis.db")) as unknown as Db;
});

afterEach(() => {
  other.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rowsFor = (generation: number, count: number): Array<[string, number]> =>
  Array.from({ length: count }, (_, i) => [
    `g${generation} lantern ${String(i).padStart(3, "0")} meadow`,
    (i % 9) + 2,
  ]);

/** Write `generation` beside the live one, publish it, and sweep the rest. */
function publish(conn: Db, generation: number, count: number): void {
  const insert = conn.prepare(
    "INSERT INTO near_dup_df (algo_version, generation, shingle, df) VALUES (?, ?, ?, ?)",
  );
  conn.transaction(() => {
    for (const [shingle, df] of rowsFor(generation, count))
      insert.run(ALGO, generation, shingle, df);
    publishDfGeneration(
      conn,
      ALGO,
      generation,
      1_000 + generation,
      count,
      1_700_000_000 + generation,
    );
  })();
  conn
    .prepare("DELETE FROM near_dup_df WHERE algo_version = ? AND generation < ?")
    .run(ALGO, generation);
}

function singleStatement(conn: Db): Array<[string, number]> {
  const generation = conn
    .prepare<[string], { g: number }>(
      "SELECT live_generation AS g FROM near_dup_df_meta WHERE algo_version = ?",
    )
    .get(ALGO)!.g;
  return conn
    .prepare<[string, number], [string, number]>(
      "SELECT shingle, df FROM near_dup_df WHERE algo_version = ? AND generation = ?",
    )
    .raw()
    .all(ALGO, generation);
}

/**
 * `db`, except that after the first page of each pass, `onPage` writes
 * through the other connection before the second page is read.
 */
function interleaved(onPage: () => void): Db {
  let armed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("ORDER BY shingle")) return stmt;
          const continuation = sql.includes("shingle > ?");
          return {
            raw: () => ({
              all: (...args: unknown[]) => {
                if (!continuation) armed = true;
                else if (armed) {
                  armed = false;
                  onPage();
                }
                return stmt.raw().all(...args);
              },
            }),
          };
        };
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Db;
}

describe("readLiveDfTable", () => {
  test("pages to the single-statement result whatever the page size", () => {
    publish(db, 1, 0);
    publish(db, 2, 47);
    const expected = singleStatement(db);
    expect(expected).toHaveLength(47);
    for (const chunkRows of [1, 2, 7, 46, 47, 48, 50_000]) {
      const { meta, entries } = readLiveDfTable(db, ALGO, chunkRows);
      expect(entries).toEqual(expected);
      expect(meta).toEqual({ totalDocs: 1_002, builtAt: 1_700_000_002, generation: 2 });
    }
  });

  test("serves the same DF buffer and lookup as one statement", () => {
    publish(db, 3, 120);
    const expected = singleStatement(db);
    expect(Buffer.from(fetchNearDupDfData(db, ALGO))).toEqual(
      Buffer.from(buildDfSab(expected, 1_003)),
    );
    const df = buildInMemoryDfFromTable(db, ALGO);
    expect(df.totalDocs).toBe(1_003);
    expect(df.size()).toBe(120);
    for (const [shingle, count] of expected) expect(df.df(shingle)).toBe(count);
    expect(df.df("g3 absent")).toBe(0);
  });

  test("reads again when a generation is published and swept mid-read", () => {
    publish(db, 1, 10);
    let published = 1;
    const { meta, entries } = readLiveDfTable(
      interleaved(() => {
        if (published === 1) publish(other, ++published, 10);
      }),
      ALGO,
      3,
    );
    expect(meta.generation).toBe(2);
    expect(entries).toEqual(rowsFor(2, 10));
    expect(entries).toEqual(singleStatement(db));
  });

  test("falls back to one transaction while publishes keep landing", () => {
    publish(db, 1, 10);
    let published = 1;
    const liveBefore: Array<Array<[string, number]>> = [];
    const { meta, entries } = readLiveDfTable(
      interleaved(() => {
        liveBefore.push(singleStatement(other));
        publish(other, ++published, 10);
      }),
      ALGO,
      3,
    );
    expect(db.inTransaction).toBe(false);
    expect(liveBefore).toHaveLength(3);
    expect(meta.generation).toBe(3);
    expect(entries).toEqual(liveBefore[2]);
    expect(singleStatement(db)).toEqual(rowsFor(4, 10));
  });
});
