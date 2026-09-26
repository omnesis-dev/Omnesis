// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The migration tail, replayed against an install that already holds data.
 *
 * Each migration has its own test, and each builds the tables it transforms.
 * That leaves one thing untested, and it is the thing an operator experiences:
 * the whole tail running in order, through the production open path, over a
 * database with rows in every table it touches. Two of these migrations would
 * have failed exactly there — one on a unique index the fixture omitted, the
 * other on data the previous migration in the same tail had just created.
 *
 * There is no old `runSchemaSetup` to build a historical database from; the
 * setup is always head-shaped. So the fixture goes the other way: open at head,
 * undo precisely what this tail added, wind `user_version` back, plant the rows
 * an older install would hold, and open again through `createDatabase`. What
 * runs then is the real runner over the real migrations.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import { retractAliasAssertions } from "./repositories/PersonAliasRepository.js";
import type Database from "better-sqlite3";
import type { Db } from "./types.js";

/** The version before the tail this file replays. */
const BEFORE_TAIL = 171;

/**
 * Every version the tail should record, in order. Derived rather than written
 * out: the claim is that the run is contiguous from {@link BEFORE_TAIL} to the
 * head and skips nothing, which a literal list restates as a number to update
 * rather than as a property to check.
 */
const TAIL_VERSIONS = Array.from(
  { length: LATEST_SCHEMA_VERSION - BEFORE_TAIL },
  (_, index) => BEFORE_TAIL + 1 + index,
);

/**
 * The versions {@link windBack} knows how to undo.
 *
 * The expectation above is derived from the head, so on its own it would let a
 * newly appended migration pass while this fixture still shaped the database
 * as if that migration had already run — the new step would replay over its
 * own effects, no-op through its idempotence guards, and the test would report
 * an upgrade it never performed. Naming them here is what makes appending a
 * migration without extending `windBack` a failure with a reason.
 *
 * A step that repairs stored data rather than shape has nothing for
 * `windBack` to undo; its input is planted by the test that replays it, and
 * it is named here on the same terms as the rest.
 */
