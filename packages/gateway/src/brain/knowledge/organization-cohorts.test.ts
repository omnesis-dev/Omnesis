// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { reconsiderPublishedRetrieval } from "./retrieval-reconsideration.js";
import { completeOrganizationBatch } from "./organization-writer.js";
import { recordKnowledgeSourceDeletion, advanceKnowledgeCascade } from "./storage-invalidation.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
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
  narrowOrganizationSelection,
  newSubjectCohortTally,
  readOrganizationCohortSummary,
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
    recordKnowledgeSourceDeletion(db, "a", 200);
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
  it.each(["changed", "deleted"])(
    "rejects a target whose other evidence was %s even when cohort evidence stayed current",
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
      if (state === "changed")
        db.exec("UPDATE documents SET content_hash='v2' WHERE id='additional'");
      else recordKnowledgeSourceDeletion(db, "additional", 102);
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
  it("keeps an organized reason when a target's evidence outside the cohort is deleted", () => {
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
    recordKnowledgeSourceDeletion(db, "additional", 200);
    // The target page survives as stale, so the cohort that placed it does too.
    expect(getKnowledgeNode(db, "wiki")?.validity).toBe("stale");
    expect(getOrganizationCohortForBatch(db, cohort.batchId)).not.toBeNull();
    expect(db.prepare("SELECT node_id FROM knowledge_organization_targets").all()).toEqual([
      { node_id: "wiki" },
    ]);
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

describe("publication-backed joint reconsideration", () => {
  const boundary = "2027-03-02T10:00:00.000Z";
  function incompletePair() {
    evidence("a");
    evidence("b");
    db.prepare("UPDATE knowledge_discovery_coverage SET retrieval_boundary=?").run(boundary);
    admit();
    expect(finish()).toBe(true);
  }
  it("reopens the joint decision before ordinary cadence and consumes that retry once", () => {
    incompletePair();
    expect(select(120)).toBeNull();
    expect(
      reconsiderPublishedRetrieval(
        db,
        { publishedThrough: "2027-03-02T09:00:00.000Z", limit: 8 },
        120,
      ),
    ).toBe(0);
    expect(select(120)).toBeNull();
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 121)).toBe(3);
    // The source debt has been consumed; the joint debt is independently durable.
    expect(
      db
        .prepare(
          "SELECT retrieval_boundary,retrieval_reconsider_at FROM knowledge_organization_cohorts WHERE id='cohort'",
        )
        .get(),
    ).toEqual({ retrieval_boundary: boundary, retrieval_reconsider_at: 121 });
    const retry = select(121)!;
    expect(retry.sourceVersions).toEqual({ a: "v1", b: "v1" });
    const replacement = admit(121, "published-retry", retry);
    expect(
      db
        .prepare(
          "SELECT retrieval_reconsider_at FROM knowledge_organization_cohorts WHERE id='cohort'",
        )
        .get(),
    ).toEqual({ retrieval_reconsider_at: null });
    expect(
      completeOrganizationCohort(
        db,
        {
          retrievalBoundary: "2027-03-02T12:00:00.000Z",
          id: replacement.id,
          batchId: replacement.batchId,
          inputFingerprint: replacement.inputFingerprint,
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
          retryAt: 1000,
        },
        122,
      ),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    createKnowledgeWorkTables(db);
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 123)).toBe(0);
    expect(
      reconsiderPublishedRetrieval(
        db,
        { publishedThrough: "2027-03-02T12:00:00.000Z", limit: 8 },
        124,
      ),
    ).toBe(0);
    expect(select(300)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_organization_cohorts").get()).toEqual({
      n: 2,
    });
  });
  it("captures a run search gap after individual source completion", () => {
    evidence("a");
    evidence("b");
    const cohort = admit();
    expect(
      completeOrganizationCohort(
        db,
        {
          id: cohort.id,
          batchId: cohort.batchId,
          inputFingerprint: cohort.inputFingerprint,
          outcome: "deferred",
          reasonCode: "awaiting_more_evidence",
          retryAt: 1000,
          retrievalBoundary: boundary,
        },
        110,
      ),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 120)).toBe(1);
    expect(select(120)?.sourceVersions).toEqual({ a: "v1", b: "v1" });
  });
  it.each(["changed", "deleted", "removed"])("does not revive a %s member revision", (change) => {
    incompletePair();
    if (change === "changed") db.exec("UPDATE documents SET content_hash='v2' WHERE id='a'");
    if (change === "deleted") db.exec("DELETE FROM documents WHERE id='a'");
    if (change === "removed") db.exec("INSERT INTO removed_sources VALUES('source-a')");
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 120);
    expect(select(120)).toBeNull();
    expect(
      db.prepare("SELECT retrieval_reconsider_at FROM knowledge_organization_cohorts").get(),
    ).toEqual({ retrieval_reconsider_at: null });
  });
  it("does not reset an unrelated cohort that did not search an incomplete view", () => {
    incompletePair();
    evidence("c");
    evidence("d");
    const unrelated = admit(120, "unrelated", select(120)!);
    expect(
      completeOrganizationCohort(
        db,
        {
          id: unrelated.id,
          batchId: unrelated.batchId,
          inputFingerprint: unrelated.inputFingerprint,
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
          retryAt: 1000,
        },
        125,
      ),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed' WHERE id=?").run(unrelated.batchId);
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 130)).toBe(3);
    expect(
      db
        .prepare(
          "SELECT id FROM knowledge_organization_cohorts WHERE retrieval_reconsider_at IS NOT NULL",
        )
        .all(),
    ).toEqual([{ id: "cohort" }]);
    expect(select(130)?.sourceVersions).toEqual({ a: "v1", b: "v1" });
  });

  it("coalesces duplicate historical fingerprints within bounded releases", () => {
    incompletePair();
    const repeat = admit(1001, "historical-repeat", select(1001)!);
    expect(
      completeOrganizationCohort(
        db,
        {
          id: repeat.id,
          batchId: repeat.batchId,
          inputFingerprint: repeat.inputFingerprint,
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
          retryAt: 5000,
        },
        1002,
      ),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 1003);
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 1004);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_organization_cohorts WHERE retrieval_reconsider_at IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 1005)).toBe(
      0,
    );
  });
  it("allows changed source versions a fresh fingerprint and publication retry", () => {
    incompletePair();
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 120);
    db.exec("UPDATE documents SET content_hash='v2' WHERE id='a'");
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "a",
        inputRevision: "v2",
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "considered",
        retrievalBoundary: "2027-03-02T12:00:00.000Z",
      },
      130,
    );
    const revised = admit(300, "revised", select(300)!);
    expect(revised.sourceVersions).toEqual({ a: "v2", b: "v1" });
    expect(
      completeOrganizationCohort(
        db,
        {
          id: revised.id,
          batchId: revised.batchId,
          inputFingerprint: revised.inputFingerprint,
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
          retryAt: 5000,
        },
        310,
      ),
    ).toBe(true);
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    expect(
      reconsiderPublishedRetrieval(
        db,
        { publishedThrough: "2027-03-02T12:00:00.000Z", limit: 8 },
        320,
      ),
    ).toBe(2);
    expect(select(320)?.inputFingerprint).toBe(revised.inputFingerprint);
  });

  it("retains exact-group debt when the configured selection limit shrinks", () => {
    evidence("a");
    evidence("b");
    evidence("c");
    db.prepare("UPDATE knowledge_discovery_coverage SET retrieval_boundary=?").run(boundary);
    admit();
    expect(finish()).toBe(true);
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 120);
    expect(
      selectOrganizationCohort(db, { now: 120, limit: 2, intervalMs: 100, retryMs: 500 }),
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT retrieval_reconsider_at FROM knowledge_organization_cohorts WHERE id='cohort'",
        )
        .get(),
    ).toEqual({ retrieval_reconsider_at: 120 });
    expect(
      Object.keys(
        selectOrganizationCohort(db, { now: 120, limit: 3, intervalMs: 100, retryMs: 500 })!
          .sourceVersions,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("backfills legacy joint debt from current members without recreating released debt on restart", () => {
    incompletePair();
    db.exec(`DROP INDEX knowledge_organization_retrieval_pending;
      DROP INDEX knowledge_organization_retrieval_due;
      DROP INDEX knowledge_organization_retrieval_identity;
      ALTER TABLE knowledge_organization_cohorts DROP COLUMN retrieval_boundary;
      ALTER TABLE knowledge_organization_cohorts DROP COLUMN retrieval_reconsidered;
      ALTER TABLE knowledge_organization_cohorts DROP COLUMN retrieval_reconsider_at;`);
    createKnowledgeWorkTables(db);
    expect(
      db.prepare("SELECT retrieval_boundary FROM knowledge_organization_cohorts").get(),
    ).toEqual({ retrieval_boundary: boundary });
    reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 120);
    createKnowledgeWorkTables(db);
    expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 8 }, 121)).toBe(0);
  });
});

