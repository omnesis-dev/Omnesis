// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  candidateAffinity,
  ownsCandidateTurn,
  candidateCoordinationKeys,
  MAX_AFFINITY_MEMBERS,
} from "./candidate-affinity.js";
import { pendingCandidateDecisions } from "./candidate-decision.js";
import { planMaintenanceGroups } from "./planner.js";
import {
  enqueueKnowledgeWork,
  createKnowledgeBatch,
  finishKnowledgeBatch,
  settleKnowledgeFrontier,
} from "./work.js";
import { settleKnowledgeCandidate } from "./discovery.js";
import { abandonKnowledgeBatch } from "./work-lifecycle.js";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,content TEXT NOT NULL,source_id TEXT NOT NULL)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function source(id: string) {
  db.prepare(
    "INSERT INTO documents VALUES(?,'v1','Fictional equipment instructions','fictional-source')",
  ).run(id);
  enqueueKnowledgeWork(
    db,
    {
      id: `w-${id}`,
      subjectId: id,
      subjectKind: "source",
      reason: "review",
      inputRevision: "v1",
      tier: "routine",
      dueAt: 1,
    },
    1,
  );
}
function candidate(id: string, ids: string[]) {
  db.prepare(
    "INSERT INTO knowledge_candidates(id,identity_key,title,scope,evidence_ids_json,status,created_at,updated_at) VALUES(?,?,'Equipment','Independent equipment reference',?,'proposed',1,1)",
  ).run(id, id, JSON.stringify(ids));
  for (const sourceId of ids)
    db.prepare("INSERT INTO knowledge_candidate_decision_work VALUES(?,1,?)").run(
      id,
      `w-${sourceId}`,
    );
}
function start(id: string, ids: string[], at = 2) {
  createKnowledgeBatch(
    db,
    {
      id,
      runId: `r-${id}`,
      tier: "routine",
      work: ids.map((x) => ({ id: `w-${x}`, generation: 1, inputRevision: "v1" })),
      regionNodeIds: ids.map((x) => `source:${x}`),
      frontier: ids.map((x) => ({
        nodeId: `source:${x}`,
        inputFingerprint: "v1",
        inputVersions: { [`source:${x}`]: "v1" },
        depth: 0,
      })),
    },
    at,
  );
}
function settle(batchId: string, id: string) {
  settleKnowledgeFrontier(
    db,
    {
      outcome: { batchId, nodeId: `source:${id}`, inputFingerprint: "v1", status: "unchanged" },
      append: [],
    },
    3,
  );
}
function groups(ids: string[]) {
  return planMaintenanceGroups(
    ids.map((id) => ({
      id: `w-${id}`,
      revision: "v1",
      changedAt: 1,
      dueAt: 1,
      tier: "routine" as const,
      targets: [`source:${id}`],
      coordinationKeys: candidateAffinity(db, [`w-${id}`]).keys,
    })),
    [],
    new Set(),
    { maxSeeds: 100, maxVisitedPerSeed: 100 },
  );
}
it("groups eight candidate sources without creating canonical dependency edges", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
  ids.forEach(source);
  candidate("c", ids);
  const planned = groups(ids);
  expect(planned).toHaveLength(1);
  expect(planned[0]!.seeds).toHaveLength(8);
  expect(planned[0]!.nodes).toEqual(ids.map((id) => `source:${id}`));
  start("batch", ids);
  expect(candidateAffinity(db, ["w-s0"]).owner).toBe("batch");
  expect(db.prepare("SELECT count(*) n FROM knowledge_dependencies").get()).toEqual({ n: 0 });
});
it("unions overlapping candidates transitively but leaves independent scopes parallel", () => {
  ["a", "b", "c", "d"].forEach(source);
  candidate("left", ["a", "b"]);
  candidate("right", ["b", "c"]);
  candidate("independent", ["d"]);
  expect(
    groups(["a", "b", "c", "d"])
      .map((g) => g.seeds.length)
      .sort(),
  ).toEqual([1, 3]);
  start("first", ["a"]);
  expect(() => start("competing", ["c"])).toThrow("Candidate curation is reserved");
  start("parallel", ["d"]);
  expect(db.prepare("SELECT count(*) n FROM knowledge_batches WHERE id='competing'").get()).toEqual(
    { n: 0 },
  );
  expect(ownsCandidateTurn(db, "parallel")).toBe(true);
});
it("serializes bounded chunks and reserves the decision only after the final source settles", () => {
  ["a", "b", "c"].forEach(source);
  candidate("c", ["a", "b", "c"]);
  start("first", ["a"]);
  expect(() => start("second", ["b"])).toThrow("reserved");
  settle("first", "a");
  expect(pendingCandidateDecisions(db, "first")).toEqual([]);
  expect(finishKnowledgeBatch(db, "first", 4)).toBe(true);
  start("second", ["b"], 5);
  settle("second", "b");
  expect(finishKnowledgeBatch(db, "second", 6)).toBe(true);
  start("last", ["c"], 7);
  expect(pendingCandidateDecisions(db, "last")).toEqual([]);
  settle("last", "c");
  expect(pendingCandidateDecisions(db, "last")).toEqual([{ id: "c", revision: 1 }]);
  expect(finishKnowledgeBatch(db, "last", 8)).toBe(false);
  settleKnowledgeCandidate(
    db,
    { id: "c", expectedRevision: 1, status: "deferred", reconsiderAt: 100 },
    9,
  );
  expect(finishKnowledgeBatch(db, "last", 10)).toBe(true);
  expect(
    db.prepare("SELECT count(*) n FROM knowledge_work WHERE status='completed'").get(),
  ).toEqual({ n: 3 });
});
it("elects one owner for legacy batches and advances after source-only completion", () => {
  ["a", "b"].forEach(source);
  start("older", ["a"], 2);
  start("newer", ["b"], 3);
  candidate("c", ["a", "b"]);
  expect(ownsCandidateTurn(db, "older")).toBe(true);
  expect(ownsCandidateTurn(db, "newer")).toBe(false);
  settle("older", "a");
  expect(finishKnowledgeBatch(db, "older", 4)).toBe(true);
  expect(ownsCandidateTurn(db, "newer")).toBe(true);
  // A repeated terminal read is not held by a subsequently elected sibling.
  expect(ownsCandidateTurn(db, "older")).toBe(true);
  settle("newer", "b");
  expect(pendingCandidateDecisions(db, "newer")).toHaveLength(1);
  expect(pendingCandidateDecisions(db, "older")).toEqual([]);
  expect(finishKnowledgeBatch(db, "newer", 5)).toBe(false);
});
it("does not revive old generation affinity or hidden candidate scope", () => {
  ["a", "b"].forEach(source);
  candidate("c", ["a", "b"]);
  start("first", ["a"]);
  db.exec("UPDATE knowledge_candidates SET decision_generation=2 WHERE id='c'");
  start("second", ["b"]);
  expect(ownsCandidateTurn(db, "second")).toBe(true);
  db.exec(
    "UPDATE knowledge_candidates SET decision_generation=1 WHERE id='c'; DELETE FROM documents WHERE id='a'",
  );
  expect(candidateAffinity(db, ["w-b"]).keys).toEqual([]);
  expect(pendingCandidateDecisions(db, "second")).toEqual([]);
});
it("keeps retry bindings coordinated after abandonment without completing untouched sources", () => {
  ["a", "b"].forEach(source);
  candidate("c", ["a", "b"]);
  start("first", ["a"]);
  abandonKnowledgeBatch(db, { batchId: "first", notBefore: 10 }, 4);
  const retry = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM knowledge_work WHERE subject_id='a' AND status='pending'")
    .get()!;
  expect(candidateAffinity(db, [retry.id]).keys).toEqual(candidateAffinity(db, ["w-b"]).keys);
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='w-b'").get()).toEqual({
    status: "pending",
  });
});

