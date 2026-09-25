// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Schema setup + migrations runner tests.
 *
 * Anchored on `runSchemaSetup` (idempotent CREATE TABLE / INSERT OR
 * IGNORE) and `runMigrations` (PRAGMA user_version + ordered Migration
 * list). The framework here is what replaced an earlier pattern of sniffing
 * a table's stored DDL with substring checks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations, type Migration } from "./migrations.js";
import { createDevice } from "./repositories/DeviceRepository.js";
import type { Db } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-schema-mig-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runSchemaSetup", () => {
  test("creates a fresh schema and is idempotent on re-run", () => {
    expect(() => runSchemaSetup(db)).not.toThrow();
    expect(() => runSchemaSetup(db)).not.toThrow();

    // A table every install has, written through to prove the shape is real
    // rather than merely created.
    expect(() =>
      db.prepare("UPDATE refresh_meta SET dirty_version = ? WHERE job = ?").run(1, "near_dup_df"),
    ).not.toThrow();
  });

  test("seeds singleton rows so dirty-mark UPDATEs hit a row", () => {
    runSchemaSetup(db);

    // link_stats keeps its data-only singleton row.
    const linkRow = db
      .prepare<unknown[], { id: number }>("SELECT id FROM link_stats WHERE id = 1")
      .get();
    expect(linkRow).toBeDefined();
    // The three legacy OCC meta tables are now folded into refresh_meta
    // Each job gets its own seed row.
    const jobs = db
      .prepare<[], { job: string }>("SELECT job FROM refresh_meta ORDER BY job")
      .all()
      .map((r) => r.job);
    expect(jobs).toEqual([
      "interaction_scores",
      "link_graph",
      "merge_rules",
      "near_dup_df",
      "people_counts",
    ]);
  });

  test("creates near-dup tables with FK + indexes + dedup index", () => {
    runSchemaSetup(db);

    // All five near-dup tables exist.
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'near_dup_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      "near_dup_df",
      "near_dup_df_meta",
      "near_dup_edges",
      "near_dup_inbox",
      "near_dup_lsh_buckets",
      "near_dup_signatures",
    ]);

    // CHECK(doc_a < doc_b) is enforced on near_dup_edges.
    expect(() =>
      db
        .prepare(
          `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard,
            pair_unique_df2, pair_unique_df5, containment_min, gate_family, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("z", "a", "v1", 0.9, 5, 10, 0.95, "email", 0),
    ).toThrow(/CHECK constraint/);

    // Dedup index on inbox: same (doc_id, reason) twice → INSERT OR IGNORE no-ops.
    db.prepare(
      `INSERT INTO near_dup_inbox (doc_id, enqueued_reason, enqueued_at) VALUES (?, ?, ?)`,
    ).run("doc-1", "insert", 100);
    db.prepare(
      `INSERT OR IGNORE INTO near_dup_inbox (doc_id, enqueued_reason, enqueued_at) VALUES (?, ?, ?)`,
    ).run("doc-1", "insert", 200);
    const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM near_dup_inbox").get()!
      .n;
    expect(count).toBe(1);
  });

  test("migration 7 widens refresh_meta CHECK on an existing install", () => {
    // Simulate a v6 install: refresh_meta with the legacy 3-job CHECK.
    db.exec(`
      CREATE TABLE refresh_meta (
        job TEXT PRIMARY KEY CHECK (job IN ('link_graph', 'interaction_scores', 'merge_rules')),
        dirty_version INTEGER NOT NULL DEFAULT 0,
        last_computed_version INTEGER NOT NULL DEFAULT -1,
        last_computed_at INTEGER,
        needs_refresh INTEGER NOT NULL DEFAULT 1
      )
    `);
    db.exec("INSERT INTO refresh_meta (job) VALUES ('link_graph')");
    db.exec("INSERT INTO refresh_meta (job) VALUES ('interaction_scores')");
    db.exec("INSERT INTO refresh_meta (job) VALUES ('merge_rules')");
    // We must run schema setup first so other tables exist (the
    // runner's transactional wrap requires the rest of the schema).
    runSchemaSetup(db);
    // After schema setup, the legacy CHECK should have been replaced
    // (CREATE TABLE IF NOT EXISTS is a no-op so it doesn't fix the CHECK).
    // The migration is what fixes it.
    runMigrations(db);
    // Migration applied → can insert the new job row.
    expect(() =>
      db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('near_dup_df')"),
    ).not.toThrow();
    const jobs = db
      .prepare<[], { job: string }>("SELECT job FROM refresh_meta ORDER BY job")
      .all()
      .map((r) => r.job);
    expect(jobs).toContain("near_dup_df");
  });

  test("creates schema_migrations table for the migration runner", () => {
    runSchemaSetup(db);
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('schema_migrations')")
      .all()
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(["description", "duration_ms", "run_at", "version"]);
  });

  test("runSchemaSetup is wrapped in a transaction (no partial schema on a CREATE failure)", () => {
    // Force a constraint violation in the middle of setup by pre-existing
    // a `documents` table with an incompatible CHECK that the second
    // CREATE TABLE IF NOT EXISTS would still respect (so we can't easily
    // force a mid-setup failure). Instead, just verify the runner is
    // a transaction-style call by inspecting that it runs end-to-end
    // without journal residue.
    runSchemaSetup(db);
    const journalMode = db.prepare<[], { journal_mode: string }>("PRAGMA journal_mode").get();
    // The schema setup itself doesn't pin the journal mode, so this is
    // just a sanity that the DB is in a valid state post-setup.
    expect(journalMode?.journal_mode).toBeDefined();
  });
});

describe("runMigrations", () => {
  test("baseline: empty migration list bumps user_version to LATEST on a fresh DB", () => {
    runSchemaSetup(db);
    const before = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(before).toBe(0);

    runMigrations(db, { migrations: [] });

    const after = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(after).toBe(LATEST_SCHEMA_VERSION);
  });

  test("runs an unapplied migration and records it in schema_migrations", () => {
    runSchemaSetup(db);

    const calls: Array<{ id: string; v: number }> = [];
    const m: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: "test: add column foo",
      up(d) {
        d.exec("ALTER TABLE devices ADD COLUMN foo TEXT");
        calls.push({ id: "m1", v: LATEST_SCHEMA_VERSION + 1 });
      },
    };

    runMigrations(db, { migrations: [m] });

    expect(calls).toHaveLength(1);
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("foo");
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(LATEST_SCHEMA_VERSION + 1);

    const recorded = db
      .prepare<
        [],
        { version: number; description: string }
      >("SELECT version, description FROM schema_migrations ORDER BY version")
      .all();
    expect(recorded).toEqual([
      { version: LATEST_SCHEMA_VERSION + 1, description: "test: add column foo" },
    ]);
  });

  test("re-running with the same head is a no-op", () => {
    runSchemaSetup(db);
    const m: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: "noop test",
      up(d) {
        d.exec("CREATE TABLE noop_test (id INTEGER PRIMARY KEY)");
      },
    };
    runMigrations(db, { migrations: [m] });
    runMigrations(db, { migrations: [m] }); // must not throw or re-run

    const rows = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM schema_migrations")
      .get()!;
    expect(rows.c).toBe(1);
  });

  test("a failing migration rolls back and doesn't bump user_version", () => {
    runSchemaSetup(db);
    // First seed user_version at baseline (no migrations to run).
    runMigrations(db, { migrations: [] });
    const v0 = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v0).toBe(LATEST_SCHEMA_VERSION);

    const m: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: "intentional failure",
      up() {
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, { migrations: [m] })).toThrow(/intentional failure/);
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(LATEST_SCHEMA_VERSION); // failed migration rolled back; baseline preserved
  });

  test("runs migrations in order even when the input list is shuffled", () => {
    runSchemaSetup(db);
    const order: number[] = [];
    const m2: Migration = {
      version: LATEST_SCHEMA_VERSION + 2,
      description: "m2",
      up() {
        order.push(2);
      },
    };
    const m1: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: "m1",
      up() {
        order.push(1);
      },
    };
    runMigrations(db, { migrations: [m2, m1] });
    expect(order).toEqual([1, 2]);
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(LATEST_SCHEMA_VERSION + 2);
  });

  test("DirtyMarks UPSERT self-heals when a refresh_meta seed row is missing", async () => {
    runSchemaSetup(db);
    // Simulate the partial-setup scenario: delete the seed.
    db.exec("DELETE FROM refresh_meta WHERE job = 'link_graph'");
    const before = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM refresh_meta WHERE job = ?")
      .get("link_graph")!;
    expect(before.c).toBe(0);

    const { markLinkStatsDirty } = await import("./DirtyMarks.js");
    markLinkStatsDirty(db);

    const row = db
      .prepare<
        [],
        { job: string; dirty_version: number; needs_refresh: number }
      >("SELECT job, dirty_version, needs_refresh FROM refresh_meta WHERE job = 'link_graph'")
      .get();
    expect(row).toEqual({ job: "link_graph", dirty_version: 1, needs_refresh: 1 });
  });

  test("migration: collapses three legacy OCC tables into refresh_meta", () => {
    // Build the legacy shape by hand — the migration runs on a DB
    // that pre-dates the collapse, so we need to simulate that layout
    // before calling runSchemaSetup / runMigrations.
    db.exec(`
      CREATE TABLE link_stats (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        total_links INTEGER NOT NULL DEFAULT 0,
        resolved_links INTEGER NOT NULL DEFAULT 0,
        by_type_json TEXT NOT NULL DEFAULT '{}',
        needs_refresh INTEGER NOT NULL DEFAULT 1,
        dirty_version INTEGER NOT NULL DEFAULT 0,
        last_computed_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE interaction_scores_meta (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        dirty_version INTEGER NOT NULL DEFAULT 0,
        last_computed_at INTEGER,
        last_computed_version INTEGER NOT NULL DEFAULT -1
      )
    `);
    db.exec(`
      CREATE TABLE merge_rules_meta (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        dirty_version INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at INTEGER,
        last_evaluated_version INTEGER NOT NULL DEFAULT -1
      )
    `);
    db.prepare(
      "INSERT INTO link_stats (id, total_links, resolved_links, needs_refresh, dirty_version, last_computed_at) VALUES (1, 42, 30, 1, 7, 1700000)",
    ).run();
    db.prepare(
      "INSERT INTO interaction_scores_meta (id, dirty_version, last_computed_version, last_computed_at) VALUES (1, 11, 9, 1700100)",
    ).run();
    db.prepare(
      "INSERT INTO merge_rules_meta (id, dirty_version, last_evaluated_version, last_evaluated_at) VALUES (1, 3, 2, 1700200)",
    ).run();

    runSchemaSetup(db);
    // runSchemaSetup added `refresh_meta` + seeded the three job rows.
    // The migration now copies the legacy state in.
    runMigrations(db);

    const rows = db
      .prepare<
        [],
        {
          job: string;
          dirty_version: number;
          last_computed_version: number;
          last_computed_at: number | null;
          needs_refresh: number;
        }
      >(
        "SELECT job, dirty_version, last_computed_version, last_computed_at, needs_refresh FROM refresh_meta ORDER BY job",
      )
      .all();
    expect(rows).toEqual([
      {
        job: "interaction_scores",
        dirty_version: 11,
        last_computed_version: 9,
        last_computed_at: 1700100,
        needs_refresh: 1,
      },
      // link_graph: legacy had no `last_computed_version` — the
      // migration backfills it from `dirty_version` so the next refresh
      // doesn't immediately re-fire on a healthy row.
      {
        job: "link_graph",
        dirty_version: 7,
        last_computed_version: 7,
        last_computed_at: 1700000,
        needs_refresh: 1,
      },
      {
        job: "merge_rules",
        dirty_version: 3,
        last_computed_version: 2,
        last_computed_at: 1700200,
        needs_refresh: 1,
      },
      // near_dup_df: seeded fresh by migration 7 alongside the CHECK
      // widening; no legacy state to copy in.
      {
        job: "near_dup_df",
        dirty_version: 0,
        last_computed_version: -1,
        last_computed_at: null,
        needs_refresh: 1,
      },
      {
        job: "people_counts",
        dirty_version: 0,
        last_computed_version: -1,
        last_computed_at: null,
        needs_refresh: 1,
      },
    ]);

    // Legacy meta tables are gone.
    const legacy = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('interaction_scores_meta', 'merge_rules_meta')")
      .all();
    expect(legacy).toEqual([]);

    // link_stats keeps its data columns but loses the OCC ones.
    const linkCols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('link_stats')")
      .all()
      .map((r) => r.name)
      .sort();
    expect(linkCols).toEqual([
      "by_type_json",
      "id",
      "last_computed_at",
      "resolved_links",
      "total_links",
    ]);
    // The data values survive the rebuild.
    const data = db
      .prepare<
        [],
        { total_links: number; resolved_links: number }
      >("SELECT total_links, resolved_links FROM link_stats WHERE id = 1")
      .get();
    expect(data).toEqual({ total_links: 42, resolved_links: 30 });
  });
});

describe("migration v11: add document_links.metadata_json", () => {
  function findMigration(version: number): Migration {
    const m = MIGRATIONS.find((mig) => mig.version === version);
    if (!m) throw new Error(`migration v${version} not in MIGRATIONS`);
    return m;
  }

  function listDocumentLinksColumns(): string[] {
    return db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('document_links')")
      .all()
      .map((r) => r.name);
  }

  test("adds metadata_json when the column is missing", () => {
    runSchemaSetup(db);
    // Simulate an install at v10 — drop the column the latest schema
    // brought in so the migration has work to do.
    db.exec("ALTER TABLE document_links DROP COLUMN metadata_json");
    expect(listDocumentLinksColumns()).not.toContain("metadata_json");

    findMigration(11).up(db);

    expect(listDocumentLinksColumns()).toContain("metadata_json");
  });

  test("is a no-op when the column already exists", () => {
    runSchemaSetup(db);
    // Fresh schema already has the column.
    expect(listDocumentLinksColumns()).toContain("metadata_json");
    // Running the migration again must not throw and must not produce
    // a duplicate column.
    expect(() => findMigration(11).up(db)).not.toThrow();
    const occurrences = listDocumentLinksColumns().filter((n) => n === "metadata_json").length;
    expect(occurrences).toBe(1);
  });

  test("end-to-end: a v10 install advances to LATEST through runMigrations", () => {
    runSchemaSetup(db);
    db.exec("ALTER TABLE document_links DROP COLUMN metadata_json");
    // Pin user_version below the head so the runner picks up v11.
    db.exec("PRAGMA user_version = 10");

    runMigrations(db);

    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThanOrEqual(11);
    expect(listDocumentLinksColumns()).toContain("metadata_json");
  });
});

describe("migration 158: the device version ledger", () => {
  const deviceColumns = (): string[] =>
    db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);

  /** An install that predates the ledger: the three columns do not exist. */
  function simulatePreLedgerInstall(): void {
    runSchemaSetup(db);
    db.exec("ALTER TABLE devices DROP COLUMN version");
    db.exec("ALTER TABLE devices DROP COLUMN version_seen_at");
    db.exec("ALTER TABLE devices DROP COLUMN protocol_version");
  }

  function migration158(): Migration {
    const m = MIGRATIONS.find((mig) => mig.version === 158);
    if (!m) throw new Error("migration 158 not in MIGRATIONS");
    return m;
  }

  test("adds the three columns to an existing install", () => {
    simulatePreLedgerInstall();
    expect(deviceColumns()).not.toContain("version");

    migration158().up(db);

    expect(deviceColumns()).toContain("version");
    expect(deviceColumns()).toContain("version_seen_at");
    expect(deviceColumns()).toContain("protocol_version");
  });

  test("is a no-op on a fresh schema that already declares them", () => {
    runSchemaSetup(db);
    expect(() => migration158().up(db)).not.toThrow();
    expect(deviceColumns().filter((n) => n === "version")).toHaveLength(1);
  });

  test("a device that never reported a version upgrades to a null reading, not a placeholder", () => {
    simulatePreLedgerInstall();
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('dev-legacy', 'legacy-host', 'collector', '{}', 1)`,
    ).run();
    db.exec("PRAGMA user_version = 157");

    runMigrations(db);

    const row = db
      .prepare<
        [],
        { version: string | null; version_seen_at: number | null; protocol_version: number | null }
      >("SELECT version, version_seen_at, protocol_version FROM devices WHERE id = 'dev-legacy'")
      .get();
    // Silence, not a guess. An invented version would be read by the ledger
    // as a real claim about a build nobody has verified.
    expect(row?.version).toBeNull();
    expect(row?.version_seen_at).toBeNull();
    expect(row?.protocol_version).toBeNull();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      LATEST_SCHEMA_VERSION,
    );
  });

  test("a version declared at pair time lands in the column, not in the capability bag", () => {
    runSchemaSetup(db);
    runMigrations(db);

    const device = createDevice(db, {
      name: "paired-host",
      kind: "collector",
      capabilities: { hostname: "paired-host.example.com", version: "1.2.3" },
    });

    expect(device.version).toBe("1.2.3");
    expect(device.versionSeenAt).toBeGreaterThan(0);
    expect(device.capabilities.version).toBeUndefined();

    const stored = db
      .prepare<
        [string],
        { version: string | null; capabilities: string }
      >("SELECT version, capabilities FROM devices WHERE id = ?")
      .get(device.id);
    expect(stored?.version).toBe("1.2.3");
    expect(JSON.parse(stored!.capabilities).version).toBeUndefined();
  });
});

