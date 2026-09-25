// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The document-diff engine's prior-content plumbing: bodies are fetched
 * pre-write ONLY while an interest registration is live, only for
 * content-changed updates, and travel to subscribers as
 * `DocumentUpsertedEvent.beforeContent` — never persisted, never cached.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, fetchDocumentProjections, upsertDocuments } from "../db.js";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "../events.js";
import { EventService } from "../http/services/EventService.js";
import { collectPriorContents, registerPriorContentInterest } from "./document-prior-content.js";
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

describe("collectPriorContents", () => {
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

  test("returns nothing while no interest is registered (feature-off ingest pays zero reads)", () => {
    upsertDocuments(db, [doc("d1", "version one")]);
    const update = doc("d1", "version two");
    expect(collectPriorContents(db, [update], beforeMapFor(db, [update])).size).toBe(0);
  });

  test("with interest: fetches the pre-write body for content-changed updates only", () => {
    const release = registerPriorContentInterest();
    try {
      upsertDocuments(db, [doc("d1", "version one"), doc("d2", "stable")]);
      const changed = doc("d1", "version two");
      const unchanged = doc("d2", "stable");
      const fresh = doc("d3", "brand new");
      const batch = [changed, unchanged, fresh];
      const got = collectPriorContents(db, batch, beforeMapFor(db, batch));
      expect(got.size).toBe(1);
      expect(got.get("google|drive-test|d1")).toBe("version one");
    } finally {
      release();
    }
  });

  test("released interest turns the fetch back off (idempotent release)", () => {
    const release = registerPriorContentInterest();
    release();
    release(); // double-release must not underflow another consumer's interest
    upsertDocuments(db, [doc("d1", "version one")]);
    const update = doc("d1", "version two");
    expect(collectPriorContents(db, [update], beforeMapFor(db, [update])).size).toBe(0);
  });
});

describe("EventService beforeContent attachment", () => {
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

  test("content-changed updates carry beforeContent; inserts never do", async () => {
    const release = registerPriorContentInterest();
    try {
      upsertDocuments(db, [doc("d1", "version one")]);
      const update = doc("d1", "version two");
      const fresh = doc("d3", "brand new");
      const batch = [update, fresh];
      const beforeMap = beforeMapFor(db, batch);
      const priorContents = collectPriorContents(db, batch, beforeMap);
      // Post-write state, as the real ingest path does.
      upsertDocuments(db, batch);

      const bus = new EventBus();
      const events: DocumentUpsertedEvent[] = [];
      bus.on("document.upserted", (e) => events.push(e));
      await new EventService(db, bus, false).emitDocumentUpserted(batch, beforeMap, priorContents);

      expect(events).toHaveLength(2);
      const updated = events.find((e) => e.after.externalId === "d1")!;
      expect(updated.contentChanged).toBe(true);
      expect(updated.beforeContent).toBe("version one");
      const inserted = events.find((e) => e.after.externalId === "d3")!;
      expect(inserted.before).toBeNull();
      expect(inserted.beforeContent).toBeUndefined();
    } finally {
      release();
    }
  });

  test("without a beforeContents map the event carries no prior body", async () => {
    upsertDocuments(db, [doc("d1", "version one")]);
    const update = doc("d1", "version two");
    const beforeMap = beforeMapFor(db, [update]);
    upsertDocuments(db, [update]);

    const bus = new EventBus();
    const events: DocumentUpsertedEvent[] = [];
    bus.on("document.upserted", (e) => events.push(e));
    await new EventService(db, bus, false).emitDocumentUpserted([update], beforeMap);
    expect(events).toHaveLength(1);
    expect(events[0].beforeContent).toBeUndefined();
  });
});
