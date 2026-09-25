// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the sweep enqueuer: fires one run per due sweep, stamps the
 * per-sweep BOUNDARY marker (not the fire time — that is what keeps a cadence
 * from drifting), holds a sweep inside its own cadence while others fire,
 * skips disabled ones, snapshots the steering prose onto the run, and fires
 * exactly once after downtime spanning several cadence periods.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { listCognitionRuns } from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  setCognitionEngineState,
  cognitionSweepLastBoundaryKey,
  cognitionSweepLegacyLastRunKey,
} from "../storage/engine-state.js";
import { mostRecentSweepBoundary } from "../sweeps/anchor.js";
import { runSweepEnqueuePass } from "./sweep-enqueuer.js";
import type { SweepDef } from "../sweeps/types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("sweep");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Local wall-clock helper — anchors are local times, so the tests must be too. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}
function sweepRuns(db: Db): ReturnType<typeof listCognitionRuns> {
  return listCognitionRuns(db, { limit: 50 }).filter((r) => r.kind === "sweep");
}
function sweepIdsOf(db: Db): string[] {
  return sweepRuns(db).map((r) => (r.payload as { sweepId: string }).sweepId);
}

function sweep(over: Partial<SweepDef> & Pick<SweepDef, "id">): SweepDef {
  return {
    name: over.id,
    origin: "user",
    modified: false,
    cadenceHours: 168,
    steeringPrompt: "Look at the money.",
    enabled: true,
    anchorMinutes: 9 * 60,
    anchorExplicit: true,
    expectedBeforeDigest: false,
    ...over,
  };
}