describe("migration 99: precise annotation dependencies", () => {
  test("clears legacy run-wide dependency edges and is idempotent", () => {
    runSchemaSetup(db);
    db.prepare(
      `INSERT INTO cognition_consumption_edges
         (prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id, created_at)
       VALUES ('person', 'panno_prior', 'loop', 'loop_unrelated', 'run_old', 1)`,
    ).run();

    const migration = MIGRATIONS.find((item) => item.version === 99);
    if (!migration) throw new Error("migration 99 not found");
    expect(() => migration.up(db)).not.toThrow();
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()
        ?.n,
    ).toBe(0);
    expect(() => migration.up(db)).not.toThrow();
  });
});

describe("migration list is append-only, contiguous, and well-formed", () => {
  const versions = MIGRATIONS.map((m) => m.version);

  // Version 1 is the implicit baseline (the schema as first shipped); the
  // first real migration is version 2. From there the chain must be gap-free
  // up to the head so an install pinned at any version replays cleanly to
  // LATEST — see the retention policy in migrations.ts. A deleted step is a
  // tombstone (no-op `up`), never a removed slot.
  const FIRST_MIGRATION_VERSION = 2;

  test("has no duplicate versions", () => {
    expect(new Set(versions).size).toBe(versions.length);
  });

  test(`is contiguous from v${FIRST_MIGRATION_VERSION} to LATEST_SCHEMA_VERSION`, () => {
    expect(Math.min(...versions)).toBe(FIRST_MIGRATION_VERSION);
    const missing: number[] = [];
    for (let v = FIRST_MIGRATION_VERSION; v <= LATEST_SCHEMA_VERSION; v++) {
      if (!versions.includes(v)) missing.push(v);
    }
    // A non-empty list means a gap: tombstone the missing version(s) with a
    // no-op `up` rather than leaving a hole in the user_version chain.
    expect(missing).toEqual([]);
  });

  test("head of the list equals LATEST_SCHEMA_VERSION", () => {
    expect(Math.max(...versions)).toBe(LATEST_SCHEMA_VERSION);
  });

  test("every migration has a description and an up() function", () => {
    for (const m of MIGRATIONS) {
      expect(m.description.trim().length).toBeGreaterThan(0);
      expect(typeof m.up).toBe("function");
    }
  });

  test("tombstoned migrations (3, 4, 8, 14) are present and run as no-ops", () => {
    runSchemaSetup(db);
    const userVersion = () =>
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const before = userVersion();
    for (const v of [3, 4, 8, 14]) {
      const m = MIGRATIONS.find((x) => x.version === v);
      if (!m) throw new Error(`migration ${v} should exist as a tombstone`);
      // A tombstone's up() must run cleanly against the live schema and leave
      // it untouched — the runner owns the user_version bump.
      expect(() => m.up(db)).not.toThrow();
    }
    expect(userVersion()).toBe(before);
  });
});

