// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { addAnnotationRecheckQueuedAt } from "./migration-213-annotation-recheck-queued.js";

it("adds the column to both stores, keeps existing rows and can run twice", () => {
  const db = new Database(":memory:");
  try {
    for (const table of ["doc_annotations", "person_annotations"]) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, last_verified_at INTEGER)`);
      db.prepare(`INSERT INTO ${table} VALUES ('fixture', 7)`).run();
    }

    addAnnotationRecheckQueuedAt(db);
    addAnnotationRecheckQueuedAt(db);

    for (const table of ["doc_annotations", "person_annotations"]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([
        { id: "fixture", last_verified_at: 7, last_recheck_queued_at: null },
      ]);
    }
  } finally {
    db.close();
  }
});
