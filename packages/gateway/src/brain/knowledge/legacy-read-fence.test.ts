// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { likeSearchDocuments } from "../../search/like-search.js";
import { resolveBrainSettings } from "../config.js";
import { buildOpenLoopDocumentInput } from "../open-loop-source/document-projection.js";
import {
  buildDueSoonDeltaPrime,
  buildSourceDeltaPrime,
  buildSynthesisDeltaPrime,
} from "../steward/delta-prime.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  getActiveLoopTitle,
  getOpenLoop,
  listLoopsForDoc,
  listLoopsForPerson,
  listOpenLoopLedger,
  listOpenLoops,
  loopPeople,
  searchOpenLoopsLexical,
} from "../storage/open-loops.js";
import {
  createObservation,
  findOpenObservationsForLoops,
  getObservation,
  listObservations,
  listObservationsForLoop,
  listOpenObservations,
} from "../storage/observations.js";
import {
  createDocAnnotation,
  getDocAnnotation,
  listDocAnnotationEvidence,
  listLiveAnnotationsForDoc,
  listLiveSameClaimTypeAnnotationsForDoc,
  listRecentLiveAnnotations,
} from "../storage/annotations.js";
import {
  createPersonAnnotation,
  getPersonAnnotation,
  listLivePersonAnnotationsForPerson,
  listLiveSameClaimTypePersonAnnotations,
  listPersonAnnotationEvidence,
  listRecentLivePersonAnnotations,
} from "../storage/person-annotations.js";
import {
  countLiveDependentsForAnnotation,
  listConsumedPriorsForDependent,
  listLiveDependentsForAnnotation,
  recordConsumptionEdges,
} from "../storage/consumption-edges.js";
import {
  listRetiredLoops,
  retireLoop,
  searchRetiredLoopsLexical,
} from "../storage/retired-loops.js";
import {
  readKnowledgeOwner,
  saveOwnedKnowledgeNode,
  type KnowledgeOwnerKind,
} from "./owner-adapters.js";
import { isKnowledgeDocumentReadable } from "./retrieval-fence.js";
import { knowledgeNodeFence, isKnowledgeOwnerReadable } from "./storage-fence.js";
import { getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
let original: string;
let newer: string;
const NOW = Date.parse("2026-02-01T12:00:00Z");
const PRIVATE_TEXT = "The workshop uses violet lanterns.";

function sourceDocument(externalId: string, content: string): string {
  upsertDocuments(db, [
    {
      providerId: ProviderId("system"),
      sourceId: SourceId(externalId === "newer" ? "fixture-private-notes" : "fixture-notes"),
      externalId,
      title: "Workshop plan",
      content,
      contentHash: externalId,
      sourceCreatedAt: "2026-02-01T10:00:00Z",
      sourceUpdatedAt: "2026-02-01T10:00:00Z",
      metadata: {},
    },
  ]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id=?")
    .get(externalId)!.id;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-legacy-read-fence-"));
  db = createDatabase(join(directory, "gateway.db"));
  original = sourceDocument("original", `The workshop is scheduled. ${PRIVATE_TEXT}`);
  newer = sourceDocument("newer", PRIVATE_TEXT);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function saveOwner(kind: KnowledgeOwnerKind, id: string): void {
  const owner = readKnowledgeOwner(db, kind, id);
  const claim = `<claim id="detail" refs="source:${newer}">${PRIVATE_TEXT}</claim>`;
  saveOwnedKnowledgeNode(
    db,
    {
      node: {
        id,
        ownerId: id,
        kind,
        title: owner.title,
        // Observation prose is never rewritten by synthesis; its node can
        // only gain provenance over the unchanged text.
        markdown:
          kind === "observation"
            ? `<claim id="detail" refs="source:${newer}">${owner.markdown}</claim>`
            : claim,
        expectedRevision: 0,
        inputVersions: { [`source:${newer}`]: "newer" },
      },
      ownerVersion: owner.versionFingerprint,
    },
    NOW,
  );
}

function seedOwners(): string {
  for (const [id, time] of [
    ["visible-loop", NOW - 100],
    ["hidden-loop", NOW],
  ] as const) {
    createOpenLoop(
      db,
      {
        id,
        title: "Prepare workshop",
        description: "The workshop is scheduled.",
        createdByRun: "run",
        confidence: 0.7,
        importance: 0.5,
        docs: [original],
        actors: ["fictional-person"],
      },
      time,
    );
  }
  appendOpenLoopLedger(db, "hidden-loop", { runId: "run", note: PRIVATE_TEXT }, NOW);
  createObservation(
    db,
    {
      id: "visible-observation",
      summary: "Workshop reminder",
      why: "The workshop is scheduled.",
      createdByRun: "run",
      citations: [original],
    },
    NOW - 100,
  );
  createObservation(
    db,
    {
      id: "hidden-observation",
      summary: "Workshop reminder",
      why: "The workshop is scheduled.",
      createdByRun: "run",
      citations: [original],
      relatedLoopIds: ["visible-loop"],
    },
    NOW,
  );
  const annotation = {
    claimType: "detail",
    claimText: "The workshop is scheduled.",
    evidenceDocId: original,
    evidenceQuote: "The workshop is scheduled.",
    confidence: 0.7,
    claimBasis: "quoted" as const,
    createdByRun: "run",
  };
  createDocAnnotation(db, { ...annotation, id: "visible-doc", docId: original }, NOW - 100);
  createDocAnnotation(db, { ...annotation, id: "hidden-doc", docId: original }, NOW);
  createPersonAnnotation(
    db,
    { ...annotation, id: "visible-person", personId: "fictional-person" },
    NOW - 100,
  );
  createPersonAnnotation(
    db,
    {
      ...annotation,
      id: "hidden-person",
      personId: "fictional-person",
      claimText: PRIVATE_TEXT,
      evidenceQuote: PRIVATE_TEXT,
    },
    NOW,
  );
  for (const [kind, id] of [
    ["loop", "hidden-loop"],
    ["observation", "hidden-observation"],
    ["doc_annotation", "hidden-doc"],
    ["person_annotation", "hidden-person"],
  ] as const)
    saveOwner(kind, id);
  // No legacy owner attachment points at the new source that supplied its prose.
  expect(getOpenLoop(db, "hidden-loop")!.docs).toEqual([original]);
  expect(getObservation(db, "hidden-observation")!.citations).toEqual([original]);
  expect(getDocAnnotation(db, "hidden-doc")!.evidenceDocId).toBe(original);
  expect(getPersonAnnotation(db, "hidden-person")!.evidenceDocId).toBe(original);
  const loop = getOpenLoop(db, "hidden-loop")!;
  retireLoop(db, loop, "done", NOW);
  upsertDocuments(db, [buildOpenLoopDocumentInput(loop, [])]);
  const mirror = db
    .prepare<
      [string],
      { id: string }
    >("SELECT id FROM documents WHERE source_id='open-loops' AND external_id=?")
    .get(loop.id)!.id;
  recordConsumptionEdges(
    db,
    [
      {
        priorStore: "doc",
        priorAnnotationId: "visible-doc",
        dependentKind: "loop",
        dependentId: "hidden-loop",
        runId: "run",
      },
      {
        priorStore: "doc",
        priorAnnotationId: "hidden-doc",
        dependentKind: "loop",
        dependentId: "visible-loop",
        runId: "run",
      },
    ],
    NOW,
  );
  return mirror;
}

function assertHidden(mirror: string): void {
  // Physical cleanup has deliberately not run: reads must already suppress prose.
  expect(db.prepare("SELECT description FROM open_loops WHERE id='hidden-loop'").get()).toEqual({
    description: PRIVATE_TEXT,
  });
  expect(getOpenLoop(db, "hidden-loop")).toBeNull();
  expect(getActiveLoopTitle(db, "hidden-loop")).toBeNull();
  expect(listOpenLoopLedger(db, "hidden-loop")).toEqual([]);
  expect(loopPeople(db, "hidden-loop")).toEqual({ actors: [], involved: [] });
  expect(listOpenLoops(db, { limit: 1 }).map((row) => row.id)).toEqual(["visible-loop"]);
  expect(listLoopsForDoc(db, original).map((row) => row.id)).toEqual(["visible-loop"]);
  expect(listLoopsForPerson(db, "fictional-person").map((row) => row.id)).toEqual(["visible-loop"]);
  expect(searchOpenLoopsLexical(db, "violet")).toEqual([]);
  expect(listRetiredLoops(db)).toEqual([]);
  expect(searchRetiredLoopsLexical(db, "violet")).toEqual([]);
  expect(getDocAnnotation(db, "hidden-doc")).toBeNull();
  expect(listDocAnnotationEvidence(db, "hidden-doc")).toEqual([]);
  expect(listLiveAnnotationsForDoc(db, original, 1).map((row) => row.id)).toEqual(["visible-doc"]);
  expect(
    listLiveSameClaimTypeAnnotationsForDoc(db, original, "detail", { limit: 1 }).map(
      (row) => row.id,
    ),
  ).toEqual(["visible-doc"]);
  expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 1 }).map((row) => row.id)).toEqual([
    "visible-doc",
  ]);
  expect(getPersonAnnotation(db, "hidden-person")).toBeNull();
  expect(listPersonAnnotationEvidence(db, "hidden-person")).toEqual([]);
  expect(
    listLivePersonAnnotationsForPerson(db, "fictional-person", 1).map((row) => row.id),
  ).toEqual(["visible-person"]);
  expect(
    listLiveSameClaimTypePersonAnnotations(db, "fictional-person", "detail", { limit: 1 }).map(
      (row) => row.id,
    ),
  ).toEqual(["visible-person"]);
  expect(
    listRecentLivePersonAnnotations(db, { sinceMs: 0, limit: 1 }).map((row) => row.id),
  ).toEqual(["visible-person"]);
  expect(getObservation(db, "hidden-observation")).toBeNull();
  expect(listObservations(db, { limit: 1 }).map((row) => row.id)).toEqual(["visible-observation"]);
  expect(listObservations(db, { createdByRun: "run" }).map((row) => row.id)).toEqual([
    "visible-observation",
  ]);
  expect(listObservationsForLoop(db, "visible-loop")).toEqual([]);
  expect(findOpenObservationsForLoops(db, ["visible-loop"])).toEqual([]);
  expect(listOpenObservations(db).map((row) => row.id)).toEqual(["visible-observation"]);
  expect(listLiveDependentsForAnnotation(db, "doc", "visible-doc")).toEqual([]);
  expect(countLiveDependentsForAnnotation(db, "doc", "visible-doc")).toBe(0);
  expect(listConsumedPriorsForDependent(db, "loop", "visible-loop")).toEqual([
    expect.objectContaining({ live: false, claimText: null, claimType: null }),
  ]);
  expect(isKnowledgeDocumentReadable(db, mirror)).toBe(false);
  expect(
    likeSearchDocuments(db, { query: "violet", limit: 10, hiddenSourceIds: [] }).map(
      (row) => row.id,
    ),
  ).not.toContain(mirror);
  const cfg = resolveBrainSettings();
  for (const prime of [
    buildSourceDeltaPrime(db, {
      sourceId: "fixture-notes",
      fromMs: NOW - 1000,
      toMs: NOW,
      now: NOW,
      cfg,
    }),
    buildDueSoonDeltaPrime(db, { now: NOW, cfg }),
    buildSynthesisDeltaPrime(db, { now: NOW, cfg }),
  ]) {
    expect(prime).not.toContain("hidden-loop");
    expect(prime).not.toContain("hidden-observation");
    expect(prime).not.toContain("violet");
  }
}

