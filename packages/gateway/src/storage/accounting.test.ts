// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { directReadPort } from "../scheduler/read-port.js";
import {
  measureStorageAccounting,
  storageAccountingMetadata,
  storageAccountingPage,
} from "./accounting.js";

const reads = () => directReadPort({ storageAccountingMetadata, storageAccountingPage }, db);

let db: ReturnType<typeof createDatabase>;
beforeEach(() => {
  db = createDatabase(":memory:");
});
afterEach(() => db.close());

test("logical byte attribution is UTF-8 precise and separated by source and calendar month", async () => {
  const content = "Invented café archive 🗃";
  for (const [externalId, source, date] of [
    ["a", "fictional-notes:first", "2020-01-01T00:00:00.000Z"],
    ["b", "fictional-notes:first", "2020-02-01T00:00:00.000Z"],
    ["c", "fictional-notes:second", "2020-02-02T00:00:00.000Z"],
  ]) {
    upsertDocuments(db, [
      {
        providerId: ProviderId("fictional-provider"),
        sourceId: SourceId(source!),
        externalId: externalId!,
        title: "Entry",
        content,
        contentHash: externalId!,
        metadata: {},
        sourceCreatedAt: date!,
        sourceUpdatedAt: date!,
      },
    ]);
  }
  const perDocument =
    Buffer.byteLength(content) + Buffer.byteLength("Entry") + Buffer.byteLength("{}");
  const snapshot = await measureStorageAccounting(reads());
  expect(snapshot.attribution).toBe("logical-payload");
  expect(snapshot.sources).toEqual([
    {
      sourceId: "fictional-notes:first",
      documents: 2,
      payloadBytes: 2 * perDocument,
      months: [
        { month: "2020-01", documents: 1, payloadBytes: perDocument },
        { month: "2020-02", documents: 1, payloadBytes: perDocument },
      ],
    },
    {
      sourceId: "fictional-notes:second",
      documents: 1,
      payloadBytes: perDocument,
      months: [{ month: "2020-02", documents: 1, payloadBytes: perDocument }],
    },
  ]);
  expect(snapshot.database.allocatedBytes).toBeGreaterThan(0);
  expect(snapshot.database.reusableBytes).toBeGreaterThanOrEqual(0);
  if (snapshot.database.tables)
    expect(snapshot.database.tables).toContainEqual(expect.objectContaining({ name: "documents" }));
});

test("empty source data is reported as empty, with physical schema overhead retained", async () => {
  expect(await measureStorageAccounting(reads())).toMatchObject({
    sources: [],
    database: { allocatedBytes: expect.any(Number) },
  });
});

test("pages release transactions and continuous inserts cannot extend the initial rowid ceiling", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    providerId: ProviderId("fictional-provider"),
    sourceId: SourceId("fictional-notes:paged"),
    externalId: `entry-${index}`,
    title: "Entry",
    content: "Invented archive",
    contentHash: `entry-${index}`,
    metadata: {},
    sourceCreatedAt: "2020-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2020-01-01T00:00:00.000Z",
  }));
  upsertDocuments(db, rows);
  const pages: number[] = [];
  const port = reads();
  const snapshot = await measureStorageAccounting({
    storageAccountingMetadata: port.storageAccountingMetadata,
    storageAccountingPage: async (after, upper) => {
      expect(db.inTransaction).toBe(false);
      const result = await port.storageAccountingPage(after, upper);
      pages.push(result.length);
      upsertDocuments(db, [
        { ...rows[0]!, externalId: `concurrent-${after}`, contentHash: `concurrent-${after}` },
      ]);
      expect(db.inTransaction).toBe(false);
      return result;
    },
  });
  expect(pages).toEqual([500, 1]);
  expect(snapshot.sources).toEqual([
    expect.objectContaining({ sourceId: "fictional-notes:paged", documents: 501 }),
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 503 });
});

test("deletions between pages leave a finite estimate and invalid source dates have their own month", async () => {
  upsertDocuments(db, [
    {
      providerId: ProviderId("fictional-provider"),
      sourceId: SourceId("fictional-notes:unknown"),
      externalId: "unknown",
      title: "Entry",
      content: "Invented archive",
      contentHash: "unknown",
      metadata: {},
      sourceCreatedAt: "unknown",
      sourceUpdatedAt: "unknown",
    },
  ]);
  const metadata = storageAccountingMetadata(db);
  const page = storageAccountingPage(db, 0, metadata.upperRowid);
  expect(page).toEqual([expect.objectContaining({ month: "unknown" })]);
  db.prepare("DELETE FROM documents").run();
  const snapshot = await measureStorageAccounting({
    storageAccountingMetadata: async () => metadata,
    storageAccountingPage: async (after, upper) => storageAccountingPage(db, after, upper),
  });
  expect(snapshot.sources).toEqual([]);
});
