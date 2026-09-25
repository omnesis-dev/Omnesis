// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Consumption-provenance edge store: recording (unique-tuple idempotence),
 * the live-dependent reads (dangling dependents drop out), the recheck
 * prompt's consumed-priors read (liveness per prior), and the sweep's
 * dead-prior watermark scan.
 *
 * Fixture data is invented — no corpus content.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCognitionProvenanceRecheckPayload } from "../run-payloads.js";
import {
  createAnnotationStorageTables,
  createDocAnnotation,
  deleteDocAnnotation,
  getDocAnnotation,
} from "./annotations.js";
import {
  createPersonAnnotationStorageTables,
  createPersonAnnotation,
  deletePersonAnnotation,
  getPersonAnnotation,
  supersedePersonAnnotation,
} from "./person-annotations.js";
import { createBriefsStorageTables } from "./schema.js";
import { finalizeCognitionRun } from "./run-queue.js";
import {
  createConsumptionEdgesTables,
  recordConsumptionEdges,
  retractAnnotationWithDependentRechecks,
  listLiveDependentsForAnnotation,
  listConsumedPriorsForDependent,
  listDeadPriorDependents,
  type ConsumptionEdgeInput,
} from "./consumption-edges.js";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  createAnnotationStorageTables(db);
  createPersonAnnotationStorageTables(db);
  createBriefsStorageTables(db);
  createConsumptionEdgesTables(db);
});
afterEach(() => {
  db.close();
});

function seedDocAnno(id: string, invalidatedAt: number | null = null): void {
  createDocAnnotation(
    db,
    {
      id,
      docId: "doc_subject",
      claimType: "topic",
      claimText: "about the rehearsal schedule",
      evidenceDocId: "doc_ev",
      evidenceQuote: "rehearsals move to Tuesdays",
      confidence: 0.7,
      claimBasis: "quoted",
      createdByRun: "run_seed",
    },
    NOW,
  );
  if (invalidatedAt !== null) {
    db.prepare("UPDATE doc_annotations SET invalidated_at = ? WHERE id = ?").run(invalidatedAt, id);
  }
}

function edge(over: Partial<ConsumptionEdgeInput> = {}): ConsumptionEdgeInput {
  return {
    priorStore: "doc",
    priorAnnotationId: "anno_1",
    dependentKind: "brief",
    dependentId: "brief_1",
    runId: "run_1",
    ...over,
  };
}

function seedBrief(id = "brief_1", title = "Rehearsal day moved"): void {
  db.prepare(
    `INSERT INTO briefs
       (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
     VALUES (?, 'run_seed', 'info', ?, 0.8, 0.5, ?, ?)`,
  ).run(id, title, NOW, NOW);
}

function seedLoop(id = "loop_1", title = "Confirm the new day"): void {
  db.prepare(
    `INSERT INTO open_loops
       (id, created_by_run, confidence, importance, title, created_at, last_update)
     VALUES (?, 'run_seed', 0.8, 0.6, ?, ?, ?)`,
  ).run(id, title, NOW, NOW);
}

