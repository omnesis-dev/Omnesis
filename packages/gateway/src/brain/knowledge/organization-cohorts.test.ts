// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeOrganizationBatch } from "./organization-writer.js";
import { purgeKnowledgeBySource, advanceKnowledgeCascade } from "./storage-invalidation.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  KNOWLEDGE_DISCOVERY_POLICY,
  recordKnowledgeCoverage,
  assertCandidateGrounded,
} from "./discovery.js";
import {
  selectOrganizationCohort,
  createOrganizationCohort,
  completeOrganizationCohort,
  completeOrganizationCohortResult,
  getOrganizationCohortForBatch,
  abandonOrganizationCohort,
  isOrganizationCohortCurrent,
} from "./organization-cohorts.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,metadata TEXT)",
  );
  db.exec("CREATE TABLE removed_sources(id TEXT PRIMARY KEY)");
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function evidence(id: string, policy = KNOWLEDGE_DISCOVERY_POLICY) {
  db.prepare("INSERT INTO documents VALUES(?,?,?,'{}')").run(id, `source-${id}`, "v1");
  recordKnowledgeCoverage(
    db,
    {
      subjectId: id,
      inputRevision: "v1",
      phase: "organization",
      policyVersion: policy,
      status: "considered",
    },
    1,
  );
}
function select(now = 100) {
  return selectOrganizationCohort(db, { now, intervalMs: 100, retryMs: 500 });
}
function admit(now = 100, id = "cohort", selection = select(now)!) {
  db.prepare(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,?,'routine','pending',?,?)",
  ).run(`batch-${id}`, `run-${id}`, "fingerprint", now, now);
  expect(
    createOrganizationCohort(
      db,
      { ...selection, id, batchId: `batch-${id}`, intervalMs: 100, retryMs: 500 },
      now,
    ),
  ).toBe(true);
  return getOrganizationCohortForBatch(db, `batch-${id}`)!;
}
function finish(now = 110) {
  const cohort = getOrganizationCohortForBatch(db, "batch-cohort")!;
  const completed = completeOrganizationCohort(
    db,
    {
      id: cohort.id,
      batchId: cohort.batchId,
      inputFingerprint: cohort.inputFingerprint,
      outcome: "no_page",
      reasonCode: "insufficient_shared_context",
      retryAt: 1000,
    },
    now,
  );
  if (completed)
    db.prepare("UPDATE knowledge_batches SET status='completed' WHERE id=?").run(cohort.batchId);
  return completed;
}
describe("bounded joint organization cohorts", () => {
  it("requires two current previously considered readable inputs and caps membership", () => {
    evidence("only");
    expect(select()).toBeNull();
    evidence("old-policy", "older-policy");
    evidence("private");
    db.prepare("INSERT INTO removed_sources VALUES(?)").run("source-private");
    expect(select()).toBeNull();
    for (let i = 0; i < 12; i++) evidence(`evidence-${i}`);
    const selection = select()!;
    expect(Object.keys(selection.sourceVersions)).toHaveLength(8);
    expect(selection.sourceVersions).not.toHaveProperty("private");
    expect(selection.sourceVersions).not.toHaveProperty("old-policy");
    expect(select()).toEqual(selection);
  });
  it("settles a no-page decision and lets one new input reuse prior context after cadence", () => {
    evidence("a");
    evidence("b");
    admit();
    expect(select(300)).toBeNull();
    expect(finish()).toBe(true);
    expect(select(300)).toBeNull();
    evidence("c");
    expect(select(199)).toBeNull();
    const next = select(200)!;
    expect(next.sourceVersions).toHaveProperty("c", "v1");
    expect(Object.keys(next.sourceVersions)).toHaveLength(2);
    expect(select(1000)?.sourceVersions).toEqual({ a: "v1", b: "v1", c: "v1" });
  });
  it("drains more than eight first-pass inputs without the repeat cadence gap", () => {
    for (let i = 0; i < 10; i++) evidence(`fresh-${i}`);
    const first = admit();
    expect(Object.keys(first.sourceVersions)).toHaveLength(8);
    expect(select(101)).toBeNull();
    expect(finish()).toBe(true);
    const second = admit(111, "second");
    expect(Object.keys(second.sourceVersions)).toHaveLength(2);
    expect(Object.keys(second.sourceVersions).every((id) => !(id in first.sourceVersions))).toBe(
      true,
    );
    expect(select(120)).toBeNull();
  });
  it("rechecks global ownership and initial eligibility after selection", () => {
    evidence("c");
    evidence("d");
    const disjointSelection = select()!;
    evidence("a");
    evidence("b");
    const selectedBeforeAdmission = selectOrganizationCohort(db, {
      now: 100,
      intervalMs: 100,
      retryMs: 500,
      limit: 2,
    })!;
    expect(selectedBeforeAdmission.sourceVersions).toEqual({ a: "v1", b: "v1" });
    admit(100, "cohort", selectedBeforeAdmission);
    db.exec(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('raced-batch','raced-run','fp','routine','pending',1,1)",
    );
    const raced = { id: "raced", batchId: "raced-batch", intervalMs: 100, retryMs: 500 };
    // Even a disjoint fresh selection cannot overlap another active cohort.
    expect(select(101)).toBeNull();
    expect(createOrganizationCohort(db, { ...raced, ...disjointSelection }, 101)).toBe(false);
    expect(finish()).toBe(true);
    // A stale selection is no longer initial after a competing admission.
    expect(createOrganizationCohort(db, { ...raced, ...selectedBeforeAdmission }, 111)).toBe(false);
    expect(createOrganizationCohort(db, { ...raced, ...disjointSelection }, 111)).toBe(true);
  });
  it("excludes sources whose maintenance work is already pending", () => {
    evidence("a");
    evidence("b");
    db.exec(
      "INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status) VALUES('work','a','source','review','v1',1,'routine',1,1,1,'pending')",
    );
    expect(select()).toBeNull();
  });
  it("rejects maintenance ownership acquired after selection", () => {
    evidence("a");
    evidence("b");
    const selection = select()!;
    db.exec(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('new-batch','new-run','fp','routine','pending',1,1)",
    );
    db.exec(
      "INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status) VALUES('work','a','source','review','v1',1,'routine',1,1,1,'pending')",
    );
    expect(
      createOrganizationCohort(
        db,
        { ...selection, id: "raced", batchId: "new-batch", intervalMs: 100, retryMs: 500 },
        100,
      ),
    ).toBe(false);
    expect(getOrganizationCohortForBatch(db, "new-batch")).toBeNull();
  });
  it.each(["changed", "deleted", "private"])(
    "rejects %s evidence at admission and at completion",
    (change) => {
      evidence("a");
      evidence("b");
      const selection = select()!;
      const cohort = admit();
      if (change === "changed") db.exec("UPDATE documents SET content_hash='v2' WHERE id='a'");
      if (change === "deleted") db.exec("DELETE FROM documents WHERE id='a'");
      if (change === "private") db.exec("INSERT INTO removed_sources VALUES('source-a')");
      expect(isOrganizationCohortCurrent(db, cohort)).toBe(false);
      expect(finish()).toBe(false);
      expect(
        createOrganizationCohort(
          db,
          { ...selection, id: "other", batchId: "other", intervalMs: 0, retryMs: 500 },
          200,
        ),
      ).toBe(false);
      expect(getOrganizationCohortForBatch(db, cohort.batchId)?.status).toBe("pending");
      expect(abandonOrganizationCohort(db, cohort.batchId, 200)).toBe(true);
      expect(getOrganizationCohortForBatch(db, cohort.batchId)?.status).toBe("abandoned");
    },
  );
  it("abandonment advances no review ledger but retains admission cadence", () => {
    evidence("a");
    evidence("b");
    const cohort = admit();
    abandonOrganizationCohort(db, cohort.batchId, 110);
    expect(select(199)).toBeNull();
    expect(select(200)).not.toBeNull();
  });
  it("erases cohort reasons and membership through bounded source privacy cleanup", () => {
    evidence("a");
    evidence("b");
    admit();
    expect(finish()).toBe(true);
    expect(
      db.prepare("SELECT outcome_json FROM knowledge_organization_cohorts").get(),
    ).toBeTruthy();
    purgeKnowledgeBySource(db, "a", 200);
    expect(db.prepare("SELECT * FROM knowledge_organization_cohorts").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM knowledge_organization_members").all()).toEqual([]);
    expect(getOrganizationCohortForBatch(db, "batch-cohort")).toBeNull();
    expect(advanceKnowledgeCascade(db, 10, 201).pending).toBe(false);
  });
  it("only accepts organized pages at the read revision with relevant current support", () => {
    evidence("a");
    evidence("b");
    const cohort = admit();
    const save = (id: string, sourceId: string, relation: "supports" | "context" = "supports") =>
      saveKnowledgeNode(
        db,
        {
          id,
          kind: "wiki",
          title: "Workshop reference",
          markdown: `<claim id="fact" refs="source:${sourceId}">The workshop is planned.</claim>`,
          expectedRevision: 0,
          inputVersions: { [`source:${sourceId}`]: "v1" },
          claims: [{ id: "fact", relations: { [`source:${sourceId}`]: relation } }],
        },
        101,
      );
    evidence("unrelated");
    save("unrelated-wiki", "unrelated");
    save("context-wiki", "a", "context");
    save("relevant-wiki", "a");
    const complete = (id: string, versions?: Record<string, number>) =>
      completeOrganizationCohort(
        db,
        {
          id: cohort.id,
          batchId: cohort.batchId,
          inputFingerprint: cohort.inputFingerprint,
          outcome: "organized",
          reasonCode: "already_organized",
          targetIds: [id],
          targetVersions: versions,
          retryAt: 1000,
        },
        110,
      );
    const sharedBudget = { remaining: 3 };
    assertCandidateGrounded(db, "relevant-wiki", ["a"], sharedBudget);
    expect(sharedBudget.remaining).toBe(1);
    expect(() => assertCandidateGrounded(db, "relevant-wiki", ["a"], sharedBudget)).toThrow(
      "bounded traversal budget",
    );
    expect(complete("unrelated-wiki", { "unrelated-wiki": 1 })).toBe(false);
    expect(complete("context-wiki", { "context-wiki": 1 })).toBe(false);
    expect(complete("relevant-wiki")).toBe(false);
    expect(complete("relevant-wiki", { "relevant-wiki": 2 })).toBe(false);
    expect(complete("relevant-wiki", { "relevant-wiki": 1, extra: 1 })).toBe(false);
    expect(complete("relevant-wiki", { "relevant-wiki": 1 })).toBe(true);
  });
  it.each(["stale", "private"])(
    "rejects a %s target even when cohort evidence stayed current",
    (state) => {
      evidence("a");
      evidence("b");
      const cohort = admit();
      evidence("additional");
      saveKnowledgeNode(
        db,
        {
          id: "wiki",
          kind: "wiki",
          title: "Workshop",
          expectedRevision: 0,
          markdown:
            '<claim id="fact" refs="source:a source:additional">The workshop is planned.</claim>',
          inputVersions: { "source:a": "v1", "source:additional": "v1" },
          claims: [
            { id: "fact", relations: { "source:a": "supports", "source:additional": "supports" } },
          ],
        },
        101,
      );
      if (state === "stale")
        db.exec("UPDATE documents SET content_hash='v2' WHERE id='additional'");
      else db.exec("INSERT INTO removed_sources VALUES('source-additional')");
      expect(isOrganizationCohortCurrent(db, cohort)).toBe(true);
      expect(
        completeOrganizationCohort(
          db,
          {
            id: cohort.id,
            batchId: cohort.batchId,
            inputFingerprint: cohort.inputFingerprint,
            outcome: "organized",
            reasonCode: "already_organized",
            targetIds: ["wiki"],
            targetVersions: { wiki: 1 },
            retryAt: 1000,
          },
          110,
        ),
      ).toBe(false);
    },
  );
  it("purges an organized reason when a target's evidence outside the cohort is deleted", () => {
    evidence("a");
    evidence("b");
    const cohort = admit();
    evidence("additional");
    saveKnowledgeNode(
      db,
      {
        id: "wiki",
        kind: "wiki",
        title: "Workshop",
        expectedRevision: 0,
        markdown:
          '<claim id="fact" refs="source:a source:additional">The workshop is planned.</claim>',
        inputVersions: { "source:a": "v1", "source:additional": "v1" },
        claims: [
          { id: "fact", relations: { "source:a": "supports", "source:additional": "supports" } },
        ],
      },
      101,
    );
    expect(
      completeOrganizationCohort(
        db,
        {
          id: cohort.id,
          batchId: cohort.batchId,
          inputFingerprint: cohort.inputFingerprint,
          outcome: "organized",
          reasonCode: "new_context_published",
          targetIds: ["wiki"],
          targetVersions: { wiki: 1 },
          retryAt: 1000,
        },
        110,
      ),
    ).toBe(true);
    expect(db.prepare("SELECT node_id FROM knowledge_organization_targets").all()).toEqual([
      { node_id: "wiki" },
    ]);
    purgeKnowledgeBySource(db, "additional", 200);
    expect(getOrganizationCohortForBatch(db, cohort.batchId)).toBeNull();
    expect(db.prepare("SELECT * FROM knowledge_organization_targets").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM knowledge_organization_members").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM knowledge_organization_cohorts").all()).toEqual([]);
  });
  it("checks cohort identity, disposition and retry before accepting completion", () => {
    evidence("a");
    evidence("b");
    const cohort = admit();
    const input = {
      id: cohort.id,
      batchId: cohort.batchId,
      inputFingerprint: cohort.inputFingerprint,
      outcome: "no_page" as const,
      reasonCode: "insufficient_evidence" as const,
      retryAt: 1000,
    };
    expect(completeOrganizationCohort(db, { ...input, inputFingerprint: "wrong" }, 110)).toBe(
      false,
    );
    expect(completeOrganizationCohort(db, { ...input, reasonCode: "already_organized" }, 110)).toBe(
      false,
    );
    expect(completeOrganizationCohort(db, { ...input, targetIds: ["wiki"] }, 110)).toBe(false);
    expect(
      completeOrganizationCohort(
        db,
        { ...input, outcome: "deferred", targetVersions: { wiki: 1 } },
        110,
      ),
    ).toBe(false);
    expect(completeOrganizationCohort(db, { ...input, retryAt: 100 }, 110)).toBe(false);
    expect(
      completeOrganizationCohort(
        db,
        { ...input, outcome: "organized", targetIds: ["missing"] },
        110,
      ),
    ).toBe(false);
    expect(
      completeOrganizationCohort(db, { ...input, outcome: "deferred", retryAt: 500 }, 110),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed' WHERE id=?").run(cohort.batchId);
    expect(select(499)).toBeNull();
    expect(select(500)).not.toBeNull();
  });
});

it("reports missing cohort grounding separately from current target or source revisions", () => {
  evidence("cohort-a");
  evidence("cohort-b");
  const cohort = admit();
  evidence("outside-context");
  const page = saveKnowledgeNode(
    db,
    {
      id: "archive-index",
      kind: "wiki",
      title: "Archive cabinet reference",
      expectedRevision: 0,
      markdown:
        '<claim id="location" refs="source:outside-context">The archive cabinet is on the upper floor.</claim>',
      inputVersions: { "source:outside-context": "v1" },
    },
    101,
  );
  const input = {
    id: cohort.id,
    batchId: cohort.batchId,
    inputFingerprint: cohort.inputFingerprint,
    outcome: "organized" as const,
    reasonCode: "existing_context_updated" as const,
    targetIds: [page.node.id],
    targetVersions: { [page.node.id]: page.node.revision },
    retryAt: 1000,
  };
  expect(completeOrganizationCohortResult(db, input, 110)).toEqual({
    accepted: false,
    reason: "grounding",
  });
  expect(getOrganizationCohortForBatch(db, cohort.batchId)?.status).toBe("pending");
  expect(
    completeOrganizationCohortResult(db, { ...input, targetVersions: { [page.node.id]: 99 } }, 110),
  ).toEqual({ accepted: false, reason: "target" });
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='cohort-a'").run();
  expect(completeOrganizationCohortResult(db, input, 110)).toEqual({
    accepted: false,
    reason: "snapshot",
  });
});

it("gives a grounded refusal actionable no-page recovery without weakening the writer fence", () => {
  evidence("cohort-a");
  evidence("cohort-b");
  const cohort = admit();
  evidence("outside-context");
  saveKnowledgeNode(
    db,
    {
      id: "archive-index",
      kind: "wiki",
      title: "Archive cabinet reference",
      expectedRevision: 0,
      markdown:
        '<claim id="location" refs="source:outside-context">The archive cabinet is on the upper floor.</claim>',
      inputVersions: { "source:outside-context": "v1" },
    },
    101,
  );
  const input = {
    id: cohort.id,
    batchId: cohort.batchId,
    runId: "run-cohort",
    inputFingerprint: cohort.inputFingerprint,
    outcome: "organized" as const,
    reasonCode: "existing_context_updated" as const,
    targetIds: ["archive-index"],
    targetVersions: { "archive-index": 1 },
    retryAt: 1000,
  };
  let refusal: unknown;
  try {
    completeOrganizationBatch(db, input, 110);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("lack actual claim supports"),
  });
  expect((refusal as Error).message).toContain(
    "Do not pad support references or guess targetVersions",
  );
  expect(
    completeOrganizationBatch(
      db,
      {
        ...input,
        outcome: "no_page",
        reasonCode: "insufficient_shared_context",
        targetIds: [],
        targetVersions: {},
      },
      110,
    ),
  ).toBe(true);
  expect(getOrganizationCohortForBatch(db, cohort.batchId)?.status).toBe("completed");
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_organization_targets WHERE cohort_id=?")
      .get(cohort.id),
  ).toEqual({ count: 0 });
});
