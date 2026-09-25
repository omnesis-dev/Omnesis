// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import {
  createDocAnnotation,
  deleteDocAnnotation,
  supersedeDocAnnotation,
} from "../../brain/storage/annotations.js";
import {
  createPersonAnnotation,
  deletePersonAnnotation,
  supersedePersonAnnotation,
} from "../../brain/storage/person-annotations.js";
import {
  deleteDocumentForRetention,
  deleteDocumentForUser,
  deleteDocuments,
  deleteDocumentsByIds,
} from "./DocumentRepository.js";

const PROVIDER = "example-provider";
const SOURCE = "example-notes:memory";
const QUOTE = "I prefer afternoon meetings.";
const deletionPaths = ["source", "ids", "user", "retention"] as const;

describe("document deletion purges durable annotation text", () => {
  let db: ReturnType<typeof createDatabase>;
  let path: string;
  let evidenceId: string;
  let survivorId: string;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    for (const externalId of ["evidence", "survivor"]) {
      upsertDocuments(db, [
        {
          providerId: ProviderId(PROVIDER),
          sourceId: SourceId(SOURCE),
          externalId,
          title: externalId,
          content: QUOTE,
          contentHash: externalId,
          metadata: {},
          sourceCreatedAt: "2026-01-01T12:00:00.000Z",
          sourceUpdatedAt: "2026-01-01T12:00:00.000Z",
        },
      ]);
    }
    evidenceId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("evidence")!.id;
    survivorId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("survivor")!.id;
    for (const state of [
      "live",
      "superseded",
      "invalidated",
      "retracted",
      "additional",
      "unrelated",
    ]) {
      const input = {
        claimType: "meeting_preference",
        claimText: QUOTE,
        evidenceDocId: state === "additional" || state === "unrelated" ? survivorId : evidenceId,
        evidenceQuote: QUOTE,
        confidence: 0.8,
        claimBasis: "quoted" as const,
        createdByRun: "interactive-fixture",
        ...(state === "additional"
          ? { additionalEvidence: [{ docId: evidenceId, quote: QUOTE }] }
          : {}),
      };
      createDocAnnotation(db, { ...input, id: `doc-${state}`, docId: survivorId }, 1);
      createPersonAnnotation(
        db,
        { ...input, id: `person-${state}`, personId: "fictional-self" },
        1,
      );
    }
    supersedeDocAnnotation(db, "doc-superseded", "doc-live", 2);
    supersedePersonAnnotation(db, "person-superseded", "person-live", 2);
    deleteDocAnnotation(db, "doc-retracted");
    deletePersonAnnotation(db, "person-retracted");
    for (const table of ["doc_annotations", "person_annotations"]) {
      db.prepare(`UPDATE ${table} SET invalidated_at = 2 WHERE id LIKE '%-invalidated'`).run();
    }
    for (const table of ["doc_annotation_evidence", "person_annotation_evidence"]) {
      db.prepare(
        `UPDATE ${table} SET broken_at = 2 WHERE annotation_id LIKE '%-additional' AND position = 1`,
      ).run();
    }
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
  });

  function remove(kind: (typeof deletionPaths)[number]): void {
    if (kind === "source") deleteDocuments(db, PROVIDER, SOURCE, ["evidence"]);
    else if (kind === "ids") deleteDocumentsByIds(db, [evidenceId]);
    else if (kind === "user") deleteDocumentForUser(db, PROVIDER, SOURCE, "evidence");
    else deleteDocumentForRetention(db, PROVIDER, SOURCE, "evidence");
  }

  test.each(deletionPaths)(
    "%s deletion removes live, retired, and broken-evidence annotations",
    (kind) => {
      remove(kind);
      expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(evidenceId)).toBeUndefined();
      for (const [parent, child, prefix] of [
        ["doc_annotations", "doc_annotation_evidence", "doc"],
        ["person_annotations", "person_annotation_evidence", "person"],
      ]) {
        expect(db.prepare(`SELECT id FROM ${parent}`).all()).toEqual([
          { id: `${prefix}-unrelated` },
        ]);
        expect(db.prepare(`SELECT annotation_id FROM ${child}`).all()).toEqual([
          { annotation_id: `${prefix}-unrelated` },
        ]);
      }
      // A later writer request cannot reintroduce an annotation after deletion.
      expect(() =>
        createDocAnnotation(
          db,
          {
            id: "late-write",
            docId: survivorId,
            claimType: "preference",
            claimText: QUOTE,
            evidenceDocId: evidenceId,
            evidenceQuote: QUOTE,
            confidence: 0.8,
            claimBasis: "quoted",
            createdByRun: "interactive-fixture",
          },
          3,
          true,
        ),
      ).toThrow("annotation evidence document no longer exists");
    },
  );

  test.each(deletionPaths)(
    "%s deletion rolls the annotation purge back when source deletion fails",
    (kind) => {
      db.exec(
        "CREATE TRIGGER reject_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'fixture deletion failure'); END",
      );
      expect(() => remove(kind)).toThrow("fixture deletion failure");
      expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(evidenceId)).toBeDefined();
      for (const table of ["doc_annotations", "person_annotations"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 5 });
      }
      for (const table of ["doc_annotation_evidence", "person_annotation_evidence"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 6 });
      }
    },
  );

  test.each(deletionPaths)(
    "%s deletion preserves evidence when an annotation purge fails",
    (kind) => {
      db.exec(
        "CREATE TRIGGER reject_purge BEFORE DELETE ON person_annotations BEGIN SELECT RAISE(ABORT, 'fixture purge failure'); END",
      );
      expect(() => remove(kind)).toThrow("fixture purge failure");
      expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(evidenceId)).toBeDefined();
      // The earlier document-annotation purge and evidence-child deletes also
      // roll back, so retrying sees the entire original provenance graph.
      for (const table of ["doc_annotations", "person_annotations"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 5 });
      }
      for (const table of ["doc_annotation_evidence", "person_annotation_evidence"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 6 });
      }
    },
  );
});
