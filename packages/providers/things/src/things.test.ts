// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { validateDocumentTemporalProjectionContracts } from "@omnesis/source-sdk";
import definition from "./index.js";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// chmod 0o000 only denies a read for a non-root process; a build running as
// root (some CI/container setups) would read straight through it.
const canDenyReads = (process.getuid?.() ?? 0) !== 0;

// Unix timestamps for testing
const TS_2024_03_08 = 1709856000;
const TS_2024_03_09 = TS_2024_03_08 + 86400;
const TS_2024_03_10 = TS_2024_03_09 + 86400;

test("descriptor projects both planned and due dates with lifecycle-aware status", () => {
  const status = {
    from: "status",
    map: { open: "active", completed: "completed", canceled: "cancelled" },
    default: "active",
  };
  expect(definition.documentTemporalProjections).toEqual([
    {
      slot: "scheduled",
      start: "scheduledAt",
      kind: "event",
      modality: "asserted",
      status,
    },
    {
      slot: "due",
      start: "dueAt",
      kind: "deadline",
      modality: "asserted",
      status,
    },
  ]);
  expect(() =>
    validateDocumentTemporalProjectionContracts(definition.documentTemporalProjections, "things"),
  ).not.toThrow();
});

/**
 * Create a test SQLite database mimicking the Things schema.
 */
function createTestThingsDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE TMTask (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      notes TEXT,
      type INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      trashed INTEGER DEFAULT 0,
      creationDate REAL,
      userModificationDate REAL,
      startDate INTEGER,
      deadline INTEGER,
      stopDate REAL,
      start INTEGER DEFAULT 1,
      project TEXT,
      area TEXT,
      heading TEXT
    );

    CREATE TABLE TMChecklistItem (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      status INTEGER DEFAULT 0,
      task TEXT,
      "index" INTEGER
    );

    CREATE TABLE TMArea (
      uuid TEXT PRIMARY KEY,
      title TEXT
    );
  `);

  return db;
}

function insertTask(
  db: Db,
  opts: {
    uuid: string;
    title: string;
    notes?: string;
    type?: number;
    status?: number;
    trashed?: boolean;
    creationDate: number;
    userModificationDate: number;
    startDate?: number;
    deadline?: number;
    project?: string;
    area?: string;
    heading?: string;
  },
) {
  db.prepare(
    `INSERT INTO TMTask
     (uuid, title, notes, type, status, trashed, creationDate, userModificationDate,
      startDate, deadline, stopDate, start, project, area, heading)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(
    opts.uuid,
    opts.title,
    opts.notes ?? null,
    opts.type ?? 0,
    opts.status ?? 0,
    opts.trashed ? 1 : 0,
    opts.creationDate,
    opts.userModificationDate,
    opts.startDate ?? null,
    opts.deadline ?? null,
    opts.project ?? null,
    opts.area ?? null,
    opts.heading ?? null,
  );
}

function insertChecklistItem(
  db: Db,
  opts: { uuid: string; title: string; status: number; task: string; index: number },
) {
  db.prepare(
    'INSERT INTO TMChecklistItem (uuid, title, status, task, "index") VALUES (?, ?, ?, ?, ?)',
  ).run(opts.uuid, opts.title, opts.status, opts.task, opts.index);
}

function insertArea(db: Db, uuid: string, title: string) {
  db.prepare("INSERT INTO TMArea (uuid, title) VALUES (?, ?)").run(uuid, title);
}

