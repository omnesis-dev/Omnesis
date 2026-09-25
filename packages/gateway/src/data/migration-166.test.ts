// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { renamePairingRedemptionReceipts } from "./migration-166-pairing-receipts.js";
import type { Db } from "./types.js";

let db: Db;

function tables(): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createV152AccessTables(db);
});

afterEach(() => db.close());

test("renames the agent-only receipts table, keeping its rows, idempotently", () => {
  db.prepare(
    `INSERT INTO agent_pairing_redemption_receipts
       (idempotency_key_hash, pairing_code_hash, request_fingerprint, sealed_response, created_at, expires_at)
     VALUES ('k', 'c', 'f', '{}', 1, 2)`,
  ).run();

  renamePairingRedemptionReceipts(db);
  renamePairingRedemptionReceipts(db);

  expect(tables()).toContain("pairing_redemption_receipts");
  expect(tables()).not.toContain("agent_pairing_redemption_receipts");
  expect(db.prepare("SELECT COUNT(*) AS count FROM pairing_redemption_receipts").get()).toEqual({
    count: 1,
  });
  const indexes = db
    .prepare<[], { name: string }>(
      "SELECT name FROM pragma_index_list('pairing_redemption_receipts')",
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toContain("idx_pairing_redemption_receipts_expiry");
});

test("creates the table when neither name exists", () => {
  db.exec("DROP TABLE agent_pairing_redemption_receipts");
  renamePairingRedemptionReceipts(db);
  expect(tables()).toContain("pairing_redemption_receipts");
});
