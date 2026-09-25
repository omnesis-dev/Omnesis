// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import {
  bumpWipeEpoch,
  createDatabase,
  getSyncState,
  upsertDocuments,
  upsertWithCursor,
} from "../db.js";
import {
  acknowledgeAbsenceCascade,
  listPendingAbsenceCascades,
} from "../data/repositories/AbsenceRepository.js";
import { finishDocumentCascade } from "./document-cascade.js";
import type Database from "better-sqlite3";

const PROVIDER = ProviderId("notes-synth");
const SOURCE = SourceId("notes-synth:local");

function document(externalId: string): DocumentInput {
  return {
    providerId: PROVIDER,
    sourceId: SOURCE,
    externalId,
    title: `Note ${externalId}`,
    content: `Contents of ${externalId}`,
    contentHash: `hash-${externalId}`,
    metadata: { documentType: "note" },
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("sync tombstone cascade outbox", () => {
  let db: Database.Database;
  let path: string;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  });

  function pending() {
    return listPendingAbsenceCascades(db, 10);
  }

  function cursor() {
    return JSON.parse(getSyncState(db, SOURCE)!.cursor) as { step: number };
  }

  function exists(externalId: string): boolean {
    return (
      db
        .prepare<
          [string, string],
          { id: string }
        >("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
        .get(SOURCE, externalId) !== undefined
    );
  }

  function deletePage(step: number, externalId = "remove-me", wipeEpoch?: number) {
    return upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId: SOURCE,
      deletedExternalIds: [externalId],
      hasMore: false,
      cursor: { step },
      ...(wipeEpoch === undefined ? {} : { wipeEpoch }),
    });
  }

  test("a deletes-only page commits its cursor, deletion and exact cleanup obligation together", () => {
    upsertDocuments(db, [document("remove-me"), document("keep-me")]);
    const removedId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("remove-me")!.id;

    const result = deletePage(1);

    expect(result.tombstoneDeletedDocumentIds).toEqual([removedId]);
    expect(result.tombstoneCascade).toEqual({
      id: expect.any(Number),
      documentIds: [removedId],
      indexDone: false,
      cognitionDone: false,
    });
    expect(exists("remove-me")).toBe(false);
    expect(exists("keep-me")).toBe(true);
    expect(cursor()).toEqual({ step: 1 });
    expect(pending()).toEqual([result.tombstoneCascade]);

    // A replayed tombstone cannot add another obligation after the row is gone.
    expect(deletePage(2).tombstoneCascade).toBeUndefined();
    expect(pending()).toHaveLength(1);
    expect(cursor()).toEqual({ step: 2 });
  });

  test("a rejected stale page advances nothing and queues no cleanup", () => {
    upsertDocuments(db, [document("remove-me")]);
    bumpWipeEpoch(db, SOURCE);

    const result = deletePage(1, "remove-me", 0);

    expect(result.rejected).toBe(true);
    expect(result.tombstoneCascade).toBeUndefined();
    expect(exists("remove-me")).toBe(true);
    expect(pending()).toEqual([]);
    expect(getSyncState(db, SOURCE)?.cursor).toBeUndefined();
  });

  test("a later SQL failure rolls back the deletion, cursor and outbox row", () => {
    upsertDocuments(db, [document("remove-me")]);
    upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId: SOURCE,
      hasMore: false,
      cursor: { step: 0 },
    });
    db.exec(`
      CREATE TRIGGER reject_cursor_advance BEFORE UPDATE OF cursor ON sync_state
      WHEN NEW.source_id = '${SOURCE}'
      BEGIN SELECT RAISE(ABORT, 'simulated cursor failure'); END
    `);

    expect(() => deletePage(1)).toThrow("simulated cursor failure");
    expect(exists("remove-me")).toBe(true);
    expect(cursor()).toEqual({ step: 0 });
    expect(pending()).toEqual([]);
  });

  test.each(["index", "cognition"] as const)(
    "retries only the unfinished %s arm after the other arm succeeded",
    async (failedArm) => {
      upsertDocuments(db, [document("remove-me")]);
      const cascade = deletePage(1).tombstoneCascade!;
      const index = vi.fn(async () => 2);
      const cognition = vi.fn(async () => {});
      const failure = new Error(`${failedArm} unavailable`);
      if (failedArm === "index") index.mockRejectedValueOnce(failure);
      else cognition.mockRejectedValueOnce(failure);
      const ops = {
        deleteIndex: index,
        purgeCognition: cognition,
        acknowledge: async (id: number, part: "index" | "cognition") => {
          acknowledgeAbsenceCascade(db, id, part);
        },
      };

      await expect(finishDocumentCascade(cascade, ops)).rejects.toThrow(failure.message);
      expect(cursor()).toEqual({ step: 1 });
      expect(exists("remove-me")).toBe(false);
      expect(pending()).toMatchObject([
        {
          id: cascade.id,
          indexDone: failedArm === "cognition",
          cognitionDone: failedArm === "index",
        },
      ]);

      expect(await finishDocumentCascade(pending()[0]!, ops)).toBe(failedArm === "index" ? 2 : 0);
      expect(pending()).toEqual([]);
      expect(index).toHaveBeenCalledTimes(failedArm === "index" ? 2 : 1);
      expect(cognition).toHaveBeenCalledTimes(failedArm === "cognition" ? 2 : 1);
    },
  );
});
