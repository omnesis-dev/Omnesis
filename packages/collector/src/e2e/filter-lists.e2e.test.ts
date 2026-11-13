// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The lists a source publishes for its filterable fields, from the source to
 * the gateway's store, through the real collector sync loop and a spawned
 * gateway.
 *
 * The `filter-lists` universe seeds the filing twin, a synthetic source with
 * nothing real behind it: seven notes, the folders they are filed in (a tree)
 * and the groups they are shared with (each with members). The test changes
 * the folders and groups in memory between syncs and asserts that:
 *   - the first sync stores both lists whole, with the tree and the members;
 *   - a sync with nothing changed sends no list at all;
 *   - a rename, a move and a deletion each reach the store on the next
 *     ordinary sync, while no note is sent again;
 *   - a gateway whose lists were deleted is sent them again on the next sync,
 *     because it reports no digest for them;
 *   - a listing that fails leaves the stored list as it was, and the sync
 *     still completes.
 *
 * The cabinet is reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { FilingCabinet } from "@omnesis/provider-filing-synth";

const SOURCE_ID = "filing:northstar";
const FOLDERS = "extra.folderIds";
const GROUPS = "extra.groupId";

interface ListRow {
  field: string;
  device_id: string;
  generation: number;
  digest: string;
  item_count: number;
  staging_generation: number | null;
}

async function cabinet(): Promise<FilingCabinet> {
  const mod = await import("@omnesis/provider-filing-synth");
  const live = mod.getFilingCabinet(SOURCE_ID);
  if (!live) throw new Error(`no filing cabinet registered for ${SOURCE_ID}`);
  return live;
}

