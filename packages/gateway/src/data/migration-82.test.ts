// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 82 adds the per-source coverage table, the index the coverage read
 * needs, and retires the terminal bootstrap marker.
 *
 * The retrospective lane used to record `done` once it ran out of candidates,
 * and `done` short-circuited every later pass before the candidate count was
 * re-read. A young install reached it on its first pass and then never
 * reviewed the history of any source connected afterwards. So this migration
 * has real data to move: the marker has to come out of that terminal state,
 * and it has to come out WITHOUT a drained-day or source watermark beside it,
 * because the absence of those is what makes the next pass re-probe the corpus
 * rather than trust a verdict this schema no longer stands behind.
 *
 * The tests drive the real boot order — `runSchemaSetup` (current DDL) then
 * `runMigrations` — over a database seeded in the old shape, because that is
 * the sequence an upgrading install actually takes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, MIGRATIONS } from "./migrations.js";

let db: Database.Database;

const migration82 = MIGRATIONS.find((m) => m.version === 82)!;
/** The version an install pinned immediately before this step sits at. */
const PREVIOUS_SCHEMA_VERSION = 81;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

/** The real boot order an upgrading install takes. */
function boot(): void {
  runSchemaSetup(db);
  runMigrations(db);
}

const engineState = (key: string): string | null =>
  db
    .prepare<[string], { value: string }>("SELECT value FROM cognition_engine_state WHERE key = ?")
    .get(key)?.value ?? null;

const tableExists = (name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

const indexExists = (name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name) !== undefined;

/**
 * An install pinned one version back, whose bootstrap lane had declared
 * itself finished.
 */
function seedFinishedLane(): void {
  runSchemaSetup(db);
  db.prepare(
    "INSERT INTO cognition_engine_state (key, value) VALUES ('bootstrap_state', 'done')",
  ).run();
  db.prepare(
    "INSERT INTO cognition_engine_state (key, value) VALUES ('bootstrap_total_enqueued', '412')",
  ).run();
  db.exec("DROP TABLE cognition_coverage");
  db.exec(`PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION}`);
}

describe("migration 82", () => {
  it("reopens a lane that had declared itself finished", () => {
    seedFinishedLane();
    boot();

    expect(engineState("bootstrap_state")).toBe("drained");
    // No drained-day / watermark: their absence is the instruction to probe.
    expect(engineState("bootstrap_drained_day")).toBeNull();
    expect(engineState("bootstrap_drained_sources")).toBeNull();
    // The cumulative counter is untouched — the run budget an operator set is
    // not something a schema upgrade gets to reset.
    expect(engineState("bootstrap_total_enqueued")).toBe("412");
  });

  it("leaves a lane that was mid-sweep alone", () => {
    runSchemaSetup(db);
    db.prepare(
      "INSERT INTO cognition_engine_state (key, value) VALUES ('bootstrap_state', 'running')",
    ).run();
    db.exec(`PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION}`);
    boot();

    expect(engineState("bootstrap_state")).toBe("running");
  });

  it("creates the coverage table itself, not only via the shared DDL", () => {
    // Driven in isolation on purpose: booting would create the table through
    // `runSchemaSetup` whatever this step does, so a boot-path assertion here
    // would pass with the migration gutted.
    seedFinishedLane();
    expect(tableExists("cognition_coverage")).toBe(false);
    migration82.up(db);

    expect(tableExists("cognition_coverage")).toBe(true);
    db.prepare(
      `INSERT INTO cognition_coverage
         (source_id, workflow_id, workflow_version, eligible, last_progress_at, status)
       VALUES ('mail:maya@example.com', 'source-bootstrap', 1, 3, 1, 'in-progress')`,
    ).run();
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_coverage").get()?.n,
    ).toBe(1);
  });

  it("creates the marked-documents index itself, not only via the shared DDL", () => {
    seedFinishedLane();
    db.exec("DROP INDEX IF EXISTS idx_documents_bootstrap_processed");
    expect(indexExists("idx_documents_bootstrap_processed")).toBe(false);
    migration82.up(db);

    expect(indexExists("idx_documents_bootstrap_processed")).toBe(true);
  });

  it("leaves the coverage count reading an index rather than scanning documents", () => {
    // The portal polls this count every 60 seconds. Migration 41's partial
    // index covers only the rows where the marker is UNSET, so without its
    // complement the count is a full scan of the largest table in the
    // database. Asserted on the real boot path, which is what both a fresh
    // install and an upgrading one take.
    seedFinishedLane();
    boot();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) AS c FROM documents WHERE bootstrap_processed_at IS NOT NULL",
      )
      .all() as Array<{ detail: string }>;

    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_documents_bootstrap_processed");
  });

  it("is safe to run twice", () => {
    seedFinishedLane();
    boot();
    expect(() => migration82.up(db)).not.toThrow();
    expect(engineState("bootstrap_state")).toBe("drained");
  });

  it("runs on a database with no engine-state table at all", () => {
    // The cognition tables come from the shared DDL, but a migration must not
    // assume a table exists just because the current schema declares it.
    expect(() => migration82.up(db)).not.toThrow();
    expect(tableExists("cognition_coverage")).toBe(true);
  });
});
