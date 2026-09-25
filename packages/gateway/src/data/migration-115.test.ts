// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 115)!;

describe("migration 115", () => {
  test("rebases receipt-relative validity onto the phone observation time idempotently", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    db.exec(`
      CREATE TABLE mobile_permission_health (
        source_id TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        valid_until INTEGER NOT NULL
      );
      INSERT INTO mobile_permission_health VALUES (
        'fictional-mobile:local', 1000, 20000, 80000
      );
    `);

    migration.up(db);
    expect(
      db.prepare("SELECT valid_until, validity_anchored FROM mobile_permission_health").get(),
    ).toEqual({ valid_until: 61_000, validity_anchored: 1 });

    // An older process may write after the first replay but before a retry.
    // The column default marks that receipt-relative row for the next replay.
    db.exec(`
      INSERT INTO mobile_permission_health (
        source_id, checked_at, received_at, valid_until
      ) VALUES (
        'fictional-mobile:late', 2000, 30000, 90000
      )
    `);

    migration.up(db);
    expect(
      db
        .prepare(
          "SELECT source_id, valid_until, validity_anchored FROM mobile_permission_health ORDER BY source_id",
        )
        .all(),
    ).toEqual([
      { source_id: "fictional-mobile:late", valid_until: 62_000, validity_anchored: 1 },
      { source_id: "fictional-mobile:local", valid_until: 61_000, validity_anchored: 1 },
    ]);

    // Upgraded writers explicitly store the marker. A later replay must not
    // reinterpret their already observation-anchored expiry.
    db.exec(`
      INSERT INTO mobile_permission_health VALUES (
        'fictional-mobile:fresh', 3000, 40000, 63000, 1
      )
    `);
    migration.up(db);
    expect(
      db
        .prepare(
          "SELECT valid_until, validity_anchored FROM mobile_permission_health WHERE source_id = 'fictional-mobile:fresh'",
        )
        .get(),
    ).toEqual({ valid_until: 63_000, validity_anchored: 1 });
    db.close();
  });
});
