// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The derivation registry's readers: per-document state, batch completion and
 * readiness filters, and the head-of-queue age the SLA observers report.
 */

import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import {
  DERIVATION_STAGES,
  derivationReadyDocIds,
  derivationStageLabels,
  documentDerivationState,
  oldestPendingDerivationMs,
} from "./DocumentDerivation.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const NOW = "2026-08-09T12:00:00.000Z";

describe("document derivation", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      /* already gone */
    }
  });

  function seedDoc(id: string, opts: { derived?: boolean; ingestedAt?: string } = {}): void {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'web', 'web:pages', ?, ?, '', ?, '{}', ?, ?, ?, ?)`,
    ).run(id, id, `Title ${id}`, `h-${id}`, NOW, NOW, opts.ingestedAt ?? NOW, NOW);
    if (opts.derived === true) {
      for (const stage of DERIVATION_STAGES) {
        db.prepare(`UPDATE documents SET ${stage.column} = ? WHERE id = ?`).run(NOW, id);
      }
    }
  }

  test("a freshly ingested document has every stage pending", () => {
    seedDoc("doc-1");
    const state = documentDerivationState(db, "doc-1");
    expect(state.exists).toBe(true);
    expect(state.complete).toBe(false);
    expect(state.pending).toEqual(DERIVATION_STAGES.map((s) => s.id));
  });

  test("a fully stamped document is complete with nothing pending", () => {
    seedDoc("doc-1", { derived: true });
    const state = documentDerivationState(db, "doc-1");
    expect(state.complete).toBe(true);
    expect(state.pending).toEqual([]);
  });

  test("a partially derived document reports only the stages still missing", () => {
    seedDoc("doc-1", { derived: true });
    db.prepare("UPDATE documents SET links_extracted_at = NULL WHERE id = ?").run("doc-1");
    const state = documentDerivationState(db, "doc-1");
    expect(state.complete).toBe(false);
    expect(state.pending).toEqual(["links"]);
    expect(derivationStageLabels(state.pending)).toEqual(["reference-graph edges"]);
  });

  test("a deleted document is not something to wait for", () => {
    // The barrier must not hold a run forever on a datum that no longer
    // exists; the data-run prompt handles the deleted case on its own.
    const state = documentDerivationState(db, "gone");
    expect(state.exists).toBe(false);
    expect(state.complete).toBe(false);
    expect(state.pending).toEqual([]);
  });

  test("the readiness filter includes fully derived and deleted ids", () => {
    seedDoc("done-1", { derived: true });
    seedDoc("done-2", { derived: true });
    seedDoc("pending-1");
    seedDoc("partial-1", { derived: true });
    db.prepare("UPDATE documents SET people_resolved_at = NULL WHERE id = ?").run("partial-1");

    const ready = derivationReadyDocIds(db, ["done-1", "done-2", "pending-1", "partial-1", "gone"]);
    expect([...ready].sort()).toEqual(["done-1", "done-2", "gone"]);
  });

  test("the batch filter short-circuits on an empty input", () => {
    expect(derivationReadyDocIds(db, []).size).toBe(0);
  });

  test("oldest-pending age measures the head of the backlog, not the newest arrival", () => {
    const now = Date.parse(NOW);
    seedDoc("old", { ingestedAt: new Date(now - 3 * 3_600_000).toISOString() });
    seedDoc("recent", { ingestedAt: new Date(now - 60_000).toISOString() });
    const stage = DERIVATION_STAGES[0];
    expect(oldestPendingDerivationMs(db, stage, now)).toBe(3 * 3_600_000);
  });

  test("oldest-pending age is null once the stage has drained", () => {
    seedDoc("doc-1", { derived: true });
    const stage = DERIVATION_STAGES[0];
    expect(oldestPendingDerivationMs(db, stage, Date.parse(NOW))).toBeNull();
  });

  test("every registered stage names a real documents column", () => {
    // The registry drives SQL built by string interpolation; a stage naming a
    // column that does not exist would fail at runtime, in the barrier, on the
    // reactive path.
    const columns = new Set(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
        .all()
        .map((r) => r.name),
    );
    for (const stage of DERIVATION_STAGES) {
      expect(columns.has(stage.column)).toBe(true);
    }
  });
});
