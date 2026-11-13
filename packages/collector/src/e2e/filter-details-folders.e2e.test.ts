// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The folder a local file and a coding session belong to, from the source to
 * the gateway's stores, through real collectors and a spawned gateway.
 *
 * The `folder-filters` universe has two computers hosting the same coding
 * sessions (the `claude-code` source) and the same local files. Both twins run the real sources over
 * files materialized on disk, and in this harness the two computers read the
 * same directory, so every folder exists at the same path on both. The suite
 * asserts that:
 *   - records written by a build at version 1, which stored no folder, are
 *     left as they are by an ordinary sync after the upgrade, and gain the
 *     folder and version 2 only when the computer reads the source again from
 *     an empty cursor, on the same records;
 *   - every record carries the id of its own folder only, and each computer's
 *     list holds the folders with their parents, stored under that computer:
 *     the same path on two computers is two folders;
 *   - a session with no recorded directory is stored with no folder at all;
 *   - a new folder reaches one computer's list through its ordinary sync
 *     without any stored record being sent again, and the other computer's
 *     list only changes when that computer syncs;
 *   - a folder moved on disk is a different folder: its files follow under the
 *     records they already had.
 *
 * Files only change on disk while the source is disabled on both computers,
 * and re-enabling a source runs its sync: a source that watches its files
 * would otherwise start a sync of its own at a moment the test does not choose.
 */

import "./synth-env.js";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { filterFieldsFor } from "@omnesis/gateway/src/access/filter-fields.js";
import { directoryFilterId } from "@omnesis/source-sdk";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";

type Db = Parameters<typeof filterFieldsFor>[0];

const SESSIONS = "claude-code:claude-maya";
const FILES = "local-files:files-maya";
const PROJECT_FOLDER = "extra.projectFolder";
const FOLDER = "extra.folder";
const NEVER = { defaultSyncInterval: "999999s" };

interface StoredDocument {
  id: string;
  external_id: string;
  title: string;
  updated_at: string;
  source_version: number;
  /** The record's folder, or null when the record carries none. */
  folder: string | null;
  /** `text` when the record carries a folder, null when the key is absent. */
  folder_type: string | null;
}