describe("ThingsSource", () => {
  let tmpDir: string;
  let testDb: Db;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "things-test-"));
    dbPath = join(tmpDir, "main.sqlite");
    testDb = createTestThingsDb(dbPath);
  });

  afterEach(() => {
    testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createInstance() {
    return definition.create!({
      accountId: "local",
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
      config: { dbPath },
    });
  }

  test("returns empty result when no tasks", async () => {
    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("syncs a single task", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Buy milk",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toBe("Buy milk");
    expect(doc.externalId).toBe("task-1");
    expect(doc.metadata.documentType).toBe("task");
    expect(doc.content).toContain("# Buy milk");
    expect(doc.content).toContain("Status: Open");
  });

  test("syncs a project", async () => {
    insertTask(testDb, {
      uuid: "proj-1",
      title: "Home Renovation",
      type: 1,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.documentType).toBe("project");
  });

  test("excludes headings (type=2)", async () => {
    insertTask(testDb, {
      uuid: "heading-1",
      title: "Section A",
      type: 2,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
  });

  test("incremental sync only returns modified tasks", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Old task",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // No changes
    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);

    // New task added
    insertTask(testDb, {
      uuid: "task-2",
      title: "New task",
      creationDate: TS_2024_03_09,
      userModificationDate: TS_2024_03_09,
    });

    const r3 = await instance.sync(r2.cursor);
    expect(r3.documents).toHaveLength(1);
    expect(r3.documents[0].title).toBe("New task");
  });

  test("detects trashed tasks as deletions", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Deleted task",
      trashed: true,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_09,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toContain("task-1");
  });

  test("includes checklist items in content", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Shopping",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });
    insertChecklistItem(testDb, {
      uuid: "cl-1",
      title: "Milk",
      status: 3,
      task: "task-1",
      index: 0,
    });
    insertChecklistItem(testDb, {
      uuid: "cl-2",
      title: "Eggs",
      status: 0,
      task: "task-1",
      index: 1,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("- [x] Milk");
    expect(doc.content).toContain("- [ ] Eggs");
  });

  test("resolves project title", async () => {
    // Insert a project
    insertTask(testDb, {
      uuid: "proj-1",
      title: "Home Reno",
      type: 1,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    // Insert a task under that project
    insertTask(testDb, {
      uuid: "task-1",
      title: "Buy paint",
      project: "proj-1",
      creationDate: TS_2024_03_09,
      userModificationDate: TS_2024_03_09,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    // Both project and task should appear
    const taskDoc = result.documents.find((d) => d.externalId === "task-1");
    expect(taskDoc).toBeDefined();
    expect(taskDoc!.content).toContain("Project: Home Reno");
    expect(taskDoc!.metadata.extra?.project).toBe("Home Reno");
  });

  test("resolves area title", async () => {
    insertArea(testDb, "area-1", "Personal");

    insertTask(testDb, {
      uuid: "task-1",
      title: "Read book",
      area: "area-1",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("Area: Personal");
    expect(doc.metadata.extra?.area).toBe("Personal");
    expect(doc.metadata.tags).toEqual(["Personal"]);
  });

  test("includes notes in content", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Plan trip",
      notes: "Check flights\nBook hotel",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents[0].content).toContain("Check flights");
    expect(result.documents[0].content).toContain("Book hotel");
  });

  test("reports bootstrap progress", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Task",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const r1 = await instance.sync(null);
    expect(r1.progress?.phase).toBe("bootstrap");
    expect(r1.progress?.total).toBe(1);
    expect(r1.progress?.processed).toBe(1);

    // No new work since r1 → no queue → no progress (consistent with
    // "progress only when there's work").
    const r2 = await instance.sync(r1.cursor);
    expect(r2.progress).toBeUndefined();
  });

  test("reports incremental progress when new work appears", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "First",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const r1 = await instance.sync(null);

    // Add a new task with a strictly later modification date so the
    // incremental delta picks it up.
    insertTask(testDb, {
      uuid: "task-2",
      title: "Second",
      creationDate: TS_2024_03_08 + 1,
      userModificationDate: TS_2024_03_08 + 1,
    });

    const r2 = await instance.sync(r1.cursor);
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.total).toBe(1);
    expect(r2.progress!.processed).toBe(1);
  });

  test("handles completed tasks", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "Done",
      status: 3,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents[0].content).toContain("Status: Completed");
    expect(result.documents[0].metadata.status).toBe("completed");
    expect(result.documents[0].metadata.extra?.status).toBe("completed");
  });

  test("watchPaths includes db and wal", async () => {
    const instance = await createInstance();
    expect(instance.watchPaths).toContain(dbPath);
    expect(instance.watchPaths).toContain(`${dbPath}-wal`);
  });

  test("snapshot reconciliation: emits presentExternalIds covering every active task UUID", async () => {
    insertTask(testDb, {
      uuid: "alive-1",
      title: "A",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });
    insertTask(testDb, {
      uuid: "alive-2",
      title: "B",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });
    insertTask(testDb, {
      uuid: "trashed-1",
      title: "Gone",
      trashed: true,
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const result = await instance.sync(null);

    // Trashed tasks are excluded from the snapshot — `WHERE trashed = 0`.
    // alive-1 + alive-2 are the only "currently-present" UUIDs.
    expect(result.presentExternalIds?.sort()).toEqual(["alive-1", "alive-2"]);
  });

  test("snapshot reconciliation: hard-deleted task drops from snapshot — gateway will reconcile", async () => {
    insertTask(testDb, {
      uuid: "task-1",
      title: "A",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });
    insertTask(testDb, {
      uuid: "task-2",
      title: "B",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });

    const instance = await createInstance();
    const first = await instance.sync(null);
    expect(first.presentExternalIds?.sort()).toEqual(["task-1", "task-2"]);

    // Hard-delete task-2 — Things 3 wipes the row entirely.
    testDb.prepare("DELETE FROM TMTask WHERE uuid = ?").run("task-2");

    // Pass first cursor — incremental sync. No tasks have changed
    // userModificationDate, so we hit the empty-page path. Snapshot
    // must still be emitted there so deletion gets caught.
    const second = await instance.sync(first.cursor);
    expect(second.documents).toHaveLength(0);
    expect(second.presentExternalIds).toEqual(["task-1"]);
  });

  test("snapshot reconciliation: paginated sync only emits on the final page", async () => {
    // Insert 250 tasks to force pagination (PAGE_SIZE = 200).
    for (let i = 0; i < 250; i++) {
      insertTask(testDb, {
        uuid: `bulk-${i.toString().padStart(3, "0")}`,
        title: `task ${i}`,
        creationDate: TS_2024_03_08,
        userModificationDate: TS_2024_03_08 + i,
      });
    }

    const instance = await createInstance();
    const page1 = await instance.sync(null);
    // Mid-bootstrap: hasMore=true → snapshot must NOT be emitted.
    expect(page1.hasMore).toBe(true);
    expect(page1.presentExternalIds).toBeUndefined();

    // Drain. Final page emits the full snapshot.
    let cursor = page1.cursor;
    let last = page1;
    let safety = 10;
    while (last.hasMore && safety-- > 0) {
      last = await instance.sync(cursor);
      cursor = last.cursor;
    }
    expect(last.hasMore).toBe(false);
    expect(last.presentExternalIds).toBeDefined();
    expect(last.presentExternalIds!.length).toBe(250);
  });
});

describe("ThingsSource — refusing to vouch for a read it cannot verify", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "things-vouch-test-"));
    dbPath = join(tmpDir, "main.sqlite");
    testDb = createTestThingsDb(dbPath);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      /* already closed by a test */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createInstance() {
    return definition.create!({
      accountId: "local",
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
      config: { dbPath },
    });
  }

  function seed(count: number, from = 1) {
    for (let i = from; i < from + count; i++) {
      insertTask(testDb, {
        uuid: `task-${i}`,
        title: `Task ${i}`,
        creationDate: TS_2024_03_08,
        userModificationDate: TS_2024_03_08 + i,
      });
    }
  }

  /**
   * Remove a required table whose absence the queries themselves survive.
   *
   * This is the shape that matters: `buildLookupMaps` catches and ignores the
   * failure, the page query never touches TMArea, and the uuid enumeration runs
   * exactly as before. Nothing throws, nothing looks wrong, and the source is
   * reading a schema it does not recognise — which is precisely the state the
   * probe exists to detect and the old code threw away.
   */
  function breakSchema() {
    testDb.exec("DROP TABLE TMArea");
  }

  test("a failed schema probe withholds the snapshot rather than enumerating through it", async () => {
    seed(4);
    const healthy = await (await createInstance()).sync(null);
    expect(healthy.presentExternalIds).toHaveLength(4);

    breakSchema();
    const degraded = await (await createInstance()).sync(null);
    expect(degraded.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);

    // The probe verdict has to reach the enumeration. Things hard-deletes with
    // no tombstone, so this snapshot is the only deletion signal there is —
    // publishing one built on unverified columns is what took a live corpus
    // from 165 tasks to 3 to none.
    expect(degraded.presentExternalIds).toBeUndefined();
  });

  test("the no-change path withholds too — it vouches for a store it read none of", async () => {
    seed(4);
    const first = await (await createInstance()).sync(null);
    expect(first.presentExternalIds).toHaveLength(4);

    breakSchema();
    // Nothing has changed since the cursor, so this cycle takes the early
    // return that publishes an enumeration without walking a single page.
    const idle = await (await createInstance()).sync(first.cursor);
    expect(idle.documents).toHaveLength(0);
    expect(idle.presentExternalIds).toBeUndefined();
  });

  test("a large deletion reconciles, and emptying the store reconciles to zero", async () => {
    seed(10);
    const healthy = await (await createInstance()).sync(null);
    expect(healthy.presentExternalIds).toHaveLength(10);

    // Seven of ten gone at once. The schema probe passed and the enumeration
    // covered its partition, so the source knows this is what the store holds.
    testDb.prepare("DELETE FROM TMTask WHERE uuid IN ('task-1','task-2','task-3','task-4')").run();
    testDb.prepare("DELETE FROM TMTask WHERE uuid IN ('task-5','task-6','task-7')").run();
    const collapsed = await (await createInstance()).sync(healthy.cursor);
    expect(collapsed.presentExternalIds?.sort()).toEqual(["task-10", "task-8", "task-9"]);

    testDb.prepare("DELETE FROM TMTask").run();
    const emptied = await (await createInstance()).sync(collapsed.cursor);
    expect(emptied.presentExternalIds).toEqual([]);
  });

  test("an ordinary deletion still reconciles", async () => {
    seed(10);
    const healthy = await (await createInstance()).sync(null);
    testDb.prepare("DELETE FROM TMTask WHERE uuid = 'task-3'").run();

    const next = await (await createInstance()).sync(healthy.cursor);
    expect(next.presentExternalIds).toHaveLength(9);
    expect(next.presentExternalIds!).not.toContain("task-3");
  });

  test("a schema that comes back is re-probed, and vouching resumes", async () => {
    seed(4);
    const healthy = await (await createInstance()).sync(null);
    breakSchema();
    const degraded = await (await createInstance()).sync(healthy.cursor);
    expect(degraded.presentExternalIds).toBeUndefined();

    // A Things upgrade restores the table mid-session. The verdict must not be
    // latched at the first bad read, or deletion detection stays off forever.
    testDb.exec("CREATE TABLE TMArea (uuid TEXT PRIMARY KEY, title TEXT)");
    const recovered = await (await createInstance()).sync(degraded.cursor);
    expect(recovered.presentExternalIds).toHaveLength(4);
    expect(recovered.issues).toEqual([]);
  });
});