it("hides legacy owner prose on a new source tombstone before bounded physical deletion", () => {
  const mirror = seedOwners();
  db.prepare(
    `INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES(?,'',1,?)
    ON CONFLICT(document_id) DO UPDATE SET deleted=1`,
  ).run(newer, NOW + 1);
  assertHidden(mirror);
});

it("hides legacy owner prose while an ancestor source purge is queued", () => {
  const mirror = seedOwners();
  db.prepare(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','source',?,'deleted',?)",
  ).run(newer, NOW + 1);
  assertHidden(mirror);
});

it("denies tombstoned owners after their knowledge row is removed, without hiding unrelated legacy rows", () => {
  createOpenLoop(
    db,
    {
      id: "removed-owner",
      title: "Workshop",
      description: "Workshop",
      createdByRun: "run",
      confidence: 0.7,
      importance: 0.5,
    },
    NOW,
  );
  expect(getOpenLoop(db, "removed-owner")).not.toBeNull();
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES(?,?)").run(
    "removed-owner",
    NOW,
  );
  expect(getOpenLoop(db, "removed-owner")).toBeNull();
  expect(isKnowledgeOwnerReadable(db, "unrelated")).toBe(true);
});

it("projects stale ancestors through support but preserves context navigation and permits self repair", () => {
  saveKnowledgeNode(
    db,
    {
      id: "ancestor",
      kind: "wiki",
      title: "Workshop",
      markdown: "Workshop context",
      expectedRevision: 0,
      inputVersions: {},
    },
    NOW,
  );
  for (const [id, relation] of [
    ["supported", "supports"],
    ["navigation", "context"],
  ] as const) {
    saveKnowledgeNode(
      db,
      {
        id,
        kind: "wiki",
        title: "Workshop",
        markdown: '<claim id="detail" refs="wiki:ancestor">Workshop</claim>',
        expectedRevision: 0,
        inputVersions: { "wiki:ancestor": 1 },
        claims: [{ id: "detail", relations: { "wiki:ancestor": relation } }],
      },
      NOW,
    );
  }
  db.prepare("UPDATE knowledge_nodes SET validity='stale' WHERE id='ancestor'").run();
  expect(knowledgeNodeFence(db, "supported").stale).toBe(true);
  expect(knowledgeNodeFence(db, "navigation").stale).toBe(false);
  expect(knowledgeNodeFence(db, "ancestor").stale).toBe(false);
  db.prepare("UPDATE knowledge_nodes SET validity='current' WHERE id='ancestor'").run();
  expect(knowledgeNodeFence(db, "supported").stale).toBe(false);
});