it("coordinates different admitted work identities for the same source", () => {
  ["a", "b", "c"].forEach(source);
  candidate("first-candidate", ["a", "b"]);
  start("first-chunk", ["a"]);
  settle("first-chunk", "a");
  expect(finishKnowledgeBatch(db, "first-chunk", 4)).toBe(true);
  start("remaining-first", ["b"], 5);
  enqueueKnowledgeWork(
    db,
    {
      id: "alias-a",
      subjectId: "a",
      subjectKind: "source",
      reason: "review",
      inputRevision: "v1",
      tier: "routine",
      dueAt: 6,
    },
    6,
  );
  candidate("second-candidate", ["a", "c"]);
  db.exec(
    "DELETE FROM knowledge_candidate_decision_work WHERE candidate_id='second-candidate' AND work_id='w-a'; INSERT INTO knowledge_candidate_decision_work VALUES('second-candidate',1,'alias-a')",
  );
  expect(candidateAffinity(db, ["w-c"]).keys).toEqual(candidateAffinity(db, ["w-b"]).keys);
  expect(candidateAffinity(db, ["alias-a"]).owner).toBe("remaining-first");
  expect(() => start("competing-second", ["c"], 7)).toThrow("Candidate curation is reserved");
});

it("holds an oversized component without preventing independent planning", () => {
  source("a");
  source("b");
  db.transaction(() => {
    const insert = db.prepare(
      "INSERT INTO knowledge_candidates(id,identity_key,title,scope,evidence_ids_json,status,created_at,updated_at) VALUES(?,?,'Equipment','Equipment reference','[\"a\"]','proposed',1,1)",
    );
    const bind = db.prepare("INSERT INTO knowledge_candidate_decision_work VALUES(?,1,'w-a')");
    for (let i = 0; i <= MAX_AFFINITY_MEMBERS; i++) {
      insert.run(`c${i}`, `c${i}`);
      bind.run(`c${i}`);
    }
  })();
  const keys = candidateCoordinationKeys(db);
  try {
    keys("w-a");
    expect.unreachable("oversized affinity must remain pending");
  } catch (error) {
    expect(error).toMatchObject({ limit: "region", seedId: "w-a" });
  }
  expect(keys("w-b")).toEqual([]);
  expect(() => start("too-large", ["a"])).toThrow("bounded scope");
  start("independent", ["b"]);
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='w-a'").get()).toEqual({
    status: "pending",
  });
});

