// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer's background batches that loop over many small units give the
 * writer back once their time slice is spent, so a write queued at their own
 * priority is served between slices rather than after the whole batch. A
 * call's hold is the cost of a unit times the units it takes; this file pins
 * the second factor without a stopwatch. A clock that never moves lets a
 * handler run its whole budget in one call, and a clock already past the
 * slice's end stops it at the first unit boundary, after one unit, with the
 * rest carried in its yield. `writer-maintenance.preempt.e2e.test.ts` drives
 * the same handlers in a real writer worker against a large corpus.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../db.js";
import { COLLAPSED_ACCEPT_CHUNK } from "../merge-candidates.js";
import { PreemptBuffer, PreemptToken } from "./preempt.js";
import { writerYieldableHandlers } from "./writer-handlers.js";
import { seedPilotCorpus, type PilotCorpus } from "./__fixtures__/pilot-corpus.js";
import type Database from "better-sqlite3";

const UNRESOLVED_DOCS = 12;
/** Two chunks of collapsed candidates: every second pending one. */
const PENDING_CANDIDATES = 4 * COLLAPSED_ACCEPT_CHUNK;

let path: string;
let db: Database.Database;
let corpus: PilotCorpus;

beforeEach(() => {
  path = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createDatabase(path) as unknown as Database.Database;
  corpus = seedPilotCorpus(db, {
    docs: 2_000,
    unresolvedDocs: UNRESOLVED_DOCS,
    pendingCandidates: PENDING_CANDIDATES,
    collapsedEvery: 2,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

const token = () => new PreemptToken(new PreemptBuffer().share());

/** A clock that never moves: nothing ends the slice. */
function stillClock(): void {
  vi.spyOn(performance, "now").mockReturnValue(0);
}

/** A clock that reads 0 when the slice starts and past any slice's end from then on. */
function spentClock(): void {
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
}

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const unresolved = () =>
  count("SELECT COUNT(*) AS n FROM documents WHERE people_resolved_at IS NULL");
const accepted = () =>
  count("SELECT COUNT(*) AS n FROM merge_candidates WHERE status = 'accepted'");

describe("people.backfillManyPeople", () => {
  const backfill = writerYieldableHandlers["people.backfillManyPeople"];

  test("runs its whole batch in one call while the slice lasts", () => {
    stillClock();
    expect(backfill(db, token(), UNRESOLVED_DOCS)).toMatchObject({ processed: UNRESOLVED_DOCS });
    expect(unresolved()).toBe(0);
  });

  test("stops after the document it is on once the slice is spent and yields the rest", () => {
    spentClock();
    const result = backfill(db, token(), UNRESOLVED_DOCS);
    expect(result).toEqual({
      kind: "yield",
      resume: [UNRESOLVED_DOCS - 1, expect.objectContaining({ processed: 1 })],
    });
    expect(unresolved()).toBe(UNRESOLVED_DOCS - 1);
  });
});

describe("people.acceptCollapsedMergeCandidates", () => {
  const accept = writerYieldableHandlers["people.acceptCollapsedMergeCandidates"];

  test("accepts every candidate in one call while the slice lasts", () => {
    const before = accepted();
    stillClock();
    const ids = corpus.collapsedCandidateIds;
    expect(ids.length).toBeGreaterThan(COLLAPSED_ACCEPT_CHUNK);
    expect(accept(db, token(), ids)).toEqual({ swept: ids.length });
    expect(accepted() - before).toBe(ids.length);
  });

  test("stops after the chunk it is on once the slice is spent and yields the rest", () => {
    const before = accepted();
    spentClock();
    const ids = corpus.collapsedCandidateIds;
    expect(accept(db, token(), ids)).toEqual({
      kind: "yield",
      resume: [ids.slice(COLLAPSED_ACCEPT_CHUNK), COLLAPSED_ACCEPT_CHUNK],
    });
    expect(accepted() - before).toBe(COLLAPSED_ACCEPT_CHUNK);
  });
});

describe("db.refreshPlannerStatistics", () => {
  const refresh = writerYieldableHandlers["db.refreshPlannerStatistics"];

  test("analyzes every planned unit in one call while the slice lasts", () => {
    stillClock();
    const result = refresh(db, token());
    expect(result).not.toHaveProperty("kind");
    expect((result as { analyzed: number }).analyzed).toBeGreaterThan(1);
  });

  test("stops after the unit it is on once the slice is spent and yields the rest", () => {
    spentClock();
    const result = refresh(db, token()) as { kind: string; resume: [string[], number, string[]] };
    expect(result.kind).toBe("yield");
    const [remaining, analyzed, tables] = result.resume;
    expect(analyzed).toBe(1);
    expect(tables).toHaveLength(1);
    expect(remaining.length).toBeGreaterThan(0);
  });
});
