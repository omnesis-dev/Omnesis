// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for `createGatewayRecordPort` — the `cite_record` tool's gateway
 * adapter (sub-issue c). Proves the resolve path against a real
 * AnalyticsDb + SQLite store:
 *   - derives title / key fields / semantic time / redacted snapshot from the
 *     table's declared contract (persisted through `ensureTable`);
 *   - resolves a co-described document id when the table binds one, NULL when
 *     it doesn't;
 *   - redacts sensitive columns in the snapshot;
 *   - rejects an unknown table and a timeless row (frozen rule), including a
 *     table whose over-the-wire anchor was too ambiguous to keep.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { RecordPortError } from "@omnesis/agent";
import { recordReference, REDACTED_VALUE } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";

import { AnalyticsDb } from "../analytics-db.js";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { createGatewayRecordPort } from "./ports.js";
import type Database from "better-sqlite3";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

type Db = Database.Database;

const ANALYTICS_DB = `/tmp/omnesis-test-record-port-${randomUUID()}.db`;

// A fictional structured source with a 1:1 doc↔row binding + a sensitive
// column. Invented data only (privacy rule).
const txnSchema: AnalyticsTableSchema = {
  tableName: "demo_transactions",
  displayName: "Demo Transactions",
  description: "Fictional transactions for tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Transaction id" },
    { name: "merchant", type: "VARCHAR", description: "Merchant" },
    { name: "amount", type: "DOUBLE", description: "Amount" },
    { name: "auth_token", type: "VARCHAR", description: "Auth token", sensitive: true },
    { name: "occurred_at", type: "TIMESTAMPTZ", description: "When it happened" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "occurred_at",
  record: { titleColumns: ["merchant"], keyColumns: ["merchant", "amount", "auth_token"] },
  boundDocument: { externalIdColumns: ["id"] },
};

// A timeless table (no semantic time) — a row from it is not citable.
const profileSchema: AnalyticsTableSchema = {
  tableName: "demo_profiles",
  displayName: "Demo Profiles",
  description: "Fictional timeless profile snapshot",
  columns: [
    { name: "id", type: "VARCHAR", description: "Profile id" },
    { name: "nickname", type: "VARCHAR", description: "Nickname" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["nickname"], keyColumns: ["nickname"] },
};

let analytics: AnalyticsDb;
let sqlitePath: string;
let db: Db;

function cleanup(path: string): void {
  for (const suffix of ["", ".wal", "-wal", "-shm", "-journal"]) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* ignore */
    }
  }
}

/** Insert a document the txn rows bind to (in `streamId`, the shared stream by default), return its gateway id. */
async function insertBoundDoc(externalId: string, streamId = ""): Promise<string> {
  const gate = directWriteGate(db);
  await gate.upsertDocuments(
    [
      {
        providerId: ProviderId("demo"),
        sourceId: SourceId("demo:acct1"),
        externalId,
        title: "Transaction",
        content: "Body",
        contentHash: "h-" + externalId + streamId,
        sourceCreatedAt: "2026-05-01T10:00:00.000Z",
        sourceUpdatedAt: "2026-05-01T10:00:00.000Z",
        metadata: { documentType: "transaction" },
      },
    ],
    undefined,
    undefined,
    undefined,
    { "demo:acct1": streamId },
  );
  const row = db
    .prepare<
      [string, string],
      { id: string }
    >("SELECT id FROM documents WHERE external_id = ? AND stream_id = ?")
    .get(externalId, streamId);
  if (!row) throw new Error("expected bound doc id");
  return row.id;
}

beforeEach(async () => {
  analytics = new AnalyticsDb(ANALYTICS_DB);
  await analytics.open();
  await analytics.ensureTable(txnSchema, "demo:acct1");
  await analytics.ensureTable(profileSchema, "demo:acct1");
  sqlitePath = `/tmp/omnesis-test-record-port-sqlite-${randomUUID()}.db`;
  db = createDatabase(sqlitePath);
});

afterEach(async () => {
  db.close();
  cleanup(sqlitePath);
  await analytics.close();
  cleanup(ANALYTICS_DB);
});

