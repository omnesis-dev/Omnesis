// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createBriefsStorageTables } from "@omnesis/gateway/src/brain/storage/schema.js";
import { createAnnotationStorageTables } from "@omnesis/gateway/src/brain/storage/annotations.js";
import { createOpenLoop } from "@omnesis/gateway/src/brain/storage/open-loops.js";
import { createKnowledgeTables } from "@omnesis/gateway/src/brain/knowledge/schema.js";
import { createKnowledgeWorkTables } from "@omnesis/gateway/src/brain/knowledge/work-schema.js";
import { buildMaintenanceCanonicalTools } from "@omnesis/gateway/src/brain/knowledge/canonical-tool-fence.js";
import { directWriteGate } from "@omnesis/gateway/src/write-gate.js";
import { verifiedMaintenanceHandoffs } from "./briefs-maintenance-handoffs.js";
import type { ExecutedTool } from "./brain-bench/obs.js";

const decision = { runId: "run", attempt: 1, actions: [{ tool: "open_loop_update", ok: false }] };
const handoff: ExecutedTool = {
  tool: "open_loop_update",
  args: { id: "target" },
  result: { kind: "error", code: "maintenance_handoff", message: "Requeued" },
};
function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cognition_runs(id TEXT PRIMARY KEY, attempts INTEGER, status TEXT, kind TEXT, payload_json TEXT);
    CREATE TABLE knowledge_batches(id TEXT PRIMARY KEY,run_id TEXT,status TEXT);
    CREATE TABLE knowledge_work(id TEXT,subject_kind TEXT,subject_id TEXT,reason TEXT,input_revision TEXT,status TEXT,batch_id TEXT,created_at INTEGER);
    INSERT INTO cognition_runs VALUES ('run',1,'completed','synthesis','{"focus":"knowledge-maintenance","batchId":"old"}'),
      ('successor',1,'completed','synthesis','{"focus":"knowledge-maintenance","batchId":"next"}');
    INSERT INTO knowledge_batches VALUES ('old','run','abandoned'),('next','successor','completed');
    INSERT INTO knowledge_work VALUES ('original','source','evidence','change','v1','deferred','old',1),
      ('retry','source','evidence','change','v1','completed','next',2);
  `);
  return db;
}

describe("verified maintenance handoffs", () => {
  test("retains failed-action ordinals and verifies durable completed continuation", () => {
    const db = fixture();
    try {
      expect([...verifiedMaintenanceHandoffs(db, decision, [handoff])]).toEqual([0]);
      const ordinary = { ...handoff, result: { kind: "error", code: "revision_conflict" } };
      expect([
        ...verifiedMaintenanceHandoffs(
          db,
          {
            ...decision,
            actions: [...decision.actions, ...decision.actions],
          },
          [ordinary, handoff],
        ),
      ]).toEqual([1]);
    } finally {
      db.close();
    }
  });
  test.each([
    "UPDATE knowledge_batches SET status='running' WHERE id='old'",
    "UPDATE cognition_runs SET status='failed' WHERE id='run'",
    "UPDATE cognition_runs SET attempts=2 WHERE id='run'",
    "UPDATE cognition_runs SET payload_json='{}' WHERE id='run'",
    "UPDATE knowledge_batches SET run_id='unrelated' WHERE id='old'",
    "UPDATE knowledge_work SET status='pending' WHERE id='retry'",
    "UPDATE knowledge_work SET input_revision='v2' WHERE id='retry'",
    "UPDATE knowledge_work SET subject_id='unrelated' WHERE id='retry'",
    "UPDATE knowledge_work SET reason='review' WHERE id='retry'",
    "UPDATE knowledge_batches SET status='running' WHERE id='next'",
    "UPDATE cognition_runs SET status='failed' WHERE id='successor'",
    "DELETE FROM knowledge_work WHERE batch_id='old'",
    "INSERT INTO knowledge_work VALUES ('lost','node','unresolved','change','v1','deferred','old',1)",
  ])("does not forgive code-only or incomplete handoffs: %s", (mutation) => {
    const db = fixture();
    try {
      db.exec(mutation);
      expect([...verifiedMaintenanceHandoffs(db, decision, [handoff])]).toEqual([]);
    } finally {
      db.close();
    }
  });
  test("missing, mismatched and ordinary-error transcripts remain failures", () => {
    const db = fixture();
    try {
      for (const steps of [
        [],
        [{ ...handoff, tool: "other" }],
        [{ ...handoff, result: { kind: "error", code: "revision_conflict" } }],
      ])
        expect([...verifiedMaintenanceHandoffs(db, decision, steps)]).toEqual([]);
    } finally {
      db.close();
    }
  });
});

test("a forced production ownership collision is only forgiven after the transferred work completes", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,metadata TEXT,source_id TEXT DEFAULT 'fixture');
      CREATE TABLE removed_sources(id TEXT PRIMARY KEY);
      INSERT INTO documents(id,content,content_hash) VALUES('evidence','The workshop begins Friday.','v1');`);
    createBriefsStorageTables(db);
    createAnnotationStorageTables(db);
    createKnowledgeTables(db);
    createKnowledgeWorkTables(db);
    db.exec(`INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at)
      VALUES('old','run','old','routine','running',1,1),('blocker','blocker-run','blocker','routine','running',1,1);
      INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status)
      VALUES('old','source:evidence','input','{"source:evidence":"v1"}',0,'offered');
      INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id)
      VALUES('original','evidence','source','change','v1',1,'routine',1,1,1,'batched','old');
      INSERT INTO knowledge_batch_regions VALUES('blocker','target');`);
    createOpenLoop(
      db,
      {
        id: "target",
        createdByRun: "prior",
        title: "Prepare workshop",
        confidence: 0.8,
        importance: 0.5,
      },
      1,
    );
    let invoked = false;
    const [tool] = buildMaintenanceCanonicalTools(
      db,
      directWriteGate(db),
      { batchId: "old", runId: "run" },
      () => [
        {
          name: "open_loop_update",
          description: "Update",
          schema: z.object({ id: z.string() }),
          mutates: true,
          async invoke() {
            invoked = true;
            return { kind: "structured" as const, resultType: "updated", data: {} };
          },
        },
      ],
      { clock: () => 4 },
    );
    const result = await tool!.invoke(
      { id: "target" },
      { sessionId: "session", messageId: "message" },
    );
    expect(result).toMatchObject({ kind: "error", code: "maintenance_handoff" });
    expect(invoked).toBe(false);
    expect(db.prepare("SELECT status FROM knowledge_batches WHERE id='old'").get()).toEqual({
      status: "abandoned",
    });
    expect(
      db
        .prepare(
          "SELECT node_id FROM knowledge_batch_regions WHERE batch_id='blocker' ORDER BY node_id",
        )
        .all(),
    ).toEqual([{ node_id: "source:evidence" }, { node_id: "target" }]);
    db.exec(
      `INSERT INTO cognition_runs(id,attempts,status,kind,payload_json,next_attempt_at,enqueued_at) VALUES('run',1,'completed','synthesis','{"focus":"knowledge-maintenance","batchId":"old"}',1,1);`,
    );
    expect([...verifiedMaintenanceHandoffs(db, decision, [handoff])]).toEqual([]);
    // Persist the successor's settled outcome; no real model is involved.
    db.exec(`UPDATE knowledge_work SET status='completed',batch_id='blocker' WHERE status='pending';
      UPDATE knowledge_batches SET status='completed' WHERE id='blocker';
      INSERT INTO cognition_runs(id,attempts,status,kind,payload_json,next_attempt_at,enqueued_at) VALUES('blocker-run',1,'completed','synthesis','{"focus":"knowledge-maintenance","batchId":"blocker"}',1,1);`);
    expect([...verifiedMaintenanceHandoffs(db, decision, [handoff])]).toEqual([0]);
  } finally {
    db.close();
  }
});
