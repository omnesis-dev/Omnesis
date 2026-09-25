// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDocAnnotation } from "../../brain/storage/annotations.js";
import { recordConsumptionEdges } from "../../brain/storage/consumption-edges.js";
import { runSchemaSetup } from "../../data/schema.js";
import { CognitionQueryService } from "./CognitionQueryService.js";

describe("CognitionQueryService annotation dependents", () => {
  let db: Database.Database;
  let service: CognitionQueryService;

  beforeEach(() => {
    db = new Database(":memory:");
    runSchemaSetup(db);
    service = new CognitionQueryService(db);
  });

  afterEach(() => db.close());

  test("distinguishes an unknown prior from an empty dependent page", () => {
    expect(service.listAnnotationDependents("doc", "missing", { limit: 2 })).toBeNull();

    createDocAnnotation(
      db,
      {
        id: "annotation-empty",
        docId: "document-example",
        claimType: "topic",
        claimText: "A fictional planning note.",
        evidenceDocId: "evidence-example",
        evidenceQuote: "The fictional review is on Tuesday.",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-example",
      },
      1_000,
    );
    expect(service.listAnnotationDependents("doc", "annotation-empty", { limit: 2 })).toEqual([]);
  });

  test("applies the dependent keyset boundary without repeating rows", () => {
    createDocAnnotation(
      db,
      {
        id: "annotation-page",
        docId: "document-example",
        claimType: "topic",
        claimText: "A fictional schedule changed.",
        evidenceDocId: "evidence-example",
        evidenceQuote: "The fictional review moved to Tuesday.",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-example",
      },
      1_000,
    );
    db.exec(`
      INSERT INTO briefs
        (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
      VALUES
        ('brief-example', 'run-example', 'info', 'Review moved', 0.8, 0.4, 1000, 1000);
      INSERT INTO open_loops
        (id, created_by_run, state, confidence, importance, title, created_at, last_update)
      VALUES
        ('loop-example', 'run-example', 'open', 0.8, 0.5, 'Confirm review time', 1000, 1000);
    `);
    recordConsumptionEdges(
      db,
      [
        {
          priorStore: "doc",
          priorAnnotationId: "annotation-page",
          dependentKind: "brief",
          dependentId: "brief-example",
          runId: "run-example",
        },
        {
          priorStore: "doc",
          priorAnnotationId: "annotation-page",
          dependentKind: "loop",
          dependentId: "loop-example",
          runId: "run-example",
        },
      ],
      2_000,
    );

    const first = service.listAnnotationDependents("doc", "annotation-page", { limit: 1 })!;
    expect(first).toHaveLength(1);
    const second = service.listAnnotationDependents("doc", "annotation-page", {
      limit: 1,
      before: {
        createdAt: first[0]!.createdAt,
        kind: first[0]!.kind,
        id: first[0]!.id,
      },
    })!;
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });
});