describe("excluded sources", () => {
  it("never selects a document from a source excluded from the Brain", () => {
    for (const id of ["a", "b", "c"]) evidence(id);
    expect(Object.keys(select()!.sourceVersions).sort()).toEqual(["a", "b", "c"]);
    const selection = selectOrganizationCohort(db, {
      now: 100,
      intervalMs: 100,
      retryMs: 500,
      excludedSources: ["source-b"],
    })!;
    expect(Object.keys(selection.sourceVersions).sort()).toEqual(["a", "c"]);
  });
});

describe("subject cohorts for important outcomes without a page", () => {
  const DAY = 86_400_000;
  const NOW = 200 * DAY;
  beforeEach(() => {
    createBriefsStorageTables(db);
    db.exec("CREATE TABLE people(id TEXT PRIMARY KEY,is_self BOOLEAN DEFAULT FALSE)");
    db.prepare("INSERT INTO people VALUES('me',1)").run();
  });
  function outcome(
    id: string,
    importance: number,
    docs: string[],
    people: string[] = [],
    state = "open",
    lastUpdate = NOW - DAY,
  ) {
    db.prepare(
      `INSERT INTO open_loops(id,created_by_run,state,confidence,importance,title,created_at,last_update)
      VALUES(?,'fixture',?,0.9,?,?,?,?)`,
    ).run(id, state, importance, `Outcome ${id}`, lastUpdate, lastUpdate);
    for (const doc of docs) {
      if (!db.prepare("SELECT 1 FROM documents WHERE id=?").get(doc)) evidence(doc);
      db.prepare("INSERT INTO open_loop_docs VALUES(?,?)").run(id, doc);
    }
    for (const person of people)
      db.prepare("INSERT INTO open_loop_people VALUES(?,?,'involved')").run(id, person);
  }
  function selectSubject(now = NOW) {
    return selectOrganizationCohort(db, {
      now,
      intervalMs: 100 * DAY,
      retryMs: 30 * DAY,
      subjectIntervalMs: DAY,
    });
  }
  function admitSubject(now = NOW, id = "subject-cohort") {
    const selection = selectSubject(now)!;
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,?,'routine','pending',?,?)",
    ).run(`batch-${id}`, `run-${id}`, "fingerprint", now, now);
    expect(
      createOrganizationCohort(
        db,
        {
          ...selection,
          id,
          batchId: `batch-${id}`,
          intervalMs: 100 * DAY,
          retryMs: 30 * DAY,
          subjectIntervalMs: DAY,
        },
        now,
      ),
    ).toBe(true);
    return getOrganizationCohortForBatch(db, `batch-${id}`)!;
  }

  it("groups an important uncovered matter's outcomes by a specific person, anchored on the most important", () => {
    outcome("memorial", 0.85, ["vet-invoice", "memorial-proof"], ["sitter"]);
    outcome("thank-sitter", 0.6, ["sitter-message"], ["sitter", "me"]);
    outcome("minor", 0.3, ["newsletter"], ["sitter"]);
    const selection = selectSubject()!;
    expect(selection.subjectLoopId).toBe("memorial");
    expect(Object.keys(selection.sourceVersions).sort()).toEqual([
      "memorial-proof",
      "sitter-message",
      "vet-invoice",
    ]);
    const cohort = admitSubject();
    expect(cohort.subjectLoopId).toBe("memorial");
  });

  it("does not join matters through the owner or a person on many outcomes", () => {
    outcome("party", 0.9, ["party-rsvp", "party-venue"], ["partner"]);
    for (let i = 0; i < 6; i++) outcome(`errand-${i}`, 0.7, [`errand-doc-${i}`], ["partner", "me"]);
    const selection = selectSubject()!;
    expect(selection.subjectLoopId).toBe("party");
    expect(Object.keys(selection.sourceVersions).sort()).toEqual(["party-rsvp", "party-venue"]);
  });

  it("skips outcomes a wiki already cites, unimportant or stale ones, and ranks larger matters first", () => {
    // Each excluded matter has two outcomes, so it would outrank the threads if selected.
    outcome("covered", 0.95, ["covered-a", "covered-b"], ["covered-person"]);
    outcome("covered-2", 0.95, ["covered-c"], ["covered-person"]);
    saveKnowledgeNode(
      db,
      {
        id: "covering-page",
        kind: "wiki",
        title: "Covered matter",
        markdown: '<claim id="c" refs="source:covered-a">The matter is covered.</claim>',
        expectedRevision: 0,
        inputVersions: { "source:covered-a": "v1" },
      },
      NOW,
    );
    outcome("covered-3", 0.95, ["covered-d"], ["covered-person"]);
    db.prepare("INSERT INTO open_loop_docs VALUES('covered-3','covered-a')").run();
    outcome("stale", 0.95, ["stale-a", "stale-b"], ["stale-person"], "open", NOW - 200 * DAY);
    outcome("stale-2", 0.95, ["stale-c"], ["stale-person"], "open", NOW - 200 * DAY);
    outcome("dismissed", 0.95, ["dismissed-a"], ["dismissed-person"], "dismissed");
    outcome("dismissed-2", 0.95, ["dismissed-b"], ["dismissed-person"], "dismissed");
    outcome("minor", 0.5, ["minor-a"], ["minor-person"]);
    outcome("minor-2", 0.5, ["minor-b"], ["minor-person"]);
    outcome("minor-3", 0.5, ["minor-c"], ["minor-person"]);
    outcome("single", 0.9, ["single-a", "single-b"]);
    outcome("thread-1", 0.75, ["thread-a", "shared-doc"]);
    outcome("thread-2", 0.75, ["shared-doc", "thread-b"]);
    expect(selectSubject()!.subjectLoopId).toMatch(/^thread-/);
  });

  it("paces subject cohorts and does not regroup a subject before its retry interval", () => {
    outcome("first", 0.9, ["first-a", "first-b"]);
    outcome("second", 0.8, ["second-a", "second-b"]);
    admitSubject();
    db.prepare("UPDATE knowledge_organization_cohorts SET status='completed'").run();
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    // Within the subject interval no subject is offered; chronological cohorts still are.
    expect(selectSubject(NOW + DAY - 1)?.subjectLoopId).toBeUndefined();
    const next = selectSubject(NOW + DAY)!;
    expect(next.subjectLoopId).toBe("second");
    admitSubject(NOW + DAY, "second-cohort");
    db.prepare("UPDATE knowledge_organization_cohorts SET status='completed'").run();
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    expect(selectSubject(NOW + 2 * DAY)?.subjectLoopId).toBeUndefined();
    expect(selectSubject(NOW + 31 * DAY)?.subjectLoopId).toBe("first");
  });

  it("admits a subject cohort over evidence chronological cohorts already reviewed", () => {
    outcome("matter", 0.9, ["matter-a", "matter-b"]);
    admit(
      NOW,
      "chronological",
      selectOrganizationCohort(db, { now: NOW, intervalMs: 100, retryMs: 30 * DAY })!,
    );
    db.prepare("UPDATE knowledge_organization_cohorts SET status='completed'").run();
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    expect(selectSubject(NOW + 1)?.subjectLoopId).toBe("matter");
    expect(admitSubject(NOW + 1).sourceVersions).toEqual({ "matter-a": "v1", "matter-b": "v1" });
  });
  it("judges every subject, so ones lacking evidence or waiting never hide a lower-ranked one", () => {
    // Thirty higher-ranked matters whose documents were never considered for organization.
    for (let i = 0; i < 30; i++) {
      const loop = `unread-${String(i).padStart(2, "0")}`;
      outcome(loop, 0.95, []);
      for (const doc of [`${loop}-a`, `${loop}-b`]) {
        db.prepare("INSERT INTO documents VALUES(?,?,?,'{}')").run(doc, `source-${doc}`, "v1");
        db.prepare("INSERT INTO open_loop_docs VALUES(?,?)").run(loop, doc);
      }
    }
    outcome("waiting", 0.9, ["waiting-a", "waiting-b"]);
    admitSubject();
    db.prepare("UPDATE knowledge_organization_cohorts SET status='completed'").run();
    db.prepare("UPDATE knowledge_batches SET status='completed'").run();
    outcome("readable", 0.7, ["readable-a", "readable-b"]);
    outcome("next", 0.65, ["next-a", "next-b"]);
    const tally = newSubjectCohortTally();
    const selection = selectOrganizationCohort(db, {
      now: NOW + DAY,
      intervalMs: 100 * DAY,
      retryMs: 30 * DAY,
      subjectIntervalMs: DAY,
      subjectTally: tally,
    })!;
    expect(selection.subjectLoopId).toBe("readable");
    expect(tally).toMatchObject({ evaluated: true, waiting: 1, skipped: 0, lackingEvidence: 30 });
    expect(tally).toMatchObject({ lackingDocuments: 60, lackingConsidered: 0 });

    // A subject the caller could not start is passed over for the next one.
    const passed = newSubjectCohortTally();
    expect(
      selectOrganizationCohort(db, {
        now: NOW + DAY,
        intervalMs: 100 * DAY,
        retryMs: 30 * DAY,
        subjectIntervalMs: DAY,
        skipSubjects: new Set(["readable"]),
        subjectTally: passed,
      })!.subjectLoopId,
    ).toBe("next");
    expect(passed.skipped).toBe(1);
  });

  it("counts why no subject started: none important, all covered, or evidence not yet considered", () => {
    const tallied = () => {
      const tally = newSubjectCohortTally();
      selectOrganizationCohort(db, {
        now: NOW,
        intervalMs: 100 * DAY,
        retryMs: 30 * DAY,
        subjectIntervalMs: DAY,
        subjectTally: tally,
      });
      return tally;
    };
    outcome("minor", 0.5, ["minor-a", "minor-b"]);
    expect(tallied()).toMatchObject({ evaluated: true, important: 0, uncovered: 0, subjects: 0 });
    outcome("covered", 0.9, ["covered-a", "covered-b"]);
    saveKnowledgeNode(
      db,
      {
        id: "covering-page",
        kind: "wiki",
        title: "Covered matter",
        markdown: '<claim id="c" refs="source:covered-a">The matter is covered.</claim>',
        expectedRevision: 0,
        inputVersions: { "source:covered-a": "v1" },
      },
      NOW,
    );
    expect(tallied()).toMatchObject({ important: 1, uncovered: 0, subjects: 0 });
    outcome("half-read", 0.9, ["read-a"]);
    db.prepare("INSERT INTO documents VALUES('unread-b','source-unread-b','v1','{}')").run();
    db.prepare("INSERT INTO open_loop_docs VALUES('half-read','unread-b')").run();
    expect(tallied()).toMatchObject({
      important: 2,
      uncovered: 1,
      subjects: 1,
      lackingEvidence: 1,
      lackingDocuments: 2,
      lackingConsidered: 1,
    });
  });

  it("narrows a selection to the sources that fit, keeping its subject and admission", () => {
    outcome("matter", 0.9, ["matter-a", "matter-b", "matter-c"]);
    const selection = selectSubject()!;
    const narrowed = narrowOrganizationSelection(selection, ["matter-a", "matter-b"]);
    expect(narrowed.subjectLoopId).toBe("matter");
    expect(narrowed.sourceVersions).toEqual({ "matter-a": "v1", "matter-b": "v1" });
    expect(narrowed.inputFingerprint).not.toBe(selection.inputFingerprint);
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch-narrow','run-narrow','fingerprint','routine','pending',?,?)",
    ).run(NOW, NOW);
    expect(
      createOrganizationCohort(
        db,
        {
          ...narrowed,
          id: "narrow",
          batchId: "batch-narrow",
          intervalMs: 100 * DAY,
          retryMs: 30 * DAY,
          subjectIntervalMs: DAY,
        },
        NOW,
      ),
    ).toBe(true);
    expect(readOrganizationCohortSummary(db)).toEqual([
      { kind: "subject", status: "pending", outcome: null, count: 1, lastCreatedAt: NOW },
    ]);
  });
});

