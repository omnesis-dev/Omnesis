// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search fences its hits through one batched read on the real io worker. Over a
 * store holding every kind of knowledge document search can meet, each verdict
 * equals the per-hit rule applied through the full node fence on a direct
 * handle, so the worker hides exactly the documents a main-thread fence hides.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../../scheduler/io-ops.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { buildKnowledgeDocumentInput } from "./mirror.js";
import {
  isKnowledgeDocumentReadable,
  knowledgeDocumentsReadable,
  type KnowledgeDocumentRef,
  type KnowledgeReadabilityReads,
} from "./retrieval-fence.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { isKnowledgeOwnerReadable } from "./storage-fence.js";
import { getKnowledgeNode } from "./storage-read.js";
import { saveKnowledgeNode } from "./storage.js";
import { retireKnowledgeWikiPage } from "./wiki-retirement.js";
import type { KnowledgeNode } from "./types.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let worker: KnowledgeReadabilityReads;

/**
 * Reference oracle: the readability rule applied one hit at a time, reading
 * each knowledge node through `getKnowledgeNode` and so always through the full fence.
 */
function perHitReadable(documentId: string, sourceId?: string): boolean {
  const source =
    db
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id=?")
      .get(documentId)?.source_id ?? sourceId;
  if (source === undefined) return false;
  if (
    db
      .prepare("SELECT 1 FROM knowledge_source_revisions WHERE document_id=? AND deleted=1")
      .get(documentId)
  )
    return false;
  if (db.prepare("SELECT 1 FROM removed_sources WHERE id=?").get(source)) return false;
  const generated = (id: string) => id === KNOWLEDGE_SOURCE_ID || id === OPEN_LOOP_SOURCE_ID;
  if (sourceId !== undefined && sourceId !== source && (generated(sourceId) || generated(source)))
    return false;
  if (!generated(source)) return true;
  const row = db
    .prepare<[string], { source_id: string; external_id: string; metadata: string }>(
      "SELECT source_id,external_id,metadata FROM documents WHERE id=?",
    )
    .get(documentId);
  if (!row) return false;
  if (row.source_id === OPEN_LOOP_SOURCE_ID)
    return (
      !!db.prepare("SELECT 1 FROM open_loops WHERE id=?").get(row.external_id) &&
      isKnowledgeOwnerReadable(db, row.external_id)
    );
  if (row.source_id !== KNOWLEDGE_SOURCE_ID) return true;
  const node = getKnowledgeNode(db, row.external_id);
  if (!node) return false;
  try {
    const metadata = JSON.parse(row.metadata) as {
      extra?: { knowledgeRevision?: unknown; knowledgeValidity?: unknown };
    };
    return (
      metadata.extra?.knowledgeRevision === node.revision &&
      metadata.extra?.knowledgeValidity === node.validity
    );
  } catch {
    return false;
  }
}