describe("filter lists: a source's folders and groups reach the gateway's store", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  /** The documents count each completed sync reported, in order. */
  const syncedDocuments: number[] = [];
  const failures: string[] = [];

  const lists = (): Map<string, ListRow> =>
    new Map(
      (
        db
          .prepare(
            `SELECT field, device_id, generation, digest, item_count, staging_generation
               FROM source_filter_lists WHERE source_id = ?`,
          )
          .all(SOURCE_ID) as ListRow[]
      ).map((row) => [row.field, row]),
    );

  /** The published items of a list, as `id → [label, parent]`. */
  const items = (field: string): Record<string, [string, string | null]> =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT i.item_id, i.label, i.parent_id
               FROM source_filter_lists l
               JOIN source_filter_items i
                 ON i.source_id = l.source_id AND i.field = l.field
                AND i.device_id = l.device_id AND i.generation = l.generation
              WHERE l.source_id = ? AND l.field = ?`,
          )
          .all(SOURCE_ID, field) as Array<{
          item_id: string;
          label: string;
          parent_id: string | null;
        }>
      ).map((row) => [row.item_id, [row.label, row.parent_id]]),
    );

  const members = (field: string, itemId: string): string[] =>
    (
      db
        .prepare(
          `SELECT m.identifier_type || ':' || m.identifier_value AS member
             FROM source_filter_lists l
             JOIN source_filter_item_members m
               ON m.source_id = l.source_id AND m.field = l.field
              AND m.device_id = l.device_id AND m.generation = l.generation
            WHERE l.source_id = ? AND l.field = ? AND m.item_id = ?
            ORDER BY member`,
        )
        .all(SOURCE_ID, field, itemId) as Array<{ member: string }>
    ).map((row) => row.member);

  const documentStamps = (): Array<{ external_id: string; updated_at: number }> =>
    db
      .prepare(
        "SELECT external_id, updated_at FROM documents WHERE source_id = ? ORDER BY external_id",
      )
      .all(SOURCE_ID) as Array<{ external_id: string; updated_at: number }>;

  const sync = () => harness.triggerSyncAndWait(SOURCE_ID, 60_000);

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "filter-lists" });
    await harness.start();
    harness.onStatusChange((change) => {
      if (change.sourceId !== SOURCE_ID) return;
      if (change.event === "sync.completed") {
        syncedDocuments.push(change.status.lastSyncStats?.documents ?? -1);
      }
      if (change.event === "sync.error") failures.push(change.status.lastError ?? "unknown error");
    });
    db = new Database(harness.getDbPath(), { readonly: true });
    await sync();
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 15_000);

  test("the first sync stores both lists whole, with the tree and the members", () => {
    expect(failures).toEqual([]);
    expect(syncedDocuments).toEqual([7]);
    expect(documentStamps()).toHaveLength(7);

    const stored = lists();
    expect([...stored.keys()].sort()).toEqual([FOLDERS, GROUPS]);
    expect(stored.get(FOLDERS)).toMatchObject({ device_id: "", generation: 1, item_count: 7 });
    expect(stored.get(GROUPS)).toMatchObject({ device_id: "", generation: 1, item_count: 2 });
    expect(stored.get(FOLDERS)?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.get(FOLDERS)?.staging_generation).toBeNull();

    expect(items(FOLDERS)).toEqual({
      "f-work": ["Work", null],
      "f-atlas": ["Atlas API", "f-work"],
      "f-budget": ["Budget", "f-work"],
      "f-home": ["Home", null],
      "f-receipts": ["Receipts", "f-home"],
      "f-receipts-2026": ["2026", "f-receipts"],
      // A folder no note is filed in is listed all the same.
      "f-empty": ["Someday", null],
    });
    // Groups are not a tree, so they have no parents.
    expect(items(GROUPS)).toEqual({
      "g-team": ["Atlas team", null],
      "g-household": ["Household", null],
    });
    expect(members(GROUPS, "g-team")).toEqual([
      "domain:example.org",
      "email:jamie.lopez@example.com",
      "email:maya.reeves@example.com",
    ]);
    expect(members(GROUPS, "g-household")).toEqual([
      "email:maya.reeves@example.com",
      "phone:+15550100142",
    ]);
    // Folders carry no members: the field does not list any.
    expect(members(FOLDERS, "f-work")).toEqual([]);
  });

  test("the collector is told the gateway's digests on its sync-state read", async () => {
    const state = await harness.gatewayJson<{ filterListDigests?: Record<string, string> }>(
      `/sync-state/${encodeURIComponent(SOURCE_ID)}`,
    );
    const stored = lists();
    expect(state.filterListDigests).toEqual({
      [FOLDERS]: stored.get(FOLDERS)?.digest,
      [GROUPS]: stored.get(GROUPS)?.digest,
    });
  });

  test("a sync with nothing changed lists the account again and sends nothing", async () => {
    const live = await cabinet();
    const before = lists();
    const stamps = documentStamps();
    const listed = { ...live.listings };

    await sync();

    expect(failures).toEqual([]);
    expect(live.listings).toEqual({ folders: listed.folders + 1, groups: listed.groups + 1 });
    // The generation only moves when a list is stored, so an unchanged one is proof nothing was.
    expect(lists()).toEqual(before);
    expect(syncedDocuments.at(-1)).toBe(0);
    expect(documentStamps()).toEqual(stamps);
  });

  test("a rename, a move and a deletion reach the store on the next sync, and no note is sent again", async () => {
    const live = await cabinet();
    const before = lists();
    const stamps = documentStamps();

    live.renameFolder("f-work", "Office");
    live.moveFolder("f-atlas", "f-home");
    live.deleteFolder("f-budget");
    await sync();

    expect(failures).toEqual([]);
    expect(items(FOLDERS)).toEqual({
      "f-work": ["Office", null],
      "f-atlas": ["Atlas API", "f-home"],
      "f-home": ["Home", null],
      "f-receipts": ["Receipts", "f-home"],
      "f-receipts-2026": ["2026", "f-receipts"],
      "f-empty": ["Someday", null],
    });
    const after = lists();
    expect(after.get(FOLDERS)).toMatchObject({ generation: 2, item_count: 6 });
    expect(after.get(FOLDERS)?.digest).not.toBe(before.get(FOLDERS)?.digest);
    // The groups did not change, so their list was not sent.
    expect(after.get(GROUPS)).toEqual(before.get(GROUPS));

    expect(syncedDocuments.at(-1)).toBe(0);
    expect(documentStamps()).toEqual(stamps);
  });

  test("a group's new name and members replace the old ones", async () => {
    const live = await cabinet();
    live.renameGroup("g-team", "Atlas crew");
    live.setGroupMembers("g-team", [{ type: "email", value: "david.lin@example.org" }]);
    await sync();

    expect(failures).toEqual([]);
    expect(items(GROUPS)["g-team"]).toEqual(["Atlas crew", null]);
    expect(members(GROUPS, "g-team")).toEqual(["email:david.lin@example.org"]);
    expect(members(GROUPS, "g-household")).toEqual([
      "email:maya.reeves@example.com",
      "phone:+15550100142",
    ]);
    expect(syncedDocuments.at(-1)).toBe(0);
  });

  test("a listing that fails leaves the stored list as it was, and the sync completes", async () => {
    const live = await cabinet();
    const before = lists();
    const stored = items(FOLDERS);
    const completed = syncedDocuments.length;

    live.renameFolder("f-home", "House");
    live.failListings(true);
    await sync();

    expect(failures).toEqual([]);
    expect(syncedDocuments).toHaveLength(completed + 1);
    expect(lists()).toEqual(before);
    expect(items(FOLDERS)).toEqual(stored);

    // Once the account can be listed again, the change that was waiting arrives.
    live.failListings(false);
    await sync();
    expect(items(FOLDERS)["f-home"]).toEqual(["House", null]);
  });

  test("a gateway whose lists were deleted is sent them again on the next sync", async () => {
    const expectedFolders = items(FOLDERS);
    const expectedGroups = items(GROUPS);
    const digests = new Map([...lists()].map(([field, row]) => [field, row.digest]));
    const stamps = documentStamps();

    const writable = new Database(harness.getDbPath());
    try {
      writable.pragma("busy_timeout = 10000");
      writable.exec(`
        DELETE FROM source_filter_item_members;
        DELETE FROM source_filter_items;
        DELETE FROM source_filter_lists;
      `);
    } finally {
      writable.close();
    }
    expect(lists().size).toBe(0);
    const state = await harness.gatewayJson<{ filterListDigests?: Record<string, string> }>(
      `/sync-state/${encodeURIComponent(SOURCE_ID)}`,
    );
    expect(state.filterListDigests).toEqual({});

    await sync();

    expect(failures).toEqual([]);
    expect(items(FOLDERS)).toEqual(expectedFolders);
    expect(items(GROUPS)).toEqual(expectedGroups);
    expect(members(GROUPS, "g-team")).toEqual(["email:david.lin@example.org"]);
    // The same lists, so the same digests; only the lists travelled.
    expect(new Map([...lists()].map(([field, row]) => [field, row.digest]))).toEqual(digests);
    expect(syncedDocuments.at(-1)).toBe(0);
    expect(documentStamps()).toEqual(stamps);
  });
});
