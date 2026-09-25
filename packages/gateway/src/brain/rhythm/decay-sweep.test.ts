// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decay engine's scheduling contract (criterion 6's decay half):
 * a stale open loop gets a status-check run scheduled `base·2^n` after
 * its last update; the back-off doubles per kept (unreinforced) check
 * up to the cap; any reinforcement resets it; a keep is recorded via
 * `lastDecayCheck` on `updateOpenLoop`; sweeps are dirty-mark-gated
 * (zero work when nothing changed) and retract pending checks for loops
 * no longer open. All durations are floor-less config — the ~1-month
 * cap compresses to milliseconds here.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  cancelPendingCognitionRunsByDedupeKeys,
  claimDueCognitionRuns,
  enqueueCognitionRun,
  type EnqueueCognitionRunInput,
} from "../storage/run-queue.js";
import { setCognitionEngineState } from "../storage/engine-state.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  deleteOpenLoop,
  getOpenLoop,
  updateOpenLoop,
} from "../storage/open-loops.js";
import { decayCheckRunDedupeKey } from "../run-payloads.js";
import { nextDecayCheckAt, runDecaySweepPass, type DecaySweepWriteOps } from "./decay-sweep.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test:briefs-decay");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("nextDecayCheckAt", () => {
  const cfg = { backoffBaseMs: 100, backoffCapMs: 800, datedFloorMs: 10, datedFraction: 0.5 };
  const undated = { deadline: null, importance: 0 };

  test("undated, unimportant loop keeps fade-and-forget: base·2^n after last update", () => {
    expect(nextDecayCheckAt({ ...undated, lastUpdate: 5000, decayCheckCount: 0 }, cfg, 5000)).toBe(
      5100,
    );
    expect(nextDecayCheckAt({ ...undated, lastUpdate: 5000, decayCheckCount: 1 }, cfg, 5000)).toBe(
      5200,
    );
    expect(nextDecayCheckAt({ ...undated, lastUpdate: 5000, decayCheckCount: 3 }, cfg, 5000)).toBe(
      5800,
    );
  });

  test("the cap bounds the undated interval", () => {
    expect(nextDecayCheckAt({ ...undated, lastUpdate: 5000, decayCheckCount: 10 }, cfg, 5000)).toBe(
      5800,
    );
  });

  test("importance stretches the undated curve — an important loop is revisited sooner (decays slower)", () => {
    // importance 1 → divide the interval by 2: base·2^1 / 2 = 100.
    expect(
      nextDecayCheckAt(
        { deadline: null, importance: 1, lastUpdate: 5000, decayCheckCount: 1 },
        cfg,
        5000,
      ),
    ).toBe(5100);
  });

  test("dated loop pre-deadline: a tension ramp — datedFraction × time-remaining from now", () => {
    const deadlineMs = Date.parse("2026-07-08T23:59:59.999");
    const now = deadlineMs - 1000; // 1000ms before the deadline
    // remaining 1000 × 0.5 = 500, within [floor 10, cap 800]; decayCheckCount is ignored.
    expect(
      nextDecayCheckAt(
        { deadline: { date: "2026-07-08" }, importance: 0, lastUpdate: 0, decayCheckCount: 9 },
        cfg,
        now,
      ),
    ).toBe(now + 500);
  });

  test("dated loop at/past deadline: the dense floor, never backing off toward deletion", () => {
    const deadlineMs = Date.parse("2026-07-08T23:59:59.999");
    const now = deadlineMs + 5000; // overdue
    expect(
      nextDecayCheckAt(
        { deadline: { date: "2026-07-08" }, importance: 0, lastUpdate: 0, decayCheckCount: 20 },
        cfg,
        now,
      ),
    ).toBe(now + cfg.datedFloorMs);
  });

  test("dated + importance shortens the ramp further", () => {
    const deadlineMs = Date.parse("2026-07-08T23:59:59.999");
    const now = deadlineMs - 1000;
    // remaining 1000 × 0.5 = 500; importance 1 → /2 → 250.
    expect(
      nextDecayCheckAt(
        { deadline: { date: "2026-07-08" }, importance: 1, lastUpdate: 0, decayCheckCount: 5 },
        cfg,
        now,
      ),
    ).toBe(now + 250);
  });
});

