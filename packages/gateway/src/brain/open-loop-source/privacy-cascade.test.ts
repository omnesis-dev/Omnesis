// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end privacy-delete cascade at the repository level: privacy-
 * deleting a source document (`DELETE /documents/:id` →
 * `deleteDocumentForUser`) deletes the open loops and briefs derived
 * from it AND the loops' mirrored `open-loop` corpus documents, whose
 * internal ids come back in the return value so the caller's index-side
 * cascade covers them.
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
import { createBrief, getBrief } from "../storage/briefs.js";
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

describe("privacy-delete cascade through deleteDocumentForUser", () => {
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

  test("deleting a source document deletes derived loops, briefs, and loop mirror docs", () => {
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

    createBrief(
      db,
      {
        id: "brf_1",
        createdByRun: "run_1",
        kind: "loop",
        title: "Contract still unsent",
        confidence: 0.9,
        urgency: 0.6,
        citations: [sourceDocId as string],
        relatedLoopIds: ["olp_1"],
      },
      1000,
    );

    // The privacy delete of the SOURCE document.
    const deletedIds = deleteDocumentForUser(db, "google", "gmail-test", "msg_1");

    // Both the source doc and the loop's mirror doc are reported for the
    // caller's index-side cascade.
    expect(deletedIds.sort()).toEqual([sourceDocId, mirrorDocId].sort());
    // Rows are gone: source doc, mirror doc, loop, brief.
    expect(docIdByExternal(db, "msg_1")).toBeNull();
    expect(docIdByExternal(db, "olp_1")).toBeNull();
    expect(getOpenLoop(db, "olp_1")).toBeNull();
    expect(getBrief(db, "brf_1")).toBeNull();
    // The source doc is tombstoned; the internal mirror is not (nothing
    // re-syncs it, and the agent must stay free to mint new loops).
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