it("fences attached observations and their knowledge nodes while a loop privacy purge is pending", () => {
  seedOwners();
  for (const id of ["attached-owned", "attached-legacy"]) {
    createObservation(
      db,
      {
        id,
        summary: "Workshop follow-up",
        why: PRIVATE_TEXT,
        createdByRun: "run",
        citations: [original],
        relatedLoopIds: ["hidden-loop", "visible-loop"],
      },
      NOW,
    );
    expect(getObservation(db, id)).not.toBeNull();
  }
  saveKnowledgeNode(
    db,
    {
      id: "attached-owned",
      kind: "observation",
      ownerId: "attached-owned",
      title: "Workshop follow-up",
      markdown: `<claim id="detail" refs="source:${original}">The workshop is scheduled.</claim>`,
      expectedRevision: 0,
      inputVersions: { [`source:${original}`]: "original" },
    },
    NOW,
  );
  expect(getKnowledgeNode(db, "attached-owned")).not.toBeNull();
  db.prepare(
    `INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES(?,'',1,?)
    ON CONFLICT(document_id) DO UPDATE SET deleted=1`,
  ).run(newer, NOW + 1);
  expect(getObservation(db, "attached-owned")).toBeNull();
  expect(getObservation(db, "attached-legacy")).toBeNull();
  expect(listObservationsForLoop(db, "visible-loop")).toEqual([]);
  expect(findOpenObservationsForLoops(db, ["visible-loop"])).toEqual([]);
  expect(listOpenObservations(db).map((row) => row.id)).toEqual(["visible-observation"]);
  expect(getKnowledgeNode(db, "attached-owned")).toBeNull();
});

it("honors a source-wide removal tombstone before document deletion starts", () => {
  const mirror = seedOwners();
  db.prepare("INSERT INTO removed_sources(id,removed_at,cleanup_done_at) VALUES(?,?,NULL)").run(
    "fixture-private-notes",
    NOW + 1,
  );
  expect(db.prepare("SELECT 1 FROM documents WHERE id=?").get(newer)).toBeDefined();
  assertHidden(mirror);
});
