// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the re-verification sweep: due selection (stale-or-never-checked
 * only, self-person facts first, oldest-verified order), same-store batching
 * with sorted-id dedupe keys, the daily cadence gate, the per-pass budget,
 * and the pending-coverage skip + dedupe-key folding that keep a shifting due
 * set from minting overlapping runs. Fixture data is invented — no corpus
 * content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { DEFAULT_COGNITION_RUN_MAX_ATTEMPTS, listCognitionRuns } from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  COGNITION_REVERIFICATION_LAST_RUN_KEY,
} from "../storage/engine-state.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { createPersonAnnotation } from "../storage/person-annotations.js";
import { verificationRunDedupeKey } from "../run-payloads.js";
import {
  runReverificationSweepPass,
  REVERIFICATION_SWEEP_CADENCE_MS,
  type ReverificationSettings,
} from "./reverification-sweep.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("reverification");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 24 * 3_600_000;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function insertPerson(db: Db, id: string, name: string, isSelf: number): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, isSelf);
}

function docAnno(db: Db, id: string, createdAt: number, lastVerifiedAt?: number): void {
  createDocAnnotation(
    db,
    {
      id,
      docId: "doc_subject",
      claimType: "topic",
      claimText: `claim ${id}`,
      evidenceDocId: "doc_evidence",
      evidenceQuote: `quote ${id}`,
      confidence: 0.6,
      claimBasis: "quoted",
      createdByRun: "run_seed",
    },
    createdAt,
  );
  if (lastVerifiedAt !== undefined) {
    db.prepare("UPDATE doc_annotations SET last_verified_at = ? WHERE id = ?").run(
      lastVerifiedAt,
      id,
    );
  }
}

function personAnno(
  db: Db,
  id: string,
  personId: string,
  createdAt: number,
  lastVerifiedAt?: number,
): void {
  createPersonAnnotation(
    db,
    {
      id,
      personId,
      claimType: "role",
      claimText: `claim ${id}`,
      evidenceDocId: "doc_evidence",
      evidenceQuote: `quote ${id}`,
      confidence: 0.6,
      claimBasis: "quoted",
      createdByRun: "run_seed",
    },
    createdAt,
  );
  if (lastVerifiedAt !== undefined) {
    db.prepare("UPDATE person_annotations SET last_verified_at = ? WHERE id = ?").run(
      lastVerifiedAt,
      id,
    );
  }
}

interface VerificationRunView {
  payload: { annotationIds: string[]; store: string };
  dedupeKey: string | null;
}
function verificationRuns(db: Db): VerificationRunView[] {
  return listCognitionRuns(db, { limit: 50 })
    .filter((r) => r.kind === "verification")
    .map((r) => ({
      payload: r.payload as VerificationRunView["payload"],
      dedupeKey: r.dedupeKey,
    }))
    .reverse(); // listCognitionRuns is newest-first; tests read enqueue order
}

const SETTINGS: ReverificationSettings = {
  enabled: true,
  intervalDays: 14,
  maxPerSweep: 3,
  batchSize: 2,
};