const WOUND_BACK = [172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mig-tail-"));
  dbPath = join(dir, `omnesis-${randomUUID()}.db`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Undo what the tail added, so the database is shaped as an install that
 * stopped at {@link BEFORE_TAIL}.
 *
 * Written as the inverse of each `up`, and deliberately not as a hand-built
 * historical schema: the parts of the database this tail does not touch stay
 * exactly as the product creates them, so a row planted below is a row the
 * real code would have written.
 */
function windBack(db: Db): void {
  // `sources.account` is created by the head schema as well as by the
  // migration, so leaving it in place is not neutral: the migration reads the
  // column, returns early, and the tail silently covers one fewer step.
  const sourceColumns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sources')")
    .all();
  if (sourceColumns.some((row) => row.name === "account"))
    db.exec("ALTER TABLE sources DROP COLUMN account");
  db.exec("DROP TABLE IF EXISTS person_alias_assertions");
  db.exec("DROP TABLE IF EXISTS source_family_meta");
  db.exec("DROP TABLE IF EXISTS source_wire_contracts");
  db.exec("DROP TABLE IF EXISTS pending_source_page_observations");
  db.exec("DROP TABLE IF EXISTS pending_source_pages");
  db.exec("DROP TABLE IF EXISTS source_sync_issues");
  db.exec("DROP INDEX IF EXISTS idx_documents_provider_source_stream_partition");
  const hasPartition = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
    .all()
    .some((row) => row.name === "partition_key");
  if (hasPartition) db.exec("ALTER TABLE documents DROP COLUMN partition_key");
  const hasAccessLevel = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
    .all()
    .some((row) => row.name === "access_level_id");
  if (hasAccessLevel) db.exec("ALTER TABLE devices DROP COLUMN access_level_id");
  const pairingsHaveAccessLevel = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_pairings')")
    .all()
    .some((row) => row.name === "access_level_id");
  if (pairingsHaveAccessLevel) db.exec("ALTER TABLE device_pairings DROP COLUMN access_level_id");
  windBackPrivateKeyJwtClients(db);
  db.exec(`DELETE FROM schema_migrations WHERE version > ${BEFORE_TAIL}`);
  db.exec(`PRAGMA user_version = ${BEFORE_TAIL}`);
}

/**
 * Rebuild `oauth_clients` in the shape it had before migration 182: no
 * `jwks_uri` or signing algorithm, and only `none` or `client_secret_basic`.
 * The columns sit inside table CHECK constraints, so they cannot be dropped in
 * place; like the migration, the rebuild runs with foreign keys off and the
 * legacy rename so the tables that reference `oauth_clients` keep pointing at it.
 */
function windBackPrivateKeyJwtClients(db: Db): void {
  const columns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('oauth_clients')")
    .all();
  if (!columns.some((row) => row.name === "jwks_uri")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    db.exec(`
      CREATE TABLE oauth_clients_prev (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        grant_types TEXT NOT NULL,
        response_types TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL
          CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic')),
        client_secret_hash TEXT,
        client_uri TEXT,
        created_at INTEGER NOT NULL,
        CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
        CHECK (json_valid(grant_types) AND json_type(grant_types) = 'array'),
        CHECK (json_valid(response_types) AND json_type(response_types) = 'array'),
        CHECK (
          (token_endpoint_auth_method = 'none' AND client_secret_hash IS NULL) OR
          (token_endpoint_auth_method = 'client_secret_basic' AND client_secret_hash IS NOT NULL)
        )
      );
      DROP TABLE oauth_clients;
      ALTER TABLE oauth_clients_prev RENAME TO oauth_clients;
      CREATE INDEX idx_oauth_clients_created ON oauth_clients(created_at, client_id);
    `);
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Open at head, wind back, plant rows, and hand back the closed path. */
function seedOlderInstall(plant: (db: Db) => void): void {
  const db = createDatabase(dbPath) as unknown as Db;
  try {
    windBack(db);
    plant(db);
  } finally {
    (db as unknown as Database.Database).close();
  }
}

/** The upgrade an operator's next start performs. */
function upgrade(): Db {
  return createDatabase(dbPath) as unknown as Db;
}

function person(db: Db, id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'whatsapp-messages:+15550100', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

function device(db: Db, id: string, name: string): void {
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES (?, ?, 'collector', 1700000000000)",
  ).run(id, name);
}

/** A registered source, whose timestamps are planted exactly as given. */
function source(
  db: Db,
  id: string,
  deviceId: string,
  createdAt: number | string,
  updatedAt: number | string,
): void {
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES (?, 'example-source', 'local', ?, '{}', 1, ?, ?)`,
  ).run(id, deviceId, createdAt, updatedAt);
}

function alias(db: Db, id: string, personId: string, type: string, value: string, source: string) {
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-01-01')`,
  ).run(id, personId, value, type, source);
}

describe("an install several versions behind, upgrading", () => {
  test("the fixture still undoes the whole tail it replays", () => {
    // Not a property of the product: a guard on this file. Every assertion
    // below is only as good as the database `windBack` hands the runner.
    expect(WOUND_BACK).toEqual(TAIL_VERSIONS);
  });

  test("the tail runs in order and lands on the head version", () => {
    seedOlderInstall(() => {});
    const db = upgrade();
    try {
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(LATEST_SCHEMA_VERSION);
      const recorded = db
        .prepare<[], { version: number }>(
          `SELECT version FROM schema_migrations WHERE version > ${BEFORE_TAIL} ORDER BY version`,
        )
        .all()
        .map((row) => row.version);
      expect(recorded).toEqual(TAIL_VERSIONS);
      // Recording a version and doing its work are different facts. This one
      // is the tail's cheapest step and the easiest to leave unexercised: the
      // head schema creates the same column, so a fixture that does not undo
      // it lets the migration return early and still be recorded.
      expect(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sources')")
          .all()
          .map((row) => row.name),
      ).toContain("account");
      expect(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
          .all()
          .map((row) => row.name),
      ).toContain("access_level_id");
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("every stored identifier gains an assertion from the source that saw it", () => {
    seedOlderInstall((db) => {
      person(db, "p-1", "maya-reeves");
      alias(db, "a-1", "p-1", "email", "maya@example.org", "gmail:me@example.org");
      alias(db, "a-2", "p-1", "phone", "+15550100142", "apple-contacts:local");
    });

    const db = upgrade();
    try {
      expect(
        db
          .prepare<[], { alias_id: string; source_id: string }>(
            "SELECT alias_id, source_id FROM person_alias_assertions ORDER BY alias_id",
          )
          .all(),
      ).toEqual([
        { alias_id: "a-1", source_id: "gmail:me@example.org" },
        { alias_id: "a-2", source_id: "apple-contacts:local" },
      ]);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("removing the first asserter preserves identifiers still used by installed documents", () => {
    seedOlderInstall((db) => {
      person(db, "p-shared", "Shared fixture person");
      alias(db, "a-shared", "p-shared", "email", "maya@example.org", "example-contacts:local");
      db.prepare(
        `INSERT INTO documents
        (id, provider_id, source_id, external_id, title, content, content_hash, metadata,
         source_created_at, source_updated_at, ingested_at, updated_at)
        VALUES ('d-shared', 'example', 'example-mail:local', 'message-1', 'Example', 'Body',
                'hash', '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
      ).run();
      db.prepare(
        "INSERT INTO document_people (document_id, person_id, role) VALUES ('d-shared', 'p-shared', 'sender')",
      ).run();
    });
    const db = upgrade();
    try {
      retractAliasAssertions(db as unknown as Database.Database, "example-contacts:local");
      expect(db.prepare("SELECT alias FROM person_aliases WHERE id = 'a-shared'").get()).toEqual({
        alias: "maya@example.org",
      });
      expect(
        db
          .prepare("SELECT source_id FROM person_alias_assertions WHERE alias_id = 'a-shared'")
          .all(),
      ).toEqual([{ source_id: "example-mail:local" }]);
      expect(
        db.prepare("SELECT person_id FROM document_people WHERE document_id = 'd-shared'").get(),
      ).toEqual({ person_id: "p-shared" });
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("a person holding both spellings of one identifier opens rather than failing", () => {
    // The collector updates before the gateway, so the prefixed twin is
    // already stored when the rewrite runs. Colliding on the unique index
    // here does not fail one migration — it fails the open, on every start,
    // for good.
    seedOlderInstall((db) => {
      person(db, "p-2", "jamie-lopez");
      alias(db, "a-bare", "p-2", "lid", "441234567890", "whatsapp-messages:+15550100");
      alias(db, "a-pref", "p-2", "lid", "whatsapp:441234567890", "whatsapp-messages:+15550100");
    });

    const db = upgrade();
    try {
      expect(
        db
          .prepare<[], { alias: string }>(
            "SELECT alias FROM person_aliases WHERE person_id = 'p-2' AND alias_type = 'lid'",
          )
          .all()
          .map((row) => row.alias),
      ).toEqual(["whatsapp:441234567890"]);
      // And the surviving row carries the assertion migration 173 wrote for
      // each of them a moment earlier, folded rather than dropped.
      expect(
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM person_alias_assertions a JOIN person_aliases al ON al.id = a.alias_id WHERE al.person_id = 'p-2'",
          )
          .get()!.n,
      ).toBe(1);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("stored documents land in the unnamed partition, which a whole-source snapshot claims", () => {
    seedOlderInstall((db) => {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES ('d-1', 'apple', 'apple-contacts:local', 'uuid-1', 'A contact', 'body', 'hash-1', '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
      ).run();
    });

    const db = upgrade();
    try {
      expect(
        db
          .prepare<[], { partition_key: string }>("SELECT partition_key FROM documents")
          .all()
          .map((row) => row.partition_key),
      ).toEqual([""]);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("no family identity is invented for a type whose accounts disagree", () => {
    seedOlderInstall((db) => {
      for (const [id, label] of [
        ["example-bank:one", "First institution"],
        ["example-bank:two", "Second institution"],
      ]) {
        db.prepare(`INSERT INTO sync_state (source_id, cursor, label) VALUES (?, '{}', ?)`).run(
          id,
          label,
        );
      }
    });

    const db = upgrade();
    try {
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM source_family_meta").get()!.n,
      ).toBe(0);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("a source stamped with a text timestamp becomes one its clients can decode", () => {
    // The clients decode `created_at` / `updated_at` as 64-bit integers for
    // every row of `/admin/sources`, so one text stamp costs them the whole
    // page. The row is planted the way the writer that produced it left it:
    // the id and the other timestamp intact, the stamp an ISO-8601 string.
    seedOlderInstall((db) => {
      device(db, "dev-1", "Fictional collector");
      source(db, "example-source:one", "dev-1", 1_700_000_000_000, "2026-09-19T16:57:54.032Z");
      source(db, "example-source:two", "dev-1", 1_700_000_000_001, 1_700_000_000_002);
    });

    const db = upgrade();
    try {
      expect(
        db
          .prepare<
            [],
            { id: string; created: string; updated: string; created_at: number; updated_at: number }
          >(
            `SELECT id, typeof(created_at) AS created, typeof(updated_at) AS updated,
                    created_at, updated_at
               FROM sources ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "example-source:one",
          created: "integer",
          updated: "integer",
          created_at: 1_700_000_000_000,
          updated_at: Date.parse("2026-09-19T16:57:54.032Z"),
        },
        {
          id: "example-source:two",
          created: "integer",
          updated: "integer",
          created_at: 1_700_000_000_001,
          updated_at: 1_700_000_000_002,
        },
      ]);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("a stamp that says nothing readable still leaves the row decodable", () => {
    seedOlderInstall((db) => {
      device(db, "dev-2", "Fictional collector");
      source(db, "example-source:three", "dev-2", 1_700_000_000_003, "not a timestamp");
    });

    const db = upgrade();
    try {
      // Nothing is recoverable from the stamp itself, so the row falls back to
      // the one timestamp it does have rather than staying undecodable.
      const row = db
        .prepare<[], { updated: string; updated_at: number }>(
          "SELECT typeof(updated_at) AS updated, updated_at FROM sources",
        )
        .get()!;
      expect(row.updated).toBe("integer");
      expect(row.updated_at).toBe(1_700_000_000_003);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("a registered OAuth client keeps its secret and can move to private_key_jwt", () => {
    seedOlderInstall((db) => {
      db.prepare(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types,
           response_types, token_endpoint_auth_method, client_secret_hash, created_at)
         VALUES ('client-a', 'agent client', '["https://agent.example.com/cb"]',
           '["authorization_code"]', '["code"]', 'client_secret_basic', 'hash-a', 1700000000000)`,
      ).run();
    });

    const db = upgrade();
    try {
      const row = db
        .prepare<[], { method: string; secret: string | null; jwks: string | null }>(
          "SELECT token_endpoint_auth_method AS method, client_secret_hash AS secret, jwks_uri AS jwks FROM oauth_clients",
        )
        .get()!;
      expect(row).toEqual({ method: "client_secret_basic", secret: "hash-a", jwks: null });
      db.prepare(
        `UPDATE oauth_clients SET token_endpoint_auth_method = 'private_key_jwt',
           client_secret_hash = NULL, jwks_uri = 'https://agent.example.com/jwks.json',
           token_endpoint_auth_signing_alg = 'ES256' WHERE client_id = 'client-a'`,
      ).run();
    } finally {
      (db as unknown as Database.Database).close();
    }
  });

  test("a second open changes nothing", () => {
    seedOlderInstall((db) => {
      person(db, "p-3", "david-lin");
      alias(db, "a-3", "p-3", "email", "david@example.org", "gmail:me@example.org");
    });
    const first = upgrade();
    (first as unknown as Database.Database).close();

    const db = upgrade();
    try {
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_alias_assertions").get()!.n,
      ).toBe(1);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM schema_migrations WHERE version > ${BEFORE_TAIL}`,
          )
          .get()!.n,
      ).toBe(TAIL_VERSIONS.length);
    } finally {
      (db as unknown as Database.Database).close();
    }
  });
});
