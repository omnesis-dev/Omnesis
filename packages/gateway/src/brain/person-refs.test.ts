// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The person-ref resolution boundary: agent-supplied `actors`/`involved`
 * values resolve to canonical person ids (emails through their alias,
 * merged ids up to the root), unknowns drop, and the boot sweep rewrites
 * legacy rows without looking like agent activity (no `last_update`
 * bump, no decay reset).
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import {
  displayPersonRefs,
  normalizeOpenLoopPersonRefs,
  partitionPersonRefs,
  resolveLoopPersonRef,
} from "./person-refs.js";
import { createOpenLoop, getOpenLoop, loopPeople } from "./storage/open-loops.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("person-refs", () => {
  let dbPath: string;
  let db: Db;

  function seedPerson(id: string, name: string, mergedInto: string | null = null): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen,
          created_at, updated_at)
       VALUES (?, ?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name, mergedInto);
  }
  function seedEmailAlias(personId: string, email: string): void {
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias, alias_type, source_id, created_at)
       VALUES (?, ?, 'email', 'test', '2026-01-01')`,
    ).run(personId, email);
  }

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    seedPerson("per_maya", "Maya Reeves");
    seedPerson("per_jamie", "Jamie Lopez");
    // per_old was merged into per_maya; its alias should resolve to the root.
    seedPerson("per_old", "M. Reeves", "per_maya");
    seedEmailAlias("per_maya", "maya@example.com");
    seedEmailAlias("per_old", "m.reeves@example.org");
    // A shared email owned by two DISTINCT people — ambiguous, never resolved.
    seedEmailAlias("per_maya", "shared@example.com");
    seedEmailAlias("per_jamie", "shared@example.com");
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("resolves person ids (following merges), emails (via alias), and rejects the rest", () => {
    expect(resolveLoopPersonRef(db, "per_maya")).toBe("per_maya");
    // A merged-away id walks up to its canonical root.
    expect(resolveLoopPersonRef(db, "per_old")).toBe("per_maya");
    // Emails resolve through the alias table — including an alias sitting
    // on a merged-away loser — and are normalized before lookup.
    expect(resolveLoopPersonRef(db, "maya@example.com")).toBe("per_maya");
    expect(resolveLoopPersonRef(db, "m.reeves@example.org")).toBe("per_maya");
    expect(resolveLoopPersonRef(db, "MAYA@EXAMPLE.COM")).toBe("per_maya");
    // Ambiguous (two distinct owners) and unknown values resolve to nothing.
    expect(resolveLoopPersonRef(db, "shared@example.com")).toBeNull();
    expect(resolveLoopPersonRef(db, "nobody@example.com")).toBeNull();
    expect(resolveLoopPersonRef(db, "not-a-person")).toBeNull();
  });

  test("partition dedupes refs that resolve to the same person and reports drops", () => {
    const part = partitionPersonRefs(db, [
      "per_maya",
      "maya@example.com", // same person again → collapsed
      "per_jamie",
      "nobody@example.com",
    ]);
    expect(part.known).toEqual(["per_maya", "per_jamie"]);
    expect(part.dropped).toEqual(["nobody@example.com"]);
  });

  test("display enrichment names resolvable refs and passes raw values through", () => {
    expect(
      displayPersonRefs(db, ["per_maya", "m.reeves@example.org", "ghost@example.com"]),
    ).toEqual([
      { id: "per_maya", name: "Maya Reeves" },
      { id: "per_maya", name: "Maya Reeves" },
      { id: "ghost@example.com", name: null },
    ]);
  });

  test("the boot sweep rewrites legacy rows in place without touching last_update or decay", async () => {
    const writeGate = directWriteGate(db);
    createOpenLoop(
      db,
      {
        id: "loop_legacy",
        createdByRun: "run_1",
        title: "Book the studio session",
        confidence: 0.8,
        importance: 0.6,
        actors: ["maya@example.com"],
        involved: ["per_jamie", "ghost@example.com"],
      },
      1000,
    );
    createOpenLoop(
      db,
      {
        id: "loop_clean",
        createdByRun: "run_1",
        title: "Already canonical",
        confidence: 0.8,
        importance: 0.6,
        actors: ["per_maya"],
      },
      1000,
    );

    const rewritten = await normalizeOpenLoopPersonRefs({
      db,
      writeGate,
      log: { info: () => {} },
    });
    expect(rewritten).toBe(1);

    const legacy = getOpenLoop(db, "loop_legacy")!;
    expect(legacy.actors).toEqual(["per_maya"]);
    // The unresolvable value stays (the read surface renders it as plain
    // text) — the sweep never destroys the agent's record.
    expect(legacy.involved).toEqual(["per_jamie", "ghost@example.com"]);
    // Hygiene, not agent activity: timestamps and decay state untouched.
    expect(legacy.lastUpdate).toBe(1000);
    expect(legacy.decayCheckCount).toBe(0);
    // The reconcile join table follows the rewrite.
    expect(loopPeople(db, "loop_legacy").actors).toEqual(["per_maya"]);

    // Idempotent: a clean store is a no-op.
    expect(await normalizeOpenLoopPersonRefs({ db, writeGate, log: { info: () => {} } })).toBe(0);
  });
});
