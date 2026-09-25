// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { createAnnotationStorageTables } from "../brain/storage/annotations.js";
import { createPersonAnnotationStorageTables } from "../brain/storage/person-annotations.js";
import { createBriefsStorageTables } from "../brain/storage/schema.js";
import {
  createConsumptionEdgesTables,
  recordConsumptionEdges,
} from "../brain/storage/consumption-edges.js";
import { parseCognitionProvenanceRecheckPayload } from "../brain/run-payloads.js";
import { MIGRATIONS } from "./migrations.js";

const NOW = Date.parse("2026-08-15T10:00:00.000Z");

describe("migration 108", () => {
  test("enqueues one recheck per live dependent and no-ops after completion", () => {
    const db = new Database(":memory:");
    try {
      createAnnotationStorageTables(db);
      createPersonAnnotationStorageTables(db);
      createBriefsStorageTables(db);
      createConsumptionEdgesTables(db);
      db.prepare(
        `INSERT INTO briefs
           (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
         VALUES ('brief_1', 'run_seed', 'info', 'Review the plan', 0.8, 0.5, ?, ?)`,
      ).run(NOW, NOW);
      db.prepare(
        `INSERT INTO open_loops
           (id, created_by_run, confidence, importance, title, created_at, last_update)
         VALUES ('loop_1', 'run_seed', 0.8, 0.6, 'Confirm the venue', ?, ?)`,
      ).run(NOW, NOW);
      recordConsumptionEdges(
        db,
        [
          {
            priorStore: "person",
            priorAnnotationId: "panno_missing",
            dependentKind: "brief",
            dependentId: "brief_1",
            runId: "run_seed",
          },
          {
            priorStore: "doc",
            priorAnnotationId: "anno_missing",
            dependentKind: "loop",
            dependentId: "loop_1",
            runId: "run_seed",
          },
          {
            priorStore: "doc",
            priorAnnotationId: "anno_missing",
            dependentKind: "brief",
            dependentId: "brief_gone",
            runId: "run_seed",
          },
        ],
        NOW,
      );

      const migration = MIGRATIONS.find((entry) => entry.version === 108)!;
      migration.up(db);
      const firstRuns = db
        .prepare<[], { payload_json: string }>("SELECT payload_json FROM cognition_runs")
        .all();
      expect(firstRuns).toHaveLength(2);
      for (const run of firstRuns) {
        expect(parseCognitionProvenanceRecheckPayload(JSON.parse(run.payload_json))).not.toBeNull();
      }
      db.prepare("UPDATE cognition_runs SET status = 'completed', completed_at = ?").run(NOW + 1);
      migration.up(db);

      const runs = db
        .prepare<
          [],
          { dedupe_key: string; payload_json: string }
        >("SELECT dedupe_key, payload_json FROM cognition_runs ORDER BY dedupe_key")
        .all();
      expect(
        runs.map((run) => ({
          dedupeKey: run.dedupe_key,
          payload: JSON.parse(run.payload_json) as unknown,
        })),
      ).toEqual([
        {
          dedupeKey: "feedback:provenance:brief:brief_1",
          payload: {
            recheckDependentKind: "brief",
            recheckDependentId: "brief_1",
            recheckGeneration: expect.any(String),
          },
        },
        {
          dedupeKey: "feedback:provenance:loop:loop_1",
          payload: {
            recheckDependentKind: "loop",
            recheckDependentId: "loop_1",
            recheckGeneration: expect.any(String),
          },
        },
      ]);
      expect(
        db
          .prepare<
            [],
            { value: string }
          >("SELECT value FROM cognition_engine_state WHERE key = 'migration:108:missing-prior-rechecks'")
          .get(),
      ).toEqual({ value: "complete" });
    } finally {
      db.close();
    }
  });
});
