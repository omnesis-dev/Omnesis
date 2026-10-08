// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { runSchemaSetup } from "../../data/schema.js";
import { resolveBrainSettings } from "../config.js";
import {
  getKnowledgeCandidate,
  publishKnowledgeCandidate,
  proposeKnowledgeCandidate,
} from "./discovery.js";
import { advanceKnowledgeCascade, getKnowledgeNode } from "./storage.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { readKnowledgeCollectionRevision } from "./reconciliation.js";

let directory: string;
let path: string;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "knowledge-candidate-lifecycle-"));
  path = join(directory, "store.db");
  db = new Database(path);
  runSchemaSetup(db);
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES('evidence','fixture','fixture-notes','plan','Planning note','The workshop is planned.','v1','2020-01-01','2020-01-01','2020-01-01','2020-01-01'),
    ('materials','fixture','fixture-notes','materials','Materials arrangement','The workshop supplies clay.','materials-v1','2020-01-02','2020-01-02','2020-01-02','2020-01-02')`,
  ).run();
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});
const proposal = (id: string, identityKey = "project:workshop") => ({
  id,
  identityKey,
  title: "Workshop",
  scope: identityKey,
  evidenceVersions: { evidence: "v1" },
});
const page = (id: string) => ({
  id,
  kind: "wiki" as const,
  title: "Workshop",
  expectedRevision: 0,
  markdown:
    '<claim id="plan" refs="source:evidence source:materials">The workshop is planned and supplies clay.</claim>',
  inputVersions: { "source:evidence": "v1", "source:materials": "materials-v1" },
});
function creationReceipt(candidateId: string) {
  return {
    candidateId,
    inventoryRevision: readKnowledgeCollectionRevision(db, "wiki_scope"),
    assessment: {
      reason: "Workshop planning and supplied materials establish a distinct reference scope.",
      relatedPageIds: [],
    },
    relatedPageRevisions: {},
  };
}
function service(verifier: EntailCapability) {
  return new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => 10,
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: async () => verifier,
    log: createLogger("knowledge-lifecycle-test"),
  });
}

it("concurrent callers converge on one page while equal titles in different scopes stay separate", async () => {
  // Production has one serialized writer; concurrent agent requests enter that same mutation seam.
  const gate = directKnowledgeGate(db);
  const [first, second, distinct] = await Promise.all([
    gate["knowledge.proposeCandidate"](proposal("first"), 1),
    gate["knowledge.proposeCandidate"](proposal("second"), 1),
    gate["knowledge.proposeCandidate"](proposal("distinct", "project:other-workshop"), 1),
  ]);
  expect(first.id).toBe(second.id);
  expect(distinct.id).not.toBe(first.id);
  expect(distinct.title).toBe(first.title);
  let entered = 0;
  let bothEntered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const brain = service({
    verify: async () => {
      if (++entered === 2) bothEntered();
      await barrier;
      return { label: "entailment" };
    },
    dispose: () => {},
  });
  const publications = Promise.allSettled([
    brain.save(page("page-a"), {
      candidateId: first.id,
      creationReceipt: creationReceipt(first.id),
      expectedCandidateRevision: first.revision,
    }),
    brain.save(page("page-b"), {
      candidateId: second.id,
      creationReceipt: creationReceipt(second.id),
      expectedCandidateRevision: second.revision,
    }),
  ]);
  await ready;
  release();
  const results = await publications;
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "revision_conflict" },
  });
  const winner = getKnowledgeCandidate(db, first.id)!;
  expect(winner.status).toBe("published");
  expect(["page-a", "page-b"]).toContain(winner.nodeId);
  const loserId = winner.nodeId === "page-a" ? "page-b" : "page-a";
  expect(getKnowledgeNode(db, loserId)).toBeNull();
  publishKnowledgeCandidate(
    db,
    {
      candidateId: distinct.id,
      creationReceipt: creationReceipt(distinct.id),
      expectedCandidateRevision: distinct.revision,
      node: page("distinct-page"),
    },
    11,
  );
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes WHERE kind='wiki'").get(),
  ).toEqual({ count: 2 });
  expect(getKnowledgeCandidate(db, distinct.id)?.nodeId).toBe("distinct-page");
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it("resumes publication after closing and reopening the candidate database without duplicate pages", () => {
  const candidate = proposeKnowledgeCandidate(db, proposal("pending"), 1);
  db.close();
  db = new Database(path);
  db.pragma("foreign_keys=ON");
  expect(getKnowledgeCandidate(db, candidate.id)).toMatchObject({
    status: "proposed",
    revision: candidate.revision,
  });
  const recovered = proposeKnowledgeCandidate(db, proposal("retry"), 2);
  expect(recovered.id).toBe(candidate.id);
  publishKnowledgeCandidate(
    db,
    {
      candidateId: recovered.id,
      creationReceipt: creationReceipt(recovered.id),
      expectedCandidateRevision: recovered.revision,
      node: page("resumed-page"),
    },
    3,
  );
  db.close();
  db = new Database(path);
  const replay = proposeKnowledgeCandidate(db, proposal("second-retry"), 4);
  expect(replay).toMatchObject({ status: "published", nodeId: "resumed-page" });
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get()).toEqual({
    count: 1,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 1 });
});

it("refuses a previously proposed candidate after evidence deletion and purges retained derivatives", () => {
  const pending = proposeKnowledgeCandidate(db, proposal("pending"), 1);
  const prior = proposeKnowledgeCandidate(db, proposal("prior", "project:prior"), 1);
  publishKnowledgeCandidate(
    db,
    {
      candidateId: prior.id,
      creationReceipt: creationReceipt(prior.id),
      expectedCandidateRevision: prior.revision,
      node: page("retained-page"),
    },
    2,
  );
  db.prepare("DELETE FROM documents WHERE id='evidence'").run();
  expect(getKnowledgeCandidate(db, pending.id)).toBeNull();
  expect(getKnowledgeNode(db, "retained-page")).toBeNull();
  expect(() =>
    publishKnowledgeCandidate(
      db,
      {
        candidateId: pending.id,
        creationReceipt: creationReceipt(pending.id),
        expectedCandidateRevision: pending.revision,
        node: page("resurrection"),
      },
      3,
    ),
  ).toThrow();
  expect(db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='resurrection'").get()).toBeUndefined();
  while (advanceKnowledgeCascade(db, 10, 4).pending) {
    /* bounded durable cleanup */
  }
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get()).toEqual({
    count: 0,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_revisions").get()).toEqual({
    count: 0,
  });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
