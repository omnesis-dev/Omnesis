// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * emitDocumentUpserted id-resolution + the batch yield.
 *
 * The emit walks the batch in sub-batches, resolving each doc's gateway id
 * with a post-write lookup and yielding the event loop between sub-batches so a
 * large emit can't freeze the interactive read path. A doc that did not survive
 * the write (deleted / re-keyed) has no id and is suppressed rather than emitted
 * with a dangling id; a genuine insert is resolved via the lookup; and the yield
 * must never drop an event.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, fetchDocumentProjections, upsertDocuments } from "../../db.js";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "../../events.js";
import { DEFAULT_INGEST_YIELD_BATCH } from "../../async-yield.js";
import { EventService } from "./EventService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}
function doc(externalId: string, content: string): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("drive-test"),
    externalId,
    title: `Doc ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "file" },
  };
}
function beforeMapFor(db: Db, docs: DocumentInput[]): Map<string, DocumentProjection> {
  const out = new Map<string, DocumentProjection>();
  const existing = fetchDocumentProjections(
    db,
    "google",
    "drive-test",
    docs.map((d) => d.externalId),
  );
  for (const [extId, projection] of existing) {
    out.set(`google|drive-test|${extId}`, projection);
  }
  return out;
}
function capture(db: Db): { events: DocumentUpsertedEvent[]; svc: EventService } {
  const bus = new EventBus();
  const events: DocumentUpsertedEvent[] = [];
  bus.on("document.upserted", (e) => events.push(e));
  return { events, svc: new EventService(db, bus, false) };
}

describe("emitDocumentUpserted id resolution + yield", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("suppresses a doc that did not survive the write (no dangling-id event)", async () => {
    upsertDocuments(db, [doc("d1", "version one")]);
    const before = beforeMapFor(db, [doc("d1", "version one")]);
    expect(before.get("google|drive-test|d1")?.id).toBeTruthy();
    // The row is gone at emit time (e.g. a concurrent delete during the
    // capture→write window). The post-write lookup finds nothing, so no event
    // is fired — the pre-write `before.id` is NOT trusted as a survivor id.
    db.prepare("DELETE FROM documents WHERE external_id = 'd1'").run();

    const { events, svc } = capture(db);
    await svc.emitDocumentUpserted([doc("d1", "version two")], before);

    expect(events).toHaveLength(0);
  });

  test("an insert (absent from `before`) resolves its id via post-write lookup", async () => {
    upsertDocuments(db, [doc("dNew", "hello world")]);
    const dbId = fetchDocumentProjections(db, "google", "drive-test", ["dNew"]).get("dNew")?.id;
    expect(dbId).toBeTruthy();

    const { events, svc } = capture(db);
    await svc.emitDocumentUpserted([doc("dNew", "hello world")], new Map());

    expect(events).toHaveLength(1);
    expect(events[0].before).toBeNull();
    expect(events[0].after.id).toBe(dbId);
  });

  test("a surviving update emits with the current gateway id and before state", async () => {
    upsertDocuments(db, [doc("dUpd", "first")]);
    const before = beforeMapFor(db, [doc("dUpd", "first")]);
    const dbId = before.get("google|drive-test|dUpd")?.id;
    // The row still exists at emit time — the normal update path.
    const { events, svc } = capture(db);
    await svc.emitDocumentUpserted([doc("dUpd", "second")], before);

    expect(events).toHaveLength(1);
    expect(events[0].before).not.toBeNull();
    expect(events[0].after.id).toBe(dbId);
    expect(events[0].contentChanged).toBe(true);
  });

  test("emits every doc across the yield boundary on a large batch", async () => {
    const n = DEFAULT_INGEST_YIELD_BATCH + 10; // crosses the yield threshold once
    const original = Array.from({ length: n }, (_, i) => doc(`big${i}`, `body ${i}`));
    upsertDocuments(db, original);
    const before = beforeMapFor(db, original);
    const changed = Array.from({ length: n }, (_, i) => doc(`big${i}`, `body ${i} v2`));

    const { events, svc } = capture(db);
    await svc.emitDocumentUpserted(changed, before);

    expect(events).toHaveLength(n);
    expect(new Set(events.map((e) => e.after.id)).size).toBe(n); // all distinct, none dropped
  });
});
