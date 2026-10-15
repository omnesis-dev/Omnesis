// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { createObservation } from "../storage/observations.js";
import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { getKnowledgeDependencies, getKnowledgeNode } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeUpkeep } from "./engine-upkeep.js";
import {
  attemptLegacyOwnerConversion,
  legacyConversionRetryDelay,
  legacyOwnerConversionFingerprint,
  readLegacyConversionStatus,
} from "./owner-conversion.js";
import type { KnowledgeEngineDeps } from "./engine.js";

const HOUR = 3_600_000;
let db: Database.Database;

function addDocument(id: string, sourceId = "notes"): void {
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?)").run(
    id,
    "test",
    sourceId,
    id,
    "Quarterly budget review moves to Thursday.",
    `hash-${id}`,
  );
}

function addDocAnnotation(id: string, evidenceDocId: string): void {
  db.prepare(
    `INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    evidenceDocId,
    "schedule",
    "The budget review is on Thursday.",
    evidenceDocId,
    "moves to Thursday",
    0.7,
    "run",
    1,
  );
}

function deferral(ownerId: string) {
  return db
    .prepare<
      [string],
      { reason: string; attempts: number; retry_at: number; input_fingerprint: string }
    >("SELECT reason,attempts,retry_at,input_fingerprint FROM knowledge_conversion_deferrals WHERE owner_id=?")
    .get(ownerId);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,provider_id TEXT,source_id TEXT,external_id TEXT,content TEXT,content_hash TEXT)",
  );
  createBriefsStorageTables(db);
  createAnnotationStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());

it("converts with the readable evidence when other citations are generated mirrors or deleted", () => {
  addDocument("budget-memo");
  addDocument("loop-mirror", OPEN_LOOP_SOURCE_ID);
  addDocument("erased-thread");
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('erased-thread','hash-erased-thread',1,1)",
  ).run();
  createObservation(
    db,
    {
      id: "budget-note",
      createdByRun: "run",
      summary: "Budget review moved",
      why: "It now falls on Thursday.",
      citations: ["budget-memo", "loop-mirror", "erased-thread"],
    },
    1,
  );
  expect(attemptLegacyOwnerConversion(db, "observation", "budget-note", 2)).toEqual({
    outcome: "converted",
  });
  expect(getKnowledgeDependencies(db, "budget-note").map((dep) => dep.ref)).toEqual([
    "source:budget-memo",
  ]);
});

it("converts an owner that cites only generated mirrors without inventing provenance", () => {
  addDocument("loop-mirror", OPEN_LOOP_SOURCE_ID);
  createObservation(
    db,
    {
      id: "mirror-note",
      createdByRun: "run",
      summary: "Follow up on the budget task",
      why: "",
      citations: ["loop-mirror"],
    },
    1,
  );
  expect(attemptLegacyOwnerConversion(db, "observation", "mirror-note", 2).outcome).toBe(
    "converted",
  );
  expect(getKnowledgeDependencies(db, "mirror-note")).toEqual([]);
});

it("sets aside an owner whose every source is gone, backing off on each refusal", () => {
  addDocAnnotation("orphan-claim", "vanished-memo");
  const first = attemptLegacyOwnerConversion(db, "doc_annotation", "orphan-claim", 10);
  expect(first).toEqual({
    outcome: "deferred",
    reason: "evidence_unavailable",
    retryAt: 10 + 6 * HOUR,
  });
  expect(getKnowledgeNode(db, "orphan-claim")).toBeNull();
  expect(deferral("orphan-claim")).toMatchObject({
    reason: "evidence_unavailable",
    attempts: 1,
    input_fingerprint: legacyOwnerConversionFingerprint(db, "doc_annotation", "orphan-claim"),
  });
  expect(attemptLegacyOwnerConversion(db, "doc_annotation", "orphan-claim", 20)).toMatchObject({
    retryAt: 20 + 12 * HOUR,
  });
  expect(deferral("orphan-claim")?.attempts).toBe(2);
});

it("sets aside a missing or privacy-hidden owner as unavailable", () => {
  expect(attemptLegacyOwnerConversion(db, "loop", "no-such-task", 5)).toMatchObject({
    outcome: "deferred",
    reason: "owner_unavailable",
  });
  expect(legacyOwnerConversionFingerprint(db, "loop", "no-such-task")).toBe(
    deferral("no-such-task")?.input_fingerprint,
  );
});

it("retries a write race soon and an input refusal slowly, both capped", () => {
  expect(legacyConversionRetryDelay("revision_conflict", 1)).toBe(5 * 60_000);
  expect(legacyConversionRetryDelay("revision_conflict", 3)).toBe(20 * 60_000);
  expect(legacyConversionRetryDelay("revision_conflict", 50)).toBe(6 * HOUR);
  expect(legacyConversionRetryDelay("evidence_unavailable", 1)).toBe(6 * HOUR);
  expect(legacyConversionRetryDelay("claim_invalid", 2)).toBe(12 * HOUR);
  expect(legacyConversionRetryDelay("owner_unavailable", 50)).toBe(7 * 24 * HOUR);
});

it("changes the input fingerprint when a cited source becomes readable again", () => {
  addDocAnnotation("orphan-claim", "vanished-memo");
  const before = legacyOwnerConversionFingerprint(db, "doc_annotation", "orphan-claim");
  addDocument("vanished-memo");
  expect(legacyOwnerConversionFingerprint(db, "doc_annotation", "orphan-claim")).not.toBe(before);
});

it("the sweep converts a valid owner once and leaves a broken one alone until its inputs change", async () => {
  addDocument("budget-memo");
  createOpenLoop(
    db,
    {
      id: "budget-task",
      createdByRun: "run",
      title: "Send the budget summary",
      description: "Summary due Thursday.",
      state: "open",
      confidence: 0.7,
      importance: 0.5,
      docs: ["budget-memo"],
    },
    1,
  );
  addDocAnnotation("orphan-claim", "vanished-memo");
  let now = 1_000;
  const gate = directKnowledgeGate(db);
  const convertOwner = vi.fn(gate["knowledge.convertOwner"]);
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const settings = resolveBrainSettings({ bootstrap: { enabled: false } });
  const upkeep = new KnowledgeUpkeep(
    {
      db,
      writeGate: { ...gate, "knowledge.convertOwner": convertOwner },
      getSettings: () => settings,
      clock: () => now,
      log,
    } as unknown as KnowledgeEngineDeps,
    (prefix) => `${prefix}-1`,
  );

  await upkeep.convert();
  expect(getKnowledgeNode(db, "budget-task")?.kind).toBe("loop");
  expect(getKnowledgeNode(db, "orphan-claim")).toBeNull();
  expect(convertOwner).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0]?.[0]).toBe(
    "Legacy owner conversion: 1 converted, 1 set aside (evidence_unavailable 1)",
  );
  expect(readLegacyConversionStatus(db)).toEqual([
    { kind: "loop", converted: 1, deferred: {} },
    { kind: "observation", converted: 0, deferred: {} },
    { kind: "doc_annotation", converted: 0, deferred: { evidence_unavailable: 1 } },
  ]);

  // Every later pass wraps over the same set-aside owner without a writer attempt or a log line.
  for (let pass = 0; pass < 5; pass++) {
    now += 60_000;
    await upkeep.convert();
  }
  expect(convertOwner).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledTimes(1);

  // Its timed retry comes due: one attempt, refused again, with a longer backoff.
  now += 6 * HOUR;
  await upkeep.convert();
  expect(convertOwner).toHaveBeenCalledTimes(3);
  expect(deferral("orphan-claim")).toMatchObject({ attempts: 2, retry_at: now + 12 * HOUR });
  await upkeep.convert();
  expect(convertOwner).toHaveBeenCalledTimes(3);

  // The missing source is synced again: the changed fingerprint makes it eligible at once.
  addDocument("vanished-memo");
  now += 60_000;
  await upkeep.convert();
  expect(convertOwner).toHaveBeenCalledTimes(4);
  expect(getKnowledgeNode(db, "orphan-claim")?.kind).toBe("doc_annotation");
  expect(deferral("orphan-claim")).toBeUndefined();
  expect(log.info).toHaveBeenLastCalledWith("Legacy owner conversion: 1 converted");
  expect(readLegacyConversionStatus(db)[2]).toEqual({
    kind: "doc_annotation",
    converted: 1,
    deferred: {},
  });
});
