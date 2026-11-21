// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * When an enumeration counts as a read of everything its source holds.
 *
 * The last page of a cycle begun with no cursor is a full read unless the
 * source says older history follows; such a source completes the read on a
 * later page. All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { upsertWithCursorBody } from "../../http/schemas/documents.js";
import { runMigrations } from "../migrations.js";
import { runSchemaSetup } from "../schema.js";
import { upsertWithCursor, type UpsertWithCursorArgs } from "./DocumentRepository.js";
import { listSourceFullReads, listSourceOpenReads } from "./SourceInventoryRepository.js";
import type { Db } from "../types.js";

const providerId = ProviderId("fixture-chat");
const sourceId = SourceId("fixture-chat:studio");
const FIRST = { id: "0d9f3c1e-6a2b-4c7d-9e8f-1a2b3c4d5e6f", startedAt: "2027-03-01T09:00:00.000Z" };
const SECOND = {
  id: "7b1e5d2c-3f4a-4b6c-8d9e-0f1a2b3c4d5e",
  startedAt: "2027-04-01T09:00:00.000Z",
};

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => db.close());

function note(externalId: string): DocumentInput {
  return {
    providerId,
    sourceId,
    externalId,
    title: `Day ${externalId}`,
    content: `Notes for ${externalId}`,
    contentHash: `hash:${externalId}`,
    metadata: { documentType: "day" },
    sourceCreatedAt: "2027-02-01T08:00:00.000Z",
    sourceUpdatedAt: "2027-02-01T08:00:00.000Z",
  };
}

let pages = 0;
function page(extra: Partial<UpsertWithCursorArgs>): void {
  pages += 1;
  upsertWithCursor(db, {
    providerId,
    sourceId,
    documents: [note(`day-${pages}`)],
    hasMore: false,
    cursor: { page: pages },
    sourceVersion: 2,
    ...extra,
  });
}

const row = (id: string) =>
  db
    .prepare<[string], { completed: number | null; fullRead: number | null; minVersion: number }>(
      `SELECT completed_at AS completed, full_read_at AS fullRead, min_source_version AS minVersion
         FROM source_inventories WHERE id = ?`,
    )
    .get(id)!;

describe("a source that reads everything in one cycle", () => {
  test("has read everything on the last page of the cycle begun with no cursor", () => {
    page({ initialInventory: FIRST, hasMore: true });
    expect(row(FIRST.id)).toMatchObject({ completed: null, fullRead: null });
    expect(listSourceOpenReads(db, sourceId)).toEqual([{ cursorRow: "", minSourceVersion: 2 }]);
    expect(listSourceFullReads(db, sourceId)).toEqual([]);

    page({ initialInventory: FIRST });
    const done = row(FIRST.id);
    expect(done.completed).not.toBeNull();
    expect(done.fullRead).toBe(done.completed);
    expect(listSourceOpenReads(db, sourceId)).toEqual([]);
    expect(listSourceFullReads(db, sourceId)).toMatchObject([
      { cursorRow: "", minSourceVersion: 2 },
    ]);
  });

  test("is not marked by a page that is not the last, whatever it says", () => {
    page({ initialInventory: FIRST, hasMore: true, fullReadComplete: true });
    expect(row(FIRST.id).fullRead).toBeNull();
  });

  test("keeps the time of the full read when later pages repeat it", () => {
    page({ initialInventory: FIRST });
    const first = row(FIRST.id).fullRead;
    page({ initialInventory: FIRST });
    page({ fullReadComplete: true });
    expect(row(FIRST.id).fullRead).toBe(first);
  });
});

