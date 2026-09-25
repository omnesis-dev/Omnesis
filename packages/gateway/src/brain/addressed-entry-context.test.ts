// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import {
  MAX_CHANGED_ADDRESSED_ENTRY_IDS,
  changedAddressedEntryIds,
  mergeChangedAddressedEntryIds,
  resolveAddressedEntries,
} from "./addressed-entry-context.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const base = {
  id: "entry-a",
  capturedAt: "2026-08-14T16:42:11.000Z",
  updatedAt: "2026-08-14T16:42:11.000Z",
  capturedTimeZoneId: "Europe/London",
  capturedUtcOffsetSeconds: 3600,
  receivedAt: "2026-08-14T16:42:15.000Z",
  surface: "ios-app",
  placeName: "Northstar",
};

describe("addressed entry attribution", () => {
  test("attributes added and edited ids but not unchanged or removed entries", () => {
    const before = { addressedEntries: [base, { ...base, id: "removed" }] };
    const after = {
      addressedEntries: [
        { ...base },
        { ...base, id: "entry-b", updatedAt: "2026-08-14T16:45:00.000Z" },
      ],
    };
    expect(changedAddressedEntryIds(before, after)).toEqual({
      ids: ["entry-b"],
      truncated: false,
    });

    after.addressedEntries[0] = {
      ...after.addressedEntries[0]!,
      updatedAt: "2026-08-14T16:50:00.000Z",
    };
    expect(changedAddressedEntryIds(before, after).ids).toEqual(["entry-a", "entry-b"]);
  });

  test("keeps the newest ids under the hard cap and preserves truncation through folds", () => {
    const entries = Array.from({ length: MAX_CHANGED_ADDRESSED_ENTRY_IDS + 3 }, (_, i) => ({
      ...base,
      id: `entry-${i}`,
    }));
    const changed = changedAddressedEntryIds({}, { addressedEntries: entries });
    expect(changed.truncated).toBe(true);
    expect(changed.ids).toHaveLength(MAX_CHANGED_ADDRESSED_ENTRY_IDS);
    expect(changed.ids.at(-1)).toBe(`entry-${entries.length - 1}`);

    const folded = mergeChangedAddressedEntryIds(changed.ids, ["entry-latest"]);
    expect(folded.truncated).toBe(true);
    expect(folded.ids.at(-1)).toBe("entry-latest");
  });
});

describe("claim-time addressed entry resolution", () => {
  let path: string;
  let db: Db;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  });

  test("reads current metadata in payload-id order and reports ids removed before claim", () => {
    upsertDocuments(db, [
      {
        providerId: ProviderId("system"),
        sourceId: SourceId("addressed-test"),
        externalId: "day",
        title: "Addressed entries",
        content: "content",
        contentHash: "hash",
        sourceCreatedAt: base.capturedAt,
        sourceUpdatedAt: base.updatedAt,
        metadata: {
          documentType: "note",
          addressedToAgent: true,
          addressedEntries: [base, { ...base, id: "entry-b" }],
        },
      },
    ]);
    const docId = db.prepare<[], { id: string }>("SELECT id FROM documents").get()!.id;
    const resolved = resolveAddressedEntries(db, docId, ["entry-b", "gone", "entry-a"]);
    expect(resolved.entries.map((entry) => entry.id)).toEqual(["entry-b", "entry-a"]);
    expect(resolved.missingIds).toEqual(["gone"]);
    expect(resolved.metadataUnavailable).toBe(false);
  });
});
