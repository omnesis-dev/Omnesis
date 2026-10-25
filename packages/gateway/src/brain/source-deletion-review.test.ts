// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source deletion is a change like an edit: whichever path deletes a cited
 * document, every Brain artifact built on it survives, loses only its pointer
 * to the document, is marked stale in its own store and is queued for the
 * Brain's review. The deleted document stays unreadable and uncitable.
 *
 * Fixture data is invented.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import {
  deleteAllBySource,
  deleteDocumentForUser,
  deleteDocuments,
  deleteDocumentsByIds,
  upsertDocuments,
} from "../data/repositories/DocumentRepository.js";
import {
  getTemporalAnnotationById,
  insertTemporalAnnotation,
  listTemporalAnnotationEvidence,
} from "../enrichment/temporal-annotations/storage.js";
import { cascadeCognitiveStateForDocs } from "./cognitive-state-cascade.js";
import { advanceKnowledgeOwnerSync } from "./knowledge/owner-sync.js";
import { getKnowledgeDependencies, getKnowledgeNode } from "./knowledge/storage.js";
import { isKnowledgeEvidenceReadable } from "./knowledge/storage-source-fence.js";
import {
  createDocAnnotation,
  getDocAnnotation,
  listDocAnnotationEvidence,
} from "./storage/annotations.js";
import { createObservation, getObservation } from "./storage/observations.js";
import {
  createOpenLoop,
  getOpenLoop,
  listOpenLoopLedger,
  SOURCE_DELETION_LEDGER_RUN_ID,
  updateOpenLoop,
} from "./storage/open-loops.js";
import {
  createPersonAnnotation,
  getPersonAnnotation,
  listPersonAnnotationEvidence,
} from "./storage/person-annotations.js";
import type Database from "better-sqlite3";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const SOURCE = "mail:maya@example.com";
const RECEIPT = "The plumber will send the invoice by Friday.";
const OTHER = "The studio confirmed the Saturday booking.";

