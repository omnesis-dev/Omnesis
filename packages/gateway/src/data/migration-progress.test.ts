// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type Migration, type MigrationProgress } from "./migrations.js";

let dir: string;
let db: Database.Database;
let reader: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-migration-progress-"));
  const path = join(dir, "gateway.db");
  db = new Database(path);
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, run_at INTEGER, duration_ms INTEGER)",
  );
  reader = new Database(path, { readonly: true });
});
afterEach(() => {
  reader.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration progress", () => {
  it("reports completion only after changes and version bookkeeping are committed", () => {
    const events: MigrationProgress[] = [];
    const seen: Array<{ version: number; inTransaction: boolean; recorded: boolean }> = [];
    const migrations: Migration[] = [
      {
        version: 1,
        description: "Example first schema",
        up: (handle) => handle.exec("CREATE TABLE first_example (id INTEGER)"),
      },
      {
        version: 2,
        description: "Example second schema",
        up: (handle) => handle.exec("CREATE TABLE second_example (id INTEGER)"),
      },
    ];
    runMigrations(db, {
      migrations,
      onProgress: (event) => {
        events.push(event);
        if (event.phase === "committed") {
          seen.push({
            version: reader.pragma("user_version", { simple: true }) as number,
            inTransaction: db.inTransaction,
            recorded:
              reader
                .prepare("SELECT version FROM schema_migrations WHERE version = ?")
                .get(event.version) !== undefined,
          });
        }
      },
    });
    expect(events).toEqual([
      { phase: "planned", current: 0, total: 2, completed: 0 },
      { phase: "started", current: 1, total: 2, completed: 0, version: 1 },
      { phase: "committed", current: 1, total: 2, completed: 1, version: 1 },
      { phase: "started", current: 2, total: 2, completed: 1, version: 2 },
      { phase: "committed", current: 2, total: 2, completed: 2, version: 2 },
    ]);
    expect(seen).toEqual([
      { version: 1, inTransaction: false, recorded: true },
      { version: 2, inTransaction: false, recorded: true },
    ]);
  });

  it("does not finish an own-transaction migration before the runner stamps its version", () => {
    const events: MigrationProgress[] = [];
    runMigrations(db, {
      migrations: [
        {
          version: 1,
          description: "Example table rebuild",
          ownTransaction: true,
          up: (handle) => {
            handle.exec("BEGIN; CREATE TABLE rebuilt_example (id INTEGER); COMMIT");
            expect(events.map((event) => event.phase)).toEqual(["planned", "started"]);
            expect(reader.pragma("user_version", { simple: true })).toBe(0);
          },
        },
      ],
      onProgress: (event) => {
        events.push(event);
        if (event.phase === "committed")
          expect(reader.pragma("user_version", { simple: true })).toBe(1);
      },
    });
    expect(events.at(-1)).toMatchObject({ phase: "committed", completed: 1 });
    expect(reader.pragma("user_version", { simple: true })).toBe(1);
  });

  it.each([false, true])(
    "reports failed version bookkeeping without a false completion (ownTransaction=%s)",
    (ownTransaction) => {
      const events: MigrationProgress[] = [];
      db.exec(
        "CREATE TRIGGER refuse_stamp BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'example refusal'); END",
      );
      expect(() =>
        runMigrations(db, {
          migrations: [
            {
              version: 1,
              description: "Example failing stamp",
              ownTransaction,
              up: (handle) =>
                handle.exec(
                  ownTransaction
                    ? "BEGIN; CREATE TABLE IF NOT EXISTS example_body (id INTEGER); COMMIT"
                    : "CREATE TABLE example_body (id INTEGER)",
                ),
            },
          ],
          onProgress: (event) => events.push(event),
        }),
      ).toThrow("example refusal");
      expect(events.map((event) => event.phase)).toEqual(["planned", "started", "failed"]);
      expect(events.at(-1)).toMatchObject({ current: 1, total: 1, completed: 0 });
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual([]);
    },
  );

  it("isolates observer exceptions from migration atomicity", () => {
    const migration: Migration = {
      version: 1,
      description: "Example safe observer",
      up: (handle) => handle.exec("CREATE TABLE observer_example (id INTEGER)"),
    };
    expect(() =>
      runMigrations(db, {
        migrations: [migration],
        onProgress: () => {
          throw new Error("observer failed");
        },
      }),
    ).not.toThrow();
    expect(reader.pragma("user_version", { simple: true })).toBe(1);
    expect(reader.prepare("SELECT * FROM observer_example").all()).toEqual([]);
  });

  it("reports no pending migrations on an up-to-date schema", () => {
    db.pragma("user_version = 7");
    const events: MigrationProgress[] = [];
    runMigrations(db, {
      migrations: [
        {
          version: 1,
          description: "Already done",
          up: () => {
            throw new Error("must not execute");
          },
        },
      ],
      onProgress: (event) => events.push(event),
    });
    expect(events).toEqual([{ phase: "planned", current: 0, total: 0, completed: 0 }]);
  });
});
