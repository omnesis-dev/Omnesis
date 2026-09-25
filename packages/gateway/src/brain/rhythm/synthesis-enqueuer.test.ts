// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the synthesis ("Noticing") enqueuer: fires once and stamps
 * the marker, holds within the cadence window, enforces the per-day cap even
 * after the cadence passes, and fires again on a new local day.
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
  COGNITION_SYNTHESIS_LAST_RUN_KEY,
} from "../storage/engine-state.js";
import { runSynthesisEnqueuePass } from "./synthesis-enqueuer.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("synthesis");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function synthRuns(db: Db): ReturnType<typeof listCognitionRuns> {
  return listCognitionRuns(db, { limit: 20 }).filter((r) => r.kind === "synthesis");
}

describe("runSynthesisEnqueuePass", () => {
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

  test("fires once, stamps the marker, and holds within cadence", async () => {
    let now = NOW;
    let seq = 0;
    const deps = {
      db,
      writeGate: directWriteGate(db),
      clock: () => now,
      getCadenceHours: () => 24,
      getMaxPerDay: () => 1,
      log,
      idGen: () => `s${++seq}`,
    };
    expect(await runSynthesisEnqueuePass(deps)).toEqual({ fired: true });
    const runs = synthRuns(db);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.payload as { focus: string }).focus).toBe("noticing");
    expect(getCognitionEngineState(db, COGNITION_SYNTHESIS_LAST_RUN_KEY)).toBe(String(NOW));

    now = NOW + HOUR; // within the 24h cadence
    expect(await runSynthesisEnqueuePass(deps)).toEqual({ fired: false });
    expect(synthRuns(db)).toHaveLength(1);
  });

  test("the per-day cap holds after the cadence passes; a new day fires again", async () => {
    let now = NOW;
    let seq = 0;
    const deps = {
      db,
      writeGate: directWriteGate(db),
      clock: () => now,
      getCadenceHours: () => 1, // cadence is not the blocker here
      getMaxPerDay: () => 1,
      log,
      idGen: () => `s${++seq}`,
    };
    expect((await runSynthesisEnqueuePass(deps)).fired).toBe(true);

    // Cadence (1h) has passed, same local day — the per-day cap blocks it.
    now = NOW + 2 * HOUR;
    expect((await runSynthesisEnqueuePass(deps)).fired).toBe(false);
    expect(synthRuns(db)).toHaveLength(1);

    // A comfortably-new local day — fires again under a fresh day key.
    now = NOW + 48 * HOUR;
    expect((await runSynthesisEnqueuePass(deps)).fired).toBe(true);
    expect(synthRuns(db)).toHaveLength(2);
  });
});
