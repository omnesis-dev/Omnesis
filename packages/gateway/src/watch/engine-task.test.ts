// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening the watch stores, and what happens when they will not open.
 *
 * Each store brings its file up to the shape its queries expect, and one of
 * those upgrades — widening a primary key, which no `ALTER TABLE` can do —
 * rebuilds a table inside a transaction and so takes the write lock. A CLI
 * holding the journal for longer than the busy timeout makes that refuse.
 *
 * Refusing has to be an answer rather than an exception, because this is called
 * straight from boot: thrown, it leaves the process on the way out of start-up
 * under a supervisor that restarts it, takes the lock again, and loops. The
 * posture is the journal's own — the watch subsystem is off, the gateway is
 * up — because an operator needs a running gateway to read the reason from.
 *
 * Real files and a real second connection — a mocked lock proves nothing about
 * SQLite's.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedSqlite, type EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import { createJudgeEvidenceReader, openWatchStores } from "./engine-task.js";

let dir: string;
let holder: EncryptedSqliteDatabase | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watch-stores-"));
});

afterEach(() => {
  holder?.close();
  holder = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Another process with the journal open and a write in flight.
 *
 * Through the same driver the gateway uses, deliberately: SQLite keeps its
 * record of who holds what per *library*, so a lock taken by a second build of
 * it loaded into this process is one the gateway's build cannot see, and the
 * test would prove nothing about contention.
 */
function lockHolder(path: string): EncryptedSqliteDatabase {
  const handle = openEncryptedSqlite(path, { key: null });
  handle.pragma("journal_mode = WAL");
  handle.exec("BEGIN EXCLUSIVE");
  return handle;
}

/**
 * A journal written by a build from before the instance key joined the
 * judgement identity — the one shape whose upgrade needs the write lock.
 */
function journalNeedingTheRebuild(path: string): void {
  const seed = openEncryptedSqlite(path, { key: null });
  seed.pragma("journal_mode = WAL");
  seed.exec(`
    CREATE TABLE watch_judgements (
      watch_id TEXT NOT NULL,
      node_id  TEXT NOT NULL,
      subject  TEXT NOT NULL,
      decision TEXT NOT NULL,
      at       TEXT NOT NULL,
      PRIMARY KEY (watch_id, node_id, subject)
    );
    INSERT INTO watch_judgements VALUES
      ('w-1', 'mail', 'doc-1', 'declined', '2026-02-01T09:00:00Z');
  `);
  seed.close();
}

describe("opening the stores over the watch journal", () => {
  it("opens them on a file it can have to itself", () => {
    const path = join(dir, "watch.db");
    journalNeedingTheRebuild(path);

    const opened = openWatchStores({ journalPath: path, storageKey: null });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The upgrade the lock is needed for actually ran.
    expect(opened.stores.traces.judgementsAll().get("w-1")).toEqual({ matched: 0, declined: 1 });
    opened.stores.adminDb.close();
    opened.stores.db.close();
  });

  it("says why rather than throwing when another process holds the write lock", () => {
    // What a CLI holding the journal looks like from here. `BEGIN EXCLUSIVE`
    // rather than `IMMEDIATE` so the upgrade cannot start and cannot be starved
    // into a partial one; the handles below wait out their busy timeout and
    // give up, which is the case boot has to survive. The wait is shortened
    // because what is being tested is the answer, not the length of the wait.
    const path = join(dir, "watch.db");
    journalNeedingTheRebuild(path);
    holder = lockHolder(path);

    const opened = openWatchStores({ journalPath: path, storageKey: null, busyTimeoutMs: 200 });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toMatch(/busy|locked/i);
  });

  it("says why rather than throwing when the file is not a database at all", () => {
    const path = join(dir, "watch.db");
    writeFileSync(path, "this is not a sqlite file");

    const opened = openWatchStores({ journalPath: path, storageKey: null });

    expect(opened.ok).toBe(false);
  });
});

describe("reading judge evidence", () => {
  function evidenceDb(): EncryptedSqliteDatabase {
    const db = openEncryptedSqlite(join(dir, "ontology.db"), { key: null });
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
    `);
    return db;
  }

  it("reads a bounded excerpt only for the journaled revision", async () => {
    const db = evidenceDb();
    const content = "x".repeat(8_001);
    db.prepare("INSERT INTO documents VALUES (?, ?, ?)").run("d-1", content, "revision-1");
    const read = createJudgeEvidenceReader(db);
    const base = {
      watch: "w-1",
      nodeId: "mail",
      key: "singleton",
      proposition: "the title describes the document",
      documentIds: ["d-1"],
      evidence: { docId: "d-1", title: "A title" },
    };

    const exact = await read({ ...base, documentRevision: "revision-1" });
    expect(exact?.["excerpt"]).toBe(`${"x".repeat(8_000)}\n[excerpt truncated]`);
    expect(await read({ ...base, documentRevision: "revision-0" })).toEqual(base.evidence);
    expect(await read({ ...base, documentIds: ["deleted"] })).toEqual(base.evidence);
    expect(await read(base), "an unfenced event borrowed today's body").toEqual(base.evidence);
    expect(
      await read({ ...base, documentIds: ["deleted"] }),
      "an unfenced missing event declined",
    ).toEqual(base.evidence);
    db.close();
  });
});