describe("ThingsSource — a database macOS refuses to open", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "things-denied-"));
    dbPath = join(tmpDir, "main.sqlite");
    new Database(dbPath).close();
  });

  afterEach(() => {
    chmodSync(dbPath, 0o644);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.skipIf(!canDenyReads)(
    "raises a typed permission error instead of syncing an empty page",
    async () => {
      chmodSync(dbPath, 0o000);
      const instance = await definition.create!({
        accountId: "local",
        sourceId: SourceId("things:local"),
        providerId: ProviderId("things:local"),
        config: { dbPath },
      });

      const failure = await instance.sync(null).then(
        () => null,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(SyncError);
      expect((failure as SyncError).kind).toBe("permission");
      expect((failure as SyncError).scope).toBe("source");
      expect((failure as SyncError).message).toMatch(/full disk access/i);
      expect((failure as SyncError).remediation).toMatchObject({
        executable: process.execPath,
        restartRequired: true,
      });
    },
  );
});

describe("ThingsSource — the database is locked", () => {
  let tmpDir: string;
  let dbPath: string;
  let writer: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "things-locked-"));
    dbPath = join(tmpDir, "main.sqlite");
    const seedDb = createTestThingsDb(dbPath);
    insertTask(seedDb, {
      uuid: "task-1",
      title: "Task 1",
      creationDate: TS_2024_03_08,
      userModificationDate: TS_2024_03_08,
    });
    seedDb.close();

    // Hold an exclusive write transaction open on a second connection —
    // the same condition Things.app puts the file in while it is writing —
    // so the source's own read hits SQLITE_BUSY rather than succeeding.
    writer = new Database(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    writer.prepare("UPDATE TMTask SET title = 'locked' WHERE uuid = 'task-1'").run();
  });

  afterEach(() => {
    writer.exec("COMMIT");
    writer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("raises a typed transient error instead of syncing an empty page", async () => {
    const instance = await definition.create!({
      accountId: "local",
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
      config: { dbPath },
    });

    const failure = await instance.sync(null).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(SyncError);
    expect((failure as SyncError).kind).toBe("transient");
    expect((failure as SyncError).scope).toBe("source");
    expect((failure as SyncError).message).toMatch(/locked/i);
  });
});
