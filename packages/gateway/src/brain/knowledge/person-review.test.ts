// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createDecisionPayloadTables } from "../decision-payload.js";
import {
  createPersonAnnotation,
  createPersonAnnotationStorageTables,
} from "../storage/person-annotations.js";
import { PersonProfileReads } from "../steward/person-profile-reads.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { PersonEditorialReview, assertPersonReviewFence } from "./person-review.js";
import type { CheckRecord } from "../record-check/check.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
let reads: PersonProfileReads;
let review: PersonEditorialReview;
const run = { batchId: "batch", runId: "run" };
const node = {
  id: "fact",
  kind: "person_annotation" as const,
  ownerId: "fact",
  expectedRevision: 1,
  title: "Profile",
  markdown: "",
  inputVersions: {},
};
function seed(id: string) {
  createPersonAnnotation(
    db,
    {
      id,
      personId: "person",
      claimType: id,
      claimText: `Prefers ${id} puzzle formats.`,
      evidenceDocId: "source",
      evidenceQuote: "Puzzle preferences",
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
    },
    1,
  );
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY,merged_into TEXT); INSERT INTO people VALUES('person',NULL); CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT); INSERT INTO documents VALUES('source','v1')",
  );
  createPersonAnnotationStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createDecisionPayloadTables(db);
  seed("fact");
  seed("sibling");
  db.exec(`INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES('fact','person_annotation','fact','Profile','','',1,1,'hash','current','{}','{}',1,1);
  INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','batch-fp','routine','running',1,1);
  INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','fact','input','{"source:source":"v1"}',0,'offered');
  INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id) VALUES('work','fact','node','review','1',1,'routine',1,1,1,'batched','batch')`);
  reads = new PersonProfileReads(db);
  review = new PersonEditorialReview(db, reads);
});
afterEach(() => db.close());

it("ordinary proof refresh never invokes the person value gate", async () => {
  db.exec("DELETE FROM knowledge_work");
  const check = vi.fn();
  expect(await review.prepare(node, run, "input", check)).toBeUndefined();
  expect(check).not.toHaveBeenCalled();
});
it("requires the complete current profile before spending on assessment", async () => {
  const check = vi.fn();
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(
    /complete current profile/,
  );
  reads.page("person", 1);
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(
    /complete current profile/,
  );
  reads.page("person", 20);
  db.exec("UPDATE person_annotations SET claim_text='Changed preference' WHERE id='sibling'");
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(
    /complete current profile/,
  );
  expect(check).not.toHaveBeenCalled();
});
it("memoizes refused retention without finishing or changing the fact", async () => {
  reads.page("person", 20);
  const check = vi.fn(async () => ({
    save: false as const,
    decisionId: "decision",
    score: 0.5,
    threshold: 1.5,
  }));
  for (let i = 0; i < 2; i++)
    await expect(review.prepare(node, run, "input", check)).rejects.toThrow(
      /canonical person_annotation_revise/,
    );
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      record: { type: "person-fact", kind: "fact", text: "Prefers fact puzzle formats." },
      personContext: expect.objectContaining({
        reconciliation: expect.objectContaining({
          retained_profile: [expect.objectContaining({ id: "sibling" })],
        }),
      }),
    }),
    undefined,
  );
  expect(db.prepare("SELECT status FROM knowledge_frontier").get()).toEqual({ status: "offered" });
  expect(db.prepare("SELECT invalidated_at FROM person_annotations WHERE id='fact'").get()).toEqual(
    { invalidated_at: null },
  );
});
it.each(["sibling", "source"])(
  "binds a late %s change into the final atomic fence",
  async (changed) => {
    reads.page("person", 20);
    const check: CheckRecord = async () => {
      db.exec(
        changed === "sibling"
          ? "UPDATE person_annotations SET claim_text='Changed preference' WHERE id='sibling'"
          : "UPDATE documents SET content_hash='v2' WHERE id='source'",
      );
      return { save: true };
    };
    const personReviewFence = await review.prepare(node, run, "input", check);
    const input: SaveKnowledgeNodeInput = {
      ...node,
      personReviewFence,
      maintenance: { ...run, inputFingerprint: "input" },
    };
    expect(() => db.transaction(() => assertPersonReviewFence(db, input))()).toThrow(
      /complete-profile assessment/,
    );
  },
);
it("preserves the gate's allowed result and isolates continuation receipts", async () => {
  reads.page("person", 20);
  const check = vi.fn(async () => ({ save: true as const }));
  const personReviewFence = await review.prepare(node, run, "input", check);
  expect(() =>
    assertPersonReviewFence(db, {
      ...node,
      personReviewFence,
      maintenance: { ...run, inputFingerprint: "input" },
    }),
  ).not.toThrow();
  const continuation = new PersonEditorialReview(db, new PersonProfileReads(db));
  await expect(continuation.prepare(node, run, "input", check)).rejects.toThrow(
    /complete current profile/,
  );
  expect(check).toHaveBeenCalledTimes(1);
});
it("does not reuse a judgment after a live policy change", async () => {
  reads.page("person", 20);
  let mode = "shadow";
  const check: CheckRecord = vi.fn(async () =>
    mode === "shadow"
      ? { save: true as const }
      : { save: false as const, decisionId: "new", score: 0.4, threshold: 1.5 },
  );
  check.policyKey = () => mode;
  await review.prepare(node, run, "input", check);
  mode = "enforce";
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(/refused retention/);
  expect(check).toHaveBeenCalledTimes(2);
});