describe("runReverificationSweepPass", () => {
  let path: string;
  let db: Db;
  let now: number;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    now = NOW;
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function deps(settings: ReverificationSettings = SETTINGS) {
    return {
      db,
      writeGate: directWriteGate(db),
      clock: () => now,
      getSettings: () => settings,
      log,
      idGen: () => `v${++seq}`,
    };
  }

  test("self-person facts lead, then oldest-verified across both stores; one store per run; sorted dedupe keys", async () => {
    insertPerson(db, "per_self", "Maya Reeves", 1);
    insertPerson(db, "per_other", "Jamie Lopez", 0);
    // Self fact: stale but RECENTLY verified relative to the others — the
    // self priority must still put it first.
    personAnno(db, "panno_self", "per_self", NOW - 200 * DAY, NOW - 20 * DAY);
    // Never-checked person fact (oldest-created of the never-checked rows).
    personAnno(db, "panno_other", "per_other", NOW - 300 * DAY);
    // Never-checked doc fact + an old-verified doc fact.
    docAnno(db, "anno_never", NOW - 250 * DAY);
    docAnno(db, "anno_old", NOW - 100 * DAY, NOW - 100 * DAY);

    const result = await runReverificationSweepPass(deps());
    expect(result.fired).toBe(true);
    expect(result.enqueued).toBe(2);

    const runs = verificationRuns(db);
    // Batch 1: the person store (its head is the self fact), filled with the
    // store's next-due id. Batch 2: the doc store, never-checked first.
    expect(runs[0]!.payload).toEqual({
      annotationIds: ["panno_self", "panno_other"],
      store: "person",
    });
    expect(runs[1]!.payload).toEqual({ annotationIds: ["anno_never", "anno_old"], store: "doc" });
    // The fold key is the SORTED id batch.
    expect(runs[0]!.dedupeKey).toBe("verify:person:panno_other,panno_self");
    expect(runs[1]!.dedupeKey).toBe("verify:doc:anno_never,anno_old");
    expect(getCognitionEngineState(db, COGNITION_REVERIFICATION_LAST_RUN_KEY)).toBe(String(NOW));
  });

  test("annotations inside the freshness interval, and invalidated rows, are not due", async () => {
    docAnno(db, "anno_fresh", NOW - 30 * DAY, NOW - 1 * DAY);
    docAnno(db, "anno_dead", NOW - 30 * DAY);
    db.prepare("UPDATE doc_annotations SET invalidated_at = ? WHERE id = 'anno_dead'").run(NOW);
    const result = await runReverificationSweepPass(deps());
    expect(result).toEqual({ fired: true, enqueued: 0 });
    expect(verificationRuns(db)).toHaveLength(0);
  });

  test("daily cadence gate: a same-day re-tick does nothing; a day later fires again", async () => {
    docAnno(db, "anno_a", NOW - 30 * DAY);
    expect((await runReverificationSweepPass(deps())).fired).toBe(true);
    now = NOW + REVERIFICATION_SWEEP_CADENCE_MS - 1;
    expect(await runReverificationSweepPass(deps())).toEqual({ fired: false, enqueued: 0 });
    now = NOW + REVERIFICATION_SWEEP_CADENCE_MS + 1;
    expect((await runReverificationSweepPass(deps())).fired).toBe(true);
  });

  test("ids already riding a pending run are skipped; only genuinely new due ids enqueue", async () => {
    docAnno(db, "anno_a", NOW - 30 * DAY);
    docAnno(db, "anno_b", NOW - 29 * DAY);
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(1);
    // A day later the runs have not executed (nothing re-stamped) and a new
    // annotation became due: the covered pair is skipped, only the newcomer
    // enqueues — no overlapping batches from due-set drift.
    docAnno(db, "anno_c", NOW - 28 * DAY);
    now = NOW + DAY + 1;
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(1);
    const runs = verificationRuns(db);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.payload.annotationIds).toEqual(["anno_c"]);
  });

  test("an identically re-detected batch folds into the pending run via its dedupe key", async () => {
    const gate = directWriteGate(db);
    const key = verificationRunDedupeKey("doc", ["anno_b", "anno_a"]);
    expect(key).toBe("verify:doc:anno_a,anno_b");
    await gate.enqueueCognitionRun(
      {
        id: "run_1",
        kind: "verification",
        payload: { annotationIds: ["anno_a", "anno_b"], store: "doc" },
        dedupeKey: key,
      },
      NOW,
    );
    await gate.enqueueCognitionRun(
      {
        id: "run_2",
        kind: "verification",
        payload: { annotationIds: ["anno_a", "anno_b"], store: "doc" },
        dedupeKey: key,
      },
      NOW + 1,
    );
    expect(verificationRuns(db)).toHaveLength(1);
  });

  test("an attempts-exhausted pending run is crash residue: cancelled, its ids re-enqueued under a fresh claimable run", async () => {
    // Coherence story. A pending run whose attempts reached the drainer's cap
    // without ever settling (a process death mid-claim, repeated) can never be
    // claimed again — the claim predicate is `attempts < maxAttempts` — so
    // counting it as coverage would shadow its member annotations from
    // re-verification forever. The sweep cancels the residue FIRST, which
    // frees its pending-unique dedupe key, and then re-enqueues the still-due
    // ids as a fresh run with a clean attempt budget (an INSERT, never a fold
    // into the dead row).
    docAnno(db, "anno_a", NOW - 30 * DAY);
    docAnno(db, "anno_b", NOW - 29 * DAY);
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(1);
    db.prepare("UPDATE cognition_runs SET attempts = ? WHERE kind = 'verification'").run(
      DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
    );
    now = NOW + DAY + 1;
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(1);
    const runs = listCognitionRuns(db, { kinds: ["verification"] });
    expect(runs).toHaveLength(1); // the residue row is gone, not kept beside the new one
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.attempts).toBe(0);
    expect(runs[0]!.dedupeKey).toBe("verify:doc:anno_a,anno_b");
    expect((runs[0]!.payload as { annotationIds: string[] }).annotationIds).toEqual([
      "anno_a",
      "anno_b",
    ]);
  });

  test("a pending run still under the attempts cap keeps covering its ids (in-flight, not residue)", async () => {
    docAnno(db, "anno_a", NOW - 30 * DAY);
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(1);
    // One attempt short of the cap — the final attempt is still owed (it may
    // be executing right now), so the row covers and is not cancelled.
    db.prepare("UPDATE cognition_runs SET attempts = ? WHERE kind = 'verification'").run(
      DEFAULT_COGNITION_RUN_MAX_ATTEMPTS - 1,
    );
    now = NOW + DAY + 1;
    expect((await runReverificationSweepPass(deps())).enqueued).toBe(0);
    const runs = listCognitionRuns(db, { kinds: ["verification"] });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempts).toBe(DEFAULT_COGNITION_RUN_MAX_ATTEMPTS - 1);
  });

  test("maxPerSweep caps the runs enqueued per pass", async () => {
    for (let i = 0; i < 6; i += 1) docAnno(db, `anno_${i}`, NOW - (40 - i) * DAY);
    const result = await runReverificationSweepPass(
      deps({ ...SETTINGS, maxPerSweep: 2, batchSize: 2 }),
    );
    expect(result.enqueued).toBe(2);
    const runs = verificationRuns(db);
    expect(runs.flatMap((r) => r.payload.annotationIds)).toHaveLength(4);
  });
});