describe("decay sweep", () => {
  let path: string;
  let db: Db;
  let clockNow: number;
  let writeCalls: number;

  const cfg = { backoffBaseMs: 100, backoffCapMs: 800, datedFloorMs: 10, datedFraction: 0.5 };

  const writeOps = (): DecaySweepWriteOps => ({
    enqueueCognitionRun: async (input: EnqueueCognitionRunInput, now: number) => {
      writeCalls += 1;
      return enqueueCognitionRun(db, input, now);
    },
    cancelPendingCognitionRuns: async (keys: string[]) => {
      writeCalls += 1;
      return cancelPendingCognitionRunsByDedupeKeys(db, keys);
    },
    setCognitionEngineState: async (key: string, value: string) => {
      writeCalls += 1;
      setCognitionEngineState(db, key, value);
    },
  });

  const sweep = () =>
    runDecaySweepPass({
      db,
      writeGate: writeOps(),
      clock: () => clockNow,
      getBackoff: () => cfg,
      log,
      idGen: () => randomUUID(),
    });

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    clockNow = 10_000;
    writeCalls = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function seedLoop(at: number): string {
    const loop = createOpenLoop(
      db,
      {
        id: `loop_${randomUUID()}`,
        createdByRun: "run_seed",
        title: "Follow up on the quote",
        confidence: 0.8,
        // Undated + importance 0 isolates the base·2^n back-off; the dated /
        // importance split is covered in the nextDecayCheckAt unit tests above.
        importance: 0,
      },
      at,
    );
    return loop.id;
  }

  function pendingCheck(loopId: string): { next_attempt_at: number; payload_json: string } | null {
    return (
      db
        .prepare<
          [string],
          { next_attempt_at: number; payload_json: string }
        >("SELECT next_attempt_at, payload_json FROM cognition_runs WHERE status = 'pending' AND dedupe_key = ?")
        .get(decayCheckRunDedupeKey(loopId)) ?? null
    );
  }

  test("a new open loop gets a status-check scheduled base after its last update", async () => {
    const loopId = seedLoop(10_000);
    const result = await sweep();
    expect(result.swept).toBe(true);
    expect(result.scheduled).toBe(1);
    const row = pendingCheck(loopId);
    expect(row).not.toBeNull();
    expect(row!.next_attempt_at).toBe(10_100);
    expect(JSON.parse(row!.payload_json)).toEqual({ decayCheckLoopId: loopId });
  });

  test("the scheduled check rides the queue's own notBefore gate (fires at the requested time)", async () => {
    seedLoop(10_000);
    await sweep();
    expect(claimDueCognitionRuns(db, { now: 10_099 })).toHaveLength(0);
    const due = claimDueCognitionRuns(db, { now: 10_100 });
    expect(due).toHaveLength(1);
    expect(due[0]?.kind).toBe("time_based");
  });

  test("dirty-mark gating: a sweep with no loop changes since the last one does zero work", async () => {
    seedLoop(10_000);
    expect((await sweep()).swept).toBe(true);
    writeCalls = 0;
    const second = await sweep();
    expect(second.swept).toBe(false);
    expect(writeCalls).toBe(0); // not even the swept-version write
  });

  test("a kept check doubles the back-off; each further keep doubles again up to the cap", async () => {
    const loopId = seedLoop(10_000);
    await sweep();

    // Keep #1 (the agent's open_loop_update with decayCheckPassed → lastDecayCheck).
    clockNow = 10_100;
    updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow);
    expect(getOpenLoop(db, loopId)?.decayCheckCount).toBe(1);
    await sweep();
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(10_100 + 200);

    // Keep #2.
    clockNow = 10_300;
    updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow);
    await sweep();
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(10_300 + 400);

    // Keeps beyond the cap stay capped.
    for (let i = 0; i < 5; i += 1) {
      clockNow += 100;
      updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow);
    }
    await sweep();
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(clockNow + 800);
  });

  test("a keep that also demotes importance still counts as a keep, not reinforcement", async () => {
    const loopId = seedLoop(10_000);
    clockNow = 10_100;
    updateOpenLoop(db, loopId, { importance: 0.3, lastDecayCheck: clockNow }, clockNow);
    const loop = getOpenLoop(db, loopId);
    expect(loop?.importance).toBe(0.3);
    expect(loop?.decayCheckCount).toBe(1);
    expect(loop?.lastDecayCheck).toBe(10_100);
  });

  test("reinforcement (a substantive update) resets the back-off; a ledger note does not", async () => {
    const loopId = seedLoop(10_000);
    clockNow = 10_100;
    updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow);
    clockNow = 10_300;
    updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow);
    expect(getOpenLoop(db, loopId)?.decayCheckCount).toBe(2);

    // New data touched the loop: a plain field update resets the counter.
    clockNow = 10_400;
    updateOpenLoop(db, loopId, { description: "the vendor replied" }, clockNow);
    expect(getOpenLoop(db, loopId)?.decayCheckCount).toBe(0);
    await sweep();
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(10_400 + 100);

    // A ledger note is NOT reinforcement: a decay-check records its
    // investigation via the ledger before stamping the verdict, so a note
    // must leave the back-off counter intact — otherwise it could never grow.
    clockNow = 10_500;
    updateOpenLoop(db, loopId, { lastDecayCheck: clockNow }, clockNow); // keep → count 1
    appendOpenLoopLedger(db, loopId, { runId: "run_x", note: "new context" }, 10_600);
    expect(getOpenLoop(db, loopId)?.decayCheckCount).toBe(1);
  });

  test("reinforcement before the pending check fires folds its schedule forward (no duplicate row)", async () => {
    const loopId = seedLoop(10_000);
    await sweep();
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(10_100);

    clockNow = 10_050;
    updateOpenLoop(db, loopId, { description: "still moving" }, clockNow);
    await sweep();
    const rows = db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ?")
      .get(decayCheckRunDedupeKey(loopId));
    expect(rows?.n).toBe(1);
    expect(pendingCheck(loopId)!.next_attempt_at).toBe(10_050 + 100);
  });

  test("a loop leaving the open state gets its pending check retracted", async () => {
    const loopId = seedLoop(10_000);
    await sweep();
    expect(pendingCheck(loopId)).not.toBeNull();

    clockNow = 10_050;
    updateOpenLoop(db, loopId, { state: "done" }, clockNow);
    const result = await sweep();
    expect(result.cancelled).toBe(1);
    expect(pendingCheck(loopId)).toBeNull();
  });

  test("a deleted loop gets its pending check retracted", async () => {
    const loopId = seedLoop(10_000);
    await sweep();
    deleteOpenLoop(db, loopId);
    const result = await sweep();
    expect(result.cancelled).toBe(1);
    expect(pendingCheck(loopId)).toBeNull();
  });

  test("snoozed / done / dismissed loops are never decay-checked", async () => {
    for (const state of ["snoozed", "done", "dismissed"] as const) {
      const loopId = seedLoop(10_000);
      updateOpenLoop(db, loopId, { state }, 10_001);
      await sweep();
      expect(pendingCheck(loopId)).toBeNull();
    }
  });

  test("a mutation landing after the sweep's dirty read re-dirties the next tick (OCC ordering)", async () => {
    const loopA = seedLoop(10_000);
    await sweep();
    expect(pendingCheck(loopA)).not.toBeNull();
    // Another mutation after that sweep completed…
    const loopB = seedLoop(11_000);
    // …means the next sweep runs (dirty > swept) and picks the new loop up.
    const result = await sweep();
    expect(result.swept).toBe(true);
    expect(pendingCheck(loopB)).not.toBeNull();
  });
});
