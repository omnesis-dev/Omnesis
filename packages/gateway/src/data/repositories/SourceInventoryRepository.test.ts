// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceId, ProviderId, type DocumentInput } from "@omnesis/types";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import {
  recordKnowledgeCoverage,
  KNOWLEDGE_DISCOVERY_POLICY,
} from "../../brain/knowledge/discovery.js";
import { readKnowledgeInventoryStatus } from "../../brain/knowledge/inventory-status.js";
import {
  upsertWithCursor,
  upsertWithCursorYieldable,
  type UpsertWithCursorArgs,
} from "./DocumentRepository.js";
import {
  createSourceInventoryTables,
  getInitialSourceInventory,
  isInventoryRevision,
} from "./SourceInventoryRepository.js";

let db: Database.Database;
const inventory = {
  id: "12345678-1234-4234-8234-123456789012",
  startedAt: "2027-01-12T12:00:00.000Z",
};
const sourceId = SourceId("fixture:inventory"),
  providerId = ProviderId("fixture");
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-01-12T12:00:00.000Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runSchemaSetup(db);
  runMigrations(db);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
function document(externalId: string, at = inventory.startedAt): DocumentInput {
  return {
    providerId,
    sourceId,
    externalId,
    title: externalId,
    content: "Invented workshop planning.",
    contentHash: externalId,
    metadata: {},
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
  };
}
function page(docs: DocumentInput[], hasMore = true): UpsertWithCursorArgs {
  return {
    providerId,
    sourceId,
    initialInventory: inventory,
    documents: docs,
    hasMore,
    cursor: { count: docs.length },
  };
}
function id(externalId: string) {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id=?")
    .get(externalId)!.id;
}

it("persists partial import identity, completes only with the final cursor, and retries idempotently", () => {
  upsertWithCursor(db, page([document("recent")]));
  expect(getInitialSourceInventory(db, sourceId)).toEqual(inventory);
  expect(isInventoryRevision(db, id("recent"), "recent")).toBe(true);
  const final = page([document("old", "2020-01-01T00:00:00.000Z")], false);
  upsertWithCursor(db, final);
  upsertWithCursor(db, final);
  expect(getInitialSourceInventory(db, sourceId)).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM source_inventory_documents").get()).toEqual({
    count: 2,
  });
  expect(readKnowledgeInventoryStatus(db, 30 * 86_400_000)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceId,
        importState: "complete",
        window: "recent",
        observed: 1,
        unconsidered: 1,
      }),
      expect.objectContaining({
        sourceId,
        importState: "complete",
        window: "history",
        observed: 1,
        unconsidered: 1,
      }),
    ]),
  );
});
it("records each yielded chunk before a first cursor exists and retains its identity on replay", () => {
  const args = page([document("one"), document("two"), document("three")], false);
  let checks = 0;
  const result = upsertWithCursorYieldable(db, args, {
    chunkSize: 1,
    token: { requested: () => ++checks >= 1 },
  });
  expect(result.kind).toBe("yield");
  expect(getInitialSourceInventory(db, sourceId)).toEqual(inventory);
  expect(isInventoryRevision(db, id("one"), "one")).toBe(true);
  upsertWithCursor(db, args);
  expect(getInitialSourceInventory(db, sourceId)).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM source_inventory_documents").get()).toEqual({
    count: 3,
  });
});
it("never labels edits or ordinary late arrivals as historical inventory, including A-B-A", () => {
  upsertWithCursor(db, page([document("edit")], false));
  upsertWithCursor(db, page([{ ...document("edit"), contentHash: "B", content: "A correction." }]));
  upsertWithCursor(db, page([document("edit")]));
  expect(isInventoryRevision(db, id("edit"), "edit")).toBe(false);
  const late = page([document("late", "2020-01-01T00:00:00.000Z")], false);
  delete late.initialInventory;
  upsertWithCursor(db, late);
  expect(isInventoryRevision(db, id("late"), "late")).toBe(false);
});
it("rolls back cross-source inventory identity reuse with its documents", () => {
  upsertWithCursor(db, page([document("one")]));
  const other = SourceId("fixture:other");
  expect(() =>
    upsertWithCursor(db, { ...page([{ ...document("two"), sourceId: other }]), sourceId: other }),
  ).toThrow("another source enumeration");
  expect(db.prepare("SELECT 1 FROM documents WHERE external_id='two'").get()).toBeUndefined();
});
it("privacy deletion removes inventory provenance with the document", () => {
  upsertWithCursor(db, page([document("private")], false));
  db.prepare("DELETE FROM documents WHERE id=?").run(id("private"));
  expect(db.prepare("SELECT COUNT(*) AS count FROM source_inventory_documents").get()).toEqual({
    count: 0,
  });
});

it("reports interpretation and organization separately without claiming partial inventory complete", () => {
  upsertWithCursor(db, page([document("phases")]));
  recordKnowledgeCoverage(
    db,
    {
      subjectId: id("phases"),
      inputRevision: "phases",
      phase: "interpretation",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status: "considered",
    },
    Date.now(),
  );
  recordKnowledgeCoverage(
    db,
    {
      subjectId: id("phases"),
      inputRevision: "phases",
      phase: "organization",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status: "gated",
    },
    Date.now(),
  );
  expect(readKnowledgeInventoryStatus(db, 30 * 86_400_000)).toEqual([
    expect.objectContaining({
      phase: "interpretation",
      importState: "importing",
      observed: 1,
      considered: 1,
      gated: 0,
    }),
    expect.objectContaining({
      phase: "organization",
      importState: "importing",
      observed: 1,
      considered: 0,
      gated: 1,
    }),
  ]);
});

it("upgrades prototype inventory clocks from gateway observations idempotently", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT);
      CREATE TABLE source_inventories(id TEXT PRIMARY KEY,source_id TEXT,cursor_row TEXT,
        started_at TEXT,observed_at INTEGER,completed_at INTEGER);
      INSERT INTO source_inventories VALUES('legacy','fictional','','2099-01-01',123456,NULL);`);
    createSourceInventoryTables(legacy);
    createSourceInventoryTables(legacy);
    expect(legacy.prepare("SELECT first_received_at FROM source_inventories").get()).toEqual({
      first_received_at: 123456,
    });
  } finally {
    legacy.close();
  }
});
