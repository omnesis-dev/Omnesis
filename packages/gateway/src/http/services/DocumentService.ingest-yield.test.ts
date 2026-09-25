// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The document-ingest before-state capture walks a batch in sub-batches with an
 * event-loop yield between them. This drives the full route → DocumentService
 * path (`POST /documents`) with a MULTI-SOURCE batch that crosses the yield
 * boundary, asserting the sub-batched, group-by-pair capture accumulates every
 * doc's before-projection correctly across the boundary — so re-posting the
 * same docs with changed content emits a `document.upserted` update for each,
 * keyed by (provider, source, externalId), with none dropped.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ProviderId,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  SourceId,
  type DocumentInput,
  type Scope,
} from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { EventBus, type DocumentUpsertedEvent } from "../../events.js";
import { DEFAULT_INGEST_YIELD_BATCH } from "../../async-yield.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { DocumentService } from "./DocumentService.js";
import { EventService } from "./EventService.js";
import type { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let token: string;
let bus: EventBus;
let app: ReturnType<typeof createServer>;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}
function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}
function post(body: unknown) {
  return app.request("/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// A batch spanning two (provider, source) pairs, sized to cross the yield
// boundary. `v` bumps the content so a re-post is a content-changed update.
function twoSourceBatch(perSource: number, v: number) {
  const docs: unknown[] = [];
  for (const sourceId of ["gmail", "drive"]) {
    for (let i = 0; i < perSource; i++) {
      const externalId = `${sourceId}-${i}`;
      docs.push({
        providerId: "google",
        sourceId,
        externalId,
        title: `Doc ${externalId}`,
        content: `body ${externalId} v${v}`,
        contentHash: `ch-${externalId}-v${v}`,
        metadata: { documentType: "email" },
        sourceCreatedAt: "2026-01-15T10:00:00Z",
        sourceUpdatedAt: "2026-01-15T10:00:00Z",
      });
    }
  }
  return { documents: docs };
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-ingest-yield-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  bus = new EventBus();
  app = createServer(db, dbPath, { eventBus: bus });
});
afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("multi-source ingest capture across the yield boundary", () => {
  test("accepts exact duplicate rows while rejecting conflicting identities in one page", async () => {
    const service = new DocumentService({
      db,
      writeGate: directWriteGate(db),
      events: new EventService(db, bus, false),
      sourceDataRemoval: {} as SourceDataRemovalService,
    });
    const document: DocumentInput = {
      providerId: ProviderId("example-provider"),
      sourceId: SourceId("strava-activities:example"),
      externalId: "activity-1",
      title: "Morning run",
      content: "A short run",
      contentHash: "activity-hash",
      metadata: { documentType: "activity", extra: { sportType: "Run" } },
      sourceCreatedAt: "2026-01-01T08:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T08:00:00.000Z",
    };
    const sameDocumentDifferentOrder = {
      sourceUpdatedAt: document.sourceUpdatedAt,
      sourceCreatedAt: document.sourceCreatedAt,
      metadata: { extra: { sportType: "Run" }, documentType: "activity" as const },
      contentHash: document.contentHash,
      content: document.content,
      title: document.title,
      externalId: document.externalId,
      sourceId: document.sourceId,
      providerId: document.providerId,
    };

    await expect(service.ingest([document, sameDocumentDifferentOrder])).resolves.toMatchObject({
      ingested: 2,
    });
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM documents").get()?.count,
    ).toBe(1);

    await expect(
      service.ingest([document, { ...document, title: "Conflicting title" }]),
    ).rejects.toThrow("conflicting document identity in one page");
  });

  test("re-post with changed content emits an update for every doc, none dropped", async () => {
    // perSource chosen so the total (2 × perSource) exceeds one yield batch.
    const perSource = Math.ceil((DEFAULT_INGEST_YIELD_BATCH + 20) / 2);
    const total = perSource * 2;

    // First post: all inserts.
    const events: DocumentUpsertedEvent[] = [];
    const off = bus.on("document.upserted", (e) => events.push(e));
    const r1 = await post(twoSourceBatch(perSource, 1));
    expect(r1.status).toBe(200);
    expect(events.filter((e) => e.before === null)).toHaveLength(total);

    // Second post: same docs, changed content → every one is a content-changed
    // update. The capture must have accumulated all `before` projections across
    // both source pairs and the yield boundary.
    events.length = 0;
    const r2 = await post(twoSourceBatch(perSource, 2));
    expect(r2.status).toBe(200);
    off();

    expect(events).toHaveLength(total);
    expect(events.every((e) => e.before !== null)).toBe(true);
    expect(events.every((e) => e.contentChanged)).toBe(true);
    // Every source pair + externalId represented exactly once (nothing dropped
    // or duplicated across sub-batches).
    const keys = new Set(events.map((e) => `${e.after.sourceId}|${e.after.externalId}`));
    expect(keys.size).toBe(total);
  });

  test("a stale replicated row emits no update while an ordinary source still uses arrival order", async () => {
    const service = new DocumentService({
      db,
      writeGate: directWriteGate(db),
      events: new EventService(db, bus, false),
      sourceDataRemoval: {} as SourceDataRemovalService,
    });
    const thingsSource = "things:account";
    const ordinarySource = "apple-health:phone";
    const policies = { [thingsSource]: "source-updated-at" as const };
    const makeVersion = (
      sourceId: string,
      title: string,
      sourceUpdatedAt: string,
    ): DocumentInput => ({
      providerId: ProviderId("example-provider"),
      sourceId: SourceId(sourceId),
      externalId: "shared-id",
      title,
      content: `${title} body`,
      contentHash: `${sourceId}-${title}`,
      metadata: { documentType: "note" as const },
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt,
    });

    await service.ingest(
      [
        makeVersion(thingsSource, "New task", "2026-03-02T00:00:00.000Z"),
        makeVersion(ordinarySource, "First aggregate", "2026-03-02T00:00:00.000Z"),
      ],
      undefined,
      false,
      undefined,
      undefined,
      policies,
    );

    const events: DocumentUpsertedEvent[] = [];
    const off = bus.on("document.upserted", (event) => events.push(event));
    const result = await service.ingest(
      [
        makeVersion(thingsSource, "Stale task", "2026-03-01T00:00:00.000Z"),
        makeVersion(ordinarySource, "Recomputed aggregate", "2026-03-01T00:00:00.000Z"),
      ],
      undefined,
      false,
      undefined,
      undefined,
      policies,
    );
    off();

    expect(result.ingested).toBe(1);
    expect(events.map((event) => event.after.sourceId)).toEqual([ordinarySource]);
    const rows = db
      .prepare<
        [],
        { source_id: string; title: string }
      >("SELECT source_id, title FROM documents ORDER BY source_id")
      .all();
    expect(rows).toEqual([
      { source_id: ordinarySource, title: "Recomputed aggregate" },
      { source_id: thingsSource, title: "New task" },
    ]);
  });

  test("replica timestamp and per-page identity contracts fail at the service boundary", async () => {
    const service = new DocumentService({
      db,
      writeGate: directWriteGate(db),
      events: new EventService(db, bus, false),
      sourceDataRemoval: {} as SourceDataRemovalService,
    });
    const sourceId = "things:validation";
    const document: DocumentInput = {
      providerId: ProviderId("example-provider"),
      sourceId: SourceId(sourceId),
      externalId: "task-one",
      title: "Invented task",
      content: "Invented body",
      contentHash: "invented-hash",
      metadata: { documentType: "note" as const },
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    };
    const policies = { [sourceId]: "source-updated-at" as const };

    await expect(
      service.ingest(
        [{ ...document, sourceUpdatedAt: "invalid" }],
        undefined,
        false,
        undefined,
        undefined,
        policies,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.ingest(
        [document, { ...document, title: "Conflicting task" }],
        undefined,
        false,
        undefined,
        undefined,
        policies,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 0 });
  });

  test("a non-holder cannot delete a replica restored after tombstone preflight", async () => {
    const direct = directWriteGate(db);
    const restored: DocumentInput = {
      providerId: ProviderId("example-provider"),
      sourceId: SourceId("things:race"),
      externalId: "restored-task",
      title: "Restored task",
      content: "Restored body",
      contentHash: "restored-hash",
      metadata: { documentType: "note" as const },
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-03T00:00:00.000Z",
    };
    let restoredInsideWriterHandoff = false;
    const racingGate: WriteGate = {
      ...direct,
      upsertWithCursor: async (args, canonicalizers) => {
        // The service's preflight has already observed the tombstone target as
        // absent. Restore it immediately before the queued writer runs. The
        // non-holder must omit the acknowledged tombstone so this row survives.
        await direct.upsertDocuments([restored]);
        restoredInsideWriterHandoff = true;
        return direct.upsertWithCursor(args, canonicalizers);
      },
    };
    const service = new DocumentService({
      db,
      writeGate: racingGate,
      events: new EventService(db, bus, false),
      sourceDataRemoval: {} as SourceDataRemovalService,
    });

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      cursorDeviceId: "replica-two",
      replicaVersionPolicy: "source-updated-at",
      deletionAuthority: false,
      body: {
        providerId: restored.providerId,
        sourceId: restored.sourceId,
        documents: [
          {
            ...restored,
            externalId: "next-task",
            title: "Next task",
            contentHash: "next-hash",
          },
        ],
        deletedExternalIds: [restored.externalId],
        hasMore: false,
        cursor: { offset: 2 },
      },
    });

    expect(restoredInsideWriterHandoff).toBe(true);
    expect(result).toMatchObject({ ingested: 1, tombstonedDeleted: 0 });
    expect(
      db
        .prepare<
          [],
          { external_id: string }
        >("SELECT external_id FROM documents WHERE source_id = 'things:race' ORDER BY external_id")
        .all(),
    ).toEqual([{ external_id: "next-task" }, { external_id: "restored-task" }]);
    expect(
      db
        .prepare<
          [string, string],
          { cursor: string }
        >("SELECT cursor FROM sync_state WHERE source_id = ? AND device_id = ?")
        .get(restored.sourceId, "replica-two"),
    ).toEqual({ cursor: JSON.stringify({ offset: 2 }) });
  });
});
