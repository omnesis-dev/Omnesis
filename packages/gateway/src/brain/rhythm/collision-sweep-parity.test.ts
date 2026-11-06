// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Parity goldens for the collision sweep. `__fixtures__/collision-sweep-parity.json`
 * holds what the sweep enqueued and what each finder returned, uncapped, on
 * the empty, small, edge and large invented fixtures, under every arm
 * configuration and cap the rhythm task can pass. The goldens were captured
 * from the sweep as it ran on the gateway's main handle; any change to where
 * or how the sweep reads must reproduce them exactly — the same candidates in
 * the same order, the same payloads, dedupe keys and marker.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  findAnnotationContradictionCandidates,
  findCollisionCandidates,
  findTemporalAnnotationCollisionCandidates,
} from "../reconcile/collision-candidates.js";
import {
  FIXTURE_NOW,
  FIXTURE_SELF,
  digestList,
  recordSweep,
  seedEdgeFixture,
  seedLargeFixture,
  seedSmallFixture,
  type SweepArms,
} from "./collision-sweep-test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const FIXTURES: Record<string, (db: Db) => void> = {
  empty: () => {},
  small: seedSmallFixture,
  edge: seedEdgeFixture,
  large: (db) => seedLargeFixture(db),
};

const ARMS: Record<string, SweepArms> = {
  default: { loops: true, contradictions: true, maxPerSweep: 3, contradictionsMax: 2 },
  "loops only": { loops: true, contradictions: false, maxPerSweep: 3, contradictionsMax: 2 },
  "contradictions only": {
    loops: false,
    contradictions: true,
    maxPerSweep: 3,
    contradictionsMax: 2,
  },
  "both off": { loops: false, contradictions: false, maxPerSweep: 3, contradictionsMax: 2 },
  "cap of one": { loops: true, contradictions: true, maxPerSweep: 1, contradictionsMax: 1 },
  "under the cap": { loops: true, contradictions: true, maxPerSweep: 60, contradictionsMax: 60 },
  "one-day horizon": {
    loops: true,
    contradictions: true,
    maxPerSweep: 60,
    contradictionsMax: 2,
    horizonDays: 1,
  },
};

let path: string;
let db: Db;
beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

/** Everything the sweep and its finders produce on one fixture. */
async function captureFixture(name: string): Promise<unknown> {
  FIXTURES[name]!(db);
  const sweeps: Record<string, unknown> = {};
  for (const [armName, arms] of Object.entries(ARMS)) sweeps[armName] = await recordSweep(db, arms);
  const uncapped = 1_000_000;
  const finders = {
    loops: digestList(
      findCollisionCandidates(db, {
        limit: uncapped,
        selfPersonId: FIXTURE_SELF,
        now: FIXTURE_NOW,
      }),
    ),
    loopsWithoutSelf: digestList(
      findCollisionCandidates(db, { limit: uncapped, selfPersonId: null, now: FIXTURE_NOW }),
    ),
    temporal: Object.fromEntries(
      [1, 60, 400].map((horizonDays) => [
        `horizon ${horizonDays}d`,
        digestList(
          findTemporalAnnotationCollisionCandidates(db, {
            limit: uncapped,
            now: FIXTURE_NOW,
            horizonDays,
          }),
        ),
      ]),
    ),
    contradictions: digestList(findAnnotationContradictionCandidates(db, { max: uncapped })),
  };
  return { sweeps, finders };
}

describe("collision sweep parity", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`the ${name} fixture enqueues and finds exactly what the main-handle sweep did`, async () => {
      const captured = await captureFixture(name);
      await expect(JSON.stringify(captured, null, 1) + "\n").toMatchFileSnapshot(
        `./__fixtures__/collision-sweep-parity.${name}.json`,
      );
    });
  }
});
