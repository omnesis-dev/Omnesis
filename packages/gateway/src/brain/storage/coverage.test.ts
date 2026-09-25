// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the per-source coverage store: increments accumulate on the
 * (source, workflow, workflow version) key, the status the counters imply is
 * written on every upsert, and a source the gateway no longer knows about in
 * any form loses its coverage — a claim about a corpus cannot outlive that
 * corpus. The retraction's two halves are tested separately, because each
 * alone is wrong: on the registration alone it would strand the
 * gateway-internal sources, which mirror documents into the corpus without a
 * `sources` row; on the documents alone it would retract a still-connected
 * source that a resync merely emptied.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import {
  documentSourceId,
  hasAnyCognitionCoverage,
  listCognitionCoverage,
  recordCognitionCoverage,
  retractOrphanCognitionCoverage,
} from "./coverage.js";
import type Database from "better-sqlite3";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("cognition coverage", () => {
  let path: string;
  let db: Db;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function seedDoc(externalId: string, sourceId: string): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: sourceId as DocumentInput["sourceId"],
      externalId,
      title: "Quarterly review",
      content: "body",
      contentHash: `hash-${externalId}`,
      metadata: { documentType: "email" },
      sourceCreatedAt: "2024-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  /** A `sources` row — a source the gateway is still connected to. */
  function seedSource(id: string): void {
    db.prepare("INSERT OR IGNORE INTO devices (id, name, kind, paired_at) VALUES (?, ?, ?, ?)").run(
      "device-1",
      "Test collector",
      "collector",
      1,
    );
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'device-1', '{}', 1, ?, ?)`,
    ).run(id, id.split(":")[0], id.split(":")[1] ?? "local", NOW, NOW);
  }

  test("accumulates increments and derives the status from the counters", () => {
    const key = {
      sourceId: "mail:maya@example.com",
      workflowId: "source-bootstrap",
      workflowVersion: 1,
    };
    recordCognitionCoverage(db, [{ ...key, eligible: 3 }], NOW);
    expect(listCognitionCoverage(db)[0]).toMatchObject({
      eligible: 3,
      processed: 0,
      status: "in-progress",
    });

    recordCognitionCoverage(
      db,
      [{ ...key, processed: 2, promptTokens: 900, completionTokens: 120 }],
      NOW + 1_000,
    );
    expect(listCognitionCoverage(db)[0]).toMatchObject({
      eligible: 3,
      processed: 2,
      promptTokens: 900,
      completionTokens: 120,
      lastProgressAt: NOW + 1_000,
      status: "in-progress",
    });

    // The last selected document settles — completed or given up on, either
    // way there is nothing outstanding.
    recordCognitionCoverage(db, [{ ...key, skipped: 1 }], NOW + 2_000);
    expect(listCognitionCoverage(db)[0]).toMatchObject({
      processed: 2,
      skipped: 1,
      status: "settled",
    });
  });

  test("a lane with no backlog reads as live, not covered", () => {
    // The real-time lane never declares documents eligible: it reacts to what
    // arrives. Calling that "settled" would claim a completeness nobody
    // measured.
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "chat:jamie@example.com",
          workflowId: "datum-intake",
          workflowVersion: 1,
          processed: 4,
        },
      ],
      NOW,
    );
    expect(listCognitionCoverage(db)[0]).toMatchObject({ processed: 4, status: "live" });
  });

  test("one workflow's versions keep separate tallies", () => {
    const base = { sourceId: "mail:maya@example.com", workflowId: "source-bootstrap" };
    recordCognitionCoverage(db, [{ ...base, workflowVersion: 1, eligible: 5, processed: 5 }], NOW);
    recordCognitionCoverage(db, [{ ...base, workflowVersion: 2, eligible: 2 }], NOW + 1);
    expect(listCognitionCoverage(db).map((r) => [r.workflowVersion, r.eligible, r.status])).toEqual(
      [
        [2, 2, "in-progress"],
        [1, 5, "settled"],
      ],
    );
  });

  test("retracts coverage for a source with neither a registration nor a document", () => {
    seedDoc("kept-1", "mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "files:jamie@example.com");
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          eligible: 1,
        },
        {
          sourceId: "files:jamie@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          eligible: 1,
        },
      ],
      NOW,
    );
    expect(hasAnyCognitionCoverage(db)).toBe(true);

    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    expect(retractOrphanCognitionCoverage(db)).toBe(1);
    expect(listCognitionCoverage(db).map((r) => r.sourceId)).toEqual(["mail:maya@example.com"]);
  });

  test("keeps the coverage of a still-registered source whose corpus was emptied", () => {
    // A resync, or a provider-side purge: the documents go, the source stays.
    // Retracting here would throw away a real tally and let the next settled
    // run rebuild the row as `live` — "no backlog" — about a source whose
    // entire history is still waiting to be reviewed.
    seedSource("mail:maya@example.com");
    const emptied = seedDoc("doomed-1", "mail:maya@example.com");
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          eligible: 400,
          processed: 400,
        },
      ],
      NOW,
    );

    db.prepare("DELETE FROM documents WHERE id = ?").run(emptied);
    expect(retractOrphanCognitionCoverage(db)).toBe(0);
    expect(listCognitionCoverage(db)[0]).toMatchObject({
      sourceId: "mail:maya@example.com",
      eligible: 400,
      status: "settled",
    });
  });

  test("resolves a document's source, and reports null once it is gone", () => {
    const id = seedDoc("kept-1", "mail:maya@example.com");
    expect(documentSourceId(db, id)).toBe("mail:maya@example.com");
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    expect(documentSourceId(db, id)).toBeNull();
  });

  test("an install that never enabled the Brain has nothing to retract", () => {
    expect(hasAnyCognitionCoverage(db)).toBe(false);
    expect(retractOrphanCognitionCoverage(db)).toBe(0);
  });
});
