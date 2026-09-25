// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { gzipSync } from "node:zlib";
import { SourceId, ProviderId } from "@omnesis/types";
import { AppleProvider } from "./provider.js";
import { AppleNotesSource } from "./notes.js";
import { appleNotesDocumentProfile } from "./document-profiles.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Helper to build a minimal note protobuf
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(data.length), data]);
}

function encodeStringField(fieldNumber: number, str: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(str, "utf-8"));
}

function buildNoteData(title: string, body: string): Buffer {
  const text = `${title}\n${body}\n`;
  const noteBuf = encodeStringField(2, text);
  const documentBuf = encodeLengthDelimited(3, noteBuf);
  const proto = encodeLengthDelimited(2, documentBuf);
  return gzipSync(proto);
}

// Core Data timestamp for 2024-03-08 00:00:00 UTC
const TS_2024_03_08 = 731548800;
const TS_2024_03_09 = 731548800 + 86400;

/**
 * Create a test SQLite database mimicking NoteStore.sqlite schema.
 */
function createTestDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZTITLE1 TEXT,
      ZSNIPPET TEXT,
      ZIDENTIFIER TEXT,
      ZCREATIONDATE3 REAL,
      ZMODIFICATIONDATE1 REAL,
      ZFOLDERMODIFICATIONDATE REAL,
      ZISPASSWORDPROTECTED INTEGER DEFAULT 0,
      ZISPINNED INTEGER DEFAULT 0,
      ZMARKEDFORDELETION INTEGER DEFAULT 0,
      ZFOLDER INTEGER,
      ZACCOUNT2 INTEGER,
      ZNOTEDATA INTEGER,
      ZTITLE2 TEXT,
      ZNAME TEXT
    );

    CREATE TABLE ZICNOTEDATA (
      Z_PK INTEGER PRIMARY KEY,
      ZNOTE INTEGER,
      ZDATA BLOB
    );
  `);

  return db;
}

function insertNote(
  db: Db,
  opts: {
    pk: number;
    title: string;
    body: string;
    identifier: string;
    creationDate: number;
    modificationDate: number;
    folderPk?: number;
    folderName?: string;
    accountPk?: number;
    accountName?: string;
    isLocked?: boolean;
    isPinned?: boolean;
    isTrashed?: boolean;
    folderIdentifier?: string;
    /** When the note last changed folders — the only stamp a remote trash-move bumps. */
    folderModificationDate?: number;
  },
) {
  const dataPk = opts.pk + 1000;

  // Insert folder if specified
  if (opts.folderPk && opts.folderName) {
    db.prepare(
      `INSERT OR IGNORE INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZIDENTIFIER)
       VALUES (?, ?, ?)`,
    ).run(opts.folderPk, opts.folderName, opts.folderIdentifier ?? `folder-${opts.folderPk}`);
  }

  // Insert account if specified
  if (opts.accountPk && opts.accountName) {
    db.prepare(
      `INSERT OR IGNORE INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZNAME, ZIDENTIFIER)
       VALUES (?, ?, ?)`,
    ).run(opts.accountPk, opts.accountName, `account-${opts.accountPk}`);
  }

  // Insert note row
  db.prepare(
    `INSERT INTO ZICCLOUDSYNCINGOBJECT
     (Z_PK, ZTITLE1, ZSNIPPET, ZIDENTIFIER, ZCREATIONDATE3, ZMODIFICATIONDATE1,
      ZFOLDERMODIFICATIONDATE, ZISPASSWORDPROTECTED, ZISPINNED, ZMARKEDFORDELETION,
      ZFOLDER, ZACCOUNT2, ZNOTEDATA)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.pk,
    opts.title,
    opts.body.slice(0, 200),
    opts.identifier,
    opts.creationDate,
    opts.modificationDate,
    opts.folderModificationDate ?? null,
    opts.isLocked ? 1 : 0,
    opts.isPinned ? 1 : 0,
    opts.isTrashed ? 1 : 0,
    opts.folderPk ?? null,
    opts.accountPk ?? null,
    dataPk,
  );

  // Insert note data
  const data = opts.isLocked ? null : buildNoteData(opts.title, opts.body);
  db.prepare(`INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)`).run(
    dataPk,
    opts.pk,
    data,
  );
}

