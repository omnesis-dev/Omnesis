// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeBatchReadIndexes,
  readKnowledgeBatch,
  readKnowledgeBatches,
} from "./batch-query.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE knowledge_batches(id TEXT PRIMARY KEY,run_id TEXT,tier TEXT,status TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,finished_at INTEGER);
    CREATE TABLE knowledge_work(id TEXT PRIMARY KEY,batch_id TEXT,reason TEXT);`);
  createKnowledgeBatchReadIndexes(db);
  createKnowledgeBatchReadIndexes(db);
  const batch = (
    id: string,
    at: number,
    tier = "routine",
    status = "completed",
    reasons = ["change"],
  ) => {
    db.prepare("INSERT INTO knowledge_batches VALUES(?,?,?,?,1,?,?,NULL)").run(
      id,
      `run_${id}`,
      tier,
      status,
      at,
      at,
    );
    reasons.forEach((reason, index) =>
      db.prepare("INSERT INTO knowledge_work VALUES(?,?,?)").run(`work_${id}_${index}`, id, reason),
    );
  };
  return { db, batch };
}

describe("maintenance batch filters and pagination", () => {
  it("filters exact reasons, tier and status before limiting and exposes every mixed-batch reason", () => {
    const { db, batch } = fixture();
    try {
      for (let i = 0; i < 60; i++) batch(`new_${i}`, 1000 + i, "immediate", "running", ["change"]);
      batch("old_match", 10, "routine", "completed", ["discovery", "review", "discovery"]);
      batch("other_tier", 9, "soon", "completed", ["discovery"]);
      batch("other_status", 8, "routine", "pending", ["discovery"]);
      const page = readKnowledgeBatches(db, {
        reason: "discovery",
        tier: "routine",
        status: "history",
        limit: 1,
      });
      expect(page.items.map((item) => item.id)).toEqual(["old_match"]);
      expect(page.items[0]!.reasons).toEqual(["discovery", "review"]);
      expect(page.hasMore).toBe(false);
      expect(readKnowledgeBatch(db, "old_match")!.reasons).toEqual(["discovery", "review"]);
      expect(readKnowledgeBatches(db, { reason: "root" }).items).toEqual([]);
      expect(readKnowledgeBatch(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });
  it("pages a historical filtered view with deterministic ties and binds cursors to all filters", () => {
    const { db, batch } = fixture();
    try {
      for (const id of ["a", "b", "c"]) batch(id, 100, "soon", "completed", ["root"]);
      batch("older", 90, "soon", "abandoned", ["root"]);
      const first = readKnowledgeBatches(db, {
        reason: "root",
        tier: "soon",
        status: "history",
        limit: 2,
      });
      expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
      expect(first.hasMore).toBe(true);
      const second = readKnowledgeBatches(db, {
        reason: "root",
        tier: "soon",
        status: "history",
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.items.map((item) => item.id)).toEqual(["c", "older"]);
      expect(second.nextCursor).toBeNull();
      for (const changes of [
        { reason: "review" as const },
        { tier: "routine" as const },
        { status: "completed" as const },
      ])
        expect(() =>
          readKnowledgeBatches(db, {
            reason: "root",
            tier: "soon",
            status: "history",
            ...changes,
            cursor: first.nextCursor!,
          }),
        ).toThrow("Invalid pagination cursor");
      expect(() => readKnowledgeBatches(db, { cursor: "not-json" })).toThrow(
        "Invalid pagination cursor",
      );
      expect(() => readKnowledgeBatches(db, { cursor: "x".repeat(2049) })).toThrow(
        "Invalid pagination cursor",
      );
    } finally {
      db.close();
    }
  });
  it("supports exact states, active grouping, bounded pages and does not invent deleted work reasons", () => {
    const { db, batch } = fixture();
    try {
      batch("pending", 3, "routine", "pending", ["upgrade"]);
      batch("running", 2, "routine", "running", ["review"]);
      batch("deferred", 1, "routine", "deferred", ["root"]);
      expect(readKnowledgeBatches(db, { status: "active" }).items.map((item) => item.id)).toEqual([
        "pending",
        "running",
      ]);
      expect(readKnowledgeBatches(db, { status: "deferred" }).items.map((item) => item.id)).toEqual(
        ["deferred"],
      );
      db.prepare("DELETE FROM knowledge_work WHERE batch_id=?").run("pending");
      expect(readKnowledgeBatch(db, "pending")!.reasons).toEqual([]);
      expect(readKnowledgeBatches(db, { reason: "upgrade" }).items).toEqual([]);
      for (let i = 0; i < 110; i++) batch(`bounded_${i}`, 100 + i);
      const bounded = readKnowledgeBatches(db, { limit: 10000 });
      expect(bounded.items).toHaveLength(100);
      expect(bounded.hasMore).toBe(true);
    } finally {
      db.close();
    }
  });
});
