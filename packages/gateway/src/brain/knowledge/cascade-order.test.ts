// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cascade runs on every install, Brain or not: every document write that
 * passes the source triggers queues one invalidation job. A step used to pick
 * its row with one join ordered by a `CASE` over the job kind, which sorted
 * every pending row of every job on every step; against a backlog of a large
 * ingest, one bounded slice held the writer for tens of seconds. The pick is
 * now two index seeks. These tests hold the new pick to the old one's order,
 * row for row, and assert the plans that make it cheap.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  advanceKnowledgeCascade,
  KNOWLEDGE_CASCADE_NEXT_JOB_SQL,
  KNOWLEDGE_CASCADE_NEXT_ROW_SQL,
  nextKnowledgeCascadeItem,
} from "./storage-invalidation.js";
import type Database from "better-sqlite3";

/** The pick this change replaced, kept here as the order it must reproduce. */
const SORTED_PICK = `SELECT f.*,j.kind,j.target_kind AS root_kind,j.target_id AS root_id
  FROM knowledge_cascade_frontier f JOIN knowledge_cascade_jobs j ON j.id=f.job_id
  WHERE f.done=0 AND (? IS NULL OR f.job_id=?)
  ORDER BY CASE j.kind WHEN 'purge' THEN 0 ELSE 1 END,j.id,f.rowid LIMIT 1`;

const NOW = 1_800_000_000_000;

let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function plantJob(
  kind: "invalidate" | "purge",
  targetKind: "source" | "node",
  targetId: string,
): number {
  const id = Number(
    db
      .prepare(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES(?,?,?,?,?)",
      )
      .run(kind, targetKind, targetId, kind === "purge" ? "deleted" : `rev-${targetId}`, NOW)
      .lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id) VALUES(?,?,?)",
  ).run(id, targetKind, targetId);
  return id;
}

/**
 * Dependency edges without their pages: a step that reaches a missing page
 * only marks it done, which is all an ordering test needs. Foreign keys are
 * off for the planting alone, since an edge's key names a claim.
 */
function plantDependents(targetKind: "source" | "node", targetId: string, nodes: string[]): void {
  db.pragma("foreign_keys = OFF");
  const insert = db.prepare(
    "INSERT INTO knowledge_dependencies(node_id,claim_id,ref,target_id,target_kind,relation,input_version_json) VALUES(?,?,?,?,?,?,'{}')",
  );
  for (const [index, node] of nodes.entries())
    insert.run(
      node,
      "c1",
      `r-${targetId}`,
      targetId,
      targetKind,
      index === 1 ? "context" : "cites",
    );
  db.pragma("foreign_keys = ON");
}

/** A mixed backlog: invalidations and purges interleaved, some with dependents. */
function plantMixedBacklog(): number[] {
  const jobs: number[] = [];
  for (let i = 0; i < 24; i++) {
    const source = `note-${String(i).padStart(3, "0")}`;
    if (i % 3 === 0)
      plantDependents("source", source, [`page-${i}-b`, `page-${i}-a`, `page-${i}-c`]);
    jobs.push(plantJob(i % 5 === 2 ? "purge" : "invalidate", "source", source));
    if (i % 7 === 3) {
      plantDependents("node", `owner-${i}`, [`page-${i}-d`]);
      jobs.push(plantJob(i % 2 ? "purge" : "invalidate", "node", `owner-${i}`));
    }
  }
  return jobs;
}

function sortedPick(onlyJobId: number | null) {
  return db.prepare(SORTED_PICK).get(onlyJobId, onlyJobId);
}

function plan(sql: string, ...args: unknown[]): string[] {
  return db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => row.detail);
}

function pendingRows(): number {
  return db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM knowledge_cascade_frontier WHERE done=0")
    .get()!.n;
}

describe("knowledge cascade order", () => {
  test("every step picks the row the sorted join picked, with and without a job filter", () => {
    const jobs = plantMixedBacklog();
    let steps = 0;
    while (sortedPick(null)) {
      expect(nextKnowledgeCascadeItem(db, undefined)).toEqual(sortedPick(null));
      for (const job of [jobs[steps % jobs.length]!, jobs[(steps * 7) % jobs.length]!])
        expect(nextKnowledgeCascadeItem(db, job) ?? null).toEqual(sortedPick(job) ?? null);
      advanceKnowledgeCascade(db, 1, NOW);
      steps++;
      expect(steps).toBeLessThan(500);
    }
    expect(nextKnowledgeCascadeItem(db, undefined)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_cascade_jobs").get()).toEqual({ n: 0 });
    expect(steps).toBeGreaterThan(jobs.length);
  });

  test("a purge queued behind invalidations still runs first", () => {
    plantJob("invalidate", "source", "note-a");
    plantJob("invalidate", "source", "note-b");
    const purge = plantJob("purge", "source", "note-c");
    expect(nextKnowledgeCascadeItem(db, undefined)?.job_id).toBe(purge);
    advanceKnowledgeCascade(db, 1, NOW);
    expect(
      db.prepare("SELECT 1 FROM knowledge_cascade_jobs WHERE id=?").get(purge),
    ).toBeUndefined();
  });

  test("a requested yield stops the slice between steps, after at least one", () => {
    for (let i = 0; i < 10; i++) plantJob("invalidate", "source", `note-${i}`);
    expect(advanceKnowledgeCascade(db, 100, NOW, undefined, { requested: () => true })).toEqual({
      pending: true,
      deletedNodeIds: [],
      invalidatedNodeIds: [],
    });
    expect(pendingRows()).toBe(9);
    let checks = 0;
    advanceKnowledgeCascade(db, 100, NOW, undefined, { requested: () => ++checks > 3 });
    expect(pendingRows()).toBe(5);
    expect(advanceKnowledgeCascade(db, 100, NOW).pending).toBe(false);
  });

  test("both picks are index seeks against an analyzed ingest backlog", () => {
    const insertJob = db.prepare(
      "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('invalidate','source',?,?,?)",
    );
    const insertRow = db.prepare(
      "INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id) VALUES(?,'source',?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const id = `drive-file-${i}`;
        insertRow.run(insertJob.run(id, `rev-${i}`, NOW).lastInsertRowid, id);
      }
    })();
    plantJob("purge", "source", "drive-file-gone");
    db.exec("ANALYZE");
    const jobPlan = plan(KNOWLEDGE_CASCADE_NEXT_JOB_SQL, "invalidate");
    expect(jobPlan.join("\n")).toMatch(
      /SEARCH j USING (COVERING )?INDEX knowledge_cascade_jobs_kind/,
    );
    const rowPlan = plan(KNOWLEDGE_CASCADE_NEXT_ROW_SQL, 1);
    expect(rowPlan.join("\n")).toMatch(/SEARCH f USING INDEX knowledge_cascade_work/);
    for (const detail of [...jobPlan, ...rowPlan]) {
      expect(detail).not.toMatch(/^SCAN/);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    }
    expect(plan(SORTED_PICK, null, null).join("\n")).toMatch(/TEMP B-TREE FOR ORDER BY/);
  });
});
