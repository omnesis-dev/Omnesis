// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import { appendOpenLoopLedger, createOpenLoop, updateOpenLoop } from "./storage/open-loops.js";
import { createBrief } from "./storage/briefs.js";
import { createGatewayLoopReadPort } from "./interactive-loop-port.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanup(p: string): void {
  for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(p + s)) unlinkSync(p + s);
}
function insertPerson(db: Db, id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

describe("interactive loop-read port", () => {
  let path: string;
  let db: Db;
  const NOW = Date.parse("2026-07-02T10:00:00.000Z");
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanup(path);
  });

  test("search returns active loop summaries and omits terminal loops", async () => {
    createOpenLoop(
      db,
      {
        id: "olp_1",
        createdByRun: "r",
        title: "Chase the deposit refund from the landlord",
        description: "Awaiting the transfer.",
        confidence: 0.8,
        importance: 0.7,
      },
      NOW,
    );
    createOpenLoop(
      db,
      {
        id: "olp_2",
        createdByRun: "r",
        title: "deposit refund receipt filed away",
        description: "Handled.",
        confidence: 0.8,
        importance: 0.5,
      },
      NOW,
    );
    updateOpenLoop(db, "olp_2", { state: "done" }, NOW); // terminal — must not surface

    const port = createGatewayLoopReadPort(db);
    const res = await port.search({ query: "deposit refund" });
    expect(res.loops.map((l) => l.loopId)).toEqual(["olp_1"]);
    expect(res.loops[0]!.title).toContain("deposit refund");
    expect(res.loops[0]!.state).toBe("open");
  });

  test("fetch returns full detail: resolved names, doc ids, ledger, coerced deadline", async () => {
    insertPerson(db, "per_maya", "Maya Reeves");
    createOpenLoop(
      db,
      {
        id: "olp_x",
        createdByRun: "r",
        title: "Sign the lease addendum",
        description: "Pending signature.",
        confidence: 0.9,
        importance: 0.8,
        actors: ["per_maya"],
        involved: ["per_ghost"],
        docs: ["doc_a", "doc_b"],
        deadline: { date: "2026-07-15" },
      },
      NOW,
    );
    appendOpenLoopLedger(db, "olp_x", { runId: "r", note: "created from the email" }, NOW);

    const loop = await createGatewayLoopReadPort(db).fetch("olp_x");
    expect(loop).not.toBeNull();
    expect(loop!.actors).toEqual(["Maya Reeves"]); // id → canonical name
    expect(loop!.involved).toEqual(["per_ghost"]); // unresolved id falls back to itself
    expect(loop!.docIds).toEqual(["doc_a", "doc_b"]);
    expect(loop!.ledger?.map((e) => e.note)).toContain("created from the email");
    expect(loop!.deadline).toBe(JSON.stringify({ date: "2026-07-15" }));
  });

  test("fetch returns null for a terminal or missing loop", async () => {
    createOpenLoop(
      db,
      {
        id: "olp_d",
        createdByRun: "r",
        title: "a dismissed thing",
        description: "gone",
        confidence: 0.8,
        importance: 0.5,
      },
      NOW,
    );
    updateOpenLoop(db, "olp_d", { state: "dismissed" }, NOW);
    const port = createGatewayLoopReadPort(db);
    expect(await port.fetch("olp_d")).toBeNull();
    expect(await port.fetch("olp_missing")).toBeNull();
  });

  test("fetch attaches relatedLoops — active loops sharing a brief", async () => {
    const mk = (id: string): void => {
      createOpenLoop(
        db,
        {
          id,
          createdByRun: "r",
          title: `loop ${id}`,
          description: "d",
          confidence: 0.8,
          importance: 0.6,
        },
        NOW,
      );
    };
    mk("olp_1");
    mk("olp_2");
    createBrief(
      db,
      {
        id: "brf_1",
        createdByRun: "r",
        kind: "loop",
        title: "grouped work",
        confidence: 0.8,
        urgency: 0.4,
        relatedLoopIds: ["olp_1", "olp_2"],
      },
      NOW,
    );
    const detail = await createGatewayLoopReadPort(db).fetch("olp_1");
    expect(detail?.relatedLoops?.map((l) => l.loopId)).toEqual(["olp_2"]);
    // A loop on no shared brief omits the field entirely.
    mk("olp_lonely");
    expect((await createGatewayLoopReadPort(db).fetch("olp_lonely"))?.relatedLoops).toBeUndefined();
  });

  test("list returns active loops IMPORTANCE-first, excludes terminal, and truncates the least important", async () => {
    const mk = (
      id: string,
      state: "open" | "snoozed" | "done",
      importance: number,
      at: number,
    ): void => {
      createOpenLoop(
        db,
        {
          id,
          createdByRun: "r",
          title: `loop ${id}`,
          description: "d",
          confidence: 0.8,
          importance,
        },
        at,
      );
      if (state !== "open") updateOpenLoop(db, id, { state }, at);
    };
    // olp_hi is OLD but important; olp_new is NEW but trivial — importance must win.
    mk("olp_hi", "open", 0.9, NOW); // old, high importance
    mk("olp_mid", "snoozed", 0.5, NOW + 1000);
    mk("olp_new", "open", 0.2, NOW + 5000); // newest, but least important
    mk("olp_done", "done", 0.95, NOW + 9000); // terminal — excluded despite importance
    const port = createGatewayLoopReadPort(db);

    const all = await port.list(undefined);
    // Importance DESC (not recency): hi > mid > new; done excluded.
    expect(all.loops.map((l) => l.loopId)).toEqual(["olp_hi", "olp_mid", "olp_new"]);
    expect(all.truncated).toBe(false);

    // Capped below the active count → the LEAST important (olp_new) is what drops.
    const capped = await port.list(2);
    expect(capped.loops.map((l) => l.loopId)).toEqual(["olp_hi", "olp_mid"]);
    expect(capped.truncated).toBe(true);

    // Boundary: cap EXACTLY equal to the active count shows all, not truncated.
    const exact = await port.list(3);
    expect(exact.loops.map((l) => l.loopId)).toEqual(["olp_hi", "olp_mid", "olp_new"]);
    expect(exact.truncated).toBe(false);
  });
});