describe("publication retries that cannot be admitted", () => {
  /** A completed cohort whose published search gap reopens it at `reconsiderAt`. */
  function reopened(id: string, docs: string[], reconsiderAt: number, createdAt = 50) {
    for (const doc of docs) evidence(doc);
    const { sourceVersions, inputFingerprint } = narrowOrganizationSelection(
      { sourceVersions: Object.fromEntries(docs.map((doc) => [doc, "v1"])), inputFingerprint: "" },
      docs,
    );
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,'fingerprint','routine','completed',?,?)",
    ).run(`batch-${id}`, `run-${id}`, createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_organization_cohorts(id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at,retrieval_reconsider_at)
      VALUES(?,?,?,?,'completed',10000,?,?,?)`,
    ).run(
      id,
      `batch-${id}`,
      inputFingerprint,
      KNOWLEDGE_DISCOVERY_POLICY,
      createdAt,
      createdAt,
      reconsiderAt,
    );
    for (const doc of docs)
      db.prepare("INSERT INTO knowledge_organization_members VALUES(?,?,'v1')").run(id, doc);
    return { sourceVersions, inputFingerprint };
  }

  it("never reopens a retry with a member parked at its revision", () => {
    reopened("stuck", ["parked-a", "parked-b"], 90);
    expect(select(100)?.publicationRetry).toBe(true);
    db.prepare(
      `INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,last_error)
      VALUES('parked','parked-a','source','review','v1',1,'routine',1,1,1,'deferred','parked')`,
    ).run();
    expect(select(100)?.publicationRetry).toBeUndefined();
  });

  it("admits the selected retry when an earlier one is passed over", () => {
    const first = reopened("first", ["first-a", "first-b"], 90);
    const second = reopened("second", ["second-a", "second-b"], 95, 99);
    const selection = selectOrganizationCohort(db, {
      now: 100,
      intervalMs: 100,
      retryMs: 500,
      skipFingerprints: new Set([first.inputFingerprint]),
    })!;
    expect(selection).toMatchObject({ ...second, publicationRetry: true });
    // Only the retry identity admits it: the cadence and review interval would refuse.
    admit(100, "second-retry", selection);
    const reopenedAt = db.prepare<[], { id: string; at: number | null }>(
      "SELECT id,retrieval_reconsider_at AS at FROM knowledge_organization_cohorts WHERE id IN ('first','second') ORDER BY id",
    );
    expect(reopenedAt.all()).toEqual([
      { id: "first", at: 90 },
      { id: "second", at: null },
    ]);
  });

  it("does not offer chronological inputs the caller passed over", () => {
    evidence("fresh-a");
    evidence("fresh-b");
    const selection = select()!;
    expect(
      selectOrganizationCohort(db, {
        now: 100,
        intervalMs: 100,
        retryMs: 500,
        skipFingerprints: new Set([selection.inputFingerprint]),
      }),
    ).toBeNull();
  });
});
