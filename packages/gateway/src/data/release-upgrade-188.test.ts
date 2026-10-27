// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The v0.6.0 release's own database, both ways.
 *
 * Upgrade: a database the published v0.6.0 release created and filled through
 * its own functions opens through today's `createDatabase`, keeps every row it
 * held and ends up shaped exactly like a fresh install. The tail fixture builds
 * its old tables from today's code; this one cannot, so a table v0.6.0 created
 * that never received a migration it needed shows up here.
 *
 * Rollback: `omnesis update` returns a failed update to the previous release
 * on the database the new one already migrated. v0.6.0 then opens that
 * database with its own schema setup (which recreates any table it misses) and
 * writes with its own INSERTs, so each of its tables must still hold each of
 * its columns, and none may have gained a NOT NULL column without a default.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import SqliteDatabase from "better-sqlite3";
import { createDatabase } from "../db.js";
import { LATEST_SCHEMA_VERSION } from "./schema-version.js";

type Row = Record<string, unknown>;

interface Manifest {
  release: string;
  revision: string;
  schema: number;
  sha256: string;
  /** Rows per table, for every ordinary table the release left non-empty. */
  counts: Record<string, number>;
  /** Every row of each table the seed wrote, in the release's own columns. */
  rows: Record<string, Row[]>;
}

interface ReleaseShape {
  release: string;
  schema: number;
  tables: Record<
    string,
    {
      /** v0.6.0's schema setup creates this table when it is missing. */
      recreatedOnOpen: boolean;
      columns: { name: string; type: string; notnull: number; default: string | null }[];
    }
  >;
}

const fixture = new URL("./fixtures/release-188/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixture), "utf8")) as Manifest;
const releaseShape = JSON.parse(
  readFileSync(new URL("schema-shape.json", fixture), "utf8"),
) as ReleaseShape;

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function tempPath(): string {
  const path = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  scratch.push(path);
  return path;
}

function installedDatabase(): string {
  const compressed = readFileSync(new URL("gateway.db.gz", fixture));
  expect(createHash("sha256").update(compressed).digest("hex")).toBe(manifest.sha256);
  const path = tempPath();
  writeFileSync(path, gunzipSync(compressed));
  return path;
}

function freshHeadDatabase(): SqliteDatabase.Database {
  return createDatabase(tempPath());
}

// --- Rows -------------------------------------------------------------------

/** Tables migration 197 drops: briefs became observations. */
const RETIRED_BRIEF_TABLES = ["brief_citations", "brief_related_loops", "briefs"];

/** Read `table` in the columns a manifest row names, in the generator's order. */
function rowsIn(db: SqliteDatabase.Database, table: string, columns: readonly string[]): Row[] {
  const blobs = new Set(
    db
      .prepare<[string], { name: string; type: string }>(
        "SELECT name, type FROM pragma_table_info(?)",
      )
      .all(table)
      .filter((c) => /BLOB/i.test(c.type))
      .map((c) => c.name),
  );
  const select = columns.map((c) => (blobs.has(c) ? `hex("${c}") AS "${c}"` : `"${c}"`));
  const order = columns.map((_, index) => index + 1).join(", ");
  return db.prepare(`SELECT ${select.join(", ")} FROM "${table}" ORDER BY ${order}`).all() as Row[];
}

function tableExists(db: SqliteDatabase.Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** What each seeded table should read after the upgrade, in v0.6.0's columns. */
function expectedRows(table: string): Row[] {
  const rows = manifest.rows[table]!;
  switch (table) {
    case "cognition_runs":
      // 197 drops pending feedback runs about a brief; every other run stays.
      return rows.filter((row) => !String(row.payload_json).includes("briefId"));
    case "cognition_sweep_tally":
      // 197 renames briefs_created to observations_noted and drops briefs_held.
      return rows.map(({ briefs_created, briefs_held: _held, ...row }) => ({
        ...row,
        observations_noted: briefs_created,
      }));
    default:
      return rows;
  }
}

function preserved(db: SqliteDatabase.Database): void {
  for (const table of Object.keys(manifest.rows)) {
    if (RETIRED_BRIEF_TABLES.includes(table)) {
      expect(tableExists(db, table), table).toBe(false);
      continue;
    }
    const expected = expectedRows(table);
    expect(rowsIn(db, table, Object.keys(expected[0]!)), table).toEqual(expected);
  }
  const counts: Record<string, number> = {};
  for (const table of Object.keys(manifest.counts)) {
    if (RETIRED_BRIEF_TABLES.includes(table)) continue;
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }
  const expectedCounts = Object.fromEntries(
    Object.entries(manifest.counts)
      .filter(([table]) => !RETIRED_BRIEF_TABLES.includes(table))
      .map(([table, count]) => {
        // One bookkeeping row per migration the upgrade applied.
        if (table === "schema_migrations")
          return [table, count + LATEST_SCHEMA_VERSION - manifest.schema];
        if (table in manifest.rows) return [table, expectedRows(table).length];
        return [table, count];
      }),
  );
  expect(counts).toEqual(expectedCounts);
}

// --- Schema objects ---------------------------------------------------------

/** Comments dropped, identifiers unquoted, whitespace collapsed. */
function canonicalSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/"(\w+)"/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

/**
 * A table's definitions — columns and table constraints — as a sorted list.
 * `ALTER TABLE ADD COLUMN` appends where a fresh install declares a column in
 * place, so order is the one difference an upgrade may legitimately leave.
 */
function tableDefinitions(sql: string): string[] {
  const body = canonicalSql(sql);
  const inner = body.slice(body.indexOf("(") + 1, body.lastIndexOf(")"));
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of inner) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === "(") depth++;
    if (!quoted && char === ")") depth--;
    if (!quoted && depth === 0 && char === ",") {
      items.push(current.trim());
      current = "";
    } else current += char;
  }
  items.push(current.trim());
  return items.sort();
}