describe("AppleNotesSource", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Db;
  let provider: AppleProvider;
  let source: AppleNotesSource;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-notes-test-"));
    dbPath = join(tmpDir, "NoteStore.sqlite");
    testDb = createTestDb(dbPath);

    provider = new AppleProvider({
      notesDbPath: dbPath,
      remindersDirPath: join(tmpDir, "nonexistent"),
      accountId: "test@icloud.com",
    });
    await provider.initialize();
    await provider.authenticate();
    source = new AppleNotesSource(provider, {
      sourceId: "apple-notes:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
  });

  afterEach(async () => {
    testDb.close();
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("apple-notes:test@icloud.com"));
    expect(source.providerId).toBe(ProviderId("apple:test@icloud.com"));
  });

  test("returns empty result when no notes", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("syncs a single note", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Shopping List",
      body: "Buy eggs\nBuy milk",
      identifier: "note-uuid-1",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      folderPk: 500,
      folderName: "Personal",
      accountPk: 600,
      accountName: "iCloud",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.externalId).toBe("note-uuid-1");
    expect(doc.title).toBe("Shopping List");
    expect(doc.content).toContain("Buy eggs");
    expect(doc.content).toContain("Buy milk");
    expect(doc.metadata.sourceUrl).toBe("notes://showNote?identifier=note-uuid-1");
    expect(doc.metadata.appUrl).toBe("mobilenotes://showNote?identifier=note-uuid-1");
    expect(doc.metadata.documentType).toBe("note");
    expect(doc.metadata.tags).toEqual(["Personal"]);
    expect(doc.metadata.extra?.account).toBe("iCloud");
    expect(doc.metadata.extra?.isPinned).toBe(false);
    expect(doc.sourceCreatedAt).toBe("2024-03-08T00:00:00.000Z");
  });

  test("two Mac stores converge on cloud note identity despite different local row ids", async () => {
    const logicalNote = {
      title: "Architecture sketch",
      body: "Review the storage boundary before Friday.",
      identifier: "cloud-note-identifier",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09,
      folderName: "Projects",
      accountName: "iCloud",
      folderIdentifier: "cloud-folder-identifier",
    };
    insertNote(testDb, {
      ...logicalNote,
      pk: 7,
      folderPk: 17,
      accountPk: 27,
    });

    const replicaPath = join(tmpDir, "NoteStore-replica.sqlite");
    const replicaDb = createTestDb(replicaPath);
    insertNote(replicaDb, {
      ...logicalNote,
      pk: 700,
      folderPk: 1700,
      accountPk: 2700,
    });
    const replicaProvider = new AppleProvider({
      notesDbPath: replicaPath,
      remindersDirPath: join(tmpDir, "nonexistent-replica"),
      accountId: "test@icloud.example",
    });
    try {
      await replicaProvider.initialize();
      await replicaProvider.authenticate();
      const firstSource = new AppleNotesSource(provider, {
        sourceId: "apple-notes:test@icloud.example",
        providerId: "apple:test@icloud.example",
      });
      const replicaSource = new AppleNotesSource(replicaProvider, {
        sourceId: "apple-notes:test@icloud.example",
        providerId: "apple:test@icloud.example",
      });

      const first = await firstSource.sync(null);
      const second = await replicaSource.sync(null);
      expect(first.documents.map((document) => document.externalId)).toEqual([
        "cloud-note-identifier",
      ]);
      expect(second.documents).toEqual(first.documents);
      expect(first.presentExternalIds).toEqual(["cloud-note-identifier"]);
      expect(second.presentExternalIds).toEqual(first.presentExternalIds);
      expect(second.cursor).not.toEqual(first.cursor);
    } finally {
      replicaDb.close();
      await replicaProvider.disconnect();
    }
  });

  test("stamps the source account email as document author (Pattern A)", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "My Note",
      body: "Body",
      identifier: "uuid-author",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const emailSource = new AppleNotesSource(provider, {
      sourceId: "apple-notes:jamesbond@example.com",
      providerId: "apple:jamesbond@example.com",
    });
    const result = await emailSource.sync(null);
    expect(result.documents).toHaveLength(1);

    const people = result.documents[0].metadata.people;
    expect(people).toBeDefined();
    expect(people).toHaveLength(1);
    expect(people![0]).toEqual({
      role: "author",
      emails: ["jamesbond@example.com"],
      phones: [],
    });
  });

  test("does not stamp people when accountId is not email-shaped", async () => {
    // Replace `provider` (which holds accountId 'test@icloud.com') with one
    // whose accountId is `local`, then build a source whose sourceId also
    // lacks an `@`. This exercises the safety gate that skips author
    // emission for non-email accountIds.
    await provider.disconnect();
    provider = new AppleProvider({
      notesDbPath: dbPath,
      remindersDirPath: join(tmpDir, "nonexistent"),
      accountId: "local",
    });
    await provider.initialize();
    await provider.authenticate();

    insertNote(testDb, {
      pk: 1,
      title: "Anon Note",
      body: "Body",
      identifier: "uuid-anon",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const localSource = new AppleNotesSource(provider, {
      sourceId: "apple-notes:local",
      providerId: "apple:local",
    });
    const result = await localSource.sync(null);
    expect(result.documents).toHaveLength(1);

    const people = result.documents[0].metadata.people;
    expect(people === undefined || people.length === 0).toBe(true);
  });

  test("syncs multiple notes", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Note A",
      body: "Content A",
      identifier: "uuid-a",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });
    insertNote(testDb, {
      pk: 2,
      title: "Note B",
      body: "Content B",
      identifier: "uuid-b",
      creationDate: TS_2024_03_09,
      modificationDate: TS_2024_03_09,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0].title).toBe("Note A");
    expect(result.documents[1].title).toBe("Note B");
  });

  test("incremental sync only returns modified notes", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Old Note",
      body: "Old content",
      identifier: "uuid-old",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);

    insertNote(testDb, {
      pk: 2,
      title: "New Note",
      body: "New content",
      identifier: "uuid-new",
      creationDate: TS_2024_03_09,
      modificationDate: TS_2024_03_09,
    });

    const r3 = await source.sync(r2.cursor);
    expect(r3.documents).toHaveLength(1);
    expect(r3.documents[0].title).toBe("New Note");
  });

  test("incremental sync picks up edited note", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Original Title",
      body: "Original body",
      identifier: "uuid-edit-test",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      folderPk: 500,
      folderName: "Notes",
    });

    // Bootstrap sync
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);
    expect(r1.documents[0].title).toBe("Original Title");

    // Edit the note: update title, body, and modification date
    const editedData = buildNoteData("Edited Title", "Edited body content");
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZTITLE1 = ?, ZMODIFICATIONDATE1 = ? WHERE Z_PK = 1`,
      )
      .run("Edited Title", TS_2024_03_08 + 200);
    testDb.prepare(`UPDATE ZICNOTEDATA SET ZDATA = ? WHERE ZNOTE = 1`).run(editedData);

    // Incremental sync should pick up the edit
    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0].title).toBe("Edited Title");
    expect(r2.documents[0].content).toContain("Edited body content");
    expect(r2.documents[0].externalId).toBe("uuid-edit-test");
  });

  test("bootstrap does NOT emit trashed notes as deletes (closes spurious-deletions)", async () => {
    // Pre-fix: a bootstrap (lastModified=0) ran the deletion query
    // unconditionally with `>= 0`, returning every trashed note as a
    // deletedExternalId even though the gateway has nothing to delete.
    // Post-fix: bootstrap returns an empty deletedExternalIds; trash is
    // detected through `presentExternalIds` (snapshot reconciliation)
    // which the gateway diffs against its own state.
    insertNote(testDb, {
      pk: 1,
      title: "Deleted Note",
      body: "Gone",
      identifier: "uuid-deleted",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09,
      isTrashed: true,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toEqual([]);
    // Snapshot path still excludes the trashed note correctly.
    expect(result.presentExternalIds).toEqual([]);

    // And a live note appears in it while the trashed one still does not —
    // the exclusion is what this test is about.
    insertNote(testDb, {
      pk: 2,
      title: "grocery list",
      body: "oat milk",
      identifier: "uuid-live",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09,
    });
    const withLive = await source.sync(null);
    expect(withLive.presentExternalIds).toEqual(["uuid-live"]);
  });

  test("incremental sync still detects trashed notes via deletedExternalIds (fast-path)", async () => {
    // First, get a real cursor by syncing a placeholder note. This
    // advances `lastModifiedTimestamp` past 0 so the next call enters
    // the incremental codepath.
    insertNote(testDb, {
      pk: 100,
      title: "Anchor",
      body: "anchor",
      identifier: "uuid-anchor",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Now insert a trashed note with a *later* mtime so it falls into
    // the incremental window.
    insertNote(testDb, {
      pk: 1,
      title: "Deleted Note",
      body: "Gone",
      identifier: "uuid-deleted",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09,
      isTrashed: true,
    });

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toContain("uuid-deleted");
  });

  test("detects notes moved to Recently Deleted folder as deletions", async () => {
    // First sync picks up the note in a normal folder
    insertNote(testDb, {
      pk: 1,
      title: "Will Delete",
      body: "Content",
      identifier: "uuid-will-delete",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      folderPk: 500,
      folderName: "Notes",
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Insert the trash folder
    testDb
      .prepare(
        `INSERT OR IGNORE INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZIDENTIFIER)
       VALUES (?, ?, ?)`,
      )
      .run(501, "Recently Deleted", "TrashFolder-CloudKit");

    // Move note to "Recently Deleted" folder (how Apple Notes handles deletion)
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZFOLDER = 501, ZMODIFICATIONDATE1 = ? WHERE Z_PK = 1`,
      )
      .run(TS_2024_03_08 + 100);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toContain("uuid-will-delete");
  });

  test("detects deletion after note was previously synced", async () => {
    // First sync picks up the note
    insertNote(testDb, {
      pk: 1,
      title: "Will Delete",
      body: "Content",
      identifier: "uuid-will-delete",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Now mark it as deleted (Apple sets ZMARKEDFORDELETION=1)
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1, ZMODIFICATIONDATE1 = ? WHERE Z_PK = 1`,
      )
      .run(TS_2024_03_08 + 100);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toContain("uuid-will-delete");
  });

  test("a remote deletion that bumps only the folder-move stamp is reported once", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Synced then remotely deleted",
      body: "Body",
      identifier: "uuid-remote-delete",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09,
      folderPk: 500,
      folderName: "Notes",
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Another device deletes the note: it moves to "Recently Deleted" with
    // the modification date untouched — only the folder-move stamp records
    // the change, at a time the cursor has already passed.
    testDb
      .prepare(
        `INSERT OR IGNORE INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZIDENTIFIER)
         VALUES (600, 'Recently Deleted', 'TrashFolder-CloudKit')`,
      )
      .run();
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZFOLDER = 600, ZFOLDERMODIFICATIONDATE = ? WHERE Z_PK = 1`,
      )
      .run(TS_2024_03_09 + 500);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toEqual(["uuid-remote-delete"]);
    expect(r2.presentExternalIds).toEqual([]);

    // The cursor advanced past the folder-move stamp: the next cycle is quiet.
    const r3 = await source.sync(r2.cursor);
    expect(r3.deletedExternalIds).toEqual([]);
    expect(r3.documents).toHaveLength(0);
  });

  test("a store without the folder-move stamp still reports ordinary deletions", async () => {
    // Rebuild the store without ZFOLDERMODIFICATIONDATE, as an older macOS
    // schema would have it: the deletes window falls back to the modification
    // date alone rather than guessing at a column.
    testDb.close();
    rmSync(dbPath);
    testDb = new Database(dbPath);
    testDb.exec(`
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (
        Z_PK INTEGER PRIMARY KEY,
        ZTITLE1 TEXT,
        ZSNIPPET TEXT,
        ZIDENTIFIER TEXT,
        ZCREATIONDATE3 REAL,
        ZMODIFICATIONDATE1 REAL,
        ZISPASSWORDPROTECTED INTEGER DEFAULT 0,
        ZISPINNED INTEGER DEFAULT 0,
        ZMARKEDFORDELETION INTEGER DEFAULT 0,
        ZFOLDER INTEGER,
        ZACCOUNT2 INTEGER,
        ZNOTEDATA INTEGER,
        ZTITLE2 TEXT,
        ZNAME TEXT
      );
      CREATE TABLE ZICNOTEDATA (
        Z_PK INTEGER PRIMARY KEY,
        ZNOTE INTEGER,
        ZDATA BLOB
      );
    `);
    testDb
      .prepare(
        `INSERT INTO ZICCLOUDSYNCINGOBJECT
         (Z_PK, ZTITLE1, ZSNIPPET, ZIDENTIFIER, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZNOTEDATA)
         VALUES (1, 'Legacy note', 'Body', 'uuid-legacy', ?, ?, 1001)`,
      )
      .run(TS_2024_03_08, TS_2024_03_09);
    testDb
      .prepare(`INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (1001, 1, ?)`)
      .run(buildNoteData("Legacy note", "Body"));

    provider = new AppleProvider({
      notesDbPath: dbPath,
      remindersDirPath: join(tmpDir, "nonexistent"),
      accountId: "test@icloud.com",
    });
    await provider.initialize();
    await provider.authenticate();
    source = new AppleNotesSource(provider, {
      sourceId: "apple-notes:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // An ordinary local deletion bumps the modification date; it is reported.
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1, ZMODIFICATIONDATE1 = ? WHERE Z_PK = 1`,
      )
      .run(TS_2024_03_09 + 500);
    const r2 = await source.sync(r1.cursor);
    expect(r2.deletedExternalIds).toEqual(["uuid-legacy"]);
  });

  test("a deletion is emitted once: the cursor moves past the trashed row", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Keeps",
      body: "Content",
      identifier: "uuid-keeps",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });
    insertNote(testDb, {
      pk: 2,
      title: "Goes",
      body: "Content",
      identifier: "uuid-goes",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(2);

    // The trash stamp is the newest timestamp in the store — the shape a
    // real deletion has, and the one that used to keep the cursor parked on
    // it (`>=`) so the same tombstone fired on every later tick.
    testDb
      .prepare(
        `UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1, ZMODIFICATIONDATE1 = ? WHERE Z_PK = 2`,
      )
      .run(TS_2024_03_08 + 100);
    const r2 = await source.sync(r1.cursor);
    expect(r2.deletedExternalIds).toEqual(["uuid-goes"]);

    const r3 = await source.sync(r2.cursor);
    expect(r3.deletedExternalIds).toEqual([]);
    expect(r3.documents).toHaveLength(0);

    // A later deletion sharing the trashed row's timestamp but a higher row
    // id still falls inside the next window: the boundary is composite.
    insertNote(testDb, {
      pk: 3,
      title: "Also goes",
      body: "Content",
      identifier: "uuid-also-goes",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08 + 100,
      isTrashed: true,
    });
    const r4 = await source.sync(r3.cursor);
    expect(r4.deletedExternalIds).toEqual(["uuid-also-goes"]);
    expect((await source.sync(r4.cursor)).deletedExternalIds).toEqual([]);
  });

  test("across a multi-page incremental run, a deletion is reported on exactly one page", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Anchor",
      body: "anchor",
      identifier: "uuid-anchor",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });
    let result = await source.sync(null);
    while (result.hasMore) result = await source.sync(result.cursor);

    // More edits than one page holds, and a trash stamp newer than all of them.
    // The provider pages 100 live rows at a time.
    for (let i = 0; i < 105; i += 1) {
      insertNote(testDb, {
        pk: 100 + i,
        title: `Edited ${i}`,
        body: "body",
        identifier: `uuid-edited-${i}`,
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_09 + i,
      });
    }
    insertNote(testDb, {
      pk: 999,
      title: "Trashed",
      body: "gone",
      identifier: "uuid-trashed",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_09 + 1000,
      isTrashed: true,
    });

    const reported: string[] = [];
    let pages = 0;
    let cursor = result.cursor;
    do {
      result = await source.sync(cursor);
      reported.push(...result.deletedExternalIds);
      cursor = result.cursor;
      pages += 1;
    } while (result.hasMore);
    expect(pages).toBeGreaterThan(1);
    expect(reported).toEqual(["uuid-trashed"]);
    expect((await source.sync(cursor)).deletedExternalIds).toEqual([]);
  });

  test("locked / password-protected notes are skipped", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Secret Note",
      body: "Hidden content",
      identifier: "uuid-locked",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      isLocked: true,
    });
    // A second, unlocked note guarantees the source still runs the page query.
    insertNote(testDb, {
      pk: 2,
      title: "Visible Note",
      body: "Shown content",
      identifier: "uuid-visible",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const result = await source.sync(null);
    // Only the visible note is emitted — the locked note is filtered at the
    // SQL layer (and a JS-level guard in case the column rename slips
    // through schema detection).
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("uuid-visible");
    // The locked note must also be absent from the snapshot reconciliation
    // so the gateway doesn't see a present-but-never-indexed phantom.
    expect(result.presentExternalIds ?? []).not.toContain("uuid-locked");
  });

  test("handles pinned notes", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Important",
      body: "Pinned content",
      identifier: "uuid-pinned",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      isPinned: true,
    });

    const result = await source.sync(null);
    expect(result.documents[0].metadata.extra?.isPinned).toBe(true);
  });

  test("paginates with hasMore", async () => {
    for (let i = 1; i <= 101; i++) {
      insertNote(testDb, {
        pk: i,
        title: `Note ${i}`,
        body: `Content ${i}`,
        identifier: `uuid-${i}`,
        creationDate: TS_2024_03_08 + i,
        modificationDate: TS_2024_03_08 + i,
      });
    }

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(100);
    expect(r1.hasMore).toBe(true);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.hasMore).toBe(false);
  });

  test("paginates across notes sharing one modificationDate without dropping tied rows", async () => {
    // 101 notes all stamped with the SAME modificationDate (e.g. a bulk
    // import or restore). A timestamp-only cursor advances to that shared
    // timestamp after page 1 and resumes with `modificationDate > cursor`,
    // skipping every tied note past the first page. The composite
    // `(modificationDate, Z_PK)` cursor must drain all 101.
    for (let i = 1; i <= 101; i++) {
      insertNote(testDb, {
        pk: i,
        title: `Note ${i}`,
        body: `Content ${i}`,
        identifier: `uuid-${i}`,
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
    }

    const emitted = new Set<string>();
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(100);
    expect(r1.hasMore).toBe(true);
    for (const doc of r1.documents) emitted.add(doc.externalId);

    const r2 = await source.sync(r1.cursor);
    for (const doc of r2.documents) emitted.add(doc.externalId);
    expect(r2.hasMore).toBe(false);

    // Every tied note emitted exactly once across the two pages — including
    // the 101st, which the timestamp-only cursor dropped.
    expect(emitted.size).toBe(101);
    for (let i = 1; i <= 101; i++) {
      expect(emitted.has(`uuid-${i}`)).toBe(true);
    }
  });

  test("cursor tracks lastModifiedTimestamp", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Note",
      body: "Content",
      identifier: "uuid-1",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08 + 500,
    });

    const result = await source.sync(null);
    const cursor = result.cursor as any;
    expect(cursor.lastModifiedTimestamp).toBe(TS_2024_03_08 + 500);
  });

  test("reports bootstrap progress", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Note",
      body: "Content",
      identifier: "uuid-1",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const result = await source.sync(null);
    expect(result.progress?.phase).toBe("bootstrap");
    expect(result.progress?.total).toBe(1);

    // No new work since first sync → no queue → no progress.
    const r2 = await source.sync(result.cursor);
    expect(r2.progress).toBeUndefined();
  });

  test("reports incremental progress when notes change", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "First",
      body: "Content",
      identifier: "uuid-1",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
    });

    const r1 = await source.sync(null);

    // New note with a strictly later modification date.
    insertNote(testDb, {
      pk: 2,
      title: "Second",
      body: "Content 2",
      identifier: "uuid-2",
      creationDate: TS_2024_03_08 + 1,
      modificationDate: TS_2024_03_08 + 1,
    });

    const r2 = await source.sync(r1.cursor);
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.total).toBe(1);
    expect(r2.progress!.processed).toBe(1);
  });

  // The declared profile is what subscription compilation reads when it turns
  // "when I pin a note in Projects" into a document predicate, so each declared
  // role and path has to be something a synced note really carries. The final
  // assertion re-lists the declared paths, so adding one without proving the
  // normalizer emits it fails here.
  test("emits every person role and metadata field the document profile declares", async () => {
    insertNote(testDb, {
      pk: 1,
      title: "Quarterly plan",
      body: "Outline the quarter",
      identifier: "note-uuid-profile",
      creationDate: TS_2024_03_08,
      modificationDate: TS_2024_03_08,
      folderPk: 700,
      folderName: "Projects",
      isPinned: true,
    });

    const [doc] = (await source.sync(null)).documents;

    expect(appleNotesDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleNotesDocumentProfile.personRoles),
    );
    expect(doc.metadata.tags).toEqual(["Projects"]);
    expect(doc.metadata.extra?.folder).toBe("Projects");
    expect(doc.metadata.extra?.isPinned).toBe(true);
    expect(appleNotesDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "tags",
      "extra.folder",
      "extra.isPinned",
    ]);
  });

  describe("dataCutoff", () => {
    test("excludes notes created before the cutoff", async () => {
      // Note created on 2024-03-08 (before cutoff)
      insertNote(testDb, {
        pk: 1,
        title: "Old Note",
        body: "Old content",
        identifier: "uuid-old",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      // Note created on 2024-03-09 (at or after cutoff)
      insertNote(testDb, {
        pk: 2,
        title: "New Note",
        body: "New content",
        identifier: "uuid-new",
        creationDate: TS_2024_03_09,
        modificationDate: TS_2024_03_09,
      });

      const cutoffSource = new AppleNotesSource(provider, {
        sourceId: "apple-notes:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].title).toBe("New Note");
    });

    test("includes all notes when no cutoff is set", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "Old Note",
        body: "Old content",
        identifier: "uuid-old",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "New Note",
        body: "New content",
        identifier: "uuid-new",
        creationDate: TS_2024_03_09,
        modificationDate: TS_2024_03_09,
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(2);
    });

    test("total in progress reflects cutoff filter", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "Old Note",
        body: "Old content",
        identifier: "uuid-old",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "New Note",
        body: "New content",
        identifier: "uuid-new",
        creationDate: TS_2024_03_09,
        modificationDate: TS_2024_03_09,
      });

      const cutoffSource = new AppleNotesSource(provider, {
        sourceId: "apple-notes:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.progress?.total).toBe(1);
    });
  });

  describe("snapshot reconciliation", () => {
    test("emits presentExternalIds covering every active note when bootstrap fits in one page", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "A",
        body: "a",
        identifier: "alive-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "B",
        body: "b",
        identifier: "alive-2",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });

      const result = await source.sync(null);
      expect(result.hasMore).toBe(false);
      expect(result.presentExternalIds?.sort()).toEqual(["alive-1", "alive-2"]);
    });

    test("does NOT emit presentExternalIds mid-bootstrap (closes spurious-deletions bug)", async () => {
      // 101 notes → first page returns hasMore=true. Snapshot must
      // NOT be emitted on partial pages or every note we haven't paged
      // through yet would be deleted.
      for (let i = 1; i <= 101; i++) {
        insertNote(testDb, {
          pk: i,
          title: `N${i}`,
          body: `b${i}`,
          identifier: `uuid-${i}`,
          creationDate: TS_2024_03_08 + i,
          modificationDate: TS_2024_03_08 + i,
        });
      }

      const r1 = await source.sync(null);
      expect(r1.hasMore).toBe(true);
      expect(r1.presentExternalIds).toBeUndefined();

      const r2 = await source.sync(r1.cursor);
      expect(r2.hasMore).toBe(false);
      expect(r2.presentExternalIds).toBeDefined();
      expect(r2.presentExternalIds!.length).toBe(101);
    });

    test("hard-deletes (note row gone, no tombstone) drop from snapshot", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "A",
        body: "a",
        identifier: "uuid-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "B",
        body: "b",
        identifier: "uuid-2",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });

      const first = await source.sync(null);
      expect(first.presentExternalIds?.sort()).toEqual(["uuid-1", "uuid-2"]);

      // Hard-delete the note rows entirely (simulates iCloud syncing
      // a deletion through that bypasses ZMARKEDFORDELETION).
      testDb.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = 2").run();
      testDb.prepare("DELETE FROM ZICNOTEDATA WHERE Z_PK = 2").run();

      const second = await source.sync(first.cursor);
      // Incremental: no docs change, but snapshot still surfaces the
      // missing ID for gateway-side reconciliation.
      expect(second.presentExternalIds).toEqual(["uuid-1"]);
    });

    test("an equal-count exchange of notes still re-enumerates the snapshot", async () => {
      // The collision the cheap signature has to survive: one note leaves the
      // live set in the same cycle another joins it with a modificationDate
      // BELOW the incremental cursor (a note restored from iCloud). The count
      // returns to its previous value, MAX(modificationDate) stays pinned by
      // an unrelated note, and the incremental predicate sees neither row — so
      // a signature built only from those two terms is unchanged and the
      // enumeration is skipped, stranding the deleted note in the corpus.
      // SUM(modificationDate) cannot break the tie either: both sides of the
      // exchange carry the same timestamp. MAX(Z_PK) is what moves, because
      // Core Data primary keys are monotone and the joining row is new.
      insertNote(testDb, {
        pk: 1,
        title: "Keep",
        body: "k",
        identifier: "keep-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "Doomed",
        body: "d",
        identifier: "doomed-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      // Pins MAX(modificationDate) so the exchange below cannot move it.
      insertNote(testDb, {
        pk: 3,
        title: "Newest",
        body: "n",
        identifier: "newest-1",
        creationDate: TS_2024_03_09,
        modificationDate: TS_2024_03_09,
      });

      const first = await source.sync(null);
      expect(first.presentExternalIds?.sort()).toEqual(["doomed-1", "keep-1", "newest-1"]);

      testDb.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = 2").run();
      testDb.prepare("DELETE FROM ZICNOTEDATA WHERE Z_PK = 1002").run();
      insertNote(testDb, {
        pk: 4,
        title: "Restored",
        body: "r",
        identifier: "restored-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });

      const second = await source.sync(first.cursor);
      // Nothing to page in — the restored note sits below the cursor.
      expect(second.documents).toHaveLength(0);
      expect(second.presentExternalIds?.sort()).toEqual(["keep-1", "newest-1", "restored-1"]);
    });

    test("a stored signature from an earlier term set forces one enumeration", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "A",
        body: "a",
        identifier: "uuid-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });

      // A cursor written before the signature grew its identity terms. It can
      // never compare equal to a signature of the current shape, so the first
      // cycle after the upgrade re-enumerates instead of trusting it.
      const result = await source.sync({
        lastModifiedTimestamp: TS_2024_03_08,
        lastModifiedPk: 1,
        lastSnapshotSignature: `1:${TS_2024_03_08}`,
      });
      expect(result.presentExternalIds).toEqual(["uuid-1"]);
    });

    test("notes in Trash folder are excluded from the snapshot", async () => {
      insertNote(testDb, {
        pk: 1,
        title: "Live",
        body: "l",
        identifier: "live-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
      });
      insertNote(testDb, {
        pk: 2,
        title: "Trashed",
        body: "t",
        identifier: "trash-1",
        creationDate: TS_2024_03_08,
        modificationDate: TS_2024_03_08,
        folderPk: 501,
        folderName: "Recently Deleted",
        folderIdentifier: "TrashFolder-CloudKit",
      });

      const result = await source.sync(null);
      // Bootstrap deliberately emits no `deletedExternalIds` — the
      // snapshot path (`presentExternalIds`) is the canonical
      // delete-detection on a fresh sync, and emitting "delete this
      // trashed note" against a gateway that has nothing is just
      // round-trip noise. See `bootstrap does NOT emit trashed notes
      // as deletes` above.
      expect(result.deletedExternalIds).toEqual([]);
      // Trashed note still excluded from presentExternalIds — snapshot
      // path is the actual delete-detection on bootstrap.
      expect(result.presentExternalIds).toEqual(["live-1"]);
    });
  });
});

