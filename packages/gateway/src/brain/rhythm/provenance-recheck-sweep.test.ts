// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the provenance-recheck sweep: the first-pass watermark anchor
 * (no backfill of deaths from before the knob), the dead-prior → live-
 * dependent scan, per-dependent dedupe folding (N dead priors → one run;
 * a pending run absorbs later deaths), claim-time coverage (a settled
 * recheck's claim covers every death older than it, and only those), the
 * group-atomic soft cap (a
 * same-timestamp death group is never split; distinct-timestamp groups
 * hold the watermark back), attempts-exhausted residue cancellation, the
 * disabled-tick watermark re-anchor, and gone-dependent skipping. Fixture
 * data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  claimDueCognitionRuns,
  completeCognitionRun,
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
  listCognitionRuns,
} from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
} from "../storage/engine-state.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { recordConsumptionEdges } from "../storage/consumption-edges.js";
import { provenanceRecheckDedupeKey } from "../run-payloads.js";
import {
  reanchorProvenanceRecheckWatermark,
  runProvenanceRecheckSweepPass,
  PROVENANCE_RECHECK_MAX_PER_PASS,
} from "./provenance-recheck-sweep.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("provenance-recheck");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("provenance-recheck sweep", () => {
  let path: string;
  let db: Db;
  let seq: number;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function deps(clockNow: number) {
    return {
      db,
      writeGate: directWriteGate(db),
      clock: () => clockNow,
      log,
      idGen: () => `id${++seq}`,
    };
  }

  function seedAnno(id: string): void {
    createDocAnnotation(
      db,
      {
        id,
        docId: "doc_subject",
        claimType: "topic",
        claimText: `claim ${id}`,
        evidenceDocId: "doc_ev",
        evidenceQuote: `quote ${id}`,
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 10_000,
    );
  }

  function killAnno(id: string, at: number): void {
    db.prepare("UPDATE doc_annotations SET invalidated_at = ? WHERE id = ?").run(at, id);
  }

  function seedBrief(id: string): void {
    db.prepare(
      `INSERT INTO briefs (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
       VALUES (?, 'run_seed', 'info', 'Practice space update', 0.7, 0.4, ?, ?)`,
    ).run(id, NOW - 10_000, NOW - 10_000);
  }

  function recordEdge(annoId: string, briefId: string): void {
    recordConsumptionEdges(
      db,
      [
        {
          priorStore: "doc",
          priorAnnotationId: annoId,
          dependentKind: "brief",
          dependentId: briefId,
          runId: "run_seed",
        },
      ],
      NOW - 10_000,
    );
  }

  function pendingRuns() {
    return listCognitionRuns(db, { statuses: ["pending"], limit: 100 });
  }

  test("first pass anchors the watermark at now and enqueues nothing (no backfill)", async () => {
    seedAnno("anno_1");
    seedBrief("brief_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW - 5_000); // died BEFORE the knob went on
    const r = await runProvenanceRecheckSweepPass(deps(NOW));
    expect(r).toEqual({ fired: false, enqueued: 0 });
    expect(getCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY)).toBe(
      String(NOW),
    );
    // The pre-anchor death is never back-processed.
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(0);
  });

  test("a dead prior with a live dependent enqueues one folded feedback run", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW)); // anchor
    seedAnno("anno_1");
    seedBrief("brief_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100);
    const r = await runProvenanceRecheckSweepPass(deps(NOW + 1_000));
    expect(r).toEqual({ fired: true, enqueued: 1 });
    const runs = pendingRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("feedback");
    expect(runs[0]!.dedupeKey).toBe(provenanceRecheckDedupeKey("brief", "brief_1"));
    expect(runs[0]!.payload).toEqual({
      recheckDependentKind: "brief",
      recheckDependentId: "brief_1",
    });
    // Watermark advanced past the death: a replay pass finds nothing new.
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(1);
  });

  test("N dead priors of ONE dependent fold into a single run; a pending run absorbs later deaths", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedBrief("brief_1");
    for (const id of ["anno_1", "anno_2"]) {
      seedAnno(id);
      recordEdge(id, "brief_1");
    }
    killAnno("anno_1", NOW + 100);
    killAnno("anno_2", NOW + 200);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(1);
    expect(pendingRuns()).toHaveLength(1);
    // A third prior dies while the recheck is still pending: covered — no
    // second run (the prompt reads the dead set at claim time).
    seedAnno("anno_3");
    recordEdge("anno_3", "brief_1");
    killAnno("anno_3", NOW + 1_500);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(1);
  });

  test("a dependent that no longer exists is skipped entirely", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedAnno("anno_1");
    recordEdge("anno_1", "brief_gone");
    killAnno("anno_1", NOW + 100);
    const r = await runProvenanceRecheckSweepPass(deps(NOW + 1_000));
    expect(r).toEqual({ fired: false, enqueued: 0 });
    expect(pendingRuns()).toHaveLength(0);
  });

  test("the per-pass cap holds the watermark back so the remainder re-surfaces next pass", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    const total = PROVENANCE_RECHECK_MAX_PER_PASS + 2;
    for (let i = 0; i < total; i++) {
      const anno = `anno_${i}`;
      const brief = `brief_${i}`;
      seedAnno(anno);
      seedBrief(brief);
      recordEdge(anno, brief);
      killAnno(anno, NOW + 100 + i);
    }
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(
      PROVENANCE_RECHECK_MAX_PER_PASS,
    );
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(2);
    expect(pendingRuns()).toHaveLength(total);
  });

  test("deaths sharing one timestamp are enqueued as a whole group — the cap never splits it", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    // The normal shape: ONE superseded prior consumed by many dependents
    // mints all their deaths at a single `invalidated_at`. Splitting the
    // group would strand the watermark before a timestamp whose rechecks are
    // already pending, re-enqueueing completed ones forever.
    const total = PROVENANCE_RECHECK_MAX_PER_PASS + 3;
    seedAnno("anno_1");
    for (let i = 0; i < total; i++) {
      const brief = `brief_${i}`;
      seedBrief(brief);
      recordEdge("anno_1", brief);
    }
    killAnno("anno_1", NOW + 100);
    // The soft cap overshoots to finish the group in one pass.
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(total);
    expect(pendingRuns()).toHaveLength(total);
    // The watermark advanced past the whole group: a rescan finds nothing.
    expect(getCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY)).toBe(
      String(NOW + 100),
    );
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(total);
  });

  test("an attempts-exhausted pending recheck is crash residue: cancelled, the next death enqueues fresh", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedAnno("anno_1");
    seedBrief("brief_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(1);
    // The pending run's attempts hit the drainer's cap without settling — the
    // drainer's `attempts < maxAttempts` claim predicate can never pick it up
    // again, so counting it as coverage would shadow brief_1 forever.
    db.prepare("UPDATE cognition_runs SET attempts = ? WHERE kind = 'feedback'").run(
      DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
    );
    seedAnno("anno_2");
    recordEdge("anno_2", "brief_1");
    killAnno("anno_2", NOW + 1_500);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(1);
    const runs = pendingRuns();
    expect(runs).toHaveLength(1); // the residue row is gone, not kept beside the new one
    expect(runs[0]!.attempts).toBe(0);
    expect(runs[0]!.dedupeKey).toBe(provenanceRecheckDedupeKey("brief", "brief_1"));
  });

  test("a pending recheck still under the attempts cap keeps covering its dependent", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedAnno("anno_1");
    seedBrief("brief_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(1);
    // One attempt short of the cap — the final attempt is still owed (it may
    // be executing right now), so the row covers and is not cancelled.
    db.prepare("UPDATE cognition_runs SET attempts = ? WHERE kind = 'feedback'").run(
      DEFAULT_COGNITION_RUN_MAX_ATTEMPTS - 1,
    );
    seedAnno("anno_2");
    recordEdge("anno_2", "brief_1");
    killAnno("anno_2", NOW + 1_500);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(0);
    const runs = pendingRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempts).toBe(DEFAULT_COGNITION_RUN_MAX_ATTEMPTS - 1);
  });

  test("a death older than the recheck's claim is covered: no second run once it settles", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedBrief("brief_1");
    seedAnno("anno_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(1);

    // A second prior dies while the run is still queued behind other work…
    seedAnno("anno_2");
    recordEdge("anno_2", "brief_1");
    killAnno("anno_2", NOW + 2_000);
    // …the run is then claimed and settles: its prompt re-derived the dead set
    // AT CLAIM TIME, so both deaths were in view.
    claimDueCognitionRuns(db, { now: NOW + 3_000 });
    completeCognitionRun(db, "run_id1", { usage: null, now: NOW + 4_000 });

    // The pending row is gone, but the claim covers both deaths: nothing new.
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 5_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(0);
  });

  test("a death after the recheck's claim is uncovered: a second run is enqueued", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW));
    seedBrief("brief_1");
    seedAnno("anno_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 1_000))).enqueued).toBe(1);
    claimDueCognitionRuns(db, { now: NOW + 2_000 });
    completeCognitionRun(db, "run_id1", { usage: null, now: NOW + 2_500 });

    // This prior died AFTER the claim, so the settled run never saw it.
    seedAnno("anno_2");
    recordEdge("anno_2", "brief_1");
    killAnno("anno_2", NOW + 3_000);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 4_000))).enqueued).toBe(1);
    const runs = pendingRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dedupeKey).toBe(provenanceRecheckDedupeKey("brief", "brief_1"));
  });

  test("disable → re-enable: the re-anchored watermark skips off-window deaths but sees later ones", async () => {
    await runProvenanceRecheckSweepPass(deps(NOW)); // first enabled pass anchors
    seedAnno("anno_1");
    seedBrief("brief_1");
    recordEdge("anno_1", "brief_1");
    killAnno("anno_1", NOW + 100); // dies while the knob is OFF
    // Each disabled tick slides the watermark up to its own now.
    await reanchorProvenanceRecheckWatermark(deps(NOW + 1_000));
    expect(getCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY)).toBe(
      String(NOW + 1_000),
    );
    // Re-enabled: the off-window death is behind the watermark — no backfill.
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 2_000))).enqueued).toBe(0);
    expect(pendingRuns()).toHaveLength(0);
    // A death after re-enable is picked up normally.
    seedAnno("anno_2");
    seedBrief("brief_2");
    recordEdge("anno_2", "brief_2");
    killAnno("anno_2", NOW + 2_500);
    expect((await runProvenanceRecheckSweepPass(deps(NOW + 3_000))).enqueued).toBe(1);
    expect(pendingRuns()[0]!.dedupeKey).toBe(provenanceRecheckDedupeKey("brief", "brief_2"));
  });

  test("the disabled-tick re-anchor is a no-op before the first enabled pass", async () => {
    await reanchorProvenanceRecheckWatermark(deps(NOW));
    expect(getCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY)).toBeNull();
  });
});
