// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  refreshKnowledgeWork,
  abandonKnowledgeBatch,
  recordKnowledgeDiscoveryTargets,
} from "./work-lifecycle.js";
import { saveKnowledgeNode } from "./storage.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  appendKnowledgeFrontier,
  createKnowledgeBatch,
  enqueueKnowledgeWork,
  finishKnowledgeBatch,
  getKnowledgeWork,
  listKnowledgeFrontier,
  listPendingKnowledgeWorkWindow,
  listKnowledgePlanningWork,
  historicalKnowledgeAdmissions,
  settleKnowledgeFrontier,
  type CreateKnowledgeBatch,
  type KnowledgeFrontierInput,
} from "./work.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,content TEXT NOT NULL)",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  db.prepare("INSERT INTO documents VALUES(?,'v1','A source')").run("source-a");
  db.prepare("INSERT INTO documents VALUES(?,'v1','Another source')").run("source-b");
});
afterEach(() => db.close());

function enqueue(id = "work-a", subjectId = "source-a", revision = "v1", dueAt = 600) {
  return enqueueKnowledgeWork(
    db,
    {
      id,
      subjectId,
      subjectKind: "source",
      reason: "change",
      inputRevision: revision,
      tier: "routine",
      dueAt,
    },
    1,
  );
}
function sourceFrontier(subjectId = "source-a", revision = "v1"): KnowledgeFrontierInput {
  return {
    nodeId: `source:${subjectId}`,
    inputFingerprint: revision,
    inputVersions: { [`source:${subjectId}`]: revision },
    depth: 0,
  };
}
function makeBatch(
  id = "batch-a",
  workId = "work-a",
  sourceId = "source-a",
  regions: string[] = [],
): CreateKnowledgeBatch {
  const work = getKnowledgeWork(db, workId)!;
  return {
    id,
    runId: `run-${id}`,
    tier: "routine",
    work: [{ id: work.id, generation: work.generation, inputRevision: work.inputRevision }],
    frontier: [sourceFrontier(sourceId, work.inputRevision)],
    regionNodeIds: regions,
  };
}
function settle(
  batchId = "batch-a",
  nodeId = "source:source-a",
  fingerprint = "v1",
  append: KnowledgeFrontierInput[] = [],
) {
  settleKnowledgeFrontier(
    db,
    { outcome: { batchId, nodeId, inputFingerprint: fingerprint, status: "changed" }, append },
    10,
  );
}

