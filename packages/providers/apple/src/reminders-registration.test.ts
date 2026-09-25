// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reminders is the one Apple source bound to an open handle rather than
 * re-reading its database each cycle: macOS keeps one store file per account
 * and the source reads a chosen one. So the binding, not just the read, has to
 * survive a store that is unreadable when the collector starts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SyncError } from "@omnesis/types";
import appleProvider from "./index.js";
import type { AppleDbOpenFailure } from "./db-helpers/internal.js";
import type { RemindersStoreInfo } from "./types.js";

const REMINDERS = appleProvider.sources.find((source) => source.id === "apple-reminders")!;

const OPTIONS = {
  sourceId: "apple-reminders:tester@example.com",
  providerId: "apple:tester@example.com",
  config: {},
} as never;

/** Enough of a Reminders store for the source's first page to run. */
function seedStore(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZREMCDREMINDER (
      Z_PK INTEGER PRIMARY KEY,
      ZIDENTIFIER BLOB,
      ZTITLE TEXT,
      ZNOTES TEXT,
      ZCOMPLETED INTEGER DEFAULT 0,
      ZFLAGGED INTEGER DEFAULT 0,
      ZPRIORITY INTEGER DEFAULT 0,
      ZCREATIONDATE REAL,
      ZLASTMODIFIEDDATE REAL,
      ZDUEDATE REAL,
      ZCOMPLETIONDATE REAL,
      ZALLDAY INTEGER DEFAULT 0,
      ZMARKEDFORDELETION INTEGER DEFAULT 0,
      ZLIST INTEGER
    );
    CREATE TABLE ZREMCDBASELIST (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT);
  `);
  return db;
}

/**
 * A stand-in provider whose store list and failure the test drives directly —
 * the real one reads paths fixed to the logged-in macOS user's home.
 */
function fakeProvider(dir: string) {
  return {
    stores: [] as RemindersStoreInfo[],
    failure: null as AppleDbOpenFailure | null,
    remindersDirFilePath: dir,
    getRemindersStoresWithAccounts(): RemindersStoreInfo[] {
      return this.stores;
    },
    getRemindersStoreGaps() {
      return [];
    },
    getRemindersOpenFailure(): AppleDbOpenFailure | null {
      return this.failure;
    },
  };
}

describe("apple-reminders registration", () => {
  let dir: string;
  let db: Database.Database | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-reminders-registration-test-"));
  });

  afterEach(() => {
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a Mac with no Reminders store preserves data and reports an unavailable store", async () => {
    const provider = fakeProvider(dir);
    const instance = await REMINDERS.create(OPTIONS, { provider } as never);

    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  });

  test("a store that cannot be read is reported by this source", async () => {
    const provider = fakeProvider(dir);
    provider.failure = { kind: "denied", message: "the grant is missing" };
    const instance = await REMINDERS.create(OPTIONS, { provider } as never);

    const failure = await instance.sync(null).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(SyncError);
    expect((failure as SyncError).kind).toBe("permission");
  });

  // A store locked at startup opens on a later cycle. Binding once, at
  // registration, would leave the source empty until the collector restarted.
  test("a store that opens on a later cycle is picked up without a restart", async () => {
    const provider = fakeProvider(dir);
    provider.failure = { kind: "busy", message: "locked" };
    const instance = await REMINDERS.create(OPTIONS, { provider } as never);

    await expect(instance.sync(null)).rejects.toThrow(
      expect.objectContaining({ kind: "transient" }),
    );

    const path = join(dir, "Data-11111111-1111-1111-1111-111111111111.sqlite");
    db = seedStore(path);
    provider.failure = null;
    provider.stores = [{ filename: "Data-11111111-1111-1111-1111-111111111111.sqlite", db }];

    const result = await instance.sync(null);
    expect(result.documents).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.issues).toEqual([]);
  });

  // The watch set is read once, at registration, so it cannot depend on a
  // store having opened by then.
  test("the stores directory is watched whether or not a store bound", async () => {
    const provider = fakeProvider(dir);
    const instance = await REMINDERS.create(OPTIONS, { provider } as never);

    expect(instance.watchPaths).toEqual([dir]);
    expect(instance.watchDirectoryPaths).toEqual([dir]);
    expect(instance.watchFileExtensions).toContain(".sqlite");
  });
});
