// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      push_transport TEXT,
      relay_url TEXT,
      relay_credential TEXT
    )
  `);
  db.prepare(
    "INSERT INTO devices (id, push_transport, relay_url, relay_credential) VALUES (?, ?, ?, ?)",
  ).run("fictional-phone", "relay", "https://relay.example", "fictional-credential");
});

afterEach(() => db.close());

test("adds empty consent fields without treating a legacy relay registration as consent", () => {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 165);
  expect(migration).toBeDefined();

  migration!.up(db);
  migration!.up(db);

  expect(
    db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((row) => row.name),
  ).toEqual(expect.arrayContaining(["relay_consent_app_id", "relay_consented_at"]));
  expect(
    db
      .prepare<
        [],
        {
          push_transport: string | null;
          relay_url: string | null;
          relay_credential: string | null;
          app_id: string | null;
          consented_at: number | null;
        }
      >(
        `SELECT push_transport, relay_url, relay_credential,
                relay_consent_app_id AS app_id, relay_consented_at AS consented_at
           FROM devices`,
      )
      .get(),
  ).toEqual({
    push_transport: null,
    relay_url: null,
    relay_credential: null,
    app_id: null,
    consented_at: null,
  });
});

test("upgrades historical device tables that predate push registration fields", () => {
  db.exec(`
    DROP TABLE devices;
    CREATE TABLE devices (
      id TEXT PRIMARY KEY
    );
    INSERT INTO devices (id) VALUES ('historical-device');
  `);

  const migration = MIGRATIONS.find((candidate) => candidate.version === 165);
  expect(migration).toBeDefined();

  migration!.up(db);
  migration!.up(db);

  expect(
    db
      .prepare<[], { app_id: string | null; consented_at: number | null }>(
        `SELECT relay_consent_app_id AS app_id, relay_consented_at AS consented_at
           FROM devices`,
      )
      .get(),
  ).toEqual({ app_id: null, consented_at: null });
});
