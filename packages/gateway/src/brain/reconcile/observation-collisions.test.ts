// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collision candidates covered by observations: a relation the user is
 * already being told about — an open (live/held) observation, or one shipped
 * in the last two weeks, whose related loops include every member — is never
 * re-proposed. Dropped observations, partial coverage and older shipments
 * leave the candidate in place.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { createObservation, transitionObservation } from "../storage/observations.js";
import { findCollisionCandidates } from "./collision-candidates.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;

let path: string;
let db: Database.Database;

function loop(id: string, deadline: string): void {
  createOpenLoop(
    db,
    { id, createdByRun: "r", title: `Task ${id}`, confidence: 0.8, importance: 0.5, deadline },
    NOW - 5 * DAY,
  );
}

function observe(id: string, relatedLoopIds: string[], at = NOW - DAY): void {
  createObservation(db, { id, createdByRun: "r", summary: `About ${id}`, relatedLoopIds }, at);
}

const candidates = () =>
  findCollisionCandidates(db, { limit: 10, selfPersonId: null, now: NOW }).map((c) =>
    c.loopIds.join(","),
  );

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  // Two loops due on the same day collide on the deadline-day key.
  loop("loop_a", "2026-07-10");
  loop("loop_b", "2026-07-10");
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("collision candidates covered by observations", () => {
  test("uncovered pair is proposed", () => {
    expect(candidates()).toEqual(["loop_a,loop_b"]);
  });

  test("a live observation spanning both loops covers the pair", () => {
    observe("obs_live", ["loop_a", "loop_b"]);
    expect(candidates()).toEqual([]);
  });

  test("a held observation still covers", () => {
    observe("obs_held", ["loop_a", "loop_b"]);
    transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, NOW - DAY);
    expect(candidates()).toEqual([]);
  });

  test("a superset of the group covers it", () => {
    loop("loop_c", "2026-08-01");
    observe("obs_wide", ["loop_a", "loop_b", "loop_c"]);
    expect(candidates()).toEqual([]);
  });

  test("an observation over only one member does not cover the pair", () => {
    observe("obs_one", ["loop_a"]);
    expect(candidates()).toEqual(["loop_a,loop_b"]);
  });

  test("two observations each covering one member do not cover the pair together", () => {
    observe("obs_one", ["loop_a"]);
    observe("obs_two", ["loop_b"]);
    expect(candidates()).toEqual(["loop_a,loop_b"]);
  });

  test("a dropped observation never covers", () => {
    observe("obs_dropped", ["loop_a", "loop_b"]);
    transitionObservation(db, "obs_dropped", { state: "dropped", reason: "withdrawn" }, NOW - DAY);
    expect(candidates()).toEqual(["loop_a,loop_b"]);
  });

  test("a shipped observation covers for fourteen days, inclusive", () => {
    observe("obs_shipped", ["loop_a", "loop_b"], NOW - 20 * DAY);
    transitionObservation(
      db,
      "obs_shipped",
      { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
      NOW - 14 * DAY,
    );
    expect(candidates()).toEqual([]);
  });

  test("a shipped observation older than fourteen days no longer covers", () => {
    observe("obs_old", ["loop_a", "loop_b"], NOW - 30 * DAY);
    transitionObservation(
      db,
      "obs_old",
      { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
      NOW - 14 * DAY - 1,
    );
    expect(candidates()).toEqual(["loop_a,loop_b"]);
  });

  test("coverage is per group: an uncovered group still surfaces beside a covered one", () => {
    loop("loop_c", "2026-07-20");
    loop("loop_d", "2026-07-20");
    observe("obs_ab", ["loop_a", "loop_b"]);
    expect(candidates()).toEqual(["loop_c,loop_d"]);
  });
});