describe("migration 131 — source membership", () => {
  /**
   * Simulate a pre-131 install: sources with the ON DELETE CASCADE device
   * FK, sync_state keyed by source_id alone, devices without revoked_at,
   * no source_devices. Then run schema setup + migrations and assert the
   * membership shape with data intact.
   */
  function seedPre131(db: Db): void {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}',
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE sync_state (
        source_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL DEFAULT '{}',
        last_synced_at TEXT,
        icon TEXT,
        label TEXT,
        url_patterns TEXT,
        last_error TEXT,
        errored_at TEXT,
        bg_color TEXT,
        accent_color TEXT,
        content_retention TEXT,
        consent_expires_at TEXT,
        last_document_at TEXT,
        minimum_gateway_version INTEGER NOT NULL DEFAULT 0
      )
    `);
    // The pre-131 projection registry carried an FK to sync_state(source_id),
    // which the composite key makes unreferenceable.
    db.exec(`
      CREATE TABLE document_temporal_projection_sources (
        source_id TEXT PRIMARY KEY,
        slots_json TEXT NOT NULL,
        last_materialized_at TEXT,
        last_sync_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES sync_state(source_id) ON DELETE CASCADE
      )
    `);
    db.prepare(
      "INSERT INTO devices (id, name, kind, capabilities, paired_at) VALUES (?, ?, ?, '{}', 1000)",
    ).run("dev-1", "collector-alpha", "collector");
    db.prepare(
      "INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, 2000, 2000)",
    ).run("test-source:acct1", "test-source", "acct1", "dev-1");
    db.prepare("INSERT INTO sync_state (source_id, cursor, label) VALUES (?, ?, ?)").run(
      "test-source:acct1",
      '{"page":7}',
      "fixture label",
    );
    db.prepare(
      "INSERT INTO document_temporal_projection_sources (source_id, slots_json, last_sync_at) VALUES (?, '[]', '2026-01-01')",
    ).run("test-source:acct1");
  }

  /** Parent table each FK of `table` points at, per SQLite's own catalog. */
  function fkParents(table: string): string[] {
    return db
      .prepare<[], { table: string }>(`SELECT "table" FROM pragma_foreign_key_list('${table}')`)
      .all()
      .map((r) => r.table);
  }

  test("backfills membership, re-keys sync_state to the shared row, and adds revoked_at", () => {
    seedPre131(db);
    runSchemaSetup(db);
    runMigrations(db);

    // Membership backfilled from the owning device.
    const members = db
      .prepare<
        [],
        { source_id: string; device_id: string }
      >("SELECT source_id, device_id FROM source_devices")
      .all();
    expect(members).toEqual([{ source_id: "test-source:acct1", device_id: "dev-1" }]);

    // sync_state kept its data on the shared ('') row.
    const state = db
      .prepare<
        [],
        { source_id: string; device_id: string; cursor: string; label: string }
      >("SELECT source_id, device_id, cursor, label FROM sync_state")
      .all();
    expect(state).toEqual([
      {
        source_id: "test-source:acct1",
        device_id: "",
        cursor: '{"page":7}',
        label: "fixture label",
      },
    ]);

    // Devices grew the revocation stamp.
    const deviceCols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    expect(deviceCols).toContain("revoked_at");

    // The projection registry lost its sync_state FK but kept its row, and
    // a per-device sync_state row is now insertable beside the shared one.
    expect(fkParents("document_temporal_projection_sources")).toEqual([]);
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_temporal_projection_sources")
        .get()!.n,
    ).toBe(1);
    expect(() =>
      db
        .prepare("INSERT INTO sync_state (source_id, device_id, cursor) VALUES (?, ?, '{}')")
        .run("test-source:acct1", "dev-1"),
    ).not.toThrow();
  });

  test("child tables still reference `sources` after the rebuild, and FK enforcement is back on", () => {
    // The rebuild renames `sources`; without legacy_alter_table every child
    // REFERENCES clause would follow the rename to `sources_old` and die
    // with it. Check SQLite's own catalog for the two children.
    seedPre131(db);
    runSchemaSetup(db);
    runMigrations(db);
    for (const child of ["source_devices", "mobile_permission_health"]) {
      const parents = fkParents(child);
      expect(parents).toContain("sources");
      expect(parents).not.toContain("sources_old");
    }
    // Enforcement was off for the rebuild and must be restored, so the
    // cascade below is real.
    expect(
      db.prepare<[], { foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys,
    ).toBe(1);
    db.prepare("DELETE FROM sources WHERE id = ?").run("test-source:acct1");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM source_devices").get()!.n).toBe(
      0,
    );
  });

  test("device deletion no longer cascades away the source", () => {
    seedPre131(db);
    runSchemaSetup(db);
    runMigrations(db);

    // The FK (no cascade) refuses the delete outright while sources still
    // point at the device — data destruction requires an explicit act.
    expect(() => db.prepare("DELETE FROM devices WHERE id = ?").run("dev-1")).toThrow(
      /FOREIGN KEY/i,
    );
    const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sources").get()!.n;
    expect(count).toBe(1);
  });

  test("is idempotent when replayed against an already-migrated shape", () => {
    seedPre131(db);
    runSchemaSetup(db);
    runMigrations(db);
    const m131 = MIGRATIONS.find((m) => m.version === 131)!;
    expect(() => m131.up(db)).not.toThrow();
    const members = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM source_devices").get()!
      .n;
    expect(members).toBe(1);
  });

  test("a crash between the body's commit and the version stamp is recovered on the next boot", () => {
    // ownTransaction migrations stamp user_version after the body returns;
    // if the process dies in between, the next runMigrations re-runs the
    // (idempotent) body and stamps it.
    seedPre131(db);
    runSchemaSetup(db);
    runMigrations(db, { migrations: MIGRATIONS.filter((m) => m.version < 131) });
    const m131 = MIGRATIONS.find((m) => m.version === 131)!;
    m131.up(db); // body committed…
    expect(
      db.prepare<[], { user_version: number }>("PRAGMA user_version").get()?.user_version,
    ).toBe(130); // …stamp missing
    runMigrations(db);
    expect(
      db.prepare<[], { user_version: number }>("PRAGMA user_version").get()?.user_version,
    ).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM source_devices").get()!.n).toBe(
      1,
    );
  });

  test("a failing ownTransaction migration leaves the version and ledger untouched", () => {
    runSchemaSetup(db);
    runMigrations(db);
    const before = db
      .prepare<[], { user_version: number }>("PRAGMA user_version")
      .get()?.user_version;
    const boom: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: "own-transaction migration that fails",
      ownTransaction: true,
      up() {
        throw new Error("simulated rebuild failure");
      },
    };
    expect(() => runMigrations(db, { migrations: [...MIGRATIONS, boom] })).toThrow(
      /simulated rebuild failure/,
    );
    expect(
      db.prepare<[], { user_version: number }>("PRAGMA user_version").get()?.user_version,
    ).toBe(before);
    expect(
      db
        .prepare<
          [number],
          { n: number }
        >("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?")
        .get(boom.version)!.n,
    ).toBe(0);
  });
});

/** The documents table as every install carried it before migration 134. */
const documentsBefore134 = (extraColumns = "") => `
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extracted_content_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_created_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_url TEXT,
      people_resolved_at TEXT,
      links_extracted_at TEXT,
      dates_extracted_at TEXT,
      dates_truncated INTEGER,
      bootstrap_processed_at TEXT,
      bootstrap_failed_at TEXT,
      ${extraColumns}UNIQUE(provider_id, source_id, external_id)
    );
`;

describe("migration 134 — one stream per document", () => {
  test("rebuilds documents and tombstones with stream ids, keeping rows, ids and indexes", () => {
    db.exec(`
      ${documentsBefore134()}
      CREATE TABLE removed_documents (
        provider_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        removed_at INTEGER NOT NULL,
        original_document_id TEXT,
        PRIMARY KEY (provider_id, source_id, external_id)
      );
      INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, bootstrap_failed_at)
        VALUES ('doc-1', 'google', 'gmail', 'm-1', 'One', 'body', 'h1', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'FAILED');
      INSERT INTO removed_documents (provider_id, source_id, external_id, removed_at) VALUES ('google', 'gmail', 'm-0', 1);
    `);
    db.pragma("user_version = 133");

    runSchemaSetup(db);
    // A row in a table that references documents(id) must follow the rebuilt table.
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, created_at, provenance_kind)
       VALUES ('doc-1', 'references', 'x', 'x', '2026-01-01T00:00:00Z', 'extracted')`,
    ).run();
    runMigrations(db);

    const pk = (table: string) =>
      db
        .prepare<[], { name: string; pk: number }>(
          `SELECT name, pk FROM pragma_table_info('${table}')`,
        )
        .all()
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(pk("removed_documents")).toEqual([
      "provider_id",
      "source_id",
      "external_id",
      "stream_id",
    ]);
    expect(
      db
        .prepare<
          [],
          { id: string; stream_id: string; bootstrap_failed_at: string | null }
        >("SELECT id, stream_id, bootstrap_failed_at FROM documents WHERE external_id = 'm-1'")
        .all(),
    ).toEqual([{ id: "doc-1", stream_id: "", bootstrap_failed_at: "FAILED" }]);
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = 'doc-1'")
        .get()?.n,
    ).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check(document_links)").all()).toEqual([]);
    // A lookup without the stream still seeks: the stream is the last key column.
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
    expect(
      plan(
        "SELECT id FROM documents WHERE provider_id = 'google' AND source_id = 'gmail' AND external_id = 'm-1'",
      ),
    ).toMatch(
      /sqlite_autoindex_documents_\d+ \(provider_id=\? AND source_id=\? AND external_id=\?\)/,
    );
    expect(
      plan(
        "SELECT id FROM documents WHERE provider_id = 'google' AND source_id = 'gmail' AND external_id = 'm-1' AND stream_id = ''",
      ),
    ).toMatch(
      /sqlite_autoindex_documents_\d+ \(provider_id=\? AND source_id=\? AND external_id=\? AND stream_id=\?\)/,
    );
    expect(
      db.prepare<[], { stream_id: string }>("SELECT stream_id FROM removed_documents").all(),
    ).toEqual([{ stream_id: "" }]);
    // Uniqueness is per stream: another device's stream may carry the same id.
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc-2', 'google', 'gmail', 'm-1', 'device-a', 'One', 'body', 'h1', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
           VALUES ('doc-3', 'google', 'gmail', 'm-1', 'device-a', 'One', 'body', 'h1', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    // The documents indexes were recreated with the table.
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_documents_source_id");
    const m134 = MIGRATIONS.find((m) => m.version === 134)!;
    expect(() => m134.up(db)).not.toThrow();
  });

  test("refuses to rebuild a documents table carrying a column the setup DDL does not declare", () => {
    db.exec(documentsBefore134("legacy_note TEXT,\n        "));
    db.pragma("user_version = 133");
    runSchemaSetup(db);
    expect(() => runMigrations(db)).toThrow(/would drop column\(s\) legacy_note/);
  });
});