let path: string;
let db: Db;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function seedDoc(externalId: string, content: string): string {
  const doc: DocumentInput = {
    providerId: "google" as DocumentInput["providerId"],
    sourceId: SOURCE as DocumentInput["sourceId"],
    externalId,
    title: externalId,
    content,
    contentHash: `hash-${externalId}`,
    metadata: { documentType: "email" },
    sourceCreatedAt: "2026-06-30T09:00:00.000Z",
    sourceUpdatedAt: "2026-06-30T09:00:00.000Z",
  };
  upsertDocuments(db, [doc]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

/** One artifact of every kind resting on `doomed`, a few also on `kept`. */
function seedArtifacts(doomed: string, kept: string): void {
  createOpenLoop(
    db,
    {
      id: "olp_invoice",
      createdByRun: "run_1",
      title: "Pay the plumber's invoice",
      description: "The invoice arrives by Friday.",
      confidence: 0.9,
      importance: 0.7,
      docs: [doomed, kept],
      origin: "user",
    },
    NOW,
  );
  createObservation(
    db,
    {
      id: "obs_invoice",
      createdByRun: "run_1",
      summary: "The plumber's invoice is due Friday",
      citations: [doomed],
      relatedLoopIds: ["olp_invoice"],
    },
    NOW,
  );
  // About another document, grounded in both.
  createDocAnnotation(
    db,
    {
      id: "ann_grounded",
      docId: kept,
      claimType: "commitment",
      claimText: "The booking and the invoice fall in the same week.",
      evidenceDocId: doomed,
      evidenceQuote: "send the invoice by Friday",
      additionalEvidence: [{ docId: kept, quote: "confirmed the Saturday booking" }],
      confidence: 0.8,
      claimBasis: "inferred",
      createdByRun: "run_1",
      verificationState: "verified",
      lastVerifiedAt: NOW,
    },
    NOW,
  );
  // About the deleted document itself.
  createDocAnnotation(
    db,
    {
      id: "ann_subject",
      docId: doomed,
      claimType: "summary",
      claimText: "An invoice notice from the plumber.",
      evidenceDocId: doomed,
      evidenceQuote: "send the invoice",
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "run_1",
    },
    NOW,
  );
  createPersonAnnotation(
    db,
    {
      id: "pan_plumber",
      personId: "per_plumber",
      claimType: "role",
      claimText: "Invoices on Fridays.",
      evidenceDocId: doomed,
      evidenceQuote: "send the invoice by Friday",
      confidence: 0.7,
      claimBasis: "quoted",
      createdByRun: "run_1",
    },
    NOW,
  );
  insertTemporalAnnotation(
    db,
    {
      id: "tan_friday",
      intervalStartMs: NOW + 86_400_000,
      intervalEndMs: NOW + 2 * 86_400_000,
      precision: "day",
      canonical: "2026-07-03",
      sentence: "The plumber's invoice is due.",
      documentIds: [doomed],
      evidence: [{ docId: doomed, quote: "by Friday" }],
      loopIds: ["olp_invoice"],
      createdByRun: "run_1",
    },
    NOW,
  );
}

function temporalInvalidatedAt(): number | null {
  return db
    .prepare<
      [],
      { invalidated_at: number | null }
    >("SELECT invalidated_at FROM temporal_annotations WHERE id = 'tan_friday'")
    .get()!.invalidated_at;
}

function reviewQueue(): Array<{ kind: string; owner_id: string; operation: string }> {
  return db
    .prepare<
      [],
      { kind: string; owner_id: string; operation: string }
    >("SELECT kind, owner_id, operation FROM knowledge_owner_changes ORDER BY kind, owner_id")
    .all();
}

/** Every artifact is still there, marked stale, and the document is gone for good. */
function expectKeptForReview(doomed: string, kept: string): void {
  expect(db.prepare("SELECT 1 FROM documents WHERE id = ?").get(doomed)).toBeUndefined();
  expect(isKnowledgeEvidenceReadable(db, doomed)).toBe(false);
  expect(
    db.prepare("SELECT deleted FROM knowledge_source_revisions WHERE document_id = ?").get(doomed),
  ).toEqual({ deleted: 1 });

  // The task stays in the journal exactly as it was, minus the dead pointer.
  const loop = getOpenLoop(db, "olp_invoice")!;
  expect(loop).toMatchObject({ state: "open", origin: "user", title: "Pay the plumber's invoice" });
  expect(loop.docs).toEqual([kept]);
  expect(loop.lastUpdate).toBe(NOW);
  expect(
    listOpenLoopLedger(db, "olp_invoice").filter(
      (entry) => entry.runId === SOURCE_DELETION_LEDGER_RUN_ID,
    ),
  ).toEqual([
    expect.objectContaining({
      note: `Source document ${doomed} was deleted. The loop is kept and queued for review.`,
    }),
  ]);

  const observation = getObservation(db, "obs_invoice")!;
  expect(observation).toMatchObject({ state: "live", citations: [] });

  // Annotations survive unverified; only the atoms citing the deleted document break.
  const grounded = getDocAnnotation(db, "ann_grounded")!;
  expect(grounded).toMatchObject({
    invalidatedAt: null,
    verificationState: "unverified",
    lastVerifiedAt: null,
    evidenceDocId: kept,
  });
  expect(listDocAnnotationEvidence(db, "ann_grounded").map((atom) => atom.evidenceDocId)).toEqual([
    kept,
  ]);
  const subject = db
    .prepare<
      [string],
      { invalidated_at: number | null; verification_state: string }
    >("SELECT invalidated_at, verification_state FROM doc_annotations WHERE id = ?")
    .get("ann_subject");
  expect(subject).toEqual({ invalidated_at: null, verification_state: "unverified" });
  const person = getPersonAnnotation(db, "pan_plumber")!;
  expect(person).toMatchObject({ invalidatedAt: null, verificationState: "unverified" });
  expect(listPersonAnnotationEvidence(db, "pan_plumber")).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT broken_at IS NOT NULL AS broken FROM person_annotation_evidence WHERE annotation_id = ?",
      )
      .all("pan_plumber"),
  ).toEqual([{ broken: 1 }]);

  expect(getTemporalAnnotationById(db, "tan_friday")).not.toBeNull();
  expect(temporalInvalidatedAt()).toBeNull();
  expect(listTemporalAnnotationEvidence(db, "tan_friday")).toEqual([
    expect.objectContaining({ documentId: doomed, brokenAt: expect.any(Number) }),
  ]);

  // Each owner is queued for review; the temporal annotation through its loop.
  expect(reviewQueue()).toEqual([
    { kind: "doc_annotation", owner_id: "ann_grounded", operation: "review" },
    { kind: "doc_annotation", owner_id: "ann_subject", operation: "review" },
    { kind: "loop", owner_id: "olp_invoice", operation: "review" },
    { kind: "observation", owner_id: "obs_invoice", operation: "review" },
    { kind: "person_annotation", owner_id: "pan_plumber", operation: "review" },
  ]);
}

