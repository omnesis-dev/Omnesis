// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runSchemaSetup } from "../../data/schema.js";
import {
  recordSourceInventoryDocument,
  recordSourceInventoryPage,
} from "../../data/repositories/SourceInventoryRepository.js";
import {
  KNOWLEDGE_DISCOVERY_POLICY,
  listKnowledgeDiscoveryBacklog,
  proposeKnowledgeCandidate,
  recordKnowledgeCoverage,
} from "./discovery.js";
import { knowledgeDiscoveryByMonth } from "./discovery-timeline.js";
import { readKnowledgeInventoryStatus } from "./inventory-status.js";
import { admitKnowledgeOrganization, listOrganizationAdmissions } from "./organization.js";
import {
  completeOrganizationCohort,
  createOrganizationCohort,
  getOrganizationCohortForBatch,
  isOrganizationCohortCurrent,
  selectOrganizationCohort,
} from "./organization-cohorts.js";
import { readKnowledgeSourceRevision } from "./source-revision.js";
import { enqueueKnowledgeWork } from "./work.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  for (const id of ["capacity", "roster"])
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES(?,'fixture','fixture-notes',?,'Observatory allocation','The observation team has six places.','body-v1','2026-02-01','2026-02-01','2026-02-01','2026-02-01')`,
    ).run(id, id);
});
afterEach(() => db.close());
function coverage(id: string, status: "considered" | "deferred" = "considered") {
  recordKnowledgeCoverage(
    db,
    {
      subjectId: id,
      inputRevision: readKnowledgeSourceRevision(db, id)!,
      phase: "organization",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status,
      reconsiderAt: status === "deferred" ? 2 : undefined,
    },
    1,
  );
}

it("rejects reference-shaped evidence keys at the writer boundary without normalization", () => {
  expect(() =>
    proposeKnowledgeCandidate(
      db,
      {
        id: "candidate",
        identityKey: "observatory",
        title: "Observatory",
        scope: "Team allocation",
        evidenceVersions: { "source:capacity": readKnowledgeSourceRevision(db, "capacity")! },
      },
      10,
    ),
  ).toThrow("bare document IDs");
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 0 });
});

it("reopens metadata-only source revisions while retaining body identities and rejecting stale commits", () => {
  coverage("capacity");
  enqueueKnowledgeWork(
    db,
    {
      id: "old-work",
      subjectId: "capacity",
      subjectKind: "source",
      reason: "change",
      inputRevision: "body-v1",
      tier: "routine",
      dueAt: 1,
    },
    1,
  );
  db.prepare("UPDATE documents SET title='Observatory allocation draft' WHERE id='capacity'").run();
  const revision = readKnowledgeSourceRevision(db, "capacity")!;
  expect(revision).not.toBe("body-v1");
  const backlog = listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 10, now: 10 });
  expect(backlog.find((row) => row.id === "capacity")).toMatchObject({
    contentHash: "body-v1",
    sourceRevision: revision,
  });
  expect(() =>
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "capacity",
        inputRevision: "body-v1",
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "considered",
      },
      10,
    ),
  ).toThrow("Discovery input changed");
  const candidate = {
    id: "observatory",
    identityKey: "project:observatory",
    title: "Observatory",
    scope: "Team allocation",
    evidenceVersions: { capacity: "body-v1" },
  };
  expect(() => proposeKnowledgeCandidate(db, candidate, 10)).toThrow("Candidate evidence changed");
  expect(
    proposeKnowledgeCandidate(db, { ...candidate, evidenceVersions: { capacity: revision } }, 10)
      .id,
  ).toBe("observatory");
  // Returning to the original metadata must not resurrect the earlier receipt.
  db.prepare("UPDATE documents SET title='Observatory allocation' WHERE id='capacity'").run();
  expect(readKnowledgeSourceRevision(db, "capacity")).not.toBe(revision);
  expect(() =>
    proposeKnowledgeCandidate(
      db,
      { ...candidate, id: "later", evidenceVersions: { capacity: revision } },
      11,
    ),
  ).toThrow("Candidate evidence changed");
});

it("keeps import provenance but reports only current semantic coverage and pending work", () => {
  const now = Date.parse("2026-02-02T00:00:00Z");
  const inventory = {
    id: "12345678-1234-4234-8234-123456789012",
    startedAt: "2026-02-02T00:00:00Z",
  };
  recordSourceInventoryPage(db, "fixture-notes", "", inventory, true, now);
  recordSourceInventoryDocument(db, {
    documentId: "capacity",
    inventoryId: inventory.id,
    revision: "body-v1",
    now,
  });
  coverage("capacity");
  enqueueKnowledgeWork(
    db,
    {
      id: "old-work",
      subjectId: "capacity",
      subjectKind: "source",
      reason: "change",
      inputRevision: "body-v1",
      tier: "routine",
      dueAt: 1,
    },
    1,
  );
  db.prepare("UPDATE documents SET source_updated_at='2026-02-02' WHERE id='capacity'").run();
  const phase = () =>
    readKnowledgeInventoryStatus(db, 7 * 86_400_000).find((row) => row.phase === "organization")!;
  expect(phase()).toMatchObject({ observed: 1, considered: 0, pending: 0, unconsidered: 1 });
  expect(knowledgeDiscoveryByMonth(db)[0]!.organization).toMatchObject({
    considered: 0,
    pending: 2,
  });
  expect(
    db
      .prepare("SELECT input_revision FROM source_inventory_documents WHERE document_id='capacity'")
      .get(),
  ).toEqual({ input_revision: "body-v1" });
  coverage("capacity");
  expect(phase()).toMatchObject({ observed: 1, considered: 1, unconsidered: 0 });
  expect(knowledgeDiscoveryByMonth(db)[0]!.organization).toMatchObject({
    considered: 1,
    pending: 1,
  });
});

it("refuses stale reconsideration and joint cohort snapshots after a metadata edit", () => {
  coverage("capacity", "deferred");
  const admission = listOrganizationAdmissions(db, { now: 10, limit: 10, retryMs: 1 })[0]!;
  expect(admission).toMatchObject({ kind: "coverage", inputRevision: "body-v1" });
  db.prepare("UPDATE documents SET source_created_at='2026-02-02' WHERE id='capacity'").run();
  expect(admitKnowledgeOrganization(db, { admission, workPrefix: "stale", retryAt: 100 }, 10)).toBe(
    false,
  );
  expect(listOrganizationAdmissions(db, { now: 10, limit: 10, retryMs: 1 })).toEqual([]);
  coverage("capacity");
  coverage("roster");
  const options = { now: 100, intervalMs: 100, retryMs: 500 };
  const selected = selectOrganizationCohort(db, options)!;
  expect(selected.sourceVersions.capacity).toBe(readKnowledgeSourceRevision(db, "capacity"));
  db.prepare(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','pending',100,100)",
  ).run();
  expect(
    createOrganizationCohort(
      db,
      { ...selected, id: "cohort", batchId: "batch", intervalMs: 100, retryMs: 500 },
      100,
    ),
  ).toBe(true);
  const cohort = getOrganizationCohortForBatch(db, "batch")!;
  expect(isOrganizationCohortCurrent(db, cohort)).toBe(true);
  db.prepare("UPDATE documents SET title='Observation team draft' WHERE id='roster'").run();
  expect(isOrganizationCohortCurrent(db, cohort)).toBe(false);
  expect(
    completeOrganizationCohort(
      db,
      {
        id: cohort.id,
        batchId: cohort.batchId,
        inputFingerprint: cohort.inputFingerprint,
        outcome: "no_page",
        reasonCode: "insufficient_shared_context",
        retryAt: 1000,
      },
      110,
    ),
  ).toBe(false);
  coverage("roster");
  // Semantic revision changes produce a new joint input, not the old one-shot key.
  db.prepare("UPDATE knowledge_batches SET status='abandoned' WHERE id='batch'").run();
  db.prepare(
    "UPDATE knowledge_organization_cohorts SET status='abandoned' WHERE id='cohort'",
  ).run();
  const next = selectOrganizationCohort(db, { ...options, now: 1000 })!;
  expect(next.sourceVersions.roster).toBe(readKnowledgeSourceRevision(db, "roster"));
  expect(next.inputFingerprint).not.toBe(selected.inputFingerprint);
});
