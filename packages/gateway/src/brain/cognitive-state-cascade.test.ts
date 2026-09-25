// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive-state cascade's coverage arm: removing a source retracts the
 * coverage claimed over it.
 *
 * The claim matters more than the row. "This source's history has been
 * reviewed" is a statement about a corpus; once the source is gone the
 * statement is unfalsifiable and, on a re-added source, wrong. Every
 * document-delete path runs this one function, which is why the retraction
 * belongs here rather than in each of them.
 *
 * Removal is the trigger, not deletion: this arm alone reasons about the
 * source rather than the documents it is handed, so it runs even for a call
 * that names none, and it leaves a still-connected source alone however much
 * of its corpus just went.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { upsertDocuments } from "../data/repositories/DocumentRepository.js";
import { listPendingAbsenceCascades } from "../data/repositories/AbsenceRepository.js";
import { purgeCognitiveStateForDocs } from "./cognitive-state-cascade.js";
import { listCognitionCoverage, recordCognitionCoverage } from "./storage/coverage.js";
import { createOpenLoop, getOpenLoop } from "./storage/open-loops.js";
import { createBrief, getBrief } from "./storage/briefs.js";
import { OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID } from "./open-loop-source/source-meta.js";
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

describe("purgeCognitiveStateForDocs", () => {
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

  function seedDoc(externalId: string, sourceId: string, providerId = "test"): string {
    const doc: DocumentInput = {
      providerId: providerId as DocumentInput["providerId"],
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

  function seedCoverage(sourceId: string): void {
    recordCognitionCoverage(
      db,
      [{ sourceId, workflowId: "source-bootstrap", workflowVersion: 1, eligible: 1, processed: 1 }],
      NOW,
    );
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

  test("drops the removed source's coverage and keeps every other source's", async () => {
    seedSource("files:jamie@example.com");
    seedSource("mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "files:jamie@example.com");
    seedDoc("kept-1", "mail:maya@example.com");
    seedCoverage("files:jamie@example.com");
    seedCoverage("mail:maya@example.com");

    // Source removal drops the `sources` row, sweeps the documents, then hands
    // the cascade their ids — in that order.
    db.prepare("DELETE FROM sources WHERE id = ?").run("files:jamie@example.com");
    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    await purgeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db).map((r) => r.sourceId)).toEqual(["mail:maya@example.com"]);
  });

  test("a partial delete leaves the source's coverage standing", async () => {
    seedSource("mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "mail:maya@example.com");
    seedDoc("kept-1", "mail:maya@example.com");
    seedCoverage("mail:maya@example.com");

    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    await purgeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db)).toHaveLength(1);
  });

  test("emptying a still-connected source keeps its coverage", async () => {
    seedSource("mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "mail:maya@example.com");
    seedCoverage("mail:maya@example.com");

    // Every document gone, the source still connected — a resync, not a
    // removal. Its history is still unreviewed and its tally still says so.
    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    await purgeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db)).toHaveLength(1);
  });

  test("retracts a removed source's coverage even when no documents are named", async () => {
    // Its corpus was already emptied by an earlier delete, so the removal
    // sweep finds nothing to hand over. The coverage row would otherwise
    // outlive every trace of the source it describes.
    seedCoverage("files:jamie@example.com");

    await purgeCognitiveStateForDocs(db, directWriteGate(db), []);

    expect(listCognitionCoverage(db)).toHaveLength(0);
  });

  test("a failed mirror delete rolls back the loop, brief and cleanup obligation for retry", async () => {
    const evidenceId = seedDoc("evidence-1", "notes-synth:local");
    const loopId = "olp_retry";
    createOpenLoop(
      db,
      {
        id: loopId,
        createdByRun: "run_1",
        title: "Confirm the studio booking",
        description: "Awaiting a reply from the studio.",
        confidence: 0.8,
        importance: 0.6,
        docs: [evidenceId],
      },
      NOW,
    );
    createBrief(
      db,
      {
        id: "brf_retry",
        createdByRun: "run_1",
        kind: "loop",
        title: "Studio booking still unconfirmed",
        confidence: 0.8,
        urgency: 0.4,
        relatedLoopIds: [loopId],
      },
      NOW,
    );
    const mirrorId = seedDoc(loopId, OPEN_LOOP_SOURCE_ID, OPEN_LOOP_PROVIDER_ID);
    db.prepare("DELETE FROM documents WHERE id = ?").run(evidenceId);
    const gate = directWriteGate(db);
    const mirrorExists = () =>
      db
        .prepare<
          [string, string, string],
          { id: string }
        >("SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
        .get(OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID, loopId) !== undefined;
    db.exec(`
      CREATE TRIGGER reject_mirror_delete BEFORE DELETE ON documents
      WHEN OLD.provider_id = '${OPEN_LOOP_PROVIDER_ID}' AND OLD.source_id = '${OPEN_LOOP_SOURCE_ID}'
      BEGIN SELECT RAISE(ABORT, 'mirror write unavailable'); END
    `);

    await expect(purgeCognitiveStateForDocs(db, gate, [evidenceId])).rejects.toThrow(
      "mirror write unavailable",
    );
    expect(mirrorExists()).toBe(true);
    expect(getOpenLoop(db, loopId)).not.toBeNull();
    expect(getBrief(db, "brf_retry")).not.toBeNull();
    expect(listPendingAbsenceCascades(db, 10)).toEqual([]);

    db.exec("DROP TRIGGER reject_mirror_delete");
    await purgeCognitiveStateForDocs(db, gate, [evidenceId]);
    expect(mirrorExists()).toBe(false);
    expect(getOpenLoop(db, loopId)).toBeNull();
    expect(getBrief(db, "brf_retry")).toBeNull();
    expect(listPendingAbsenceCascades(db, 10)).toMatchObject([
      { documentIds: [mirrorId], indexDone: false, cognitionDone: false },
    ]);
  });
});
