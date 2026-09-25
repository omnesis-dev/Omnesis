// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-partition snapshot claims, through the structured sync branch.
 *
 * A claim reaches the gateway from `sync` and from `syncStructured` by
 * different call sites, and the structured one is where every hybrid source
 * lives — a Notion database, a repository, a calendar, each of which is both a
 * table's worth of rows and a partition's worth of documents. The two branches
 * were written apart, so proving one says nothing about the other.
 *
 * The property has two halves that have to be proved together: sweeping the
 * right partition looks exactly like sweeping nothing unless the same cycle
 * also leaves the unreadable one alone.
 *
 * The synthetic Notion double partitions by database, the way the real source
 * does, and the `partitioned` impairment makes every second database
 * unreadable while deleting one of the readable ones outright. Its analytics
 * rows are deliberately outside the assertions: a table has no per-partition
 * form, so a claiming cycle says nothing about its rows at all — that is the
 * behaviour, not an omission.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** A hybrid source: analytics rows and documents from one `syncStructured`. */
const SOURCE = "notion-databases:user_john_smith";

/** Snapshots that must agree before an absence is due. The shipped value. */
const MIN_OBSERVATIONS = 3;

const ABSENCE_CONFIG = {
  gateway: {
    snapshotAbsence: {
      minObservations: MIN_OBSERVATIONS,
      // Spent by the sync round trip itself, so no test sleeps.
      minAge: "10ms",
      maxMarksPerSnapshot: 200,
      deletionGrace: "1ms",
    },
  },
};

let harness: SyntheticE2EHarness;

function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** What the gateway holds for this source, with the partition each names. */
function storedRows(): Array<{ externalId: string; partition: string }> {
  return readDb((db) =>
    db
      .prepare<[string], { external_id: string; partition_key: string | null }>(
        // Insertion order, not id order: the double makes every second database
        // unreadable in the order the fixture lists them, and the split below
        // has to agree with that. Sorting by external id would pair the halves
        // off against a different ordering entirely.
        "SELECT external_id, partition_key FROM documents WHERE source_id = ? ORDER BY rowid",
      )
      .all(SOURCE)
      .map((r) => ({ externalId: r.external_id, partition: r.partition_key ?? "" })),
  );
}

function storedIds(): string[] {
  return storedRows().map((r) => r.externalId);
}

/** Absences this source currently carries, still short of their deadline. */
function pendingAbsences(): string[] {
  return readDb((db) =>
    db
      .prepare<[string], { external_id: string }>(
        "SELECT external_id FROM document_absences WHERE source_id = ? ORDER BY external_id",
      )
      .all(SOURCE)
      .map((r) => r.external_id),
  );
}

async function drainSweep(maxCycles = 8): Promise<void> {
  let previous = -1;
  for (let i = 0; i < maxCycles; i++) {
    await harness.gatewayJson("/admin/background/run/absence.sweep", { method: "POST" });
    await harness.gatewayJson("/admin/background/run/absence.sweep", { method: "POST" });
    const total = storedIds().length;
    if (total === previous) return;
    previous = total;
  }
  throw new Error(`the absence sweep was still deleting after ${maxCycles} cycles`);
}

/** One sync of this source, with the given read impairment in force. */
async function syncUnder(spec: string | null): Promise<void> {
  if (spec) process.env.OMNESIS_SYNTH_READ_IMPAIRMENT = spec;
  else delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
  try {
    await harness.triggerSyncAndWait(SOURCE, 120_000);
  } finally {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
  }
}

describe("per-partition claims through the structured branch", () => {
  let readable: string[];
  let unreadable: string[];

  beforeAll(async () => {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
    harness = new SyntheticE2EHarness({
      // Synthetic, for the on-demand background trigger `drainSweep` uses —
      // `/admin/background/run/:task` is a test affordance and 404s otherwise.
      // The sweep itself is an ordinary periodic job, and nothing this file
      // asserts about claims is behind a gate.
      gatewayMode: "synthetic",
      universe: "default",
      extraGatewayConfig: ABSENCE_CONFIG,
    });
    await harness.start();
    await harness.triggerSyncAndWait(SOURCE, 120_000);

    // The double makes every second database unreadable, in the order the
    // fixture lists them. The split is read back off the corpus rather than
    // assumed, so this stays true if the fixture grows.
    const rows = storedRows();
    const partitions = [...new Set(rows.map((r) => r.partition))];
    const broken = new Set(partitions.filter((_, i) => i % 2 === 1));
    readable = rows.filter((r) => !broken.has(r.partition)).map((r) => r.externalId);
    unreadable = rows.filter((r) => broken.has(r.partition)).map((r) => r.externalId);
  }, 240_000);

  afterAll(async () => {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
    await harness?.destroy();
  });

  test("a healthy structured cycle stamps every document with its database", () => {
    // Without this the claims below would name partitions no stored document is
    // in, and the sweep would touch nothing — which passes for the wrong reason.
    expect(readable.length).toBeGreaterThan(0);
    expect(unreadable.length).toBeGreaterThan(0);
    expect(storedRows().every((r) => r.partition !== "")).toBe(true);
  });

  test("a database deleted upstream is swept while an unreadable one is untouched", async () => {
    const before = storedIds();
    for (let i = 0; i < MIN_OBSERVATIONS; i++) {
      await syncUnder(`${SOURCE}:partitioned:1`);
    }

    // Only documents from the claimed, readable half are marked. The unreadable
    // half is evidence of nothing, however many cycles omit it.
    const marked = pendingAbsences();
    expect(marked.length).toBeGreaterThan(0);
    for (const id of marked) expect(readable).toContain(id);

    await drainSweep();

    const after = storedIds();
    expect(after).toEqual(before.filter((id) => !marked.includes(id)));
    // Said the other way round, because this is the half the all-or-nothing
    // shape could not have: every document of a database that would not open is
    // still here.
    for (const id of unreadable) expect(after).toContain(id);
  }, 300_000);

  test("the unreadable databases recover, and so does the one that was swept", async () => {
    // The corpus is whole again — not merely unchanged. The documents the
    // cycles above deleted were deleted because the source stopped naming them,
    // and a repaired read names them again.
    //
    // Driven to a fixed point rather than with one sync: this source reads one
    // database per cycle, so re-walking four of them takes four. Stopping at
    // one would assert against a corpus still halfway through its own repair.
    let previous = -1;
    for (let i = 0; i < 8 && storedIds().length !== previous; i++) {
      previous = storedIds().length;
      await syncUnder(null);
    }
    expect(storedIds().sort()).toEqual([...readable, ...unreadable].sort());
  }, 240_000);
});
