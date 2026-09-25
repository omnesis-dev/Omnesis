// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  REPLICA_CLAIM_RETENTION_MS,
  clearClaimsForDevice,
  clearClaimsForExternalIds,
  clearClaimsForSource,
  clearRestoredClaims,
  countDisputedBySource,
  countRestoredByMember,
  createReplicaDeletionClaimsTable,
  hasAnyReplicaClaims,
  judgeTombstones,
  listClaimedExternalIds,
  listDeletersByRestorer,
  listDisputedExternalIds,
  listRestoredExternalIdsByDevice,
  pruneUncontestedClaims,
  recordDeletionClaims,
  recordPresenceClaims,
  recordRestorerOmissions,
} from "./ReplicaDeletionClaimRepository.js";
import type { Db } from "../types.js";

const PROVIDER = "apple";
const SOURCE = "apple-notes:local";
const T0 = 1_700_000_000_000;

function rows(db: Db) {
  return db
    .prepare<
      [],
      { external_id: string; device_id: string; role: string; at: number }
    >("SELECT external_id, device_id, role, at FROM replica_deletion_claims ORDER BY external_id, device_id")
    .all();
}

describe("replica deletion claims", () => {
  let db: Db;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:") as unknown as Db;
    createReplicaDeletionClaimsTable(db);
    // The prune consults the members' cursor rows; the ledger otherwise
    // stands alone.
    db.exec(
      "CREATE TABLE sync_state (source_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', last_synced_at TEXT, PRIMARY KEY (source_id, device_id))",
    );
  });

  afterEach(() => db.close());

  test("an item with no history is fresh; nothing is written until the deletion lands", () => {
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-1", "n-2"], T0)).toEqual({
      fresh: ["n-1", "n-2"],
      settled: [],
      disputed: [],
      newlyDisputed: 0,
    });
    expect(rows(db)).toEqual([]);
    expect(hasAnyReplicaClaims(db)).toBe(false);

    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    expect(rows(db)).toEqual([{ external_id: "n-1", device_id: "mac-a", role: "deleted", at: T0 }]);
    expect(hasAnyReplicaClaims(db)).toBe(true);
  });

  test("a sibling that brings a deleted item back disputes it; the deleter's repeats are not fresh", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1", "unrelated"], T0 + 1);
    expect(rows(db)).toEqual([
      { external_id: "n-1", device_id: "mac-a", role: "deleted", at: T0 },
      { external_id: "n-1", device_id: "mac-b", role: "restored", at: T0 + 1 },
    ]);
    expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["n-1", "unrelated"])).toEqual(["n-1"]);

    // The deleter asserting the same deletion again changes nothing and is
    // not a new dispute; its verdict keeps its original time.
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0 + 2)).toEqual({
      fresh: [],
      settled: [],
      disputed: ["n-1"],
      newlyDisputed: 0,
    });
    expect(rows(db)[0]).toEqual({
      external_id: "n-1",
      device_id: "mac-a",
      role: "deleted",
      at: T0,
    });

    // A third member weighing in against the restorer is a new voice, but
    // the item stays disputed while the restorer stands by it.
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 3)).toEqual({
      fresh: [],
      settled: [],
      disputed: ["n-1"],
      newlyDisputed: 1,
    });
    expect(countDisputedBySource(db)).toEqual(new Map([[SOURCE, 1]]));
    expect(countRestoredByMember(db, SOURCE)).toEqual(new Map([["mac-b", 1]]));
  });

  test("a restorer's dispute names every member that reported the item deleted, per source", () => {
    expect(listDeletersByRestorer(db, SOURCE)).toEqual(new Map());
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 1);
    judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 2);
    // Another source's ledger stays out of this one's answer.
    recordDeletionClaims(db, PROVIDER, "apple-notes:other", "mac-d", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, "apple-notes:other", "mac-b", ["n-1"], T0 + 1);

    const deleters = listDeletersByRestorer(db, SOURCE);
    expect([...deleters.keys()]).toEqual(["mac-b"]);
    expect(deleters.get("mac-b")!.sort()).toEqual(["mac-a", "mac-c"]);
    expect(listDeletersByRestorer(db, "apple-notes:other")).toEqual(
      new Map([["mac-b", ["mac-d"]]]),
    );
  });

  test("the restorer's own tombstone settles the item; its history stays until pruned", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 1);
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 2)).toEqual({
      fresh: [],
      settled: ["n-1"],
      disputed: [],
      newlyDisputed: 0,
    });
    // Every row is now `deleted`, so a sibling still mid-bootstrap that
    // brings the item back disputes it rather than reopening a fresh cycle.
    expect(rows(db)).toEqual([
      { external_id: "n-1", device_id: "mac-a", role: "deleted", at: T0 },
      { external_id: "n-1", device_id: "mac-b", role: "deleted", at: T0 + 2 },
    ]);
    expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["n-1"])).toEqual([]);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 3);
    expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["n-1"])).toEqual(["n-1"]);
  });

  test("the holder repeating its tombstone before any sibling bootstrapped keeps the history", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0 + 1).settled).toEqual([
      "n-1",
    ]);
    expect(rows(db)).toEqual([{ external_id: "n-1", device_id: "mac-a", role: "deleted", at: T0 }]);
    // The sibling's late bootstrap is a dispute, not a new document.
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 2);
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0 + 3).disputed).toEqual([
      "n-1",
    ]);
  });

  test("a member's restores can be listed and withdrawn per member, per sibling set, or wholesale", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1", "n-2"], T0 + 1);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 1);
    expect(listRestoredExternalIdsByDevice(db, PROVIDER, SOURCE, "mac-b").sort()).toEqual([
      "n-1",
      "n-2",
    ]);
    expect(listRestoredExternalIdsByDevice(db, PROVIDER, SOURCE, "mac-a")).toEqual([]);

    clearRestoredClaims(db, SOURCE, { deviceId: "mac-c" });
    expect(countRestoredByMember(db, SOURCE)).toEqual(new Map([["mac-b", 2]]));
    clearRestoredClaims(db, SOURCE, { exceptDeviceId: "mac-a" });
    expect(countRestoredByMember(db, SOURCE)).toEqual(new Map());
    // The deletions themselves are untouched.
    expect(rows(db).map((r) => `${r.external_id}/${r.device_id}/${r.role}`)).toEqual([
      "n-1/mac-a/deleted",
      "n-2/mac-a/deleted",
    ]);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 2);
    clearRestoredClaims(db, SOURCE, "all");
    expect(countRestoredByMember(db, SOURCE)).toEqual(new Map());
  });

  test("with two restorers, the item settles only once both have agreed", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 1);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 1);
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 2).disputed).toEqual([
      "n-1",
    ]);
    expect(countRestoredByMember(db, SOURCE)).toEqual(new Map([["mac-c", 1]]));
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 3).settled).toEqual([
      "n-1",
    ]);
    expect(rows(db).map((r) => r.role)).toEqual(["deleted", "deleted", "deleted"]);
  });

  test("a deleter that contributes the item again withdraws its verdict", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-2"], T0 + 1);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0 + 2);
    // n-1: the only deleter recanted → no history. n-2: same, and the
    // restorer's row goes with it — a restore with nothing to dispute is
    // just a document.
    expect(rows(db)).toEqual([]);
  });

  test("a deleter that holds the item again while another deleter stands becomes a restorer", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 1);
    judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 2);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1"], T0 + 3);
    expect(rows(db)).toEqual([
      { external_id: "n-1", device_id: "mac-a", role: "restored", at: T0 + 3 },
      { external_id: "n-1", device_id: "mac-b", role: "restored", at: T0 + 1 },
      { external_id: "n-1", device_id: "mac-c", role: "deleted", at: T0 + 2 },
    ]);
    // mac-c's repeated tombstone now has two restorers to convince.
    expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 4).disputed).toEqual([
      "n-1",
    ]);
  });

  test("a detached device's verdicts are void, and an item left with no deleter loses its history", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1", "n-2"], T0 + 1);
    judgeTombstones(db, PROVIDER, SOURCE, "mac-c", ["n-2"], T0 + 2);

    clearClaimsForDevice(db, SOURCE, "mac-b");
    expect(rows(db)).toEqual([
      { external_id: "n-1", device_id: "mac-a", role: "deleted", at: T0 },
      { external_id: "n-2", device_id: "mac-a", role: "deleted", at: T0 },
      { external_id: "n-2", device_id: "mac-c", role: "deleted", at: T0 + 2 },
    ]);

    clearClaimsForDevice(db, SOURCE, "mac-a");
    expect(rows(db)).toEqual([
      { external_id: "n-2", device_id: "mac-c", role: "deleted", at: T0 + 2 },
    ]);
  });

  test("the operator's own delete, and a source wipe, leave nothing to dispute", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1", "n-2"], T0 + 1);
    clearClaimsForExternalIds(db, PROVIDER, SOURCE, ["n-1"]);
    expect(listClaimedExternalIds(db, PROVIDER, SOURCE, ["n-1", "n-2"])).toEqual(["n-2"]);
    clearClaimsForSource(db, SOURCE);
    expect(rows(db)).toEqual([]);
  });

  test("uncontested deletions are pruned after the retention; disputed ones are kept", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["old", "disputed"], T0);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["disputed"], T0 + 1);
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["recent"], T0 + 1000);
    const now = T0 + REPLICA_CLAIM_RETENTION_MS + 500;
    expect(pruneUncontestedClaims(db, SOURCE, now)).toBe(1);
    expect(rows(db).map((r) => `${r.external_id}/${r.device_id}`)).toEqual([
      "disputed/mac-a",
      "disputed/mac-b",
      "recent/mac-a",
    ]);
  });

  test("nothing is pruned while a member of the source still has a reset cursor", () => {
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["old"], T0);
    db.prepare(
      "INSERT INTO sync_state (source_id, device_id, last_synced_at) VALUES (?, ?, NULL)",
    ).run(SOURCE, "mac-b");
    const now = T0 + REPLICA_CLAIM_RETENTION_MS + 500;
    expect(pruneUncontestedClaims(db, SOURCE, now)).toBe(0);
    // The member bootstrapped; the retention applies again.
    db.prepare("UPDATE sync_state SET last_synced_at = ? WHERE device_id = ?").run(
      "2026-03-01T00:00:00.000Z",
      "mac-b",
    );
    expect(pruneUncontestedClaims(db, SOURCE, now)).toBe(1);
  });

  describe("a restorer's omissions", () => {
    const policy = { minObservations: 3, minAgeMs: 300, spacingMs: 100 };
    const omit = (device: string, ids: string[], at: number) =>
      recordRestorerOmissions(
        db,
        PROVIDER,
        SOURCE,
        device,
        { omitted: ids, named: [] },
        policy,
        at,
      );
    const name = (device: string, ids: string[], at: number) =>
      recordRestorerOmissions(
        db,
        PROVIDER,
        SOURCE,
        device,
        { omitted: [], named: ids },
        policy,
        at,
      );
    const counter = (id: string, device: string) =>
      db
        .prepare<
          [string, string],
          { omissions: number; first_omitted_at: number | null; last_omitted_at: number | null }
        >("SELECT omissions, first_omitted_at, last_omitted_at FROM replica_deletion_claims WHERE external_id = ? AND device_id = ?")
        .get(id, device);

    beforeEach(() => {
      recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["n-1", "n-2"], T0);
      recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1", "n-2"], T0 + 1);
    });

    test("count only when spaced, and mature only once both currencies are spent", () => {
      expect(omit("mac-b", ["n-1"], T0 + 10)).toEqual([]);
      // Inside the spacing window: no independent evidence, nothing written.
      expect(omit("mac-b", ["n-1"], T0 + 50)).toEqual([]);
      expect(counter("n-1", "mac-b")).toEqual({
        omissions: 1,
        first_omitted_at: T0 + 10,
        last_omitted_at: T0 + 10,
      });
      expect(omit("mac-b", ["n-1"], T0 + 120)).toEqual([]);
      // Three observations but the age has not passed.
      expect(omit("mac-b", ["n-1"], T0 + 230)).toEqual([]);
      expect(counter("n-1", "mac-b")?.omissions).toBe(3);
      // The age passes: the next spaced omission is the verdict.
      expect(omit("mac-b", ["n-1"], T0 + 340)).toEqual(["n-1"]);
    });

    test("naming the item again starts the clock over", () => {
      omit("mac-b", ["n-1"], T0 + 10);
      omit("mac-b", ["n-1"], T0 + 120);
      name("mac-b", ["n-1"], T0 + 200);
      expect(counter("n-1", "mac-b")).toEqual({
        omissions: 0,
        first_omitted_at: null,
        last_omitted_at: null,
      });
      expect(omit("mac-b", ["n-1"], T0 + 400)).toEqual([]);
      expect(counter("n-1", "mac-b")?.first_omitted_at).toBe(T0 + 400);
    });

    test("the item arriving on a page also starts the clock over", () => {
      omit("mac-b", ["n-1"], T0 + 10);
      recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 20);
      expect(counter("n-1", "mac-b")?.omissions).toBe(0);
    });

    test("only the omitting member's own restores count; other members and deleters are untouched", () => {
      expect(omit("mac-a", ["n-1"], T0 + 10)).toEqual([]);
      expect(counter("n-1", "mac-a")?.omissions).toBe(0);
      expect(omit("mac-c", ["n-1"], T0 + 10)).toEqual([]);
      expect(counter("n-1", "mac-b")?.omissions).toBe(0);
    });

    test("a matured omission is disputed while another member still holds the item", () => {
      recordPresenceClaims(db, PROVIDER, SOURCE, "mac-c", ["n-1"], T0 + 2);
      omit("mac-b", ["n-1"], T0 + 10);
      omit("mac-b", ["n-1"], T0 + 120);
      omit("mac-b", ["n-1"], T0 + 230);
      const matured = omit("mac-b", ["n-1"], T0 + 340);
      expect(matured).toEqual(["n-1"]);
      const verdict = judgeTombstones(db, PROVIDER, SOURCE, "mac-b", matured, T0 + 340);
      expect(verdict).toMatchObject({ settled: [], disputed: ["n-1"], newlyDisputed: 1 });
      expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["n-1"])).toEqual(["n-1"]);
      // mac-b's row on n-1 reads deleted now; its restore of n-2 is untouched.
      expect(countRestoredByMember(db, SOURCE)).toEqual(
        new Map([
          ["mac-b", 1],
          ["mac-c", 1],
        ]),
      );
      // The last restorer's own matured omission settles it.
      omit("mac-c", ["n-1"], T0 + 400);
      omit("mac-c", ["n-1"], T0 + 510);
      omit("mac-c", ["n-1"], T0 + 620);
      const last = omit("mac-c", ["n-1"], T0 + 730);
      expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-c", last, T0 + 730).settled).toEqual([
        "n-1",
      ]);
    });

    test("a matured omission applied as a tombstone settles the item like any verdict", () => {
      omit("mac-b", ["n-1"], T0 + 10);
      omit("mac-b", ["n-1"], T0 + 120);
      omit("mac-b", ["n-1"], T0 + 230);
      const matured = omit("mac-b", ["n-1"], T0 + 340);
      expect(judgeTombstones(db, PROVIDER, SOURCE, "mac-b", matured, T0 + 340).settled).toEqual([
        "n-1",
      ]);
      expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["n-1", "n-2"])).toEqual(["n-2"]);
    });
  });

  test("a reader on another connection sees what the writer recorded", () => {
    // The gateway writes the ledger from its writer worker and reads it from
    // the main thread: two connections to one file. A reader that asked while
    // the ledger was empty must still see the writer's later rows.
    const path = `/tmp/omnesis-test-${randomUUID()}.db`;
    const writer = new SqliteDatabase(path) as unknown as Db;
    const reader = new SqliteDatabase(path, { readonly: true }) as unknown as Db;
    try {
      createReplicaDeletionClaimsTable(writer);
      expect(hasAnyReplicaClaims(reader)).toBe(false);
      expect(listClaimedExternalIds(reader, PROVIDER, SOURCE, ["n-1"])).toEqual([]);

      recordDeletionClaims(writer, PROVIDER, SOURCE, "mac-a", ["n-1"], T0);
      recordPresenceClaims(writer, PROVIDER, SOURCE, "mac-b", ["n-1"], T0 + 1);

      expect(hasAnyReplicaClaims(reader)).toBe(true);
      expect(listClaimedExternalIds(reader, PROVIDER, SOURCE, ["n-1"])).toEqual(["n-1"]);
      expect(countDisputedBySource(reader)).toEqual(new Map([[SOURCE, 1]]));
    } finally {
      reader.close();
      writer.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(path + suffix)) unlinkSync(path + suffix);
      }
    }
  });
});

describe("histories of the two planes never touch", () => {
  test("a detached deleter's document restore is not kept alive by a row's deleter", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    createReplicaDeletionClaimsTable(db);
    // A document and a row share an id, as a structured source's do.
    recordDeletionClaims(db, "things", "things:local", "mac-a", ["task-1"], 1);
    recordPresenceClaims(db, "things", "things:local", "mac-b", ["task-1"], 2);
    recordDeletionClaims(db, "analytics:things_tasks", "things:local", "mac-c", ["task-1"], 3);
    clearClaimsForDevice(db, "things:local", "mac-a");
    // The document's only deleter left, so its restore has nothing to dispute…
    expect(listDisputedExternalIds(db, "things", "things:local", ["task-1"])).toEqual([]);
    // …while the row's history, under its own namespace, stands.
    expect(
      listClaimedExternalIds(db, "analytics:things_tasks", "things:local", ["task-1"]),
    ).toEqual(["task-1"]);
  });
});