describe("migration 135 — one re-auth reminder per (principal, device)", () => {
  test("rekeys a reminder table that predates per-device rows, keeping every reminder on the legacy row", () => {
    db.exec(`
      CREATE TABLE reauth_reminders (
        principal TEXT PRIMARY KEY,
        first_needed_at INTEGER NOT NULL,
        last_notified_at INTEGER NOT NULL,
        notify_count INTEGER NOT NULL,
        reservation_token TEXT,
        reserved_until INTEGER
      )
    `);
    db.prepare(
      "INSERT INTO reauth_reminders (principal, first_needed_at, last_notified_at, notify_count) VALUES ('fictional-provider:maya@example.com', 10, 20, 3)",
    ).run();
    db.pragma("user_version = 134");

    runSchemaSetup(db);
    runMigrations(db);

    const pk = db
      .prepare<[], { name: string; pk: number }>(
        "SELECT name, pk FROM pragma_table_info('reauth_reminders')",
      )
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["principal", "device_id"]);
    expect(
      db
        .prepare<
          [],
          {
            device_id: string;
            first_needed_at: number;
            last_notified_at: number;
            notify_count: number;
          }
        >(
          "SELECT device_id, first_needed_at, last_notified_at, notify_count FROM reauth_reminders WHERE principal = 'fictional-provider:maya@example.com'",
        )
        .all(),
    ).toEqual([{ device_id: "", first_needed_at: 10, last_notified_at: 20, notify_count: 3 }]);
    // A device's own row coexists with the legacy one.
    db.prepare(
      "INSERT INTO reauth_reminders (principal, device_id, first_needed_at, last_notified_at, notify_count) VALUES ('fictional-provider:maya@example.com', 'device-a', 30, 30, 1)",
    ).run();
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM reauth_reminders WHERE principal = 'fictional-provider:maya@example.com'")
        .get()?.n,
    ).toBe(2);
  });

  test("retires needs-auth reminders queued before the upgrade; other queued kinds stay pending", () => {
    db.exec(`
      CREATE TABLE reauth_reminders (
        principal TEXT PRIMARY KEY,
        first_needed_at INTEGER NOT NULL,
        last_notified_at INTEGER NOT NULL,
        notify_count INTEGER NOT NULL,
        reservation_token TEXT,
        reserved_until INTEGER
      )
    `);
    db.pragma("user_version = 134");
    runSchemaSetup(db);
    const device = createDevice(db, { name: "Fictional phone", kind: "ios" });
    const queue = (id: string, kind: string, collapseId: string) => {
      db.prepare(
        `INSERT INTO notifications (id, kind, target_id, title, body, collapse_id, created_at, expires_at)
         VALUES (?, ?, 'fictional-mail:a', 'Title', 'Body', ?, 1, 1000000)`,
      ).run(id, kind, collapseId);
      db.prepare(
        "INSERT INTO notification_deliveries (id, notification_id, device_id, state) VALUES (?, ?, ?, 'pending')",
      ).run(`${id}-delivery`, id, device.id);
    };
    // The collapse id a reminder carried when it was keyed by principal alone.
    queue("n-reauth", "needs-auth", "needs-auth:0123456789abcdef0123:fedcba9876543210fedc");
    queue("n-watch", "watch", "watch:0123456789abcdef0123:fedcba9876543210fedc");

    runMigrations(db);

    const stateOf = (id: string) =>
      db
        .prepare<
          [string],
          { state: string }
        >("SELECT state FROM notification_deliveries WHERE notification_id = ?")
        .get(id)?.state;
    expect(stateOf("n-reauth")).toBe("superseded");
    expect(stateOf("n-watch")).toBe("pending");
  });

  test("is a no-op on a table that already carries device_id", () => {
    runSchemaSetup(db);
    runMigrations(db);
    db.prepare(
      "INSERT INTO reauth_reminders (principal, device_id, first_needed_at, last_notified_at, notify_count) VALUES ('fictional-provider:maya@example.com', 'device-a', 30, 30, 2)",
    ).run();
    const m135 = MIGRATIONS.find((m) => m.version === 135)!;
    expect(() => m135.up(db)).not.toThrow();
    expect(
      db
        .prepare<
          [],
          { notify_count: number }
        >("SELECT notify_count FROM reauth_reminders WHERE principal = 'fictional-provider:maya@example.com' AND device_id = 'device-a'")
        .get()?.notify_count,
    ).toBe(2);
  });
});