describe("a source deletion keeps what the Brain built on it", () => {
  it("through a sync tombstone", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    db.exec("DELETE FROM knowledge_owner_changes");

    expect(deleteDocuments(db, "google", SOURCE, ["invoice"])).toEqual([doomed]);
    expectKeptForReview(doomed, kept);

    // A repeated pass finds nothing left to mark.
    expect(deleteDocuments(db, "google", SOURCE, ["invoice"])).toEqual([]);
    expectKeptForReview(doomed, kept);
  });

  it("through the snapshot-absence sweep", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    db.exec("DELETE FROM knowledge_owner_changes");

    expect(deleteDocumentsByIds(db, [doomed])).toEqual([doomed]);
    expectKeptForReview(doomed, kept);
  });

  it("through an explicit delete", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    db.exec("DELETE FROM knowledge_owner_changes");

    expect(deleteDocumentForUser(db, "google", SOURCE, "invoice")).toEqual([doomed]);
    expectKeptForReview(doomed, kept);
  });

  it("through a source removal and its cognitive-state cascade", async () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    db.exec("DELETE FROM knowledge_owner_changes");
    // The removal sweep hands the cascade the ids, then wipes the source.
    const gate = directWriteGate(db);
    await cascadeCognitiveStateForDocs(db, gate, [doomed, kept]);
    deleteAllBySource(db, SOURCE);
    await cascadeCognitiveStateForDocs(db, gate, [doomed, kept]);

    expect(getOpenLoop(db, "olp_invoice")).toMatchObject({ state: "open", docs: [] });
    expect(isKnowledgeEvidenceReadable(db, doomed)).toBe(false);
    expect(getDocAnnotation(db, "ann_grounded")?.verificationState).toBe("unverified");
    expect(getObservation(db, "obs_invoice")).toMatchObject({ state: "live" });
    for (const id of ["ann_grounded", "ann_subject"])
      expect(db.prepare("SELECT invalidated_at FROM doc_annotations WHERE id = ?").get(id)).toEqual(
        { invalidated_at: null },
      );
    expect(getPersonAnnotation(db, "pan_plumber")?.invalidatedAt).toBeNull();
    expect(getTemporalAnnotationById(db, "tan_friday")).not.toBeNull();
    expect(temporalInvalidatedAt()).toBeNull();
    expect(reviewQueue().map((row) => row.operation)).toEqual([
      "review",
      "review",
      "review",
      "review",
      "review",
    ]);
  });
});

describe("a repeated pass", () => {
  it("finds nothing left to mark once the review has been drained", async () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    deleteDocuments(db, "google", SOURCE, ["invoice"]);
    advanceKnowledgeOwnerSync(db, 50, NOW);
    expect(reviewQueue()).toEqual([]);

    // The post-delete cascade a sync tombstone also runs.
    await cascadeCognitiveStateForDocs(db, directWriteGate(db), [doomed]);
    expect(reviewQueue()).toEqual([]);
    expect(
      listOpenLoopLedger(db, "olp_invoice").filter(
        (entry) => entry.runId === SOURCE_DELETION_LEDGER_RUN_ID,
      ),
    ).toHaveLength(1);
  });
});

describe("a bulk wipe whose review drains before the documents go", () => {
  it("queues the owner again once its node still cites the deleted document", async () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    advanceKnowledgeOwnerSync(db, 50, NOW);
    const gate = directWriteGate(db);

    // The removal sweep reviews before the rows go, and owner sync drains in between.
    await cascadeCognitiveStateForDocs(db, gate, [doomed]);
    advanceKnowledgeOwnerSync(db, 50, NOW + 1);
    expect(getKnowledgeDependencies(db, "olp_invoice").map((dep) => dep.ref)).toContain(
      `source:${doomed}`,
    );

    deleteAllBySource(db, SOURCE);
    await cascadeCognitiveStateForDocs(db, gate, [doomed]);
    expect(reviewQueue().find((row) => row.owner_id === "olp_invoice")?.operation).toBe("review");
    advanceKnowledgeOwnerSync(db, 50, NOW + 2);
    expect(getKnowledgeDependencies(db, "olp_invoice").map((dep) => dep.ref)).not.toContain(
      `source:${doomed}`,
    );
    expect(getKnowledgeNode(db, "olp_invoice")?.validity).toBe("stale");
  });
});