interface SchemaObject {
  type: string;
  table: string;
  definition: string | string[] | null;
  columns?: Row[];
}

function schemaObjects(db: SqliteDatabase.Database): Record<string, SchemaObject> {
  const rows = db
    .prepare<[], { type: string; name: string; tbl_name: string; sql: string | null }>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return Object.fromEntries(
    rows.map((row) => {
      const plain = row.type === "table" && !/^CREATE VIRTUAL/i.test(row.sql ?? "");
      return [
        `${row.type} ${row.name}`,
        {
          type: row.type,
          table: row.tbl_name,
          definition:
            row.sql === null ? null : plain ? tableDefinitions(row.sql) : canonicalSql(row.sql),
          ...(plain
            ? {
                columns: db
                  .prepare(
                    `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name`,
                  )
                  .all(row.name) as Row[],
              }
            : {}),
        },
      ];
    }),
  );
}

describe("a database created by the v0.6.0 release", () => {
  test("is the release's own schema 188, holding every seeded row", () => {
    expect(manifest).toMatchObject({ release: "v0.6.0", schema: 188 });
    const old = new SqliteDatabase(installedDatabase(), { readonly: true });
    try {
      expect(old.pragma("user_version", { simple: true })).toBe(188);
      expect(tableExists(old, "briefs")).toBe(true);
      for (const [table, rows] of Object.entries(manifest.rows))
        expect(rowsIn(old, table, Object.keys(rows[0]!)), table).toEqual(rows);
    } finally {
      old.close();
    }
  });

  test("upgrades to head keeping every row, and a second open changes nothing", () => {
    const path = installedDatabase();
    const snapshots: unknown[] = [];
    for (let open = 0; open < 2; open++) {
      const db = createDatabase(path);
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
        preserved(db);
        snapshots.push({
          schema: schemaObjects(db),
          rows: Object.fromEntries(
            Object.keys(manifest.counts)
              .filter((table) => tableExists(db, table))
              .map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]),
          ),
        });
      } finally {
        db.close();
      }
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  test("keeps the meaning of what the operator and the agent wrote", () => {
    const db = createDatabase(installedDatabase());
    try {
      const note = (id: string) =>
        db
          .prepare(
            "SELECT text, surface, place_name, transcribed_at, from_owner, task_id, page_context FROM note_entries WHERE id = ?",
          )
          .get(id);
      expect(note("fixture-note-voice-done")).toEqual({
        text: "Send the marathon entry form before Friday.",
        surface: "ios-app",
        place_name: null,
        transcribed_at: "2026-01-15T09:02:00.000Z",
        // A note captured before the note agent existed is not queued for it.
        from_owner: 0,
        task_id: null,
        page_context: null,
      });
      expect(note("fixture-note-located")).toMatchObject({ place_name: "Riverside" });
      expect(
        db
          .prepare(
            "SELECT audio, saved_text, placeholder, allow_vocabulary FROM voice_note_transcriptions",
          )
          .all(),
      ).toEqual([
        {
          audio: Buffer.from("fixture"),
          saved_text: "Voice note (transcribing)",
          placeholder: 1,
          allow_vocabulary: expect.any(Number),
        },
      ]);
      expect(
        db.prepare("SELECT cursor FROM sync_state WHERE source_id = 'gmail:fixture'").get(),
      ).toEqual({ cursor: JSON.stringify({ fixtureBookmark: "gmail", page: 3 }) });
      // Open loops became tasks: a loop the Brain found is a Brain suggestion,
      // and one already resolved keeps when it was resolved.
      expect(
        db
          .prepare(
            "SELECT id, state, origin, accepted, ignored, resolved_at, last_update FROM open_loops ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "fixture-loop-budget",
          state: "done",
          origin: "brain",
          accepted: 0,
          ignored: 0,
          resolved_at: 1768467600000,
          last_update: 1768467600000,
        },
        {
          id: "fixture-loop-entry-form",
          state: "open",
          origin: "brain",
          accepted: 0,
          ignored: 0,
          resolved_at: null,
          last_update: 1768467605000,
        },
      ]);
      expect(db.prepare("SELECT observations_noted FROM cognition_sweep_tally").all()).toEqual([
        { observations_noted: 3 },
      ]);
      expect(db.prepare("SELECT content FROM cognition_notes").get()).toEqual({
        content: "Maya prefers morning reminders.",
      });
      expect(
        db
          .prepare(
            `SELECT g.name AS grant_name, c.capability, c.source_mode, c.source_ids
               FROM access_grants g JOIN access_grant_capabilities c ON c.grant_id = g.id
              ORDER BY c.capability`,
          )
          .all(),
      ).toEqual([
        {
          grant_name: "Fictional agent access",
          capability: "direct",
          source_mode: "allowlist",
          source_ids: '["gmail:fixture"]',
        },
        {
          grant_name: "Fictional agent access",
          capability: "notes",
          source_mode: "all",
          source_ids: "[]",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("ends up shaped exactly like a fresh install of head", () => {
    const upgraded = createDatabase(installedDatabase());
    const fresh = freshHeadDatabase();
    try {
      expect(schemaObjects(upgraded)).toEqual(schemaObjects(fresh));
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});

// --- Rollback -----------------------------------------------------------------

/**
 * Columns head no longer has that v0.6.0 still writes. Each is a known
 * rollback break, accepted with its reason; nothing else may join this list
 * without the same scrutiny.
 */
const ACCEPTED_ROLLBACK_BREAKS: Record<string, string> = {
  "cognition_sweep_tally.briefs_created":
    "197 renamed it observations_noted; only experimental sweeps write the tally",
  "cognition_sweep_tally.briefs_held":
    "197 dropped it with briefs; only experimental sweeps write the tally",
};

/** Everything a rolled-back v0.6.0 gateway would trip over in `db`. */
function rollbackBreaks(db: SqliteDatabase.Database): string[] {
  const breaks: string[] = [];
  for (const [table, { recreatedOnOpen, columns }] of Object.entries(releaseShape.tables)) {
    const head = db
      .prepare<[string], { name: string; notnull: number; dflt_value: string | null; pk: number }>(
        'SELECT name, "notnull", dflt_value, pk FROM pragma_table_info(?)',
      )
      .all(table);
    if (head.length === 0) {
      // v0.6.0's own schema setup recreates the table, empty, on open.
      if (!recreatedOnOpen) breaks.push(`${table}: table dropped, and v0.6.0 does not recreate it`);
      continue;
    }
    const present = new Set(head.map((c) => c.name));
    for (const column of columns)
      if (!present.has(column.name) && !(`${table}.${column.name}` in ACCEPTED_ROLLBACK_BREAKS))
        breaks.push(`${table}.${column.name}: column v0.6.0 writes is gone`);
    const known = new Set(columns.map((c) => c.name));
    for (const column of head)
      if (!known.has(column.name) && column.notnull === 1 && column.dflt_value === null)
        breaks.push(
          `${table}.${column.name}: NOT NULL without a default, so v0.6.0's INSERTs fail`,
        );
  }
  return breaks;
}

describe("rolling a head database back to the v0.6.0 release", () => {
  test("the snapshot is the release's own schema", () => {
    expect(releaseShape).toMatchObject({ release: "v0.6.0", schema: 188 });
    const old = new SqliteDatabase(installedDatabase(), { readonly: true });
    try {
      for (const [table, { columns }] of Object.entries(releaseShape.tables))
        expect(
          old
            .prepare(
              `SELECT name, type, "notnull", dflt_value AS "default" FROM pragma_table_info(?) ORDER BY cid`,
            )
            .all(table),
          table,
        ).toEqual(columns);
    } finally {
      old.close();
    }
  });

  test("leaves every table and column v0.6.0 writes, with nothing new it must fill", () => {
    const db = freshHeadDatabase();
    try {
      expect(rollbackBreaks(db)).toEqual([]);
      // Each accepted break is still real: the day it is fixed, it leaves the list.
      for (const key of Object.keys(ACCEPTED_ROLLBACK_BREAKS)) {
        const [table, column] = key.split(".") as [string, string];
        expect(
          releaseShape.tables[table]?.columns.map((c) => c.name),
          key,
        ).toContain(column);
        expect(
          db.prepare("SELECT name FROM pragma_table_info(?)").all(table),
          key,
        ).not.toContainEqual({ name: column });
      }
    } finally {
      db.close();
    }
  });
});