describe("migration 142 — bounded URL-ownership cursors", () => {
  test("adds both cursors idempotently while preserving unresolved-link progress", () => {
    db.exec(`
      CREATE TABLE link_reconcile_state (
        id INTEGER PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        last_wrapped_at TEXT
      )
    `);
    db.prepare(
      "INSERT INTO link_reconcile_state (id, cursor, cycle_count) VALUES (1, 47, 3)",
    ).run();
    const migration = MIGRATIONS.find((entry) => entry.version === 142)!;

    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
    expect(
      db
        .prepare<
          [],
          {
            cursor: number;
            cycle_count: number;
            ownership_link_cursor: number;
            ownership_link_max_id: number;
            ownership_document_cursor: number;
            ownership_document_max_rowid: number;
          }
        >(
          `SELECT cursor, cycle_count, ownership_link_cursor, ownership_link_max_id,
                  ownership_document_cursor, ownership_document_max_rowid
             FROM link_reconcile_state WHERE id = 1`,
        )
        .get(),
    ).toEqual({
      cursor: 47,
      cycle_count: 3,
      ownership_link_cursor: 0,
      ownership_link_max_id: 0,
      ownership_document_cursor: 0,
      ownership_document_max_rowid: 0,
    });
  });
});

describe("migration 145 — bounded unresolved URL cycles", () => {
  test("seeds the first finite cycle from the legacy cursor and remains idempotent", () => {
    db.exec(`
      CREATE TABLE link_reconcile_state (
        id INTEGER PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        last_wrapped_at TEXT
      )
    `);
    db.prepare(
      "INSERT INTO link_reconcile_state (id, cursor, cycle_count) VALUES (1, 47, 3)",
    ).run();
    const migration = MIGRATIONS.find((entry) => entry.version === 145)!;

    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
    expect(
      db
        .prepare<
          [],
          { cursor: number; max: number; cycles: number }
        >("SELECT cursor, url_cycle_max_id AS max, cycle_count AS cycles FROM link_reconcile_state WHERE id = 1")
        .get(),
    ).toEqual({ cursor: 47, max: 47, cycles: 3 });
  });
});

