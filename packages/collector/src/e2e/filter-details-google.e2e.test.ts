// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The details mail and Drive records carry for a filter to match on,
 * and the lists the two sources publish, from the source to the gateway's
 * stores through the real collector sync loop and a spawned gateway.
 *
 * The `e2e-minimal` universe seeds the Google doubles: three messages with
 * built-in and user labels, and three files in a tree of folders. The doubles
 * hold the mailbox and the Drive in memory, so the test renames a label, moves
 * a folder, labels a message and moves a file between syncs. It asserts that:
 *   - an account read by the build before these details holds records at
 *     version 1 with no label or folder ids;
 *   - upgrading the host changes nothing by itself: an ordinary sync leaves
 *     those records as they were, and only a read from an empty cursor gives
 *     every record the detail and version 2, on the same documents;
 *   - records carry ids, never names, and an empty list when they have none;
 *   - each source's list is stored whole, shared by every device, with the
 *     folder tree's parents;
 *   - the gateway reads both sources' declarations as fields it can apply,
 *     and stores each source's resync cost sentence;
 *   - a label nested by its name is stored under its parent;
 *   - a renamed label and a renamed or moved folder reach the stored lists on
 *     the next ordinary sync while no record is sent again;
 *   - a label put on or taken off a message, and a file moved to another
 *     folder, send that one record again.
 *
 * The doubles are reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { filterFieldsFor } from "@omnesis/gateway/src/access/filter-fields.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { DriveTwinAccount, GmailTwinMailbox } from "@omnesis/provider-google-synth";

const GMAIL = "gmail:john.smith@example.com";
const DRIVE = "google-drive:john.smith@example.com";
const LABELS = "extra.labelIds";
const FOLDERS = "extra.folderIds";

interface StoredRecord {
  id: string;
  external_id: string;
  updated_at: string;
  source_version: number;
  metadata: string;
}

type FilterFieldsDb = Parameters<typeof filterFieldsFor>[0];

