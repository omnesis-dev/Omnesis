// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Addressing an analytics row over the wire, by every column its key names.
 *
 * A row key is written in TypeScript by the source, encoded once by the SDK,
 * carried as JSON, re-encoded by the gateway from the table's declaration and
 * finally compared against an expression DuckDB evaluates over stored rows.
 * Five representations of one idea, and a unit test can only ever see two of
 * them at a time. What this file asserts is that a key survives the whole
 * trip: the row a source names is the row that goes, and the row that stays is
 * still there afterwards.
 *
 * The case that makes it worth a real gateway is a table whose key is more
 * than one column, holding two rows that share each half of it. Addressed by
 * either half alone a delete takes both, so a source that leans on an
 * upstream's promise that one half is unique is one broken promise away from
 * removing a row it never named.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** A fictional ledger table, keyed by both the connection and the entry. */
const TABLE = "e2e_row_key_entries";

const SCHEMA = {
  tableName: TABLE,
  displayName: "Ledger entries",
  description: "Fictional rows for the row-key contract",
  columns: [
    { name: "item_id", type: "VARCHAR", description: "Connection" },
    { name: "entry_id", type: "VARCHAR", description: "Entry" },
    { name: "amount", type: "DOUBLE", description: "Amount" },
  ],
  primaryKey: ["item_id", "entry_id"],
  deleteKey: ["item_id", "entry_id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["entry_id"], keyColumns: ["item_id", "entry_id"] },
} as const;

const SOURCE = "synthetic:test@example.com";

let harness: SyntheticE2EHarness;

async function ingest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return harness.gatewayJson<Record<string, unknown>>("/analytics/ingest", {
    method: "POST",
    body: JSON.stringify({ tableName: TABLE, records: [], sourceId: SOURCE, ...body }),
  });
}

/**
 * A refused page, as the gateway answers it.
 *
 * Asserted on the message rather than on the throw: a 500 from anywhere in the
 * write path throws just as loudly, and would satisfy a bare rejection while
 * saying the opposite about whether the contract was understood.
 */
async function refuse(body: Record<string, unknown>): Promise<{ error?: string }> {
  const res = await harness.gatewayFetch("/analytics/ingest", {
    method: "POST",
    body: JSON.stringify({ tableName: TABLE, records: [], sourceId: SOURCE, ...body }),
  });
  expect(res.status).toBe(400);
  return (await res.json()) as { error?: string };
}

/** The keys this table's pending absences are recorded under. */
async function pendingAbsenceKeys(): Promise<string[]> {
  const result = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
    method: "POST",
    body: JSON.stringify({
      sql:
        `SELECT key_value FROM _analytics_absences ` +
        `WHERE table_name = '${TABLE}' ORDER BY key_value`,
    }),
  });
  return result.rows.map((row) => String(row[0]));
}

/** Every row the table holds, as `item/entry`. */
async function held(): Promise<string[]> {
  const result = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
    method: "POST",
    body: JSON.stringify({
      sql: `SELECT item_id, entry_id FROM ${TABLE} ORDER BY item_id, entry_id`,
    }),
  });
  return result.rows.map((row) => `${String(row[0])}/${String(row[1])}`);
}

async function seed(): Promise<void> {
  await ingest({
    schema: SCHEMA,
    records: [
      { item_id: "i1", entry_id: "e1", amount: 1 },
      { item_id: "i1", entry_id: "e2", amount: 2 },
      { item_id: "i2", entry_id: "e1", amount: 3 },
    ],
  });
}

describe("a row named by more than one column, over the wire", () => {
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "e2e-minimal" });
    await harness.start();
    // Nothing here depends on a synced source, and a sync loop writing
    // alongside these pages would make "what the table holds" ambiguous.
    await harness.stopSyncLoopsAndDrain(60_000);
    await seed();
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("the seeded rows are there, including the two that share each half", async () => {
    expect(await held()).toEqual(["i1/e1", "i1/e2", "i2/e1"]);
  });

  test("a delete names one row and only that row goes", async () => {
    const result = await ingest({ deletedKeys: [{ item_id: "i2", entry_id: "e1" }] });

    expect(result.deleted).toBe(1);
    expect(await held()).toEqual(["i1/e1", "i1/e2"]);
  });

  test("a snapshot omitting one row marks that row and no other", async () => {
    const result = await ingest({
      presentKeys: [{ item_id: "i1", entry_id: "e1" }],
      observationId: "row-key-obs-1",
    });

    // One omission recorded against a corpus of two, and nothing deleted on
    // the spot: absence is evidence, not an instruction.
    expect(result.absence).toMatchObject({ absent: 1, stored: 2, snapshot: 1 });
    expect(await held()).toEqual(["i1/e1", "i1/e2"]);
    // And recorded under the canonical form of the whole key, which is the
    // string every later arrival, tombstone and sweep has to reproduce.
    expect(await pendingAbsenceKeys()).toEqual([JSON.stringify(["i1", "e2"])]);
  });

  test("the row arriving again is what clears its absence, before any snapshot", async () => {
    // An arrival is stronger evidence than a snapshot naming the row, and it
    // is applied at ingest: the page that carries the row forgets its pending
    // absence. That is the assertion this makes, because it is the one the
    // key encoding has to get right — a key built differently on the write
    // than on the mark names nothing, and the absence survives the arrival to
    // be swept later.
    await ingest({ records: [{ item_id: "i1", entry_id: "e2", amount: 2 }] });

    // Gone on arrival, before any snapshot says anything.
    expect(await pendingAbsenceKeys()).toEqual([]);

    const later = await ingest({
      presentKeys: [
        { item_id: "i1", entry_id: "e1" },
        { item_id: "i1", entry_id: "e2" },
      ],
      observationId: "row-key-obs-2",
    });

    // Nothing left for the snapshot to clear, and nothing absent: the arrival
    // already did it. `cleared: 1` here would mean the arrival had missed.
    expect(later.absence).toMatchObject({ absent: 0, cleared: 0 });
    expect(await held()).toEqual(["i1/e1", "i1/e2"]);
  });

  test("a key that does not name the table's columns is refused", async () => {
    // Naming half a key would otherwise mean "and everything else that shares
    // this value", which is the deletion this whole contract exists to stop.
    const refusal = await refuse({ deletedKeys: [{ entry_id: "e1" }] });

    expect(refusal.error).toMatch(/names \(item_id, entry_id\)/);
    expect(await held()).toEqual(["i1/e1", "i1/e2"]);
  });

  test("the single-column spelling cannot address this table at all", async () => {
    const refusal = await refuse({ deletedIds: ["e1"], deleteKeyColumn: "entry_id" });

    expect(refusal.error).toMatch(/addressed by \(item_id, entry_id\)/);
    expect(await held()).toEqual(["i1/e1", "i1/e2"]);
  });
});