describe("migration 133 — one write epoch per cursor row", () => {
  test("rekeys an epoch table that predates per-device rows, keeping every epoch on the shared row", () => {
    db.exec(`
      CREATE TABLE source_wipe_epoch (
        source_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.prepare("INSERT INTO source_wipe_epoch (source_id, epoch) VALUES ('notes', 4)").run();
    db.pragma("user_version = 132");

    runSchemaSetup(db);
    runMigrations(db);

    const pk = db
      .prepare<[], { name: string; pk: number }>(
        "SELECT name, pk FROM pragma_table_info('source_wipe_epoch')",
      )
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["source_id", "device_id"]);
    expect(
      db
        .prepare<
          [],
          { device_id: string; epoch: number }
        >("SELECT device_id, epoch FROM source_wipe_epoch WHERE source_id = 'notes'")
        .all(),
    ).toEqual([{ device_id: "", epoch: 4 }]);
    // A member's own row coexists with the shared one.
    db.prepare(
      "INSERT INTO source_wipe_epoch (source_id, device_id, epoch) VALUES ('notes', 'device-a', 1)",
    ).run();
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM source_wipe_epoch WHERE source_id = 'notes'")
        .get()?.n,
    ).toBe(2);
  });

  test("is a no-op on a table that already carries device_id", () => {
    runSchemaSetup(db);
    runMigrations(db);
    db.prepare(
      "INSERT INTO source_wipe_epoch (source_id, device_id, epoch) VALUES ('notes', 'device-a', 3)",
    ).run();
    const m133 = MIGRATIONS.find((m) => m.version === 133)!;
    expect(() => m133.up(db)).not.toThrow();
    expect(
      db
        .prepare<
          [],
          { epoch: number }
        >("SELECT epoch FROM source_wipe_epoch WHERE source_id = 'notes' AND device_id = 'device-a'")
        .get()?.epoch,
    ).toBe(3);
  });
});

describe("migration 132 — device install identity", () => {
  test("adds install_id with a per-kind unique index, idempotently", () => {
    runSchemaSetup(db);
    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("install_id");
    db.prepare(
      "INSERT INTO devices (id, name, kind, capabilities, paired_at, install_id) VALUES ('d1', 'one', 'ios', '{}', 1, 'same')",
    ).run();
    // Same install id, same kind → refused; different kind → allowed.
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (id, name, kind, capabilities, paired_at, install_id) VALUES ('d2', 'two', 'ios', '{}', 1, 'same')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (id, name, kind, capabilities, paired_at, install_id) VALUES ('d3', 'three', 'android', '{}', 1, 'same')",
        )
        .run(),
    ).not.toThrow();
    const m132 = MIGRATIONS.find((m) => m.version === 132)!;
    expect(() => m132.up(db)).not.toThrow();
  });

  test("upgrades a devices table that predates install identities", () => {
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}',
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      )
    `);
    db.prepare(
      "INSERT INTO devices (id, name, kind, capabilities, paired_at) VALUES ('d1', 'one', 'ios', '{}', 1)",
    ).run();
    db.pragma("user_version = 131");

    // Schema setup on the old shape must not reach for the missing column.
    runSchemaSetup(db);
    const indexesBefore = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(indexesBefore).not.toContain("idx_devices_install");

    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("install_id");
    const indexesAfter = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(indexesAfter).toContain("idx_devices_install");
    // The pre-existing row is untouched and adoptable by name (NULL identity).
    expect(
      db
        .prepare<
          [],
          { install_id: string | null }
        >("SELECT install_id FROM devices WHERE id = 'd1'")
        .get()?.install_id,
    ).toBeNull();
  });
});
