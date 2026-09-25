// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { SourceId, ProviderId } from "@omnesis/types";
import { AppleRemindersSource } from "./reminders.js";
import { appleRemindersDocumentProfile } from "./document-profiles.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Core Data timestamp for 2024-03-08 00:00:00 UTC
const TS_2024_03_08 = 731548800;
const TS_2024_03_09 = TS_2024_03_08 + 86400;

/**
 * Create a test SQLite database mimicking Reminders schema.
 */
function createTestRemindersDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE ZREMCDBASELIST (
      Z_PK INTEGER PRIMARY KEY,
      ZNAME TEXT,
      ZMARKEDFORDELETION INTEGER DEFAULT 0,
      ZIDENTIFIER BLOB
    );

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

    CREATE TABLE ZREMCDHASHTAGLABEL (
      Z_PK INTEGER PRIMARY KEY,
      ZNAME TEXT
    );

    CREATE TABLE ZREMCDOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZREMINDER INTEGER,
      ZREMINDER1 INTEGER,
      ZREMINDER2 INTEGER,
      ZHASHTAGLABEL INTEGER,
      ZREMINDER3 INTEGER,
      ZREMINDER4 INTEGER,
      ZREMINDER5 INTEGER
    );
  `);

  return db;
}

function insertHashtag(db: Db, pk: number, name: string) {
  db.prepare("INSERT INTO ZREMCDHASHTAGLABEL (Z_PK, ZNAME) VALUES (?, ?)").run(pk, name);
}

function linkReminderHashtag(db: Db, joinPk: number, reminderPk: number, hashtagPk: number) {
  db.prepare("INSERT INTO ZREMCDOBJECT (Z_PK, ZHASHTAGLABEL, ZREMINDER3) VALUES (?, ?, ?)").run(
    joinPk,
    hashtagPk,
    reminderPk,
  );
}

function insertList(db: Db, pk: number, name: string) {
  db.prepare(
    "INSERT INTO ZREMCDBASELIST (Z_PK, ZNAME, ZIDENTIFIER) VALUES (?, ?, randomblob(16))",
  ).run(pk, name);
}

function insertReminder(
  db: Db,
  opts: {
    pk: number;
    identifier: string;
    title: string;
    notes?: string;
    completed?: boolean;
    flagged?: boolean;
    priority?: number;
    creationDate: number;
    lastModifiedDate: number;
    dueDate?: number;
    completionDate?: number;
    allDay?: boolean;
    listPk?: number;
    isTrashed?: boolean;
  },
) {
  // Store identifier as a hex blob
  const idBuf = Buffer.from(opts.identifier.replace(/-/g, ""), "hex");
  db.prepare(
    `INSERT INTO ZREMCDREMINDER
     (Z_PK, ZIDENTIFIER, ZTITLE, ZNOTES, ZCOMPLETED, ZFLAGGED, ZPRIORITY,
      ZCREATIONDATE, ZLASTMODIFIEDDATE, ZDUEDATE, ZCOMPLETIONDATE,
      ZALLDAY, ZMARKEDFORDELETION, ZLIST)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.pk,
    idBuf,
    opts.title,
    opts.notes ?? null,
    opts.completed ? 1 : 0,
    opts.flagged ? 1 : 0,
    opts.priority ?? 0,
    opts.creationDate,
    opts.lastModifiedDate,
    opts.dueDate ?? null,
    opts.completionDate ?? null,
    opts.allDay ? 1 : 0,
    opts.isTrashed ? 1 : 0,
    opts.listPk ?? null,
  );
}

