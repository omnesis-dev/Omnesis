// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import {
  insertTemporalAnnotation,
  invalidateTemporalAnnotation,
} from "../enrichment/temporal-annotations/storage.js";
import { createOpenLoop, updateOpenLoop } from "./storage/open-loops.js";
import { createDocAnnotation } from "./storage/annotations.js";
import { readDocConnections } from "./doc-connections.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanup(p: string): void {
  for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(p + s)) unlinkSync(p + s);
}

describe("readDocConnections", () => {
  let path: string;
  let db: Db;
  const NOW = Date.parse("2026-07-02T10:00:00.000Z");
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanup(path);
  });

  /** Seed through the real ingest path; returns the generated doc id. */
  function insertRealDoc(externalId: string, content = "body"): string {
    const doc: DocumentInput = {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail-test"),
      externalId,
      title: `Message ${externalId}`,
      content,
      contentHash: `hash-${externalId}`,
      metadata: {},
      sourceCreatedAt: "2026-01-01T10:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T10:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(externalId)?.id ?? ""
    );
  }

  test.each([null, "verified", "unverified", "failed"] as const)(
    "annotation hints preserve proof state %s alongside evidence",
    (verificationState) => {
      const docX = insertRealDoc("dx", "quote for the venue");
      createOpenLoop(
        db,
        {
          id: "olp_1",
          createdByRun: "r",
          title: "Reply to the venue quote",
          description: "d",
          confidence: 0.8,
          importance: 0.7,
          docs: [docX],
        },
        NOW,
      );
      createDocAnnotation(
        db,
        {
          id: "a1",
          docId: docX,
          claimType: "topic",
          claimText: "the venue quote thread",
          evidenceDocId: docX,
          evidenceQuote: "quote for the venue",
          confidence: 0.6,
          claimBasis: "quoted",
          createdByRun: "r",
          verificationState,
        },
        NOW,
      );

      const lean = readDocConnections(db, docX, { annotations: false });
      expect(lean.openLoops.map((l) => l.loopId)).toEqual(["olp_1"]);
      expect(lean.openLoops[0]!.title).toBe("Reply to the venue quote");
      expect(lean.annotations).toEqual([]);

      const full = readDocConnections(db, docX, { annotations: true });
      expect(full.openLoops.map((l) => l.loopId)).toEqual(["olp_1"]);
      expect(full.annotations).toHaveLength(1);
      expect(full.annotations[0]!.claim).toBe("the venue quote thread");
      expect(full.annotations[0]!.claimType).toBe("topic");
      // The reground pointer rides every inline hint.
      expect(full.annotations[0]!.evidenceDocId).toBe(docX);
      expect(full.annotations[0]!.verificationState).toBe(verificationState ?? "unverified");
    },
  );

  test("terminal loops are not surfaced as connections", () => {
    createOpenLoop(
      db,
      {
        id: "olp_done",
        createdByRun: "r",
        title: "handled",
        description: "d",
        confidence: 0.8,
        importance: 0.5,
        docs: ["doc_y"],
      },
      NOW,
    );
    updateOpenLoop(db, "olp_done", { state: "done" }, NOW);
    expect(readDocConnections(db, "doc_y", { annotations: true }).openLoops).toEqual([]);
  });

  test("empty stores for a document with no loops or annotations", () => {
    const c = readDocConnections(db, "doc_none", { annotations: true });
    expect(c.openLoops).toEqual([]);
    expect(c.annotations).toEqual([]);
    expect(c.temporalAnnotations).toEqual([]);
  });

  test("a temporal annotation's time names its instants in UTC, its days as written", () => {
    const docId = insertRealDoc("d-instants");
    const cases: Array<[string, string]> = [
      [
        "2026-10-18T18:28:00+01:00 .. 2026-10-18T19:26:00+01:00",
        "2026-10-18T17:28:00.000Z .. 2026-10-18T18:26:00.000Z",
      ],
      // Written without an offset, the clock was read in the gateway's zone.
      ["2026-10-18T19:26", new Date("2026-10-18T19:26").toISOString()],
      ["2026-10-18 .. 2026-10-18T09:00:00Z", "2026-10-18 .. 2026-10-18T09:00:00.000Z"],
      ["2026-10", "2026-10"],
    ];
    for (const [index, [canonical]] of cases.entries()) {
      insertTemporalAnnotation(
        db,
        {
          id: `ta_instant_${index}`,
          intervalStartMs: 1000 + index,
          intervalEndMs: 2000 + index,
          precision: "instant",
          canonical,
          sentence: `fitting ${index}`,
          documentIds: [docId],
          createdByRun: "r",
        },
        NOW,
      );
    }
    const when = Object.fromEntries(
      readDocConnections(db, docId, {
        annotations: false,
        temporalAnnotations: true,
      }).temporalAnnotations.map((t) => [t.annotationId, t.when]),
    );
    for (const [index, [, expected]] of cases.entries()) {
      expect(when[`ta_instant_${index}`]).toBe(expected);
    }
  });

  test("temporalAnnotations opt attaches live annotations and excludes invalidated rows", () => {
    const docId = insertRealDoc("d1");
    insertTemporalAnnotation(
      db,
      {
        id: "ta_1",
        intervalStartMs: 1000,
        intervalEndMs: 2000,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "the deposit is due",
        kind: "deadline",
        documentIds: [docId],
        createdByRun: "r",
      },
      NOW,
    );
    // Off by default (the search-lean path).
    expect(readDocConnections(db, docId, { annotations: true }).temporalAnnotations).toEqual([]);
    // On when asked.
    const withTime = readDocConnections(db, docId, {
      annotations: true,
      temporalAnnotations: true,
    });
    expect(withTime.temporalAnnotations).toHaveLength(1);
    expect(withTime.temporalAnnotations[0]).toEqual({
      annotationId: "ta_1",
      sentence: "the deposit is due",
      when: "2026-07-08",
      kind: "deadline",
    });
    // Invalidated entries drop out.
    invalidateTemporalAnnotation(db, "ta_1", NOW + 1000);
    expect(
      readDocConnections(db, docId, {
        annotations: true,
        temporalAnnotations: true,
      }).temporalAnnotations,
    ).toEqual([]);
  });
});
