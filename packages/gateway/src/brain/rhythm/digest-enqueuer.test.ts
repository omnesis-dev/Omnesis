// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The digest readiness barrier: fires once per local day at the digest
 * hour, but only after today's dailies were enqueued AND the queue has
 * genuinely settled — with the grace deadline as the bounded escape so a
 * busy morning still gets its brief.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { listCognitionRuns, claimDueCognitionRuns } from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  setCognitionEngineState,
  cognitionSweepLastBoundaryKey,
  COGNITION_DAILY_LAST_RUN_DAY_KEY,
  COGNITION_DIGEST_LAST_RUN_DAY_KEY,
} from "../storage/engine-state.js";
import { digestRunDedupeKey } from "../run-payloads.js";
import { runDigestEnqueuePass, type DigestEnqueuerDeps } from "./digest-enqueuer.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("digest");
// 07:10 local on an unambiguous date: past the 07:00 digest boundary but
// inside the 45-minute grace window, so the readiness barrier is live.
const NOW = new Date(2026, 6, 2, 7, 10, 0).getTime();
const TODAY = "2026-07-02";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("runDigestEnqueuePass", () => {
  let path: string;
  let db: Db;
  let now: number;
  let activeRuns: number;

  const deps = (over: Partial<DigestEnqueuerDeps> = {}): DigestEnqueuerDeps => ({
    db,
    writeGate: directWriteGate(db),
    clock: () => now,
    getDigestHour: () => 7,
    getGraceMinutes: () => 45,
    getActiveRunCount: () => activeRuns,
    log,
    idGen: () => randomUUID(),
    ...over,
  });

  const markDailiesEnqueued = (day = TODAY) =>
    setCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY, day);
  const digestRuns = () =>
    listCognitionRuns(db, { limit: 10 }).filter((r) => r.dedupeKey?.startsWith("daily:digest:"));

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    now = NOW;
    activeRuns = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("fires when dailies are enqueued and the queue is settled; marker written last", async () => {
    markDailiesEnqueued();
    const out = await runDigestEnqueuePass(deps());
    expect(out).toEqual({ fired: true });
    const runs = digestRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("daily");
    expect(runs[0]!.payload).toEqual({ digest: true, date: TODAY });
    expect(runs[0]!.dedupeKey).toBe(digestRunDedupeKey(TODAY));
    expect(getCognitionEngineState(db, COGNITION_DIGEST_LAST_RUN_DAY_KEY)).toBe(TODAY);
  });

  test("waits while today's dailies were not yet enqueued", async () => {
    const out = await runDigestEnqueuePass(deps());
    expect(out).toEqual({ fired: false, reason: "waiting" });
    expect(digestRuns()).toHaveLength(0);
  });

  test("waits until every digest-prerequisite sweep has fired", async () => {
    markDailiesEnqueued();
    const prerequisites = [
      { id: "overnight-context", anchorMinutes: 5 * 60 },
      { id: "unresolved-contact", anchorMinutes: 5 * 60 + 10 },
    ];
    const readyDeps = deps({ getDigestPrerequisiteSweeps: () => prerequisites });

    expect(await runDigestEnqueuePass(readyDeps)).toEqual({ fired: false, reason: "waiting" });

    setCognitionEngineState(db, cognitionSweepLastBoundaryKey(prerequisites[0]!.id), String(now));
    expect(await runDigestEnqueuePass(readyDeps)).toEqual({ fired: false, reason: "waiting" });

    setCognitionEngineState(db, cognitionSweepLastBoundaryKey(prerequisites[1]!.id), String(now));
    expect(await runDigestEnqueuePass(readyDeps)).toEqual({ fired: true });
  });

  test("waits while a due pending run is outstanding, then fires once it settles", async () => {
    markDailiesEnqueued();
    const gate = directWriteGate(db);
    await gate.enqueueCognitionRun(
      { id: "run_overnight", kind: "data", payload: { docId: "d" } },
      now - 1000,
    );
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: false, reason: "waiting" });
    // Settle it (claim + complete) — barrier releases.
    claimDueCognitionRuns(db, { now });
    await gate.finalizeCognitionRun({
      runId: "run_overnight",
      now,
      day: TODAY,
      mechanism: "data",
      modelId: null,
      usage: null,
      claimedPayloadJson: JSON.stringify({ docId: "d" }),
      debounceMs: 0,
      outcome: { kind: "completed" },
    });
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
  });

  test("a debounced future run does not hold the digest hostage", async () => {
    markDailiesEnqueued();
    await directWriteGate(db).enqueueCognitionRun(
      // Debounced: not claimable until later this morning.
      { id: "run_debounced", kind: "data", payload: { docId: "d" }, notBefore: now + 3_600_000 },
      now,
    );
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
  });

  test("waits while a run is executing right now", async () => {
    markDailiesEnqueued();
    activeRuns = 1;
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: false, reason: "waiting" });
    activeRuns = 0;
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
  });

  test("the grace deadline composes anyway on a busy morning", async () => {
    // Queue busy AND dailies missing — but it is past 07:45 local.
    activeRuns = 3;
    now = new Date(2026, 6, 2, 7, 46, 0).getTime();
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
  });

  test("a crash after enqueue but before the marker cannot double-fire the day", async () => {
    markDailiesEnqueued();
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
    // Simulate the crash window: the run row exists (even settled), but
    // the marker write was lost.
    claimDueCognitionRuns(db, { now });
    const runId = digestRuns()[0]!.id;
    await directWriteGate(db).finalizeCognitionRun({
      runId,
      now,
      day: TODAY,
      mechanism: "daily",
      modelId: null,
      usage: null,
      claimedPayloadJson: JSON.stringify({ digest: true, date: TODAY }),
      debounceMs: 0,
      outcome: { kind: "completed" },
    });
    db.prepare("DELETE FROM cognition_engine_state WHERE key = ?").run(
      COGNITION_DIGEST_LAST_RUN_DAY_KEY,
    );
    // Replay: the settled row proves the day fired; marker is repaired.
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: false, reason: "already-ran" });
    expect(digestRuns()).toHaveLength(1);
    expect(getCognitionEngineState(db, COGNITION_DIGEST_LAST_RUN_DAY_KEY)).toBe(TODAY);
  });

  test("a poisoned pending row (attempts exhausted) cannot hold the barrier forever", async () => {
    markDailiesEnqueued();
    await directWriteGate(db).enqueueCognitionRun(
      { id: "run_poison", kind: "data", payload: { docId: "d" } },
      now - 1000,
    );
    db.prepare("UPDATE cognition_runs SET attempts = 5 WHERE id = 'run_poison'").run();
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
  });

  test("fires once per local day; a clock jump backwards stays quiet", async () => {
    markDailiesEnqueued();
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: true });
    expect(await runDigestEnqueuePass(deps())).toEqual({ fired: false, reason: "already-ran" });
    // Clock jumps back before today's boundary — still quiet (yesterday's
    // boundary resolves, and the marker already covers a later day).
    now = new Date(2026, 6, 2, 6, 0, 0).getTime();
    expect((await runDigestEnqueuePass(deps())).fired).toBe(false);
  });
});
