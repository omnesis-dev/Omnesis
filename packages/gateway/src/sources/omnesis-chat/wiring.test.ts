// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import Sqlite from "better-sqlite3";
import {
  deleteOmnesisChatConversation,
  listInterruptedOmnesisChatRetentionDocumentIds,
  retainOmnesisChatConversation,
} from "./wiring.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { WriteGate } from "../../write-gate.js";

describe("deleteOmnesisChatConversation", () => {
  test("preserves the authoritative document when index cleanup fails", async () => {
    const readDb = conversationDatabase();
    const deleteDocuments = vi.fn().mockResolvedValue(["doc-1"]);
    const deleteChunksByDocuments = vi.fn().mockRejectedValue(new Error("index unavailable"));

    await expect(
      deleteOmnesisChatConversation(
        {
          writeGate: { deleteDocuments } as unknown as WriteGate,
          indexWriteGate: { deleteChunksByDocuments } as unknown as IndexWriteGate,
          readDb,
        },
        "conversation-1",
      ),
    ).rejects.toThrow("index unavailable");

    expect(deleteChunksByDocuments).toHaveBeenCalledWith(["doc-1"]);
    expect(deleteDocuments).not.toHaveBeenCalled();
    readDb.close();
  });

  test("uses the coordinated durable batch port when it is available", async () => {
    const readDb = conversationDatabase();
    const order: string[] = [];
    const deleteDocuments = vi.fn(async () => {
      order.push("document");
      return ["doc-1"];
    });
    const deleteChunksByDocuments = vi.fn();
    const retentionIndexDeleteBatch = vi.fn(
      async (_documentId: string, _limit: number, sourceDeleted: boolean) => {
        order.push(sourceDeleted ? "index-final" : "index-prepare");
        return sourceDeleted
          ? { deletedChunks: 1, complete: true, readyForSourceDelete: false }
          : { deletedChunks: 0, complete: false, readyForSourceDelete: true };
      },
    );

    await expect(
      deleteOmnesisChatConversation(
        {
          writeGate: { deleteDocuments } as unknown as WriteGate,
          indexWriteGate: { deleteChunksByDocuments } as unknown as IndexWriteGate,
          retentionIndexDeleteBatch,
          readDb,
        },
        "conversation-1",
      ),
    ).resolves.toBe("doc-1");

    expect(order).toEqual(["index-prepare", "document", "index-final"]);
    expect(deleteChunksByDocuments).not.toHaveBeenCalled();
    readDb.close();
  });
});

describe("retainOmnesisChatConversation", () => {
  test("defers the authoritative delete until bounded index cleanup completes", async () => {
    const readDb = conversationDatabase();
    const deleteDocumentForRetention = vi.fn().mockResolvedValue("doc-1");
    const completeDocumentRetention = vi.fn();
    const retentionIndexDeleteBatch = vi.fn().mockResolvedValue({
      deletedChunks: 64,
      complete: false,
      readyForSourceDelete: false,
    });

    await expect(
      retainOmnesisChatConversation(
        {
          writeGate: {
            deleteDocumentForRetention,
            completeDocumentRetention,
          } as unknown as WriteGate,
          retentionIndexDeleteBatch,
          readDb,
        },
        "conversation-1",
      ),
    ).resolves.toBe(false);
    expect(retentionIndexDeleteBatch).toHaveBeenCalledWith("doc-1", 64, false);
    expect(deleteDocumentForRetention).not.toHaveBeenCalled();
    expect(completeDocumentRetention).not.toHaveBeenCalled();
    readDb.close();
  });

  test("deletes the source before the held final index batch and resumes by tombstone id", async () => {
    const readDb = conversationDatabase();
    const order: string[] = [];
    const retentionIndexDeleteBatch = vi.fn(
      async (_id: string, _limit: number, sourceDeleted: boolean) => {
        order.push(sourceDeleted ? "index-final" : "index-prepare");
        expect(
          readDb.prepare("SELECT 1 FROM documents WHERE id = 'doc-1'").get() !== undefined,
        ).toBe(!sourceDeleted);
        return sourceDeleted
          ? { deletedChunks: 1, complete: true, readyForSourceDelete: false }
          : { deletedChunks: 0, complete: false, readyForSourceDelete: true };
      },
    );
    const deleteDocumentForRetention = vi.fn(async () => {
      order.push("source");
      readDb
        .prepare(
          `INSERT INTO removed_documents
             (provider_id, source_id, external_id, removed_at, original_document_id)
           VALUES ('system', 'omnesis-chat', 'conversation-1', 1, 'doc-1')`,
        )
        .run();
      readDb.prepare("DELETE FROM documents WHERE id = 'doc-1'").run();
      return "doc-1";
    });
    const completeDocumentRetention = vi.fn(async () => {
      order.push("tombstone-clear");
      readDb
        .prepare(
          `DELETE FROM removed_documents
            WHERE provider_id = 'system'
              AND source_id = 'omnesis-chat'
              AND external_id = 'conversation-1'`,
        )
        .run();
    });
    const writeGate = {
      deleteDocumentForRetention,
      completeDocumentRetention,
    } as unknown as WriteGate;

    await expect(
      retainOmnesisChatConversation(
        {
          writeGate,
          retentionIndexDeleteBatch,
          readDb,
        },
        "conversation-1",
      ),
    ).resolves.toBe(true);
    expect(order).toEqual(["index-prepare", "source", "index-final", "tombstone-clear"]);
    expect(deleteDocumentForRetention).toHaveBeenCalledTimes(1);
    expect(completeDocumentRetention).toHaveBeenCalledTimes(1);
    expect(readDb.prepare("SELECT 1 FROM removed_documents").get()).toBeUndefined();
    readDb.close();
  });

  test("recovers the original index id from an interrupted retention tombstone", () => {
    const readDb = conversationDatabase();
    readDb.prepare("DELETE FROM documents WHERE id = 'doc-1'").run();
    readDb
      .prepare(
        `INSERT INTO removed_documents
          (provider_id, source_id, external_id, removed_at, original_document_id)
         VALUES ('system', 'omnesis-chat', 'conversation-1', 1, 'doc-1')`,
      )
      .run();

    expect(listInterruptedOmnesisChatRetentionDocumentIds(readDb)).toEqual(["doc-1"]);
    readDb.close();
  });
});

function conversationDatabase(): Sqlite.Database {
  const db = new Sqlite(":memory:");
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL
    );
    INSERT INTO documents (id, provider_id, source_id, external_id)
    VALUES ('doc-1', 'system', 'omnesis-chat', 'conversation-1');
    CREATE TABLE removed_documents (
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      removed_at INTEGER NOT NULL,
      original_document_id TEXT,
      PRIMARY KEY (provider_id, source_id, external_id)
    );
  `);
  return db;
}