describe("durable maintenance work", () => {
  it("refreshes obsolete pending versions and retires removed identities without rewriting batched work", () => {
    const input = {
      id: "refresh",
      subjectId: "source-a",
      subjectKind: "source" as const,
      reason: "change" as const,
      inputRevision: "v1",
      tier: "routine" as const,
      dueAt: 900,
    };
    enqueueKnowledgeWork(db, input, 10);
    enqueueKnowledgeWork(db, { ...input, id: "removed", subjectId: "source-b" }, 10);
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
    db.prepare("DELETE FROM documents WHERE id='source-b'").run();
    expect(refreshKnowledgeWork(db, ["refresh", "removed"], 20)).toBe(2);
    expect(getKnowledgeWork(db, "refresh")).toMatchObject({
      inputRevision: "v2",
      generation: 2,
      dueAt: 900,
      status: "pending",
    });
    expect(getKnowledgeWork(db, "removed")?.status).toBe("completed");
    db.prepare("UPDATE knowledge_work SET status='batched' WHERE id='refresh'").run();
    db.prepare("UPDATE documents SET content_hash='v3' WHERE id='source-a'").run();
    expect(refreshKnowledgeWork(db, ["refresh"], 30)).toBe(0);
    expect(getKnowledgeWork(db, "refresh")?.inputRevision).toBe("v2");
  });

  it("folds newer revisions without postponing an existing deadline and rejects delayed old events", () => {
    enqueue();
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
    expect(enqueue("new-event", "source-a", "v2", 900)).toMatchObject({
      id: "work-a",
      generation: 2,
      inputRevision: "v2",
      dueAt: 600,
    });
    expect(() => enqueue("delayed-event", "source-a", "v1", 100)).toThrow("obsolete");
    expect(getKnowledgeWork(db, "work-a")).toMatchObject({
      generation: 2,
      inputRevision: "v2",
      dueAt: 600,
    });
  });

  it("keeps changes arriving during a batch as a successor and fences stale planning", () => {
    enqueue();
    const planned = makeBatch();
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
    enqueue("new-event", "source-a", "v2");
    expect(() => createKnowledgeBatch(db, planned, 2)).toThrow("changed during batch planning");
    expect(db.prepare("SELECT 1 FROM knowledge_batches").all()).toEqual([]);
    createKnowledgeBatch(db, makeBatch(), 3);
    db.prepare("UPDATE documents SET content_hash='v3' WHERE id='source-a'").run();
    expect(enqueue("successor", "source-a", "v3")).toMatchObject({
      id: "successor",
      status: "pending",
    });
    expect(getKnowledgeWork(db, "work-a")!.inputRevision).toBe("v2");
  });

  it("exposes window overflow rather than pretending bounded intake covers every seed", () => {
    enqueue();
    enqueue("work-b", "source-b");
    expect(listPendingKnowledgeWorkWindow(db, 1)).toMatchObject({
      hasMore: true,
      items: [{ id: "work-a" }],
    });
    expect(listPendingKnowledgeWorkWindow(db, 2).hasMore).toBe(false);
  });

  it("requires persisted obligations even when discovery has no dependent nodes yet", () => {
    enqueue();
    const input = makeBatch();
    input.frontier = [];
    expect(() => createKnowledgeBatch(db, input, 2)).toThrow("frontier obligation");
    expect(getKnowledgeWork(db, "work-a")!.status).toBe("pending");
    createKnowledgeBatch(db, makeBatch(), 3);
    expect(finishKnowledgeBatch(db, "batch-a", 4)).toBe(false);
  });

  it("replays creation idempotently but rejects identity reuse with different inputs", () => {
    enqueue();
    const input = makeBatch();
    createKnowledgeBatch(db, input, 2);
    createKnowledgeBatch(db, input, 3);
    expect(getKnowledgeWork(db, "work-a")!.attempts).toBe(1);
    expect(() => createKnowledgeBatch(db, { ...input, runId: "different-run" }, 4)).toThrow(
      "different inputs",
    );
    expect(() => createKnowledgeBatch(db, { ...input, regionNodeIds: ["new-region"] }, 4)).toThrow(
      "different inputs",
    );
  });

  it("locks complete potential regions and releases them only after completion", () => {
    enqueue();
    enqueue("work-b", "source-b");
    createKnowledgeBatch(db, makeBatch("batch-a", "work-a", "source-a", ["shared-project"]), 2);
    const second = makeBatch("batch-b", "work-b", "source-b", ["shared-project"]);
    expect(() => createKnowledgeBatch(db, second, 3)).toThrow("overlaps an active batch");
    expect(getKnowledgeWork(db, "work-b")!.status).toBe("pending");
    settle();
    expect(finishKnowledgeBatch(db, "batch-a", 11)).toBe(true);
    createKnowledgeBatch(db, second, 12);
    expect(getKnowledgeWork(db, "work-b")!.status).toBe("batched");
  });

  it("settles and expands atomically, never completing between BFS levels", () => {
    enqueue();
    createKnowledgeBatch(db, makeBatch(), 2);
    const child = {
      nodeId: "project",
      inputFingerprint: "inputs-v1",
      inputVersions: { "source:source-a": "v1" },
      depth: 1,
    };
    settle("batch-a", "source:source-a", "v1", [child]);
    expect(finishKnowledgeBatch(db, "batch-a", 11)).toBe(false);
    settle("batch-a", "project", "inputs-v1");
    expect(finishKnowledgeBatch(db, "batch-a", 12)).toBe(true);
    const before = db
      .prepare("SELECT revision,finished_at FROM knowledge_batches WHERE id='batch-a'")
      .get();
    expect(finishKnowledgeBatch(db, "batch-a", 99)).toBe(true);
    expect(
      db.prepare("SELECT revision,finished_at FROM knowledge_batches WHERE id='batch-a'").get(),
    ).toEqual(before);
    expect(() => appendKnowledgeFrontier(db, "batch-a", [child])).toThrow("completed batch");
  });

  it("rolls settlement back when expansion collides with another in-flight region", () => {
    enqueue();
    enqueue("work-b", "source-b");
    createKnowledgeBatch(db, makeBatch(), 2);
    createKnowledgeBatch(db, makeBatch("batch-b", "work-b", "source-b", ["reserved"]), 2);
    const child = { nodeId: "reserved", inputFingerprint: "next", inputVersions: {}, depth: 1 };
    expect(() => settle("batch-a", "source:source-a", "v1", [child])).toThrow(
      "overlaps an active batch",
    );
    expect(listKnowledgeFrontier(db, "batch-a")[0]!.status).toBe("pending");
    expect(finishKnowledgeBatch(db, "batch-a", 11)).toBe(false);
  });

  it("records coverage and source settlement in the same transaction", () => {
    enqueue();
    createKnowledgeBatch(db, makeBatch(), 2);
    const coverage = {
      subjectId: "source-a",
      inputRevision: "v1",
      phase: "interpretation" as const,
      policyVersion: "test-v1",
      status: "considered" as const,
    };
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
    expect(() =>
      settleKnowledgeFrontier(
        db,
        {
          outcome: {
            batchId: "batch-a",
            nodeId: "source:source-a",
            inputFingerprint: "v1",
            status: "changed",
          },
          append: [],
          coverage: [coverage],
        },
        3,
      ),
    ).toThrow("Discovery input changed");
    expect(listKnowledgeFrontier(db, "batch-a")[0]!.status).toBe("pending");
    expect(db.prepare("SELECT 1 FROM knowledge_discovery_coverage").all()).toEqual([]);
    db.prepare("UPDATE documents SET content_hash='v1' WHERE id='source-a'").run();
    settleKnowledgeFrontier(
      db,
      {
        outcome: {
          batchId: "batch-a",
          nodeId: "source:source-a",
          inputFingerprint: "v1",
          status: "changed",
        },
        append: [],
        coverage: [coverage],
      },
      4,
    );
    expect(listKnowledgeFrontier(db, "batch-a")[0]!.status).toBe("changed");
    expect(db.prepare("SELECT status FROM knowledge_discovery_coverage").get()).toEqual({
      status: "considered",
    });
  });

  it("rejects a fingerprint reused for different inputs and retains deferred obligations", () => {
    enqueue();
    createKnowledgeBatch(db, makeBatch(), 2);
    expect(() =>
      appendKnowledgeFrontier(db, "batch-a", [
        { ...sourceFrontier(), inputVersions: { "source:source-a": "v2" } },
      ]),
    ).toThrow("fingerprint was reused");
    settleKnowledgeFrontier(
      db,
      {
        outcome: {
          batchId: "batch-a",
          nodeId: "source:source-a",
          inputFingerprint: "v1",
          status: "deferred",
        },
        append: [],
      },
      3,
    );
    expect(finishKnowledgeBatch(db, "batch-a", 4)).toBe(false);
    expect(getKnowledgeWork(db, "work-a")!.status).toBe("batched");
  });
  it("abandons a failed batch without losing a newer queued revision or keeping region locks", () => {
    enqueue();
    createKnowledgeBatch(db, makeBatch("batch-a", "work-a", "source-a", ["shared"]), 2);
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
    enqueue("successor", "source-a", "v2", 100);
    expect(abandonKnowledgeBatch(db, { batchId: "batch-a", notBefore: 20 }, 10)).toBe(true);
    expect(abandonKnowledgeBatch(db, { batchId: "batch-a", notBefore: 20 }, 11)).toBe(false);
    expect(getKnowledgeWork(db, "successor")).toMatchObject({
      status: "pending",
      inputRevision: "v2",
      dueAt: 100,
    });
    expect(db.prepare("SELECT status FROM knowledge_batches WHERE id='batch-a'").get()).toEqual({
      status: "abandoned",
    });
    enqueue("work-b", "source-b");
    createKnowledgeBatch(db, makeBatch("batch-b", "work-b", "source-b", ["shared"]), 12);
    expect(getKnowledgeWork(db, "work-b")!.status).toBe("batched");
  });

  it("keeps discovery hints through retries and removes them with source privacy deletion", () => {
    saveKnowledgeNode(
      db,
      {
        id: "target",
        kind: "wiki",
        title: "Planning",
        markdown: "Context",
        expectedRevision: 0,
        inputVersions: {},
      },
      1,
    );
    recordKnowledgeDiscoveryTargets(
      db,
      { sourceId: "source-a", sourceRevision: "v1", nodeIds: ["target"] },
      2,
    );
    enqueue();
    createKnowledgeBatch(db, makeBatch(), 3);
    abandonKnowledgeBatch(db, { batchId: "batch-a", notBefore: 10 }, 4);
    expect(
      db.prepare("SELECT source_revision,node_id FROM knowledge_discovery_targets").all(),
    ).toEqual([{ source_revision: "v1", node_id: "target" }]);
    db.prepare("DELETE FROM documents WHERE id='source-a'").run();
    expect(db.prepare("SELECT 1 FROM knowledge_discovery_targets").all()).toEqual([]);
  });
});