describe("consumption edges", () => {
  test("recording is idempotent on the (prior, dependent) tuple", () => {
    expect(recordConsumptionEdges(db, [edge()], NOW)).toBe(1);
    // Same tuple again (different run id): ignored — first attribution wins.
    expect(recordConsumptionEdges(db, [edge({ runId: "run_2" })], NOW + 1)).toBe(0);
    const row = db
      .prepare<
        [],
        { run_id: string; created_at: number }
      >("SELECT run_id, created_at FROM cognition_consumption_edges")
      .get()!;
    expect(row).toEqual({ run_id: "run_1", created_at: NOW });
    // A different dependent is a new edge.
    expect(recordConsumptionEdges(db, [edge({ dependentId: "brief_2" })], NOW + 2)).toBe(1);
  });

  test("live-dependent reads drop edges whose brief/loop no longer exists", () => {
    seedDocAnno("anno_1");
    seedBrief();
    seedLoop();
    recordConsumptionEdges(
      db,
      [
        edge(),
        edge({ dependentKind: "loop", dependentId: "loop_1" }),
        edge({ dependentKind: "brief", dependentId: "brief_gone" }),
      ],
      NOW,
    );
    const deps = listLiveDependentsForAnnotation(db, "doc", "anno_1");
    expect(deps.map((d) => [d.kind, d.id, d.title])).toEqual([
      ["brief", "brief_1", "Rehearsal day moved"],
      ["loop", "loop_1", "Confirm the new day"],
    ]);
    // A hard-deleted dependent drops out of the live read.
    db.prepare("DELETE FROM briefs WHERE id = 'brief_1'").run();
    expect(listLiveDependentsForAnnotation(db, "doc", "anno_1").map((d) => d.id)).toEqual([
      "loop_1",
    ]);
  });

  test("listConsumedPriorsForDependent reads each prior's CURRENT liveness", () => {
    seedDocAnno("anno_live");
    seedDocAnno("anno_dead", NOW + 500);
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_1",
        claimType: "role",
        claimText: "coordinates the rehearsals",
        evidenceDocId: "doc_ev",
        evidenceQuote: "she coordinates the rehearsals",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW,
    );
    createPersonAnnotation(
      db,
      {
        id: "panno_2",
        personId: "per_1",
        claimType: "role",
        claimText: "hands rehearsals to Maya Reeves",
        evidenceDocId: "doc_ev",
        evidenceQuote: "handing this over to Maya",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW + 1,
    );
    supersedePersonAnnotation(db, "panno_1", "panno_2", NOW + 600);
    recordConsumptionEdges(
      db,
      [
        edge({ priorAnnotationId: "anno_live" }),
        edge({ priorAnnotationId: "anno_dead" }),
        edge({ priorStore: "person", priorAnnotationId: "panno_1" }),
        edge({ priorStore: "person", priorAnnotationId: "panno_retracted" }),
      ],
      NOW + 700,
    );
    const priors = listConsumedPriorsForDependent(db, "brief", "brief_1");
    expect(priors.map((p) => [p.store, p.annotationId, p.live, p.supersededBy])).toEqual([
      ["doc", "anno_live", true, null],
      ["doc", "anno_dead", false, null],
      ["person", "panno_1", false, "panno_2"],
      // A hard-retracted (or never-known) prior surfaces dead, claim-less.
      ["person", "panno_retracted", false, null],
    ]);
    expect(priors[3]!.claimText).toBeNull();
  });

  test("the dead-prior scan windows on invalidated_at and requires a live dependent", () => {
    seedDocAnno("anno_a", NOW + 100);
    seedDocAnno("anno_b", NOW + 200);
    seedDocAnno("anno_c", NOW + 900);
    seedBrief("brief_1", "Card");
    recordConsumptionEdges(
      db,
      [
        edge({ priorAnnotationId: "anno_a" }),
        edge({ priorAnnotationId: "anno_b" }),
        edge({ priorAnnotationId: "anno_b", dependentId: "brief_gone" }),
        edge({ priorAnnotationId: "anno_c" }),
      ],
      NOW,
    );
    // Window (NOW+100, NOW+500]: anno_a excluded (at the exclusive bound),
    // anno_c excluded (beyond), anno_b's dangling dependent excluded.
    const rows = listDeadPriorDependents(db, { sinceExclusive: NOW + 100, until: NOW + 500 });
    expect(rows).toEqual([
      {
        priorStore: "doc",
        priorAnnotationId: "anno_b",
        invalidatedAt: NOW + 200,
        dependentKind: "brief",
        dependentId: "brief_1",
      },
    ]);
  });

  test("hard retract atomically enqueues rechecks and keeps claim-less provenance", () => {
    seedDocAnno("anno_1");
    seedBrief();
    seedLoop();
    recordConsumptionEdges(
      db,
      [edge(), edge({ dependentKind: "loop", dependentId: "loop_1" })],
      NOW,
    );

    expect(
      retractAnnotationWithDependentRechecks(db, "doc", "anno_1", NOW + 100, () =>
        deleteDocAnnotation(db, "anno_1"),
      ),
    ).toBe(true);
    expect(getDocAnnotation(db, "anno_1")).toBeNull();

    const runs = db
      .prepare<
        [],
        { kind: string; payload_json: string; dedupe_key: string }
      >("SELECT kind, payload_json, dedupe_key FROM cognition_runs ORDER BY dedupe_key")
      .all();
    for (const run of runs) {
      expect(parseCognitionProvenanceRecheckPayload(JSON.parse(run.payload_json))).not.toBeNull();
    }
    expect(
      runs.map((run) => ({
        kind: run.kind,
        payload: JSON.parse(run.payload_json) as unknown,
        dedupeKey: run.dedupe_key,
      })),
    ).toEqual([
      {
        kind: "feedback",
        payload: {
          recheckDependentKind: "brief",
          recheckDependentId: "brief_1",
          recheckGeneration: expect.any(String),
        },
        dedupeKey: "feedback:provenance:brief:brief_1",
      },
      {
        kind: "feedback",
        payload: {
          recheckDependentKind: "loop",
          recheckDependentId: "loop_1",
          recheckGeneration: expect.any(String),
        },
        dedupeKey: "feedback:provenance:loop:loop_1",
      },
    ]);
    expect(listConsumedPriorsForDependent(db, "brief", "brief_1")).toEqual([
      {
        store: "doc",
        annotationId: "anno_1",
        live: false,
        claimType: null,
        claimText: null,
        supersededBy: null,
      },
    ]);
  });

  test("person retract folded into an in-flight recheck survives its finalization", () => {
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_1",
        claimType: "role",
        claimText: "coordinates the rehearsals",
        evidenceDocId: "doc_ev",
        evidenceQuote: "she coordinates the rehearsals",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW,
    );
    seedBrief();
    recordConsumptionEdges(db, [edge({ priorStore: "person", priorAnnotationId: "panno_1" })], NOW);
    const claimedPayloadJson = JSON.stringify({
      recheckDependentKind: "brief",
      recheckDependentId: "brief_1",
      recheckGeneration: "00000000-0000-4000-8000-000000000001",
    });
    db.prepare(
      `INSERT INTO cognition_runs
         (id, kind, payload_json, dedupe_key, status, attempts,
          next_attempt_at, enqueued_at, cycle_anchor_at)
       VALUES ('run_existing', 'feedback', ?,
               'feedback:provenance:brief:brief_1', 'pending', 3, ?, ?, ?)`,
    ).run(claimedPayloadJson, NOW, NOW, NOW);

    expect(
      retractAnnotationWithDependentRechecks(db, "person", "panno_1", NOW + 100, () =>
        deletePersonAnnotation(db, "panno_1"),
      ),
    ).toBe(true);
    expect(getPersonAnnotation(db, "panno_1")).toBeNull();
    const folded = db
      .prepare<
        [],
        { attempts: number; payload_json: string }
      >("SELECT attempts, payload_json FROM cognition_runs")
      .get()!;
    expect(folded.attempts).toBe(0);
    expect(folded.payload_json).not.toBe(claimedPayloadJson);
    const foldedPayload = JSON.parse(folded.payload_json) as Record<string, unknown>;
    expect(parseCognitionProvenanceRecheckPayload(foldedPayload)).not.toBeNull();
    expect(foldedPayload.recheckGeneration).not.toBe("00000000-0000-4000-8000-000000000001");
    expect(foldedPayload).toEqual({
      recheckDependentKind: "brief",
      recheckDependentId: "brief_1",
      recheckGeneration: expect.any(String),
    });

    finalizeCognitionRun(db, {
      runId: "run_existing",
      now: NOW + 200,
      day: "2026-08-15",
      mechanism: "provenance-recheck",
      modelId: null,
      usage: null,
      claimedPayloadJson,
      outcome: { kind: "completed" },
    });
    expect(db.prepare<[], { status: string }>("SELECT status FROM cognition_runs").get()).toEqual({
      status: "pending",
    });
  });

  test("failed queue insertion rolls the hard retract back", () => {
    seedDocAnno("anno_1");
    seedBrief();
    recordConsumptionEdges(db, [edge()], NOW);
    db.exec(`
      CREATE TRIGGER reject_recheck BEFORE INSERT ON cognition_runs
      BEGIN
        SELECT RAISE(ABORT, 'queue unavailable');
      END
    `);

    expect(() =>
      retractAnnotationWithDependentRechecks(db, "doc", "anno_1", NOW + 100, () =>
        deleteDocAnnotation(db, "anno_1"),
      ),
    ).toThrow("queue unavailable");
    expect(getDocAnnotation(db, "anno_1")).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_runs").get()).toEqual({ n: 0 });
  });
});