describe("runSweepEnqueuePass", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  const deps = (clock: () => number, sweeps: () => SweepDef[]) => {
    let seq = 0;
    return {
      db,
      writeGate: directWriteGate(db),
      clock,
      getSweeps: sweeps,
      log,
      idGen: () => `s${++seq}`,
    };
  };

  /** Seed the markers a first pass would write, so a test starts mid-schedule. */
  async function seed(clock: () => number, sweeps: SweepDef[]): Promise<void> {
    expect((await runSweepEnqueuePass(deps(clock, () => sweeps))).fired).toBe(0);
  }

  test("the very first pass seeds the phase instead of firing everything at once", async () => {
    // A fresh install must not enqueue every sweep in one serialized batch at
    // whatever time the gateway happened to start.
    const now = local(2026, 7, 2, 10);
    const sweeps = [sweep({ id: "finances" }), sweep({ id: "health" })];
    expect(
      (
        await runSweepEnqueuePass(
          deps(
            () => now,
            () => sweeps,
          ),
        )
      ).fired,
    ).toBe(0);
    expect(sweepRuns(db)).toHaveLength(0);
    // Seeded one day short of a cadence, so each is due at its own next anchor.
    expect(getCognitionEngineState(db, cognitionSweepLastBoundaryKey("finances"))).toBe(
      String(local(2026, 6, 26, 9)),
    );
    // ...and it fires there, not before.
    let later = local(2026, 7, 3, 8);
    expect(
      (
        await runSweepEnqueuePass(
          deps(
            () => later,
            () => sweeps,
          ),
        )
      ).fired,
    ).toBe(0);
    later = local(2026, 7, 3, 9);
    expect(
      (
        await runSweepEnqueuePass(
          deps(
            () => later,
            () => sweeps,
          ),
        )
      ).fired,
    ).toBe(2);
  });

  test("fires one run per enabled sweep, snapshots steering, stamps boundary markers", async () => {
    const now = local(2026, 7, 2, 10);
    const sweeps = [
      sweep({ id: "finances", origin: "system" }),
      sweep({
        id: "health",
        steeringPrompt: "Look at the health.",
        temporalAnnotationPrimeDays: 14,
      }),
      sweep({ id: "off-one", cadenceHours: 24, enabled: false }),
    ];
    await seed(() => now - 8 * DAY, sweeps);
    expect(
      await runSweepEnqueuePass(
        deps(
          () => now,
          () => sweeps,
        ),
      ),
    ).toEqual({ fired: 2 });

    const runs = sweepRuns(db);
    expect(runs).toHaveLength(2);
    const byId = new Map(runs.map((r) => [(r.payload as { sweepId: string }).sweepId, r]));
    expect([...byId.keys()].sort()).toEqual(["finances", "health"]);
    expect((byId.get("finances")!.payload as { steeringPrompt: string }).steeringPrompt).toBe(
      "Look at the money.",
    );
    // Origin rides the payload so the inspector can label a run without
    // re-resolving the sweep set as it stood at enqueue time.
    expect((byId.get("finances")!.payload as { origin: string }).origin).toBe("system");
    expect((byId.get("health")!.payload as { origin: string }).origin).toBe("user");
    // The prime-window request is snapshotted with the steering; a sweep
    // without one carries no field at all.
    expect(
      (byId.get("health")!.payload as { temporalAnnotationPrimeDays?: number })
        .temporalAnnotationPrimeDays,
    ).toBe(14);
    expect(byId.get("finances")!.payload as object).not.toHaveProperty(
      "temporalAnnotationPrimeDays",
    );

    // The marker holds the BOUNDARY (09:00 that morning), not `now` (10:00).
    const boundary = mostRecentSweepBoundary(now, 9 * 60);
    expect(getCognitionEngineState(db, cognitionSweepLastBoundaryKey("finances"))).toBe(
      String(boundary),
    );
    expect(boundary).toBe(local(2026, 7, 2, 9));
    expect(getCognitionEngineState(db, cognitionSweepLastBoundaryKey("off-one"))).toBeNull();
  });

  test("a weekly sweep holds inside its cadence and re-fires on its own anchor, without drift", async () => {
    let now = local(2026, 6, 24, 10);
    const sweeps = [sweep({ id: "finances" })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    await seed(() => now, sweeps);
    now = local(2026, 7, 2, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);

    // A day later, and six days later: the week has not passed.
    now = local(2026, 7, 3, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);
    now = local(2026, 7, 8, 23);
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);

    // The next anchor a full week on. Even though the tick lands at 23:00,
    // the marker records 09:00 — so the phase is preserved rather than
    // creeping forward by one tick interval per period.
    now = local(2026, 7, 9, 23);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
    expect(getCognitionEngineState(db, cognitionSweepLastBoundaryKey("finances"))).toBe(
      String(local(2026, 7, 9, 9)),
    );
    expect(sweepIdsOf(db)).toEqual(["finances", "finances"]);
  });

  test("downtime spanning several cadence periods fires ONCE, not once per missed period", async () => {
    let now = local(2026, 6, 24, 10);
    const sweeps = [sweep({ id: "finances" })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    await seed(() => now, sweeps);
    now = local(2026, 7, 2, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);

    // Gateway down for a month; comes back mid-afternoon.
    now = local(2026, 8, 3, 15);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);
    expect(sweepRuns(db)).toHaveLength(2);
  });

  test("a backwards clock jump past a boundary already fired stays quiet", async () => {
    let now = local(2026, 7, 1, 10);
    const sweeps = [sweep({ id: "finances" })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    await seed(() => now, sweeps);
    now = local(2026, 7, 9, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
    now = local(2026, 7, 2, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);
  });

  test("a cadence that is not a whole number of days rounds to the nearest one", async () => {
    // 36h has no daily boundary of its own; rounding to 2 days is what stops
    // it coming round every single day.
    let now = local(2026, 7, 1, 10);
    const sweeps = [sweep({ id: "pulse", cadenceHours: 36 })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    await seed(() => now, sweeps);
    now = local(2026, 7, 3, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
    now = local(2026, 7, 4, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);
    now = local(2026, 7, 5, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
  });

  test("a replay after the marker write folds onto the same occurrence", async () => {
    // The dedupe key is keyed on the BOUNDARY's day, not the tick's, so a
    // crash between the enqueue and the marker write replays onto the same key
    // even when the retry lands on the next calendar day.
    let now = local(2026, 6, 24, 23, 50);
    const sweeps = [sweep({ id: "nightly", cadenceHours: 24, anchorMinutes: 23 * 60 + 50 })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    await seed(() => now, sweeps);
    now = local(2026, 6, 25, 23, 50);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);

    // Roll the marker back the way a crash-before-write would leave it, and
    // replay after midnight.
    setCognitionEngineState(db, cognitionSweepLastBoundaryKey("nightly"), String(0));
    setCognitionEngineState(
      db,
      cognitionSweepLegacyLastRunKey("nightly"),
      String(local(2026, 6, 24, 23, 50)),
    );
    now = local(2026, 6, 26, 0, 5);
    await runSweepEnqueuePass(d);
    expect(sweepRuns(db)).toHaveLength(1);
  });

  test("the pre-anchor marker seeds the cadence, so an upgrade does not re-fire everything", async () => {
    // The old marker held a wall-clock fire time. Reading it once as a seed is
    // what stops an upgrade mid-cadence from firing every sweep at boot.
    const lastFire = local(2026, 7, 2, 12, 22);
    setCognitionEngineState(db, cognitionSweepLegacyLastRunKey("finances"), String(lastFire));
    let now = lastFire + DAY;
    const sweeps = [sweep({ id: "finances" })];
    const d = deps(
      () => now,
      () => sweeps,
    );
    expect((await runSweepEnqueuePass(d)).fired).toBe(0);

    // And it fires at its own anchor once the week is genuinely up.
    now = local(2026, 7, 9, 10);
    expect((await runSweepEnqueuePass(d)).fired).toBe(1);
    // The legacy key is only ever read, never written.
    expect(getCognitionEngineState(db, cognitionSweepLegacyLastRunKey("finances"))).toBe(
      String(lastFire),
    );
  });
});
