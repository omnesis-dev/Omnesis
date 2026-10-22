// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive-state cascade: removing a source retracts the coverage claimed
 * over it, and the artifacts built on deleted documents are kept for review.
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
import {
  cascadeCognitiveStateForDocs,
  SOURCE_DELETION_REVIEW_BATCH,
} from "./cognitive-state-cascade.js";
import { listCognitionCoverage, recordCognitionCoverage } from "./storage/coverage.js";
import { createOpenLoop, getOpenLoop } from "./storage/open-loops.js";
import { createObservation, getObservation } from "./storage/observations.js";
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

describe("cascadeCognitiveStateForDocs", () => {
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
    await cascadeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db).map((r) => r.sourceId)).toEqual(["mail:maya@example.com"]);
  });

  test("a partial delete leaves the source's coverage standing", async () => {
    seedSource("mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "mail:maya@example.com");
    seedDoc("kept-1", "mail:maya@example.com");
    seedCoverage("mail:maya@example.com");

    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    await cascadeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db)).toHaveLength(1);
  });

  test("emptying a still-connected source keeps its coverage", async () => {
    seedSource("mail:maya@example.com");
    const doomed = seedDoc("doomed-1", "mail:maya@example.com");
    seedCoverage("mail:maya@example.com");

    // Every document gone, the source still connected — a resync, not a
    // removal. Its history is still unreviewed and its tally still says so.
    db.prepare("DELETE FROM documents WHERE id = ?").run(doomed);
    await cascadeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);

    expect(listCognitionCoverage(db)).toHaveLength(1);
  });

  test("retracts a removed source's coverage even when no documents are named", async () => {
    // Its corpus was already emptied by an earlier delete, so the removal
    // sweep finds nothing to hand over. The coverage row would otherwise
    // outlive every trace of the source it describes.
    seedCoverage("files:jamie@example.com");

    await cascadeCognitiveStateForDocs(db, directWriteGate(db), []);

    expect(listCognitionCoverage(db)).toHaveLength(0);
  });

  test("keeps the loops and observations built on deleted documents and queues them for review", async () => {
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
    createObservation(
      db,
      {
        id: "obs_retry",
        createdByRun: "run_1",
        summary: "Studio booking still unconfirmed",
        citations: [evidenceId],
        relatedLoopIds: [loopId],
      },
      NOW,
    );
    const mirrorId = seedDoc(loopId, OPEN_LOOP_SOURCE_ID, OPEN_LOOP_PROVIDER_ID);
    // A bulk wipe removes rows wholesale, then hands the cascade their ids.
    db.prepare("DELETE FROM documents WHERE id = ?").run(evidenceId);

    await cascadeCognitiveStateForDocs(db, directWriteGate(db), [evidenceId]);

    expect(getOpenLoop(db, loopId)).toMatchObject({ docs: [] });
    expect(getObservation(db, "obs_retry")).toMatchObject({ citations: [] });
    expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(mirrorId)).toEqual({
      id: mirrorId,
    });
    expect(listPendingAbsenceCascades(db, 10)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT kind, owner_id, operation FROM knowledge_owner_changes WHERE operation = 'review' ORDER BY kind",
        )
        .all(),
    ).toEqual([
      { kind: "loop", owner_id: loopId, operation: "review" },
      { kind: "observation", owner_id: "obs_retry", operation: "review" },
    ]);
  });

  test("hands a bulk deletion to the writer in bounded batches", async () => {
    createOpenLoop(
      db,
      { id: "olp_any", createdByRun: "run_1", title: "Any loop", confidence: 0.5, importance: 0.5 },
      NOW,
    );
    const batches: number[] = [];
    const ids = Array.from({ length: SOURCE_DELETION_REVIEW_BATCH * 2 + 1 }, (_, i) => `doc-${i}`);
    await cascadeCognitiveStateForDocs(
      db,
      {
        reviewBrainArtifactsForDeletedDocs: async (batch) => {
          batches.push(batch.length);
          return directWriteGate(db).reviewBrainArtifactsForDeletedDocs(batch);
        },
        retractOrphanCognitionCoverage: async () => 0,
      },
      ids,
    );
    expect(batches).toEqual([SOURCE_DELETION_REVIEW_BATCH, SOURCE_DELETION_REVIEW_BATCH, 1]);
  });
});