describe("createGatewayRecordPort", () => {
  test("resolves title, key fields, semantic time, and redacted snapshot from the contract", async () => {
    const port = createGatewayRecordPort(db, analytics);
    const ref = recordReference("demo_transactions", [{ name: "id", value: "txn-1" }]);
    const resolved = await port.resolve({
      reference: ref,
      snapshot: {
        id: "txn-1",
        merchant: "Stellar Sound",
        amount: 42,
        auth_token: "secret-abc",
        occurred_at: "2026-05-01T10:00:00.000Z",
      },
    });
    expect(resolved.title).toBe("Stellar Sound");
    expect(resolved.semanticTime).toBe("2026-05-01T10:00:00.000Z");
    expect(resolved.tableDisplayName).toBe("Demo Transactions");
    expect(resolved.sourceType).toBe("demo");
    // Sensitive column redacted in both snapshot and key fields.
    expect(resolved.snapshot.auth_token).toBe(REDACTED_VALUE);
    expect(resolved.keyFields.find((f) => f.label === "Auth token")?.value).toBe(REDACTED_VALUE);
  });

  test("resolves the bound document id when a matching document exists", async () => {
    const docId = await insertBoundDoc("txn-1");
    const port = createGatewayRecordPort(db, analytics);
    const resolved = await port.resolve({
      reference: recordReference("demo_transactions", [{ name: "id", value: "txn-1" }]),
      snapshot: { id: "txn-1", merchant: "Stellar Sound", occurred_at: "2026-05-01T10:00:00.000Z" },
    });
    expect(resolved.boundDocumentId).toBe(docId);
  });

  test("resolves the bound document id when the catalog source id collapsed to the bare type", async () => {
    // A second account on the same table collapses the catalog source_id to the
    // bare type ("demo"), while the document stays account-qualified
    // ("demo:acct1"). The row→document inverse must still resolve.
    await analytics.ensureTable(txnSchema, "demo:acct2");
    const docId = await insertBoundDoc("txn-1");
    const port = createGatewayRecordPort(db, analytics);
    const resolved = await port.resolve({
      reference: recordReference("demo_transactions", [{ name: "id", value: "txn-1" }]),
      snapshot: { id: "txn-1", merchant: "Stellar Sound", occurred_at: "2026-05-01T10:00:00.000Z" },
    });
    expect(resolved.boundDocumentId).toBe(docId);
  });

  test("resolves the document in the cited row's stream when the table keys by stream", async () => {
    await analytics.ingestPage({
      tableName: "demo_transactions",
      records: [
        {
          id: "txn-1",
          merchant: "Stellar Sound",
          amount: 42,
          auth_token: "secret-abc",
          occurred_at: "2026-05-01T10:00:00.000Z",
        },
      ],
      sourceId: "demo:acct1",
      streamId: "device-a",
    });
    const sharedDocId = await insertBoundDoc("txn-1");
    const deviceDocId = await insertBoundDoc("txn-1", "device-a");
    const port = createGatewayRecordPort(db, analytics);
    const resolve = (primaryKeyColumns: { name: string; value: string }[]) =>
      port.resolve({
        reference: recordReference("demo_transactions", primaryKeyColumns),
        snapshot: {
          id: "txn-1",
          merchant: "Stellar Sound",
          occurred_at: "2026-05-01T10:00:00.000Z",
        },
      });
    const id = { name: "id", value: "txn-1" };
    expect((await resolve([id, { name: "_stream_id", value: "device-a" }])).boundDocumentId).toBe(
      deviceDocId,
    );
    expect((await resolve([id, { name: "_stream_id", value: "" }])).boundDocumentId).toBe(
      sharedDocId,
    );
    // A reference that names no stream is ambiguous on this table: no document is claimed.
    expect((await resolve([id])).boundDocumentId).toBeNull();
  });

  test("boundDocumentId is null when no co-described document exists", async () => {
    const port = createGatewayRecordPort(db, analytics);
    const resolved = await port.resolve({
      reference: recordReference("demo_transactions", [{ name: "id", value: "txn-999" }]),
      snapshot: {
        id: "txn-999",
        merchant: "Studio Northstar",
        occurred_at: "2026-05-02T10:00:00.000Z",
      },
    });
    expect(resolved.boundDocumentId).toBeNull();
  });

  test("rejects an unknown table", async () => {
    const port = createGatewayRecordPort(db, analytics);
    await expect(
      port.resolve({
        reference: recordReference("ghost_table", [{ name: "id", value: "x" }]),
        snapshot: { id: "x" },
      }),
    ).rejects.toBeInstanceOf(RecordPortError);
  });

  test("rejects a row from a timeless table (not timeline-eligible)", async () => {
    const port = createGatewayRecordPort(db, analytics);
    await expect(
      port.resolve({
        reference: recordReference("demo_profiles", [{ name: "id", value: "p1" }]),
        snapshot: { id: "p1", nickname: "Maya" },
      }),
    ).rejects.toMatchObject({ rejection: { reason: "not_timeline_eligible" } });
  });

  test("rejects a row from a table whose ambiguous anchor was dropped at ingest", async () => {
    // A device may push a schema anchored on a timezone-less TIMESTAMP, which
    // has no stable UTC instant. `ensureTable` keeps the rows but drops the
    // anchor, so the table is timeless and its rows are not citable.
    const shiftSchema: AnalyticsTableSchema = {
      tableName: "demo_shifts",
      displayName: "Demo Shifts",
      description: "Fictional shifts pushed with a timezone-less anchor",
      columns: [
        { name: "id", type: "VARCHAR", description: "Shift id" },
        { name: "site", type: "VARCHAR", description: "Site" },
        { name: "started_at", type: "TIMESTAMP", description: "Wall-clock start" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "started_at",
      record: { titleColumns: ["site"], keyColumns: ["site"] },
    };
    await analytics.ensureTable(shiftSchema, "demo:acct1");

    // The persisted contract, not the pushed one, decides eligibility.
    const persisted = await analytics.getRecordTableSchema("demo_shifts");
    expect(persisted?.semanticTimeColumn).toBeNull();

    // The row carries a non-empty anchor value, so the dropped anchor is the
    // only thing standing between it and a citation.
    const port = createGatewayRecordPort(db, analytics);
    await expect(
      port.resolve({
        reference: recordReference("demo_shifts", [{ name: "id", value: "shift-1" }]),
        snapshot: { id: "shift-1", site: "Northgate Depot", started_at: "2026-05-03 09:00:00" },
      }),
    ).rejects.toMatchObject({ rejection: { reason: "not_timeline_eligible" } });
  });

  test("rejects a row whose declared semantic-time value is empty", async () => {
    const port = createGatewayRecordPort(db, analytics);
    await expect(
      port.resolve({
        reference: recordReference("demo_transactions", [{ name: "id", value: "txn-2" }]),
        snapshot: { id: "txn-2", merchant: "Riverside Estate", occurred_at: null },
      }),
    ).rejects.toMatchObject({ rejection: { reason: "not_timeline_eligible" } });
  });
});
