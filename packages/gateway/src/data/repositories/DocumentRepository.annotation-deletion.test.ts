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

describe("document deletion keeps durable annotations for review", () => {
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
    "%s deletion keeps every annotation and breaks only the atoms citing the deleted document",
    (kind) => {
      remove(kind);
      expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(evidenceId)).toBeUndefined();
      for (const [parent, child, prefix] of [
        ["doc_annotations", "doc_annotation_evidence", "doc"],
        ["person_annotations", "person_annotation_evidence", "person"],
      ]) {
        // Nothing is deleted or invalidated by the deletion itself.
        expect(db.prepare(`SELECT id, invalidated_at FROM ${parent} ORDER BY id`).all()).toEqual([
          { id: `${prefix}-additional`, invalidated_at: null },
          { id: `${prefix}-invalidated`, invalidated_at: 2 },
          { id: `${prefix}-live`, invalidated_at: null },
          { id: `${prefix}-superseded`, invalidated_at: 2 },
          { id: `${prefix}-unrelated`, invalidated_at: null },
        ]);
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${child}`).get()).toEqual({ n: 6 });
        // The live annotation lost its only grounding: kept, unverified, its atom broken.
        expect(
          db.prepare(`SELECT verification_state FROM ${parent} WHERE id = ?`).get(`${prefix}-live`),
        ).toEqual({ verification_state: "unverified" });
        expect(
          db
            .prepare(`SELECT broken_at IS NOT NULL AS broken FROM ${child} WHERE annotation_id = ?`)
            .all(`${prefix}-live`),
        ).toEqual([{ broken: 1 }]);
        // The one resting elsewhere is untouched.
        expect(
          db
            .prepare(`SELECT broken_at FROM ${child} WHERE annotation_id = ?`)
            .all(`${prefix}-unrelated`),
        ).toEqual([{ broken_at: null }]);
      }
      // Each kept live annotation is queued for review.
      expect(
        db
          .prepare(
            "SELECT owner_id FROM knowledge_owner_changes WHERE operation = 'review' ORDER BY owner_id",
          )
          .all(),
      ).toEqual([{ owner_id: "doc-live" }, { owner_id: "person-live" }]);
      // A later writer request cannot ground a new annotation on the deleted document.
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
    "%s deletion rolls the annotation review back when source deletion fails",
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
    "%s deletion keeps the document when marking an annotation for review fails",
    (kind) => {
      db.exec(
        "CREATE TRIGGER reject_review BEFORE UPDATE ON person_annotations BEGIN SELECT RAISE(ABORT, 'fixture review failure'); END",
      );
      expect(() => remove(kind)).toThrow("fixture review failure");
      expect(db.prepare("SELECT id FROM documents WHERE id = ?").get(evidenceId)).toBeDefined();
      // The document-annotation marks and broken atoms roll back too, so a
      // retry sees the entire original provenance graph.
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM doc_annotation_evidence WHERE broken_at IS NOT NULL")
          .get(),
      ).toEqual({ n: 1 });
      for (const table of ["doc_annotations", "person_annotations"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 5 });
      }
      for (const table of ["doc_annotation_evidence", "person_annotation_evidence"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 6 });
      }
    },
  );
});
