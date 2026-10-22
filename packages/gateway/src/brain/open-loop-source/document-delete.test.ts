// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An explicit delete of a source document (`DELETE /documents/:id` →
 * `deleteDocumentForUser`) at the repository level: the document goes and is
 * tombstoned, while the open loops and observations derived from it, and the
 * loops' mirrored `open-loop` corpus documents, are kept for review.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, deleteDocumentForUser, upsertDocuments } from "../../db.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  getOpenLoop,
  listOpenLoopLedger,
  listOpenLoops,
} from "../storage/open-loops.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { buildOpenLoopDocumentInput } from "./document-projection.js";
import { OPEN_LOOP_SOURCE_ID } from "./source-meta.js";
import type Database from "better-sqlite3";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function sourceDoc(externalId: string, content: string): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("gmail-test"),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "email" },
  };
}

function docIdByExternal(db: Db, externalId: string): string | null {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  return row?.id ?? null;
}

describe("an explicit document delete through deleteDocumentForUser", () => {
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

  test("deleting a source document keeps derived loops, observations and loop mirror docs", () => {
    // A source document + a loop derived from it, mirrored into the corpus.
    upsertDocuments(db, [sourceDoc("msg_1", "Could you send the signed venue contract?")]);
    const sourceDocId = docIdByExternal(db, "msg_1");
    expect(sourceDocId).not.toBeNull();

    const loop = createOpenLoop(
      db,
      {
        id: "olp_1",
        createdByRun: "run_1",
        title: "Send the signed venue contract",
        description: "Requested by email.",
        confidence: 0.9,
        importance: 0.7,
        docs: [sourceDocId as string],
      },
      1000,
    );
    appendOpenLoopLedger(db, "olp_1", { runId: "run_1", note: "created from the request" }, 1000);
    upsertDocuments(db, [buildOpenLoopDocumentInput(loop, listOpenLoopLedger(db, "olp_1"))]);
    const mirrorDocId = docIdByExternal(db, "olp_1");
    expect(mirrorDocId).not.toBeNull();

    createObservation(
      db,
      {
        id: "obs_1",
        createdByRun: "run_1",
        summary: "Contract still unsent",
        citations: [sourceDocId as string],
        relatedLoopIds: ["olp_1"],
      },
      1000,
    );

    // The explicit delete of the SOURCE document.
    const deletedIds = deleteDocumentForUser(db, "google", "gmail-test", "msg_1");

    // Only the source doc goes, and only it is reported for the caller's
    // index-side cascade.
    expect(deletedIds).toEqual([sourceDocId]);
    expect(docIdByExternal(db, "msg_1")).toBeNull();
    // The loop, its mirror and the observation stay, without the dead pointer.
    expect(docIdByExternal(db, "olp_1")).toBe(mirrorDocId);
    expect(getOpenLoop(db, "olp_1")).toMatchObject({ state: "open", docs: [] });
    expect(getObservation(db, "obs_1")).toMatchObject({ state: "live", citations: [] });
    // The source doc is tombstoned.
    const tombstones = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM removed_documents")
      .all()
      .map((r) => r.external_id);
    expect(tombstones).toEqual(["msg_1"]);
  });

  test("privacy-deleting an unrelated document leaves loops untouched", () => {
    upsertDocuments(db, [
      sourceDoc("msg_1", "About the contract"),
      sourceDoc("msg_2", "Lunch plans"),
    ]);
    const loop = createOpenLoop(
      db,
      {
        id: "olp_1",
        createdByRun: "run_1",
        title: "Send the signed venue contract",
        confidence: 0.9,
        importance: 0.7,
        docs: [docIdByExternal(db, "msg_1") as string],
      },
      1000,
    );
    upsertDocuments(db, [buildOpenLoopDocumentInput(loop, [])]);

    deleteDocumentForUser(db, "google", "gmail-test", "msg_2");
    expect(getOpenLoop(db, "olp_1")).not.toBeNull();
    expect(docIdByExternal(db, "olp_1")).not.toBeNull();
    expect(listOpenLoops(db)).toHaveLength(1);
  });

  test("the mirror doc lives under the open-loops source id", () => {
    const loop = createOpenLoop(
      db,
      {
        id: "olp_1",
        createdByRun: "run_1",
        title: "Decide on the August trip destination",
        confidence: 0.8,
        importance: 0.9,
      },
      1000,
    );
    upsertDocuments(db, [buildOpenLoopDocumentInput(loop, [])]);
    const row = db
      .prepare<
        [string],
        { source_id: string; provider_id: string }
      >("SELECT source_id, provider_id FROM documents WHERE external_id = ?")
      .get("olp_1");
    expect(row).toEqual({ source_id: OPEN_LOOP_SOURCE_ID, provider_id: "system" });
  });
});