describe("store details", () => {
  it("promotes a person fact's surviving atom and keeps it unverified", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    createPersonAnnotation(
      db,
      {
        id: "pan_two",
        personId: "per_plumber",
        claimType: "schedule",
        claimText: "works on fridays and saturdays.",
        evidenceDocId: doomed,
        evidenceQuote: "by Friday",
        additionalEvidence: [{ docId: kept, quote: "Saturday booking" }],
        confidence: 0.7,
        claimBasis: "inferred",
        createdByRun: "run_1",
      },
      NOW,
    );
    deleteDocuments(db, "google", SOURCE, ["invoice"]);
    expect(getPersonAnnotation(db, "pan_two")).toMatchObject({
      invalidatedAt: null,
      verificationState: "unverified",
      evidenceDocId: kept,
    });
  });

  it("breaks the atoms of a temporal annotation linked to no loop, and queues nothing for it", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    insertTemporalAnnotation(
      db,
      {
        id: "tan_alone",
        intervalStartMs: NOW,
        intervalEndMs: NOW,
        precision: "day",
        canonical: "2026-07-02",
        sentence: "The invoice arrives.",
        documentIds: [doomed],
        evidence: [{ docId: doomed, quote: "by Friday" }],
        createdByRun: "run_1",
      },
      NOW,
    );
    db.exec("DELETE FROM knowledge_owner_changes");
    deleteDocuments(db, "google", SOURCE, ["invoice"]);
    expect(listTemporalAnnotationEvidence(db, "tan_alone")).toEqual([
      expect.objectContaining({ brokenAt: expect.any(Number) }),
    ]);
    expect(
      db.prepare("SELECT invalidated_at FROM temporal_annotations WHERE id = 'tan_alone'").get(),
    ).toEqual({ invalidated_at: null });
    expect(reviewQueue()).toEqual([]);
  });
});

describe("the queued review", () => {
  it("projects the owner without the deleted source, marks its node stale and queues maintenance", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    const kept = seedDoc("booking", OTHER);
    seedArtifacts(doomed, kept);
    advanceKnowledgeOwnerSync(db, 50, NOW);
    const before = getKnowledgeNode(db, "olp_invoice")!;
    expect(
      getKnowledgeDependencies(db, "olp_invoice")
        .map((dep) => dep.ref)
        .sort(),
    ).toEqual([`source:${doomed}`, `source:${kept}`].sort());

    deleteDocuments(db, "google", SOURCE, ["invoice"]);
    // The owner's own later activity never downgrades the pending review.
    updateOpenLoop(db, "olp_invoice", { importance: 0.8 }, NOW + 1);
    expect(reviewQueue().find((row) => row.owner_id === "olp_invoice")?.operation).toBe("review");

    const synced = advanceKnowledgeOwnerSync(db, 50, NOW + 2);
    expect(synced.deferred).toBe(0);
    expect(synced.pending).toBe(false);
    for (const id of ["olp_invoice", "obs_invoice", "ann_grounded", "ann_subject", "pan_plumber"]) {
      const node = getKnowledgeNode(db, id)!;
      expect(node.validity).toBe("stale");
      expect(getKnowledgeDependencies(db, id).map((dep) => dep.ref)).not.toContain(
        `source:${doomed}`,
      );
      expect(
        db
          .prepare(
            "SELECT reason, input_revision FROM knowledge_work WHERE subject_kind='node' AND subject_id=? AND status='pending'",
          )
          .get(id),
      ).toEqual({ reason: "change", input_revision: String(node.revision) });
    }
    expect(getKnowledgeNode(db, "olp_invoice")!.revision).toBeGreaterThan(before.revision);
    expect(getKnowledgeDependencies(db, "olp_invoice").map((dep) => dep.ref)).toEqual([
      `source:${kept}`,
    ]);
    // Nothing was erased on the way.
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_node_tombstones").get()).toEqual({
      n: 0,
    });
  });

  it("projects an owner whose every cited source is gone as unsupported text", () => {
    const doomed = seedDoc("invoice", RECEIPT);
    createOpenLoop(
      db,
      {
        id: "olp_alone",
        createdByRun: "run_1",
        title: "Reply to the plumber",
        confidence: 0.9,
        importance: 0.5,
        docs: [doomed],
        origin: "user",
      },
      NOW,
    );
    advanceKnowledgeOwnerSync(db, 50, NOW);
    deleteDocuments(db, "google", SOURCE, ["invoice"]);

    expect(advanceKnowledgeOwnerSync(db, 50, NOW + 1)).toMatchObject({
      deferred: 0,
      pending: false,
    });
    expect(getOpenLoop(db, "olp_alone")).toMatchObject({ state: "open", docs: [] });
    expect(getKnowledgeNode(db, "olp_alone")).toMatchObject({
      validity: "stale",
      plainText: "Reply to the plumber",
    });
    expect(getKnowledgeDependencies(db, "olp_alone")).toEqual([]);
  });
});
