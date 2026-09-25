// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 77 rekeys document temporal projections onto the document they
 * describe.
 *
 * The old key omitted the provider, so two documents differing only in
 * provider — legitimately distinct rows — computed one id. The second to be
 * written collided with the first, which failed the page and stalled the
 * source. Rekeying is only safe if it is collision-free for rows already
 * stored, and if it leaves every row otherwise untouched.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

let db: Database.Database;

const migration77 = MIGRATIONS.find((m) => m.version === 77)!;

const expectedId = (documentId: string, slot: string): string =>
  `tp_${createHash("sha256").update(`${documentId}\0${slot}`).digest("hex").slice(0, 32)}`;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

function seed(): void {
  db.exec(`
    CREATE TABLE document_temporal_projections (
      id TEXT PRIMARY KEY CHECK (id LIKE 'tp_%'),
      source_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_external_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_exclusive_ms INTEGER NOT NULL,
      start_canonical TEXT NOT NULL,
      end_canonical TEXT NOT NULL,
      precision TEXT NOT NULL,
      all_day INTEGER NOT NULL,
      time_zone TEXT,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      modality TEXT NOT NULL,
      status TEXT NOT NULL,
      source_updated_at TEXT,
      projected_at TEXT NOT NULL,
      UNIQUE(document_id, slot)
    )
  `);
  const insert = db.prepare(
    `INSERT INTO document_temporal_projections VALUES
     (?, 'mail:inbox', ?, ?, ?, 100, 200, 'a', 'b', 'instant', 0, NULL, ?, 'event', 'asserted', 'active', NULL, 'p')`,
  );
  // Two documents, two slots each — the shape the old key could not tell apart.
  insert.run("tp_old_one", "doc-one", "ext-shared", "scheduled", "First");
  insert.run("tp_old_two", "doc-one", "ext-shared", "due", "First deadline");
  insert.run("tp_old_three", "doc-two", "ext-shared", "scheduled", "Second");
}

describe("migration 77", () => {
  test("rekeys every row onto its document and slot", () => {
    seed();
    migration77.up(db);

    const rows = db
      .prepare<
        [],
        { id: string; document_id: string; slot: string; label: string }
      >("SELECT id, document_id, slot, label FROM document_temporal_projections ORDER BY label")
      .all();

    expect(rows.map((r) => r.id)).toEqual(rows.map((r) => expectedId(r.document_id, r.slot)));
    // Distinct documents no longer share a key, which is the whole point.
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  test("changes nothing but the key", () => {
    seed();
    const before = db
      .prepare(
        "SELECT document_id, slot, label, start_ms, kind FROM document_temporal_projections ORDER BY label",
      )
      .all();
    migration77.up(db);
    const after = db
      .prepare(
        "SELECT document_id, slot, label, start_ms, kind FROM document_temporal_projections ORDER BY label",
      )
      .all();
    expect(after).toEqual(before);
  });

  test("is safe to replay", () => {
    seed();
    migration77.up(db);
    const first = db.prepare("SELECT * FROM document_temporal_projections ORDER BY id").all();
    migration77.up(db);
    expect(db.prepare("SELECT * FROM document_temporal_projections ORDER BY id").all()).toEqual(
      first,
    );
  });

  test("carries an annotation's citation of a projection across the rekey", () => {
    seed();
    db.exec(`
      CREATE TABLE temporal_annotation_projections (
        annotation_id TEXT NOT NULL,
        projection_id TEXT NOT NULL CHECK (projection_id LIKE 'tp_%'),
        PRIMARY KEY (annotation_id, projection_id)
      )
    `);
    db.prepare("INSERT INTO temporal_annotation_projections VALUES (?, ?)").run(
      "ta_one",
      "tp_old_one",
    );
    // An analytics-row projection keeps its key, so a link to one must not move.
    db.prepare("INSERT INTO temporal_annotation_projections VALUES (?, ?)").run(
      "ta_two",
      "tp_analytics_untouched",
    );

    migration77.up(db);

    const links = db
      .prepare<
        [],
        { annotation_id: string; projection_id: string }
      >("SELECT annotation_id, projection_id FROM temporal_annotation_projections ORDER BY annotation_id")
      .all();
    expect(links).toEqual([
      { annotation_id: "ta_one", projection_id: expectedId("doc-one", "scheduled") },
      { annotation_id: "ta_two", projection_id: "tp_analytics_untouched" },
    ]);

    // The citation still resolves to a row that exists.
    const target = db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM document_temporal_projections WHERE id = ?")
      .get(links[0]!.projection_id);
    expect(target).toBeDefined();
  });

  test("does nothing on an empty or absent table", () => {
    seed();
    db.exec("DELETE FROM document_temporal_projections");
    expect(() => migration77.up(db)).not.toThrow();

    const fresh = new Database(":memory:");
    try {
      expect(() => migration77.up(fresh)).not.toThrow();
    } finally {
      fresh.close();
    }
  });
});
