// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hot-path contract of the temporal-annotation invalidation subscriber: on
 * `document.upserted` it fires the (single-writer) invalidate op only
 * for content-changed events, only while the feature is enabled, and
 * only for documents a live entry actually cites (the cheap read
 * guard) — and a failed invalidate is logged, never thrown back into
 * the emitter.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase } from "../db.js";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "../events.js";
import {
  insertTemporalAnnotation,
  invalidateTemporalAnnotation,
  invalidateTemporalAnnotationsForDoc,
} from "../enrichment/temporal-annotations/storage.js";
import { subscribeTemporalAnnotationInvalidator } from "./temporal-annotation-invalidator.js";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

const NOW = Date.parse("2026-07-08T12:00:00Z");

let db: Db;
let dbPath: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function seedDoc(id: string): void {
  const iso = new Date(NOW - 60_000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test-provider', 'test-source', ?, 'Renewal notice', 'body', 'hash-a', ?, ?, ?, ?)`,
  ).run(id, id, iso, iso, iso, iso);
}

function projection(id: string): DocumentProjection {
  const iso = new Date(NOW - 60_000).toISOString();
  return {
    id,
    providerId: "test-provider",
    sourceId: "test-source",
    externalId: id,
    documentType: "file",
    title: "Renewal notice",
    contentHash: "hash-b",
    metadata: {},
    sourceCreatedAt: iso,
    sourceUpdatedAt: iso,
    people: [],
  };
}

function upsertEvent(docId: string, contentChanged = true): DocumentUpsertedEvent {
  const after = projection(docId);
  return {
    before: { ...after, contentHash: "hash-a" },
    after,
    afterContent: "new body",
    changedFields: contentChanged ? ["contentHash"] : ["title"],
    contentChanged,
  };
}

function captureLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warns.push(message);
    },
    error: () => {},
    child: () => log,
  };
  return { log, warns };
}

function wire(over: Partial<Parameters<typeof subscribeTemporalAnnotationInvalidator>[0]> = {}) {
  const bus = new EventBus();
  const invalidate = vi.fn((_docId: string, _now: number) =>
    Promise.resolve({ invalidated: 1, kept: 0, atomsBroken: 0, atomsHealed: 0, resurrected: 0 }),
  );
  subscribeTemporalAnnotationInvalidator({
    db,
    eventBus: bus,
    invalidate,
    isEnabled: () => true,
    clock: () => NOW,
    log: captureLog().log,
    ...over,
  });
  return { bus, invalidate };
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  seedDoc("doc_cited");
  seedDoc("doc_uncited");
  insertTemporalAnnotation(
    db,
    {
      id: "tix_cited",
      intervalStartMs: Date.UTC(2026, 6, 20),
      intervalEndMs: Date.UTC(2026, 6, 21) - 1,
      precision: "day",
      canonical: "2026-07-20",
      sentence: "Lease renewal decision is due",
      kind: "deadline",
      documentIds: ["doc_cited"],
      createdByRun: "run_seed",
    },
    NOW - 3_600_000,
  );
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("temporal-annotation invalidator", () => {
  test("a content-changed upsert of a cited document fires invalidate(docId, clock())", () => {
    const { bus, invalidate } = wire();
    bus.emit("document.upserted", upsertEvent("doc_cited"));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("doc_cited", NOW);
  });

  test("a metadata-only upsert (contentChanged: false) never invalidates", () => {
    const { bus, invalidate } = wire();
    bus.emit("document.upserted", upsertEvent("doc_cited", false));
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("inert while the feature is disabled", () => {
    const { bus, invalidate } = wire({ isEnabled: () => false });
    bus.emit("document.upserted", upsertEvent("doc_cited"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("a document no live entry cites is guarded out before the writer hop", () => {
    const { bus, invalidate } = wire();
    bus.emit("document.upserted", upsertEvent("doc_uncited"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("a churn-invalidated entry keeps the guard warm so a change-back can resurrect it", () => {
    // The seeded entry falls to the churn path (blanket, cause
    // 'content_change') — the next upsert must still reach the writer op.
    invalidateTemporalAnnotationsForDoc(db, "doc_cited", NOW - 1_000);
    const { bus, invalidate } = wire();
    bus.emit("document.upserted", upsertEvent("doc_cited"));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("doc_cited", NOW);
  });

  test("a deliberately deleted entry does not keep the guard warm", () => {
    invalidateTemporalAnnotation(db, "tix_cited", NOW - 1_000);
    const { bus, invalidate } = wire();
    bus.emit("document.upserted", upsertEvent("doc_cited"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("a failed invalidate is logged, not thrown into the emitter", async () => {
    const { log, warns } = captureLog();
    const invalidate = vi.fn(() => Promise.reject(new Error("writer closed")));
    const { bus } = wire({ invalidate, log });
    // The emit itself must not throw — the rejection is swallowed off-path.
    expect(() => bus.emit("document.upserted", upsertEvent("doc_cited"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("doc_cited");
    expect(warns[0]).toContain("writer closed");
  });
});