describe("AppleNotesSource — refusing to vouch for an unverified read", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Db;
  let provider: AppleProvider;
  let source: AppleNotesSource;

  const CREATED = 700000000;

  function seed(count: number, from = 1) {
    for (let i = from; i < from + count; i++) {
      insertNote(db, {
        pk: i,
        title: `Note ${i}`,
        body: `Body of note ${i}`,
        identifier: `note-${i}`,
        creationDate: CREATED,
        modificationDate: CREATED + i,
      });
    }
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-notes-vouch-test-"));
    dbPath = join(tmpDir, "NoteStore.sqlite");
    db = createTestDb(dbPath);
    provider = new AppleProvider({
      notesDbPath: dbPath,
      remindersDirPath: join(tmpDir, "nonexistent"),
      accountId: "notes@example.com",
    });
    await provider.initialize();
    source = new AppleNotesSource(provider, {
      sourceId: "apple-notes:notes@example.com",
      providerId: "apple:notes@example.com",
    });
  });

  afterEach(async () => {
    await provider.disconnect();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a large deletion reconciles — magnitude is not the provider's judgement", async () => {
    seed(20);
    const healthy = await source.sync(null);
    expect(healthy.presentExternalIds).toHaveLength(20);

    // Fifteen of twenty notes deleted at once. The read covered its one
    // partition, so the source knows what the store holds and says so. Refusing
    // here would not delay the deletion — a withheld snapshot tells the gateway
    // nothing, so nothing gets marked and no deadline runs — it would cancel
    // it, and leave Omnesis holding notes the operator deleted.
    db.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK <= 15").run();
    const collapsed = await source.sync(healthy.cursor);
    expect(collapsed.presentExternalIds?.sort()).toEqual([
      "note-16",
      "note-17",
      "note-18",
      "note-19",
      "note-20",
    ]);
  });

  test("emptying the store entirely reconciles to zero", async () => {
    seed(20);
    const healthy = await source.sync(null);
    expect(healthy.presentExternalIds).toHaveLength(20);

    db.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT").run();
    const emptied = await source.sync(healthy.cursor);
    // `[]`, not `undefined`. An operator who deletes every note expects them
    // gone from Omnesis; a guard that silently kept them would be a privacy
    // failure worse than the bug it was guarding against.
    expect(emptied.presentExternalIds).toEqual([]);
  });

  test("an ordinary deletion still reconciles", async () => {
    seed(20);
    const healthy = await source.sync(null);
    expect(healthy.presentExternalIds).toHaveLength(20);

    db.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = 7").run();
    const next = await source.sync(healthy.cursor);
    expect(next.presentExternalIds).toHaveLength(19);
    expect(next.presentExternalIds!).not.toContain("note-7");
  });

  test("a schema whose column names cannot be identified fails loudly instead of reading through a guess", async () => {
    // A note store where none of the candidate names for the `account` column
    // exists. The historical fallback is not in the table either, so every
    // query built from it would otherwise fail with an opaque SQLite error
    // from deep inside the walk.
    const strangeDir = mkdtempSync(join(tmpdir(), "apple-notes-schema-test-"));
    const strangePath = join(strangeDir, "NoteStore.sqlite");
    const strange = new Database(strangePath);
    strange.exec(`
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (
        Z_PK INTEGER PRIMARY KEY,
        ZTITLE1 TEXT,
        ZSNIPPET TEXT,
        ZIDENTIFIER TEXT,
        ZCREATIONDATE3 REAL,
        ZMODIFICATIONDATE1 REAL,
        ZISPASSWORDPROTECTED INTEGER DEFAULT 0,
        ZISPINNED INTEGER DEFAULT 0,
        ZMARKEDFORDELETION INTEGER DEFAULT 0,
        ZFOLDER INTEGER,
        ZNOTEDATA INTEGER,
        ZTITLE2 TEXT,
        ZNAME TEXT
      );
      CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);
    `);
    strange.close();

    const strangeProvider = new AppleProvider({
      notesDbPath: strangePath,
      remindersDirPath: join(strangeDir, "nonexistent"),
      accountId: "notes@example.com",
    });
    const strangeSource = new AppleNotesSource(strangeProvider, {
      sourceId: "apple-notes:notes@example.com",
      providerId: "apple:notes@example.com",
    });
    try {
      await expect(strangeSource.sync(null)).rejects.toThrow(
        /Apple Notes schema not recognised.*account/s,
      );
    } finally {
      await strangeProvider.disconnect();
      rmSync(strangeDir, { recursive: true, force: true });
    }
  });

  test("a locked note is absent from the documents AND from the snapshot", async () => {
    seed(3);
    insertNote(db, {
      pk: 90,
      title: "Locked",
      body: "",
      identifier: "note-locked",
      creationDate: CREATED,
      modificationDate: CREATED + 90,
      isLocked: true,
    });

    const result = await source.sync(null);
    // A note excluded from ingest but present in the enumeration would be
    // deleted on the next reconcile; one present in ingest but absent from the
    // enumeration would be deleted immediately. The two filters are the same
    // expression, so neither can happen.
    expect(result.documents.map((d) => d.externalId)).not.toContain("note-locked");
    expect(result.presentExternalIds).toBeDefined();
    expect(result.presentExternalIds!).not.toContain("note-locked");
    expect(result.presentExternalIds!.sort()).toEqual(["note-1", "note-2", "note-3"]);
  });
});