function insertDocument(
  id: string,
  sourceId: string,
  externalId: string,
  metadata: string,
  contentHash = "v1",
): void {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,stream_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'fixture',?,?,?,'Workshop','The workshop moved to Friday.',?,?,'2026-02-01','2026-02-01','2026-02-01','2026-02-01')`,
  ).run(id, sourceId, externalId, id, contentHash, metadata);
}

/** A mirror of `node`, optionally carrying a different revision or validity than the node. */
function mirror(id: string, node: KnowledgeNode, extra: Record<string, unknown> = {}): void {
  const projection = buildKnowledgeDocumentInput(node);
  insertDocument(
    id,
    KNOWLEDGE_SOURCE_ID,
    node.id,
    JSON.stringify({
      ...projection.metadata,
      extra: { ...projection.metadata.extra, ...extra },
    }),
  );
}

function page(id: string, cites: string, now: number): KnowledgeNode {
  return saveKnowledgeNode(
    db,
    {
      id,
      kind: "wiki",
      title: `Workshop plan ${id}`,
      markdown: `<claim id="date" refs="source:${cites}">The workshop moved to Friday.</claim>`,
      expectedRevision: 0,
      inputVersions: { [`source:${cites}`]: "v1" },
    },
    now,
  ).node;
}

/** Every ref search can meet, with the source id its index entry carries. */
function seed(): KnowledgeDocumentRef[] {
  insertDocument("evidence", "fixture-notes", "evidence", "{}");
  insertDocument("evidence-moving", "fixture-notes", "evidence-moving", "{}");
  insertDocument("evidence-removed", "fixture-removed", "evidence-removed", "{}");
  db.prepare("INSERT INTO removed_sources(id,removed_at) VALUES('fixture-removed',1)").run();

  // Readable: its mirror carries the node's revision and validity.
  mirror("mirror-current", page("current", "evidence", 100));
  // A revision the mirror has not caught up with.
  const revised = page("revised", "evidence", 100);
  mirror("mirror-revised", revised);
  saveKnowledgeNode(
    db,
    {
      id: revised.id,
      kind: revised.kind,
      title: revised.title,
      markdown: revised.markdown,
      expectedRevision: revised.revision,
      inputVersions: { "source:evidence": "v1" },
      metadata: { importance: 0.9 },
    },
    110,
  );
  // A cited source changed after the node read it: stored current, effectively
  // stale. A mirror written as current is unreadable; one written stale is not.
  const drifted = page("drifted", "evidence-moving", 100);
  mirror("mirror-drifted-current", drifted);
  mirror("mirror-drifted-stale", drifted, { knowledgeValidity: "stale" });
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='evidence-moving'").run();
  // Stored stale: only a stale mirror is readable.
  const stored = page("stored-stale", "evidence", 100);
  db.prepare("UPDATE knowledge_nodes SET validity='stale' WHERE id='stored-stale'").run();
  mirror("mirror-stored-stale", { ...stored, validity: "stale" });
  mirror("mirror-stored-stale-as-current", stored);
  // Stored stale and hidden.
  const hiddenStale = page("stored-stale-tombstoned", "evidence", 100);
  db.prepare(
    "UPDATE knowledge_nodes SET validity='stale' WHERE id='stored-stale-tombstoned'",
  ).run();
  mirror("mirror-stored-stale-tombstoned", { ...hiddenStale, validity: "stale" });
  db.prepare(
    "INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('stored-stale-tombstoned',120)",
  ).run();
  // Stale where the node is current and nothing it read changed.
  mirror("mirror-current-as-stale", page("current-node", "evidence", 100), {
    knowledgeValidity: "stale",
  });
  // Hidden: tombstoned, and being purged.
  mirror("mirror-tombstoned", page("tombstoned", "evidence", 100));
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('tombstoned',120)").run();
  mirror("mirror-purging", page("purging", "evidence", 100));
  db.prepare(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','purging','1',120)",
  ).run();
  // Retired: the mirror of the page before retirement, and one of the retired revision.
  const retiring = page("retiring", "evidence", 100);
  mirror("mirror-retiring", retiring);
  const retired = retireKnowledgeWikiPage(
    db,
    {
      id: retiring.id,
      expectedRevision: retiring.revision,
      reason: "Superseded by the venue page.",
    },
    undefined,
    130,
  );
  mirror("mirror-retired", retiring, {
    knowledgeRevision: retired.revision,
    knowledgeValidity: "stale",
  });
  mirror("mirror-malformed", page("malformed", "evidence", 100));
  // Metadata that is JSON but no object: reading it throws, which reads as unreadable.
  db.prepare("UPDATE documents SET metadata='null' WHERE id='mirror-malformed'").run();
  mirror("mirror-orphan", { ...page("orphan-template", "evidence", 100), id: "no-such-node" });

  createOpenLoop(
    db,
    {
      id: "loop-open",
      createdByRun: "run",
      title: "Confirm the room",
      state: "open",
      importance: 0.4,
      confidence: 0.8,
    },
    100,
  );
  insertDocument("loop-doc", OPEN_LOOP_SOURCE_ID, "loop-open", "{}");
  insertDocument("loop-doc-gone", OPEN_LOOP_SOURCE_ID, "loop-gone", "{}");

  const ids = db
    .prepare<[], { id: string; source_id: string }>(
      "SELECT id,source_id FROM documents ORDER BY id",
    )
    .all();
  return [
    ...ids.map((row) => ({ documentId: row.id, sourceId: row.source_id })),
    ...ids.map((row) => ({ documentId: row.id })),
    // Index metadata that lags a move across the generated/ordinary boundary.
    { documentId: "mirror-current", sourceId: "fixture-notes" },
    { documentId: "evidence", sourceId: KNOWLEDGE_SOURCE_ID },
    // Ordinary moves keep the live identity.
    { documentId: "evidence", sourceId: "fixture-mail" },
    // Missing rows: ordinary hits fall back to their hint, generated ones never do.
    { documentId: "missing", sourceId: "fixture-notes" },
    { documentId: "missing", sourceId: "fixture-removed" },
    { documentId: "missing", sourceId: KNOWLEDGE_SOURCE_ID },
    { documentId: "missing" },
    // A repeated ref is judged once and answered in place.
    { documentId: "mirror-current", sourceId: KNOWLEDGE_SOURCE_ID },
  ];
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  worker = ioGateFromScheduler(scheduler);
});

afterEach(async () => {
  await scheduler.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

it("fences every hit on the worker exactly as the per-hit rule does on a direct handle", async () => {
  const refs = seed();
  const expected = refs.map((ref) => perHitReadable(ref.documentId, ref.sourceId));
  const verdict = (id: string, sourceId?: string) =>
    expected[refs.findIndex((ref) => ref.documentId === id && ref.sourceId === sourceId)];

  // The fixture reaches every outcome the rule distinguishes.
  expect(verdict("evidence", "fixture-notes")).toBe(true);
  expect(verdict("evidence-removed", "fixture-removed")).toBe(false);
  expect(verdict("mirror-current", KNOWLEDGE_SOURCE_ID)).toBe(true);
  expect(verdict("mirror-revised", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-drifted-current", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-drifted-stale", KNOWLEDGE_SOURCE_ID)).toBe(true);
  expect(verdict("mirror-stored-stale", KNOWLEDGE_SOURCE_ID)).toBe(true);
  expect(verdict("mirror-stored-stale-as-current", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-stored-stale-tombstoned", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-current-as-stale", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-tombstoned", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-purging", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-retiring", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-retired", KNOWLEDGE_SOURCE_ID)).toBe(true);
  expect(verdict("mirror-malformed", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-orphan", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("loop-doc", OPEN_LOOP_SOURCE_ID)).toBe(true);
  expect(verdict("loop-doc-gone", OPEN_LOOP_SOURCE_ID)).toBe(false);
  expect(verdict("mirror-current", "fixture-notes")).toBe(false);
  expect(verdict("evidence", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("evidence", "fixture-mail")).toBe(true);
  expect(verdict("missing", "fixture-notes")).toBe(true);
  expect(verdict("missing", KNOWLEDGE_SOURCE_ID)).toBe(false);
  expect(verdict("missing", undefined)).toBe(false);

  expect(await worker.knowledgeDocumentsReadable(refs)).toEqual(expected);
  expect(knowledgeDocumentsReadable(db, refs)).toEqual(expected);
  expect(refs.map((ref) => isKnowledgeDocumentReadable(db, ref.documentId, ref.sourceId))).toEqual(
    expected,
  );
});

it("answers an empty batch without a read", async () => {
  expect(await worker.knowledgeDocumentsReadable([])).toEqual([]);
});