describe("filter details: Gmail labels and Drive folders reach the gateway's stores", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  let mailbox: GmailTwinMailbox;
  let drive: DriveTwinAccount;
  /** The documents count each completed sync reported, per source, in order. */
  const synced: Record<string, number[]> = { [GMAIL]: [], [DRIVE]: [] };
  const failures: string[] = [];

  const records = (sourceId: string): StoredRecord[] =>
    db
      .prepare(
        `SELECT id, external_id, updated_at, source_version, metadata
           FROM documents WHERE source_id = ? ORDER BY external_id`,
      )
      .all(sourceId) as StoredRecord[];

  /** Each record's value at a metadata path, `undefined` when the record does not hold it. */
  const details = (sourceId: string, key: "labelIds" | "folderIds"): Record<string, unknown> =>
    Object.fromEntries(
      records(sourceId).map((record) => [
        record.external_id,
        (JSON.parse(record.metadata) as { extra?: Record<string, unknown> }).extra?.[key],
      ]),
    );

  const versions = (sourceId: string): number[] => [
    ...new Set(records(sourceId).map((record) => record.source_version)),
  ];

  const stamps = (sourceId: string) =>
    records(sourceId).map(({ id, external_id, updated_at }) => ({ id, external_id, updated_at }));

  const list = (sourceId: string, field: string) =>
    db
      .prepare(
        `SELECT device_id, generation, item_count, staging_generation
           FROM source_filter_lists WHERE source_id = ? AND field = ?`,
      )
      .get(sourceId, field) as
      | { device_id: string; generation: number; item_count: number; staging_generation: null }
      | undefined;

  /** The published items of a list, as `id → [label, parent]`. */
  const items = (sourceId: string, field: string): Record<string, [string, string | null]> =>
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
          .all(sourceId, field) as Array<{
          item_id: string;
          label: string;
          parent_id: string | null;
        }>
      ).map((row) => [row.item_id, [row.label, row.parent_id]]),
    );

  const sync = (sourceId: string) => harness.triggerSyncAndWait(sourceId, 60_000);

  /** Send the source's host back to an empty cursor, keeping every stored document. */
  async function rereadFromStart(sourceId: string): Promise<void> {
    const headers = {
      Authorization: `Bearer ${harness.deviceForSource(sourceId).token}`,
      "Content-Type": "application/json",
    };
    const path = `${harness.gatewayUrl}/sync-state/${encodeURIComponent(sourceId)}`;
    const state = (await (await fetch(path, { headers })).json()) as { wipeEpoch?: number };
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: { offset: 0 }, writeEpoch: state.wipeEpoch }),
    });
    expect(await response.json()).toEqual({ ok: true });
  }

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    harness.onStatusChange((change) => {
      const counts = synced[change.sourceId];
      if (!counts) return;
      if (change.event === "sync.completed") {
        counts.push(change.status.lastSyncStats?.documents ?? -1);
      }
      if (change.event === "sync.error") failures.push(change.status.lastError ?? "unknown error");
    });
    db = new Database(harness.getDbPath(), { readonly: true });
    const twins = await import("@omnesis/provider-google-synth");
    const liveMailbox = twins.getGmailTwin(GMAIL);
    const liveDrive = twins.getDriveTwin(DRIVE);
    if (!liveMailbox || !liveDrive) throw new Error("the Google doubles are not registered");
    mailbox = liveMailbox;
    drive = liveDrive;
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 30_000);

  test("an account read by the build before these details holds records without them, at version 1", async () => {
    mailbox.beforeFilterDetails = true;
    drive.beforeFilterDetails = true;
    harness.setSourceVersion(GMAIL, 1);
    harness.setSourceVersion(DRIVE, 1);

    await sync(GMAIL);
    await sync(DRIVE);

    expect(failures).toEqual([]);
    expect(versions(GMAIL)).toEqual([1]);
    expect(versions(DRIVE)).toEqual([1]);
    expect(details(GMAIL, "labelIds")).toEqual({
      "synth-gmail-001": undefined,
      "synth-gmail-002": undefined,
      "synth-gmail-003": undefined,
    });
    expect(details(DRIVE, "folderIds")).toEqual({
      "synth-gdrive-001": undefined,
      "synth-gdrive-002": undefined,
      "synth-gdrive-003": undefined,
    });
  }, 180_000);

  test("upgrading the host changes no stored record: an ordinary sync sends nothing again", async () => {
    const before = { gmail: stamps(GMAIL), drive: stamps(DRIVE) };
    mailbox.beforeFilterDetails = false;
    drive.beforeFilterDetails = false;
    harness.setSourceVersion(GMAIL, 2);
    harness.setSourceVersion(DRIVE, 2);

    await sync(GMAIL);
    await sync(DRIVE);

    expect(failures).toEqual([]);
    expect(synced[GMAIL]?.at(-1)).toBe(0);
    expect(synced[DRIVE]?.at(-1)).toBe(0);
    expect(versions(GMAIL)).toEqual([1]);
    expect(versions(DRIVE)).toEqual([1]);
    expect(Object.values(details(GMAIL, "labelIds"))).toEqual([undefined, undefined, undefined]);
    expect(Object.values(details(DRIVE, "folderIds"))).toEqual([undefined, undefined, undefined]);
    expect({ gmail: stamps(GMAIL), drive: stamps(DRIVE) }).toEqual(before);
  }, 180_000);

  test("a read from an empty cursor gives every record its ids and version 2, on the same documents", async () => {
    const before = { gmail: records(GMAIL), drive: records(DRIVE) };

    await rereadFromStart(GMAIL);
    await rereadFromStart(DRIVE);
    await sync(GMAIL);
    await sync(DRIVE);

    expect(failures).toEqual([]);
    expect(synced[GMAIL]?.at(-1)).toBe(3);
    expect(synced[DRIVE]?.at(-1)).toBe(3);
    expect(versions(GMAIL)).toEqual([2]);
    expect(versions(DRIVE)).toEqual([2]);
    // Gmail's ids for the labels, never the names "Work" or "Running".
    expect(details(GMAIL, "labelIds")).toEqual({
      "synth-gmail-001": ["INBOX", "Label_synthetic_005"],
      "synth-gmail-002": ["INBOX", "Label_synthetic_002", "Label_synthetic_003"],
      "synth-gmail-003": ["SENT"],
    });
    // The folder each file sits in directly, not the folders above it.
    expect(details(DRIVE, "folderIds")).toEqual({
      "synth-gdrive-001": ["synth-drive-reports"],
      "synth-gdrive-002": ["synth-drive-archive"],
      "synth-gdrive-003": ["synth-drive-root"],
    });
    const identity = (rows: StoredRecord[]) => rows.map(({ id, external_id }) => [id, external_id]);
    expect(identity(records(GMAIL))).toEqual(identity(before.gmail));
    expect(identity(records(DRIVE))).toEqual(identity(before.drive));
  }, 180_000);

  test("each source's list is stored whole, shared by every device, with the folder tree", () => {
    expect(list(GMAIL, LABELS)).toMatchObject({ device_id: "", staging_generation: null });
    expect(items(GMAIL, LABELS)).toEqual({
      INBOX: ["Inbox", null],
      SENT: ["Sent", null],
      Label_synthetic_005: ["Work", null],
      Label_synthetic_002: ["Personal", null],
      Label_synthetic_003: ["Running", null],
    });

    const folders = items(DRIVE, FOLDERS);
    expect(list(DRIVE, FOLDERS)).toMatchObject({
      device_id: "",
      item_count: Object.keys(folders).length,
      staging_generation: null,
    });
    expect(Object.keys(folders).length).toBeGreaterThan(3);
    expect(folders["synth-drive-root"]).toEqual(["Fictional Drive", null]);
    expect(folders["synth-drive-observatory"]).toEqual(["Observatory", "synth-drive-root"]);
    expect(folders["synth-drive-reports"]).toEqual(["Reports", "synth-drive-observatory"]);
    expect(folders["synth-drive-archive"]).toEqual(["Archive", "synth-drive-root"]);
    // Every folder a record names is in the list.
    for (const ids of Object.values(details(DRIVE, "folderIds"))) {
      for (const id of ids as string[]) expect(folders).toHaveProperty(id);
    }
  });

  test("the gateway reads both declarations as fields it can apply, and stores each resync cost", () => {
    const gmail = filterFieldsFor(db as unknown as FilterFieldsDb, "gmail");
    expect(gmail).toMatchObject({
      state: "declared",
      outputRevision: 2,
      fields: [
        {
          path: LABELS,
          state: "ready",
          type: "string-array",
          filter: {
            capability: "tree",
            minVersion: 2,
            scope: "global",
            noun: { one: "label", many: "labels" },
            levels: [{ one: "label", many: "labels" }],
            picker: "tree",
            inside: { one: "label", many: "labels" },
          },
        },
      ],
      person: {
        state: "ready",
        filter: {
          minVersion: 2,
          roles: ["sender", "recipient"],
          identifiers: ["email", "domain"],
          maxPeople: 1000,
        },
      },
    });

    const driveFields = filterFieldsFor(db as unknown as FilterFieldsDb, "google-drive");
    expect(driveFields).toMatchObject({
      state: "declared",
      outputRevision: 2,
      fields: [
        {
          path: FOLDERS,
          state: "ready",
          type: "string-array",
          filter: {
            capability: "tree",
            minVersion: 2,
            scope: "global",
            noun: { one: "folder", many: "folders" },
            levels: [{ one: "folder", many: "folders" }],
            picker: "tree",
            inside: { one: "folder", many: "folders" },
          },
        },
      ],
      person: null,
    });

    const costs = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT source_type, resync_cost FROM source_family_meta
              WHERE source_type IN ('gmail', 'google-drive')`,
          )
          .all() as Array<{ source_type: string; resync_cost: string | null }>
      ).map((row) => [row.source_type, row.resync_cost]),
    );
    expect(costs).toEqual({
      gmail: "This reads about 75,000 messages a day.",
      "google-drive": "This downloads every file in your Drive again.",
    });
  });

  test("a renamed label and a renamed, moved folder change the lists only", async () => {
    const before = {
      gmail: stamps(GMAIL),
      drive: stamps(DRIVE),
      labels: list(GMAIL, LABELS)!.generation,
      folders: list(DRIVE, FOLDERS)!.generation,
    };

    mailbox.renameLabel("Label_synthetic_005", "Office");
    drive.renameFolder("synth-drive-reports", "Reports 2026");
    drive.moveFolder("synth-drive-reports", "synth-drive-archive");
    await sync(GMAIL);
    await sync(DRIVE);

    expect(failures).toEqual([]);
    expect(items(GMAIL, LABELS)["Label_synthetic_005"]).toEqual(["Office", null]);
    expect(items(DRIVE, FOLDERS)["synth-drive-reports"]).toEqual([
      "Reports 2026",
      "synth-drive-archive",
    ]);
    expect(list(GMAIL, LABELS)?.generation).toBe(before.labels + 1);
    expect(list(DRIVE, FOLDERS)?.generation).toBe(before.folders + 1);
    // No record was sent again, and the ids the records hold still name the same things.
    expect(synced[GMAIL]?.at(-1)).toBe(0);
    expect(synced[DRIVE]?.at(-1)).toBe(0);
    expect(stamps(GMAIL)).toEqual(before.gmail);
    expect(stamps(DRIVE)).toEqual(before.drive);
    expect(details(GMAIL, "labelIds")["synth-gmail-001"]).toEqual(["INBOX", "Label_synthetic_005"]);
    expect(details(DRIVE, "folderIds")["synth-gdrive-001"]).toEqual(["synth-drive-reports"]);
  }, 180_000);

  test("a label put on or taken off a message, and a moved file, send that one record again", async () => {
    const before = { gmail: stamps(GMAIL), drive: stamps(DRIVE) };
    const untouched = (rows: ReturnType<typeof stamps>, changed: string[]) =>
      rows.filter((row) => !changed.includes(row.external_id));

    // "Office" is the label renamed above, so the new one nests inside it.
    mailbox.createLabel("Label_synthetic_900", "Office/Finance");
    mailbox.addLabel("synth-gmail-001", "Label_synthetic_900");
    mailbox.removeLabel("synth-gmail-003", "SENT");
    drive.moveFile("synth-gdrive-002", ["synth-drive-observatory"]);
    drive.moveFile("synth-gdrive-003", []);
    await sync(GMAIL);
    await sync(DRIVE);

    expect(failures).toEqual([]);
    expect(synced[GMAIL]?.at(-1)).toBe(2);
    expect(synced[DRIVE]?.at(-1)).toBe(2);
    expect(details(GMAIL, "labelIds")).toEqual({
      "synth-gmail-001": ["INBOX", "Label_synthetic_005", "Label_synthetic_900"],
      "synth-gmail-002": ["INBOX", "Label_synthetic_002", "Label_synthetic_003"],
      // A message left with no label holds an empty list, not an absent one.
      "synth-gmail-003": [],
    });
    expect(details(DRIVE, "folderIds")).toEqual({
      "synth-gdrive-001": ["synth-drive-reports"],
      "synth-gdrive-002": ["synth-drive-observatory"],
      // A file in no folder holds an empty list.
      "synth-gdrive-003": [],
    });
    expect(versions(GMAIL)).toEqual([2]);
    expect(versions(DRIVE)).toEqual([2]);
    expect(untouched(stamps(GMAIL), ["synth-gmail-001", "synth-gmail-003"])).toEqual(
      untouched(before.gmail, ["synth-gmail-001", "synth-gmail-003"]),
    );
    expect(untouched(stamps(DRIVE), ["synth-gdrive-002", "synth-gdrive-003"])).toEqual(
      untouched(before.drive, ["synth-gdrive-002", "synth-gdrive-003"]),
    );
    // The new label is in the list the same sync published.
    expect(items(GMAIL, LABELS)["Label_synthetic_900"]).toEqual([
      "Office/Finance",
      "Label_synthetic_005",
    ]);
    // Every label a record names is in the list.
    const listed = items(GMAIL, LABELS);
    for (const ids of Object.values(details(GMAIL, "labelIds"))) {
      for (const id of ids as string[]) expect(listed).toHaveProperty(id);
    }

    // Each change is sent once.
    await sync(GMAIL);
    await sync(DRIVE);
    expect(synced[GMAIL]?.at(-1)).toBe(0);
    expect(synced[DRIVE]?.at(-1)).toBe(0);
  }, 180_000);
});