describe("AppleRemindersSource", () => {
  let tmpDir: string;
  let testDb: Db;
  let source: AppleRemindersSource;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-reminders-test-"));
    const dbPath = join(tmpDir, "Data-test.sqlite");
    testDb = createTestRemindersDb(dbPath);
    insertList(testDb, 1, "Reminders");
    insertList(testDb, 2, "Groceries");

    source = new AppleRemindersSource(testDb, {
      sourceId: "apple-reminders:test@icloud.com",
      providerId: "apple:test@icloud.com",
      dbPath,
    });
  });

  afterEach(() => {
    testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("apple-reminders:test@icloud.com"));
    expect(source.providerId).toBe(ProviderId("apple:test@icloud.com"));
  });

  test("returns empty result when no reminders", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("a reminder without a 16-byte identifier gets no deep link", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB00",
      title: "Water the plants",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 2,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.sourceUrl).toBeUndefined();
  });

  test("syncs a single reminder", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB01",
      title: "Buy bread",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 2,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toBe("Buy bread");
    expect(doc.content).toContain("Buy bread");
    expect(doc.metadata.sourceUrl).toBe(
      "x-apple-reminderkit://REMCDReminder/AABB0011-2233-4455-6677-889900AABB01",
    );
    expect(doc.metadata.documentType).toBe("reminder");
    expect(doc.metadata.tags).toEqual(["Groceries"]);
    expect(doc.metadata.status).toBe("open");
    expect(doc.metadata.extra?.list).toBe("Groceries");
    expect(doc.metadata.extra?.completed).toBe(false);
    expect(doc.sourceCreatedAt).toBe("2024-03-08T00:00:00.000Z");
  });

  test("two Mac stores converge on cloud reminder identity despite different local row ids", async () => {
    const identifier = "AABB0011223344556677889900AABB77";
    insertReminder(testDb, {
      pk: 7,
      identifier,
      title: "Review the project outline",
      notes: "Confirm the fictional milestones.",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 2,
    });
    const replicaPath = join(tmpDir, "Data-replica.sqlite");
    const replicaDb = createTestRemindersDb(replicaPath);
    insertList(replicaDb, 1700, "Groceries");
    insertReminder(replicaDb, {
      pk: 700,
      identifier,
      title: "Review the project outline",
      notes: "Confirm the fictional milestones.",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1700,
    });
    const replicaSource = new AppleRemindersSource(replicaDb, {
      sourceId: "apple-reminders:test@icloud.example",
      providerId: "apple:test@icloud.example",
      dbPath: replicaPath,
    });
    try {
      const firstSource = new AppleRemindersSource(testDb, {
        sourceId: "apple-reminders:test@icloud.example",
        providerId: "apple:test@icloud.example",
        dbPath: join(tmpDir, "Data-test.sqlite"),
      });
      const first = await firstSource.sync(null);
      const second = await replicaSource.sync(null);
      expect(first.documents.map((document) => document.externalId)).toEqual([identifier]);
      expect(second.documents).toEqual(first.documents);
      expect(second.cursor).not.toEqual(first.cursor);

      testDb
        .prepare(
          "UPDATE ZREMCDREMINDER SET ZMARKEDFORDELETION = 1, ZLASTMODIFIEDDATE = ? WHERE Z_PK = 7",
        )
        .run(TS_2024_03_09);
      replicaDb
        .prepare(
          "UPDATE ZREMCDREMINDER SET ZMARKEDFORDELETION = 1, ZLASTMODIFIEDDATE = ? WHERE Z_PK = 700",
        )
        .run(TS_2024_03_09);
      expect((await firstSource.sync(first.cursor)).deletedExternalIds).toEqual([identifier]);
      expect((await replicaSource.sync(second.cursor)).deletedExternalIds).toEqual([identifier]);
    } finally {
      replicaDb.close();
    }
  });

  test("syncs completed reminder", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB02",
      title: "Done task",
      completed: true,
      completionDate: TS_2024_03_09,
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_09,
      listPk: 1,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.metadata.status).toBe("completed");
    expect(doc.metadata.extra?.completed).toBe(true);
    expect(doc.content).toContain("Completed");
  });

  test("syncs reminder with due date", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB03",
      title: "Call dad",
      dueDate: TS_2024_03_09,
      allDay: true,
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("Due: 2024-03-09");
    expect(doc.metadata.extra?.dueDate).toBeDefined();
    // First-class typed deadline (date-only for an all-day reminder). A
    // reminder has no separate scheduled-start, so `scheduledAt` stays unset.
    expect(doc.metadata.dueAt).toBe("2024-03-09");
    expect(doc.metadata.scheduledAt).toBeUndefined();
  });

  test("omits typed dueAt when a reminder has no due date", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB0D",
      title: "Water the plants",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.metadata.dueAt).toBeUndefined();
    expect(doc.metadata.scheduledAt).toBeUndefined();
  });

  test("syncs flagged high-priority reminder", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB04",
      title: "Urgent",
      flagged: true,
      priority: 1,
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.metadata.extra?.flagged).toBe(true);
    expect(doc.metadata.extra?.priority).toBe("high");
    expect(doc.content).toContain("Priority: high");
    expect(doc.content).toContain("Flagged");
  });

  test("syncs reminder with notes", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB05",
      title: "Meeting prep",
      notes: "Review slides\nPrint handouts",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("Review slides");
    expect(doc.content).toContain("Print handouts");
  });

  test("incremental sync only returns modified reminders", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB06",
      title: "Old",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);

    insertReminder(testDb, {
      pk: 2,
      identifier: "AABB0011223344556677889900AABB07",
      title: "New",
      creationDate: TS_2024_03_09,
      lastModifiedDate: TS_2024_03_09,
      listPk: 1,
    });

    const r3 = await source.sync(r2.cursor);
    expect(r3.documents).toHaveLength(1);
    expect(r3.documents[0].title).toBe("New");
  });

  test("paginates across reminders sharing an identical last-modified timestamp", async () => {
    // Regression for provider-apple-3: a plain `ZLASTMODIFIEDDATE > cursor`
    // keyset walk drops every tied reminder past the PAGE_SIZE slice — page 1
    // slices them off and page 2's `> timestamp` excludes the tied value, so
    // they vanish from sync output entirely. Reminders has no snapshot
    // reconciliation to surface them later. PAGE_SIZE is 200; insert 201
    // reminders all on one identical ZLASTMODIFIEDDATE so the boundary lands
    // inside the tied run.
    const total = 201;
    const expectedIds = new Set<string>();
    for (let i = 1; i <= total; i++) {
      // 32 hex chars, deterministic per pk → externalId === this identifier.
      const identifier = i.toString(16).toUpperCase().padStart(32, "0");
      expectedIds.add(identifier);
      insertReminder(testDb, {
        pk: i,
        identifier,
        title: `Imported task ${i}`,
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });
    }

    const emittedIds = new Set<string>();

    const page1 = await source.sync(null);
    expect(page1.hasMore).toBe(true);
    for (const doc of page1.documents) emittedIds.add(doc.externalId);

    const page2 = await source.sync(page1.cursor);
    for (const doc of page2.documents) emittedIds.add(doc.externalId);

    // Every tied reminder must emit across the two pages — none dropped at the
    // page boundary.
    expect(emittedIds.size).toBe(total);
    expect(emittedIds).toEqual(expectedIds);
  });

  test("detects trashed reminders as deletions on incremental sync", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB08",
      title: "Deleted",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_09,
      isTrashed: true,
      listPk: 1,
    });

    // Bootstrap (cursor=null → lastModified=0) intentionally does NOT emit
    // deletions — without a cursor every trashed reminder would surface as a
    // fake delete on first sync. The Notes source uses the same contract.
    // To exercise the deletion path we pass a cursor older than the row's
    // ZLASTMODIFIEDDATE so the incremental query picks the row up.
    const cursor = { lastModifiedTimestamp: TS_2024_03_08 };
    const result = await source.sync(cursor);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(1);
  });

  test("deletion emission advances the cursor past the deletion timestamp", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB99",
      title: "About to be trashed",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_09,
      isTrashed: true,
      listPk: 1,
    });

    // Cursor pinned just before the deletion timestamp.
    const result1 = await source.sync({ lastModifiedTimestamp: TS_2024_03_08 });
    expect(result1.deletedExternalIds).toHaveLength(1);
    const cursor1 = result1.cursor as { lastModifiedTimestamp: number };
    // The cursor must have advanced to the deleted row's modificationDate so
    // the deletion stream stays monotonic over (changes ∪ deletions). The
    // boundary-inclusive `>=` query is the price of not losing deletions at
    // the cursor edge; the gateway dedupes repeat tombstones idempotently.
    expect(cursor1.lastModifiedTimestamp).toBeGreaterThanOrEqual(TS_2024_03_09);
  });

  // The declared profile is what subscription compilation reads when it turns
  // "when I flag a high-priority reminder in Groceries" into a document
  // predicate, so each declared role and path has to be something a synced
  // reminder really carries. The final assertion re-lists the declared paths,
  // so adding one without proving the normalizer emits it fails here.
  test("emits every person role and metadata field the document profile declares", async () => {
    insertReminder(testDb, {
      pk: 60,
      identifier: "AABB0011223344556677889900AABB60",
      title: "Order coffee beans",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      completed: true,
      completionDate: TS_2024_03_09,
      flagged: true,
      priority: 1,
      dueDate: TS_2024_03_09,
      listPk: 2,
    });
    insertHashtag(testDb, 60, "pantry");
    linkReminderHashtag(testDb, 160, 60, 60);

    const [doc] = (await source.sync(null)).documents;

    expect(appleRemindersDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleRemindersDocumentProfile.personRoles),
    );
    expect(doc.metadata.tags).toEqual(["Groceries", "pantry"]);
    expect(doc.metadata.extra?.list).toBe("Groceries");
    expect(doc.metadata.extra?.hashtags).toEqual(["pantry"]);
    expect(doc.metadata.extra?.completed).toBe(true);
    expect(doc.metadata.extra?.flagged).toBe(true);
    // The three Reminders priority levels are the declared vocabulary; a
    // reminder outside them falls back to its raw number, which is why the
    // field is canonical rather than closed.
    expect(appleRemindersDocumentProfile.metadataFields).toContainEqual(
      expect.objectContaining({
        path: "extra.priority",
        canonicalValues: expect.arrayContaining([doc.metadata.extra?.priority]),
      }),
    );
    expect(appleRemindersDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "tags",
      "extra.list",
      "extra.hashtags",
      "extra.completed",
      "extra.flagged",
      "extra.priority",
    ]);
  });

  test("inline hashtags are surfaced in metadata.tags and rendered in content", async () => {
    // Reproduces apple-reminders-hashtags-ignored: hashtag labels were never
    // joined, so search-by-#tag and metadata.tags both missed them.
    insertReminder(testDb, {
      pk: 40,
      identifier: "AABB0011223344556677889900AABB40",
      title: "Read the news",
      notes: "And cnn.com",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });
    insertHashtag(testDb, 1, "news");
    insertHashtag(testDb, 2, "reading");
    linkReminderHashtag(testDb, 100, 40, 1);
    linkReminderHashtag(testDb, 101, 40, 2);

    const result = await source.sync(null);
    const doc = result.documents[0];

    expect(doc.metadata.tags).toEqual(expect.arrayContaining(["Reminders", "news", "reading"]));
    expect(doc.metadata.extra?.hashtags).toEqual(["news", "reading"]);
    expect(doc.content).toMatch(/Tags:.*#news.*#reading|Tags:.*#reading.*#news/);
  });

  test("hashtag names are normalized (lowercase, leading # stripped, deduped)", async () => {
    insertReminder(testDb, {
      pk: 41,
      identifier: "AABB0011223344556677889900AABB41",
      title: "Buy milk",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });
    // Macros that mimic real Reminders behaviour: leading '#' may or may not
    // be present depending on the entry path.
    insertHashtag(testDb, 10, "Groceries");
    insertHashtag(testDb, 11, "#GROCERIES");
    linkReminderHashtag(testDb, 200, 41, 10);
    linkReminderHashtag(testDb, 201, 41, 11);

    const result = await source.sync(null);
    const doc = result.documents[0];

    // After normalisation both rows collapse to "groceries"; deduped in tags.
    expect(doc.metadata.extra?.hashtags).toEqual(["groceries"]);
    const groceryEntries = (doc.metadata.tags ?? []).filter((t) => t === "groceries");
    expect(groceryEntries).toHaveLength(1);
  });

  test("reminders without hashtags still emit only the list-name tag", async () => {
    insertReminder(testDb, {
      pk: 42,
      identifier: "AABB0011223344556677889900AABB42",
      title: "Plain task",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });
    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.metadata.tags).toEqual(["Reminders"]);
    expect(doc.metadata.extra?.hashtags).toBeUndefined();
    expect(doc.content).not.toContain("Tags:");
  });

  test("picks the correct ZREMINDER* column when multiple are present (Sequoia-style schema)", async () => {
    // Reproduces the validation failure on 2026-04-28: the previous picker
    // used `cols.find()` on `/^ZREMINDER\d*$/`, which returned `ZREMINDER`
    // (the first match). On Sequoia the hashtag FK actually lives on
    // `ZREMINDER3`, so the join silently returned 0 rows.
    insertReminder(testDb, {
      pk: 50,
      identifier: "AABB0011223344556677889900AABB50",
      title: "Tag picker test",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });
    insertHashtag(testDb, 50, "important");
    // Insert a junk row on ZREMINDER (column 0) just to make sure the
    // picker doesn't accidentally settle on it.
    testDb.prepare("INSERT INTO ZREMCDOBJECT (Z_PK, ZREMINDER) VALUES (?, ?)").run(900, 999);
    // The actual hashtag FK lives on ZREMINDER3 (Sequoia layout).
    linkReminderHashtag(testDb, 901, 50, 50);

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.metadata.tags).toEqual(expect.arrayContaining(["Reminders", "important"]));
  });

  test("re-probes hashtag column on next sync after first hashtag is created", async () => {
    // If a user has zero inline hashtags at boot, the picker must NOT cache
    // a "no hashtags" verdict — otherwise the source ignores their first
    // hashtag forever (until collector restart).
    insertReminder(testDb, {
      pk: 60,
      identifier: "AABB0011223344556677889900AABB60",
      title: "Pre-hashtag",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    // First sync — no hashtags exist yet.
    const first = await source.sync(null);
    expect(first.documents[0].metadata.tags).toEqual(["Reminders"]);

    // User adds their first hashtag on this reminder. Bump
    // ZLASTMODIFIEDDATE so the second sync picks the row up.
    insertHashtag(testDb, 60, "first");
    linkReminderHashtag(testDb, 700, 60, 60);
    testDb
      .prepare("UPDATE ZREMCDREMINDER SET ZLASTMODIFIEDDATE = ? WHERE Z_PK = ?")
      .run(TS_2024_03_09, 60);

    const second = await source.sync(first.cursor);
    expect(second.documents[0].metadata.tags).toEqual(
      expect.arrayContaining(["Reminders", "first"]),
    );
  });

  test("missing hashtag tables degrade gracefully (older macOS schemas)", async () => {
    // Drop the hashtag tables to simulate an older macOS schema. Source
    // should detect the absence and not crash.
    testDb.exec("DROP TABLE ZREMCDOBJECT; DROP TABLE ZREMCDHASHTAGLABEL;");
    insertReminder(testDb, {
      pk: 43,
      identifier: "AABB0011223344556677889900AABB43",
      title: "Old-school reminder",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.tags).toEqual(["Reminders"]);
  });

  test("reports bootstrap progress", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB09",
      title: "Task",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const result = await source.sync(null);
    expect(result.progress?.phase).toBe("bootstrap");
    expect(result.progress?.total).toBe(1);

    // No new work → no progress.
    const r2 = await source.sync(result.cursor);
    expect(r2.progress).toBeUndefined();
  });

  test("reports incremental progress when reminders change", async () => {
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB01",
      title: "First",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const r1 = await source.sync(null);

    insertReminder(testDb, {
      pk: 2,
      identifier: "AABB0011223344556677889900AABB02",
      title: "Second",
      creationDate: TS_2024_03_08 + 1,
      lastModifiedDate: TS_2024_03_08 + 1,
      listPk: 1,
    });

    const r2 = await source.sync(r1.cursor);
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.total).toBe(1);
  });

  test("two separate sources for two stores sync independently", async () => {
    // Create a second store DB
    const db2Path = join(tmpDir, "Data-test2.sqlite");
    const db2 = createTestRemindersDb(db2Path);
    insertList(db2, 1, "Work");

    const source2 = new AppleRemindersSource(db2, {
      sourceId: "apple-reminders:other@icloud.com",
      providerId: "apple:other@icloud.com",
      dbPath: db2Path,
    });

    // Insert reminders in each store
    insertReminder(testDb, {
      pk: 1,
      identifier: "AABB0011223344556677889900AABB0A",
      title: "Store 1 task",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    insertReminder(db2, {
      pk: 1,
      identifier: "CCDD0011223344556677889900CCDD01",
      title: "Store 2 task",
      creationDate: TS_2024_03_08,
      lastModifiedDate: TS_2024_03_08,
      listPk: 1,
    });

    const r1 = await source.sync(null);
    const r2 = await source2.sync(null);

    expect(r1.documents).toHaveLength(1);
    expect(r1.documents[0].title).toBe("Store 1 task");
    expect(r1.documents[0].sourceId).toBe(SourceId("apple-reminders:test@icloud.com"));

    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0].title).toBe("Store 2 task");
    expect(r2.documents[0].sourceId).toBe(SourceId("apple-reminders:other@icloud.com"));

    db2.close();
  });

  describe("people stamping (Pattern A)", () => {
    test("stamps source's account email as author when accountId is an email", async () => {
      insertReminder(testDb, {
        pk: 1,
        identifier: "AABB0011223344556677889900AABB70",
        title: "Email-account reminder",
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });

      const result = await source.sync(null);
      const doc = result.documents[0];
      expect(doc.metadata.people).toEqual([{ role: "author", emails: ["test@icloud.com"] }]);
    });

    test("emits no people when accountId is not an email", async () => {
      const dbPath = join(tmpDir, "Data-test.sqlite");
      const localSource = new AppleRemindersSource(testDb, {
        sourceId: "apple-reminders:local",
        providerId: "apple:local",
        dbPath,
      });

      insertReminder(testDb, {
        pk: 1,
        identifier: "AABB0011223344556677889900AABB71",
        title: "Local-account reminder",
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });

      const result = await localSource.sync(null);
      const doc = result.documents[0];
      expect(doc.metadata.people).toBeUndefined();
    });
  });

  describe("dataCutoff", () => {
    test("excludes reminders created before the cutoff", async () => {
      insertReminder(testDb, {
        pk: 1,
        identifier: "AABB0011223344556677889900AABB0B",
        title: "Old Reminder",
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });
      insertReminder(testDb, {
        pk: 2,
        identifier: "AABB0011223344556677889900AABB0C",
        title: "New Reminder",
        creationDate: TS_2024_03_09,
        lastModifiedDate: TS_2024_03_09,
        listPk: 1,
      });

      const dbPath = join(tmpDir, "Data-test.sqlite");
      const cutoffSource = new AppleRemindersSource(testDb, {
        sourceId: "apple-reminders:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dbPath,
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].title).toBe("New Reminder");
    });

    test("includes all reminders when no cutoff is set", async () => {
      insertReminder(testDb, {
        pk: 1,
        identifier: "AABB0011223344556677889900AABB0D",
        title: "Old Reminder",
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });
      insertReminder(testDb, {
        pk: 2,
        identifier: "AABB0011223344556677889900AABB0E",
        title: "New Reminder",
        creationDate: TS_2024_03_09,
        lastModifiedDate: TS_2024_03_09,
        listPk: 1,
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(2);
    });

    test("total in progress reflects cutoff filter", async () => {
      insertReminder(testDb, {
        pk: 1,
        identifier: "AABB0011223344556677889900AABB0F",
        title: "Old Reminder",
        creationDate: TS_2024_03_08,
        lastModifiedDate: TS_2024_03_08,
        listPk: 1,
      });
      insertReminder(testDb, {
        pk: 2,
        identifier: "AABB0011223344556677889900AABB10",
        title: "New Reminder",
        creationDate: TS_2024_03_09,
        lastModifiedDate: TS_2024_03_09,
        listPk: 1,
      });

      const dbPath = join(tmpDir, "Data-test.sqlite");
      const cutoffSource = new AppleRemindersSource(testDb, {
        sourceId: "apple-reminders:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dbPath,
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.progress?.total).toBe(1);
    });
  });
});