it("rejects a pending canonical owner conversion before any paid decision", async () => {
  reads.page("person", 20);
  db.exec(
    "INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('person_annotation','fact','update',2)",
  );
  const check = vi.fn();
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(
    /before synthesis conversion/,
  );
  expect(check).not.toHaveBeenCalled();
});

it("reuses assessment after a proof-only projection revision while enforcing the fresh frontier", async () => {
  reads.page("person", 20);
  const check = vi.fn(async () => ({ save: true as const }));
  const first = await review.prepare(node, run, "input", check);
  db.exec(
    "UPDATE knowledge_nodes SET revision=2 WHERE id='fact'; UPDATE knowledge_frontier SET input_fingerprint='refreshed' WHERE node_id='fact'",
  );
  await expect(review.prepare(node, run, "input", check)).rejects.toThrow(/input changed/);
  const current = { ...node, expectedRevision: 2 };
  const next = await review.prepare(current, run, "refreshed", check);
  expect(next).toEqual(first);
  expect(check).toHaveBeenCalledTimes(1);
  expect(() =>
    assertPersonReviewFence(db, {
      ...current,
      personReviewFence: next,
      maintenance: { ...run, inputFingerprint: "refreshed" },
    }),
  ).not.toThrow();
});

it.each(["fact", "sibling", "source"])(
  "does not reuse retention after canonical %s changes",
  async (changed) => {
    reads.page("person", 20);
    const check = vi.fn(async () => ({ save: true as const }));
    const first = await review.prepare(node, run, "input", check);
    if (changed === "source") {
      db.exec(
        "UPDATE documents SET content_hash='v2' WHERE id='source'; UPDATE knowledge_frontier SET input_versions_json='{\"source:source\":\"v2\"}'",
      );
    } else {
      db.prepare(
        "UPDATE person_annotations SET claim_text='Revised puzzle preference' WHERE id=?",
      ).run(changed);
      // Simulate the canonical projection conversion; real callers cannot bypass its pending journal.
      db.exec("DELETE FROM knowledge_owner_changes");
    }
    reads.page("person", 20);
    const next = await review.prepare(node, run, "input", check);
    expect(next?.profileFingerprint).not.toBe(first?.profileFingerprint);
    expect(check).toHaveBeenCalledTimes(2);
  },
);