it("reserves a bounded planning slot for history during a live backlog", () => {
  enqueue("live", "source-a", "v1", 1);
  enqueueKnowledgeWork(
    db,
    {
      id: "history",
      subjectId: "source-b",
      subjectKind: "source",
      reason: "discovery",
      inputRevision: "v1",
      tier: "routine",
      dueAt: 100,
    },
    2,
  );
  expect(listPendingKnowledgeWorkWindow(db, 1).items.map((item) => item.id)).toEqual(["live"]);
  expect(listKnowledgePlanningWork(db, 1).map((item) => item.id)).toEqual(["history"]);
  expect(listKnowledgePlanningWork(db, 2).map((item) => item.id)).toEqual(["live", "history"]);
});

it("historical budgets survive privacy erasure and count neither folds nor recovery retries", () => {
  const input = {
    id: "history",
    subjectId: "source-a",
    subjectKind: "source" as const,
    reason: "discovery" as const,
    inputRevision: "v1",
    tier: "routine" as const,
    dueAt: 1,
  };
  enqueueKnowledgeWork(db, input, 1);
  enqueueKnowledgeWork(db, { ...input, id: "fold" }, 2);
  expect(historicalKnowledgeAdmissions(db, 2)).toEqual({ total: 1, today: 1 });
  db.prepare("UPDATE knowledge_work SET status='deferred' WHERE id='history'").run();
  enqueueKnowledgeWork(db, { ...input, id: "retry" }, 3, "history");
  expect(historicalKnowledgeAdmissions(db, 3)).toEqual({ total: 1, today: 1 });
  db.exec("DELETE FROM knowledge_work; DELETE FROM documents");
  createKnowledgeWorkTables(db);
  expect(historicalKnowledgeAdmissions(db, 4)).toEqual({ total: 1, today: 1 });
});

it("initializes historical aggregate counters once from existing admitted work", () => {
  enqueueKnowledgeWork(
    db,
    {
      id: "history",
      subjectId: "source-a",
      subjectKind: "source",
      reason: "upgrade",
      inputRevision: "v1",
      tier: "routine",
      dueAt: 1,
    },
    1,
  );
  db.exec("DROP TABLE knowledge_historical_admissions");
  createKnowledgeWorkTables(db);
  createKnowledgeWorkTables(db);
  expect(historicalKnowledgeAdmissions(db, 2)).toEqual({ total: 1, today: 1 });
});

it("rejects a frontier settlement from another run atomically", () => {
  enqueue();
  createKnowledgeBatch(db, makeBatch(), 2);
  expect(() =>
    settleKnowledgeFrontier(
      db,
      {
        outcome: {
          batchId: "batch-a",
          runId: "wrong-run",
          nodeId: "source:source-a",
          inputFingerprint: "v1",
          status: "changed",
        },
        append: [],
      },
      3,
    ),
  ).toThrow("owned by this run");
  expect(listKnowledgeFrontier(db, "batch-a")[0]?.status).toBe("pending");
});