describe("filter details: the folders of local files and coding sessions", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  let laptop: HarnessDevice;
  let desktop: HarnessDevice;
  /** Where the twins materialized the session files and the local files. */
  let sessionsDir: string;
  let filesDir: string;
  const failures: string[] = [];

  const documents = (sourceId: string, device: HarnessDevice): StoredDocument[] => {
    const path = sourceId === SESSIONS ? "$.extra.projectFolder" : "$.extra.folder";
    return db
      .prepare(
        `SELECT id, external_id, title, updated_at, source_version,
                json_extract(metadata, '${path}') AS folder,
                json_type(metadata, '${path}') AS folder_type
           FROM documents WHERE source_id = ? AND stream_id = ? ORDER BY external_id`,
      )
      .all(sourceId, device.deviceId) as StoredDocument[];
  };

  /** What stays the same when a record is not written again. */
  const identity = (rows: StoredDocument[]) =>
    rows.map(({ id, external_id, updated_at }) => ({ id, external_id, updated_at }));

  const byExternalId = (rows: StoredDocument[]): Record<string, string | null> =>
    Object.fromEntries(rows.map((row) => [row.external_id, row.folder]));

  /** One computer's published list for a field, as `id → [label, parent]`. */
  const list = (
    sourceId: string,
    field: string,
    device: HarnessDevice,
  ): Record<string, [string, string | null]> =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT i.item_id, i.label, i.parent_id
               FROM source_filter_lists l
               JOIN source_filter_items i
                 ON i.source_id = l.source_id AND i.field = l.field
                AND i.device_id = l.device_id AND i.generation = l.generation
              WHERE l.source_id = ? AND l.field = ? AND l.device_id = ?`,
          )
          .all(sourceId, field, device.deviceId) as Array<{
          item_id: string;
          label: string;
          parent_id: string | null;
        }>
      ).map((row) => [row.item_id, [row.label, row.parent_id]]),
    );

  /** The devices a list is stored under for a field. */
  const listDevices = (sourceId: string, field: string): string[] =>
    (
      db
        .prepare(
          "SELECT device_id FROM source_filter_lists WHERE source_id = ? AND field = ? ORDER BY 1",
        )
        .all(sourceId, field) as Array<{ device_id: string }>
    ).map((row) => row.device_id);

  const sync = (sourceId: string, device: HarnessDevice) =>
    harness.triggerSyncAndWait(sourceId, 90_000, device);

  const disable = async (sourceId: string): Promise<void> => {
    await laptop.engine.disableSource(sourceId);
    await desktop.engine.disableSource(sourceId);
  };

  /** Re-enable a source on one computer, which syncs it there. */
  const enable = async (sourceId: string, device: HarnessDevice): Promise<void> => {
    expect(await device.engine.enableSource(sourceId, NEVER)).toBe(true);
  };

  /** Send a computer back to the start of a source, keeping every stored record. */
  const readAgainFromTheStart = async (sourceId: string, device: HarnessDevice): Promise<void> => {
    const headers = {
      Authorization: `Bearer ${device.token}`,
      "Content-Type": "application/json",
    };
    const url = `${harness.gatewayUrl}/sync-state/${encodeURIComponent(sourceId)}`;
    const state = (await (await fetch(url, { headers })).json()) as { wipeEpoch?: number };
    const reset = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: {}, writeEpoch: state.wipeEpoch }),
    });
    expect(await reset.json()).toEqual({ ok: true });
    await sync(sourceId, device);
  };

  const fileFolder = (relative: string): string => directoryFilterId(join(filesDir, relative))!;

  const sessionFile = (id: string, cwd: string | undefined, day: number): void => {
    const timestamp = new Date(Date.UTC(2026, 2, day, 10, 0)).toISOString();
    const entry = (type: "user" | "assistant", message: Record<string, unknown>) => ({
      type,
      uuid: `${id}-${type}`,
      parentUuid: type === "user" ? null : `${id}-user`,
      sessionId: id,
      timestamp,
      ...(cwd === undefined ? {} : { cwd }),
      isSidechain: false,
      ...(type === "user" ? { userType: "external" } : {}),
      message,
    });
    const rows = [
      entry("user", { role: "user", content: `zqfilter invented prompt of ${id}` }),
      entry("assistant", {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `zqfilter invented answer of ${id}` }],
      }),
    ];
    writeFileSync(
      join(sessionsDir, `${id}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  };

  const SESSION_FOLDERS = {
    "cli:ff-claude-code-atlas:2026-03-01": "/srv/work/atlas-api",
    // Started in a subfolder: filed under the subfolder, not its parent.
    "cli:ff-claude-code-guide:2026-03-02": "/srv/work/atlas-api/docs",
    "cli:ff-claude-code-billing:2026-03-03": "/srv/work/billing",
    "cli:ff-claude-code-garden:2026-03-04": "/srv/personal/garden-notes",
    "cli:ff-claude-code-bench:2026-03-05": "/srv/workshop/bench",
    // Moved into a subfolder, and into an unrelated project: both stay where they started.
    "cli:ff-claude-code-retries:2026-03-06": "/srv/work/billing",
    "cli:ff-claude-code-roaming:2026-03-07": "/srv/work/atlas-api",
  };

  const SESSION_LIST: Record<string, [string, string | null]> = {
    "/srv": ["/srv", null],
    "/srv/work": ["/srv/work", "/srv"],
    "/srv/work/atlas-api": ["/srv/work/atlas-api", "/srv/work"],
    "/srv/work/atlas-api/docs": ["/srv/work/atlas-api/docs", "/srv/work/atlas-api"],
    "/srv/work/billing": ["/srv/work/billing", "/srv/work"],
    "/srv/personal": ["/srv/personal", "/srv"],
    "/srv/personal/garden-notes": ["/srv/personal/garden-notes", "/srv/personal"],
    // Beside /srv/work, never inside it.
    "/srv/workshop": ["/srv/workshop", "/srv"],
    "/srv/workshop/bench": ["/srv/workshop/bench", "/srv/workshop"],
  };

  const fileFolders = (): Record<string, string> => ({
    "zqfilter-atlas.md": fileFolder("work/atlas-api"),
    "zqfilter-guide.md": fileFolder("work/atlas-api/docs"),
    "zqfilter-billing.md": fileFolder("work/billing"),
    "zqfilter-garden.md": fileFolder("personal/garden-notes"),
    "zqfilter-bench.md": fileFolder("workshop/bench"),
    "zqfilter-inbox.md": fileFolder(""),
  });

  const fileListParents = (): Record<string, string | null> => ({
    [fileFolder("")]: null,
    [fileFolder("work")]: fileFolder(""),
    [fileFolder("work/atlas-api")]: fileFolder("work"),
    [fileFolder("work/atlas-api/docs")]: fileFolder("work/atlas-api"),
    [fileFolder("work/billing")]: fileFolder("work"),
    [fileFolder("personal")]: fileFolder(""),
    [fileFolder("personal/garden-notes")]: fileFolder("personal"),
    [fileFolder("workshop")]: fileFolder(""),
    [fileFolder("workshop/bench")]: fileFolder("workshop"),
  });

  const parents = (listed: Record<string, [string, string | null]>) =>
    Object.fromEntries(Object.entries(listed).map(([id, [, parent]]) => [id, parent]));

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "folder-filters" });
    await harness.start();
    harness.onStatusChange((change) => {
      if (change.sourceId !== SESSIONS && change.sourceId !== FILES) return;
      if (change.event === "sync.error") {
        failures.push(`${change.sourceId}: ${change.status.lastError ?? "unknown error"}`);
      }
    });
    db = new Database(harness.getDbPath(), { readonly: true });
    [laptop, desktop] = harness.devicesForSource(SESSIONS) as [HarnessDevice, HarnessDevice];
    expect(harness.devicesForSource(FILES)).toEqual([laptop, desktop]);
    sessionsDir = laptop.engine.getSourcesById(SESSIONS)[0]!.instance.watchPaths![0]!;
    filesDir = realpathSync(laptop.engine.getSourcesById(FILES)[0]!.instance.watchPaths![0]!);
    // Both computers read the same directories: every path is the same on the two.
    expect(desktop.engine.getSourcesById(SESSIONS)[0]!.instance.watchPaths![0]).toBe(sessionsDir);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 30_000);

  test("records from before the folder was written gain it only when the source is read again from the start", async () => {
    // The desktop runs the build before folders: its pages are stamped
    // version 1, and what that build stored had no folder on it.
    harness.setSourceVersion(SESSIONS, 1, desktop);
    harness.setSourceVersion(FILES, 1, desktop);
    await sync(SESSIONS, desktop);
    await sync(FILES, desktop);
    const writable = new Database(harness.getDbPath());
    try {
      writable.pragma("busy_timeout = 10000");
      writable
        .prepare(
          `UPDATE documents
              SET metadata = json_remove(metadata, '$.extra.projectFolder', '$.extra.folder')
            WHERE source_id IN (?, ?) AND stream_id = ?`,
        )
        .run(SESSIONS, FILES, desktop.deviceId);
    } finally {
      writable.close();
    }
    const oldSessions = documents(SESSIONS, desktop);
    const oldFiles = documents(FILES, desktop);
    expect(oldSessions).toHaveLength(7);
    expect(oldFiles).toHaveLength(6);
    for (const row of [...oldSessions, ...oldFiles]) {
      expect(row).toMatchObject({ source_version: 1, folder_type: null });
    }

    // Upgraded. An ordinary sync finds no file changed and sends nothing:
    // every record stays at version 1, without a folder.
    harness.setSourceVersion(SESSIONS, 2, desktop);
    harness.setSourceVersion(FILES, 2, desktop);
    await sync(SESSIONS, desktop);
    await sync(FILES, desktop);
    expect(documents(SESSIONS, desktop)).toEqual(oldSessions);
    expect(documents(FILES, desktop)).toEqual(oldFiles);

    // Read again from an empty cursor, every session and file comes back
    // although no file changed, onto the record it already had.
    await readAgainFromTheStart(SESSIONS, desktop);
    await readAgainFromTheStart(FILES, desktop);
    const newSessions = documents(SESSIONS, desktop);
    const newFiles = documents(FILES, desktop);
    expect(newSessions.map((row) => row.id)).toEqual(oldSessions.map((row) => row.id));
    expect(newFiles.map((row) => row.id)).toEqual(oldFiles.map((row) => row.id));
    for (const row of [...newSessions, ...newFiles]) {
      expect(row).toMatchObject({ source_version: 2, folder_type: "text" });
    }
    expect(byExternalId(newSessions)).toEqual(SESSION_FOLDERS);
    expect(Object.fromEntries(newFiles.map((row) => [row.title, row.folder]))).toEqual(
      fileFolders(),
    );
    expect(failures).toEqual([]);
  }, 300_000);

  test("the gateway reads both declarations as filters it can apply, per device", () => {
    const sessions = filterFieldsFor(db as unknown as Db, "claude-code");
    expect(sessions).toMatchObject({
      state: "declared",
      outputRevision: 2,
      person: null,
      fields: [
        {
          path: PROJECT_FOLDER,
          state: "ready",
          type: "string",
          filter: {
            capability: "tree",
            minVersion: 2,
            scope: "device",
            noun: { one: "project folder", many: "project folders" },
            inside: { one: "project folder", many: "project folders" },
          },
        },
      ],
    });
    expect(filterFieldsFor(db as unknown as Db, "local-files")).toMatchObject({
      state: "declared",
      outputRevision: 2,
      person: null,
      fields: [
        {
          path: FOLDER,
          state: "ready",
          type: "string",
          filter: {
            capability: "tree",
            minVersion: 2,
            scope: "device",
            noun: { one: "folder", many: "folders" },
            inside: { one: "folder", many: "folders" },
          },
        },
      ],
    });
  });

  test("the same path on two computers is two folders: each has its own records and its own list", async () => {
    await sync(SESSIONS, laptop);
    await sync(FILES, laptop);
    expect(failures).toEqual([]);

    for (const device of [laptop, desktop]) {
      const sessions = documents(SESSIONS, device);
      expect(byExternalId(sessions)).toEqual(SESSION_FOLDERS);
      expect(sessions.every((row) => row.source_version === 2)).toBe(true);
      const files = documents(FILES, device);
      expect(Object.fromEntries(files.map((row) => [row.title, row.folder]))).toEqual(
        fileFolders(),
      );
      expect(files.every((row) => row.source_version === 2)).toBe(true);

      // The record holds its own folder; the folders above it are in the list.
      expect(list(SESSIONS, PROJECT_FOLDER, device)).toEqual(SESSION_LIST);
      expect(parents(list(FILES, FOLDER, device))).toEqual(fileListParents());
    }
    // The two computers hold the same sessions in two streams, as separate records.
    const laptopIds = new Set(documents(SESSIONS, laptop).map((row) => row.id));
    expect(documents(SESSIONS, desktop).some((row) => laptopIds.has(row.id))).toBe(false);
    // One list per computer, never one shared by both.
    const devices = [laptop.deviceId, desktop.deviceId].sort();
    expect(listDevices(SESSIONS, PROJECT_FOLDER)).toEqual(devices);
    expect(listDevices(FILES, FOLDER)).toEqual(devices);
  }, 180_000);

  test("a new project folder reaches one computer's list by its ordinary sync, and no stored record is sent again", async () => {
    const laptopBefore = documents(SESSIONS, laptop);
    const desktopBefore = documents(SESSIONS, desktop);

    await disable(SESSIONS);
    sessionFile("ff-claude-code-prototype", "/srv/lab/prototype", 8);
    // A session whose file recorded no directory.
    sessionFile("ff-claude-code-nowhere", undefined, 9);
    await enable(SESSIONS, laptop);

    const laptopAfter = documents(SESSIONS, laptop);
    expect(byExternalId(laptopAfter)).toEqual({
      ...SESSION_FOLDERS,
      "cli:ff-claude-code-prototype:2026-03-08": "/srv/lab/prototype",
      "cli:ff-claude-code-nowhere:2026-03-09": null,
    });
    // No folder at all on the session that recorded none: the key is absent,
    // at the version that would have written it.
    expect(
      laptopAfter.find((row) => row.external_id === "cli:ff-claude-code-nowhere:2026-03-09"),
    ).toMatchObject({ source_version: 2, folder_type: null });
    // The seven sessions already stored were not written again.
    expect(identity(laptopAfter.filter((row) => row.external_id in SESSION_FOLDERS))).toEqual(
      identity(laptopBefore),
    );
    expect(list(SESSIONS, PROJECT_FOLDER, laptop)).toEqual({
      ...SESSION_LIST,
      "/srv/lab": ["/srv/lab", "/srv"],
      "/srv/lab/prototype": ["/srv/lab/prototype", "/srv/lab"],
    });

    // The desktop has not synced: its records and its list are what they were.
    expect(documents(SESSIONS, desktop)).toEqual(desktopBefore);
    expect(list(SESSIONS, PROJECT_FOLDER, desktop)).toEqual(SESSION_LIST);

    await enable(SESSIONS, desktop);
    expect(list(SESSIONS, PROJECT_FOLDER, desktop)).toEqual(list(SESSIONS, PROJECT_FOLDER, laptop));
    expect(
      identity(documents(SESSIONS, desktop).filter((row) => row.external_id in SESSION_FOLDERS)),
    ).toEqual(identity(desktopBefore));
    expect(failures).toEqual([]);
  }, 180_000);

  test("an empty folder is listed, and a folder moved on disk takes its files with it under the same records", async () => {
    const before = documents(FILES, laptop);
    const desktopBefore = documents(FILES, desktop);

    await disable(FILES);
    mkdirSync(join(filesDir, "someday"));
    await enable(FILES, laptop);

    // Only the list changed: no file was sent again.
    expect(documents(FILES, laptop)).toEqual(before);
    expect(parents(list(FILES, FOLDER, laptop))).toEqual({
      ...fileListParents(),
      [fileFolder("someday")]: fileFolder(""),
    });
    expect(parents(list(FILES, FOLDER, desktop))).toEqual(fileListParents());

    await disable(FILES);
    renameSync(join(filesDir, "work", "billing"), join(filesDir, "personal", "billing"));
    await enable(FILES, laptop);

    const after = documents(FILES, laptop);
    const moved = after.find((row) => row.title === "zqfilter-billing.md")!;
    const original = before.find((row) => row.title === "zqfilter-billing.md")!;
    // The same record, now under the folder's new path.
    expect(moved.id).toBe(original.id);
    expect(moved.folder).toBe(fileFolder("personal/billing"));
    expect(identity(after.filter((row) => row.id !== moved.id))).toEqual(
      identity(before.filter((row) => row.id !== original.id)),
    );
    const listed = parents(list(FILES, FOLDER, laptop));
    expect(listed[fileFolder("personal/billing")]).toBe(fileFolder("personal"));
    // The old path is no longer a folder on this computer.
    expect(Object.keys(listed)).not.toContain(fileFolder("work/billing"));

    // The desktop still holds what it last read, until it syncs.
    expect(documents(FILES, desktop)).toEqual(desktopBefore);
    expect(parents(list(FILES, FOLDER, desktop))).toEqual(fileListParents());
    await enable(FILES, desktop);
    expect(parents(list(FILES, FOLDER, desktop))).toEqual(listed);
    expect(failures).toEqual([]);
  }, 180_000);
});