it.each([1, 2])(
  "transfers current debt atomically into an already pending retry at clock %s",
  (clock) => {
    ["a", "b"].forEach(source);
    candidate("c", ["a", "b"]);
    start("first", ["a"]);
    enqueueKnowledgeWork(
      db,
      {
        id: "pending-retry",
        subjectId: "a",
        subjectKind: "source",
        reason: "review",
        inputRevision: "v1",
        tier: "routine",
        dueAt: 10,
      },
      clock,
    );
    // Old generations remain historical; only the live obligation transfers.
    db.prepare("INSERT INTO knowledge_candidate_decision_work VALUES('c',0,'w-a')").run();
    abandonKnowledgeBatch(db, { batchId: "first", notBefore: 10 }, 4);
    expect(db.prepare("SELECT status FROM knowledge_work WHERE id='w-a'").get()).toEqual({
      status: "deferred",
    });
    expect(
      db
        .prepare(
          "SELECT generation,work_id FROM knowledge_candidate_decision_work WHERE candidate_id='c' AND work_id!='w-b' ORDER BY generation",
        )
        .all(),
    ).toEqual([
      { generation: 0, work_id: "w-a" },
      { generation: 1, work_id: "pending-retry" },
    ]);
    start("second", ["b"], 11);
    settle("second", "b");
    expect(pendingCandidateDecisions(db, "second")).toEqual([]);
    expect(finishKnowledgeBatch(db, "second", 12)).toBe(true);
    createKnowledgeBatch(
      db,
      {
        id: "retry-batch",
        runId: "retry-run",
        tier: "routine",
        work: [{ id: "pending-retry", generation: 1, inputRevision: "v1" }],
        regionNodeIds: ["source:a"],
        frontier: [
          {
            nodeId: "source:a",
            inputFingerprint: "v1",
            inputVersions: { "source:a": "v1" },
            depth: 0,
          },
        ],
      },
      13,
    );
    expect(pendingCandidateDecisions(db, "retry-batch")).toEqual([]);
    settle("retry-batch", "a");
    expect(pendingCandidateDecisions(db, "retry-batch")).toEqual([{ id: "c", revision: 1 }]);
  },
);

it("does not treat an orphan deferred binding as settled source work", () => {
  ["a", "b"].forEach(source);
  candidate("c", ["a", "b"]);
  db.prepare("UPDATE knowledge_work SET status='deferred' WHERE id='w-a'").run();
  start("remaining", ["b"]);
  settle("remaining", "b");
  expect(pendingCandidateDecisions(db, "remaining")).toEqual([]);
  expect(
    db.prepare("SELECT decision_pending FROM knowledge_candidates WHERE id='c'").get(),
  ).toEqual({ decision_pending: 1 });
});