describe("a source that imports its history in stages", () => {
  test("has not read everything when it says older history follows", () => {
    page({ initialInventory: FIRST, fullReadComplete: false });
    const first = row(FIRST.id);
    // The enumeration is complete for everything else that reads it.
    expect(first.completed).not.toBeNull();
    expect(first.fullRead).toBeNull();
    expect(listSourceFullReads(db, sourceId)).toEqual([]);
    expect(listSourceOpenReads(db, sourceId)).toEqual([{ cursorRow: "", minSourceVersion: 2 }]);
  });

  test("completes the read on the later page that says so", () => {
    page({ initialInventory: FIRST, fullReadComplete: false });
    page({});
    page({ hasMore: true, fullReadComplete: true });
    expect(row(FIRST.id).fullRead).toBeNull();
    page({ fullReadComplete: true });
    expect(row(FIRST.id).fullRead).not.toBeNull();
    expect(listSourceFullReads(db, sourceId)).toMatchObject([
      { cursorRow: "", minSourceVersion: 2 },
    ]);
  });

  test("counts the read at the lowest version of any page until it is complete", () => {
    page({ initialInventory: FIRST, fullReadComplete: false, sourceVersion: 3 });
    page({ sourceVersion: 1 });
    page({ sourceVersion: 3, fullReadComplete: true });
    expect(row(FIRST.id)).toMatchObject({ minVersion: 1 });
    // A page after the read is complete no longer changes it.
    page({ sourceVersion: 0 });
    expect(row(FIRST.id)).toMatchObject({ minVersion: 1 });
  });

  test("a page that says nothing never completes a read that was left open", () => {
    page({ initialInventory: FIRST, fullReadComplete: false });
    for (let index = 0; index < 3; index++) page({});
    expect(row(FIRST.id).fullRead).toBeNull();
  });
});

describe("several reads of one account", () => {
  test("reports the full read made at the highest version, and the latest open one", () => {
    page({ initialInventory: FIRST, sourceVersion: 1 });
    db.prepare("UPDATE source_inventories SET observed_at = observed_at - 1000").run();
    page({ initialInventory: SECOND, sourceVersion: 3, hasMore: true });
    expect(listSourceFullReads(db, sourceId)).toMatchObject([{ minSourceVersion: 1 }]);
    expect(listSourceOpenReads(db, sourceId)).toEqual([{ cursorRow: "", minSourceVersion: 3 }]);
    page({ initialInventory: SECOND, sourceVersion: 3 });
    expect(listSourceFullReads(db, sourceId)).toMatchObject([{ minSourceVersion: 3 }]);
    expect(listSourceOpenReads(db, sourceId)).toEqual([]);
  });

  test("keeps each device's read apart", () => {
    page({ initialInventory: FIRST, cursorDeviceId: "dev-laptop", streamId: "dev-laptop" });
    page({
      initialInventory: SECOND,
      cursorDeviceId: "dev-desktop",
      streamId: "dev-desktop",
      hasMore: true,
    });
    expect(listSourceFullReads(db, sourceId).map((read) => read.cursorRow)).toEqual(["dev-laptop"]);
    expect(listSourceOpenReads(db, sourceId).map((read) => read.cursorRow)).toEqual([
      "dev-desktop",
    ]);
  });

  test("an enumeration recorded before full reads were is not taken for one", () => {
    db.prepare(
      `INSERT INTO source_inventories (id, source_id, cursor_row, started_at, first_received_at, observed_at, completed_at, min_source_version)
       VALUES (?, ?, '', ?, 1, 1, 1, 0)`,
    ).run(FIRST.id, sourceId, FIRST.startedAt);
    page({});
    expect(row(FIRST.id).fullRead).toBeNull();
    expect(listSourceFullReads(db, sourceId)).toEqual([]);
  });
});

test("the page body carries what the source said, and nothing when it said nothing", () => {
  const body = {
    providerId: "fixture-chat",
    sourceId: "fixture-chat:studio",
    hasMore: false,
    cursor: {},
  };
  expect(upsertWithCursorBody.parse(body).fullReadComplete).toBeUndefined();
  expect(upsertWithCursorBody.parse({ ...body, fullReadComplete: false }).fullReadComplete).toBe(
    false,
  );
  expect(upsertWithCursorBody.safeParse({ ...body, fullReadComplete: "yes" }).success).toBe(false);
});
