// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { canDenyReads } from "../testing/apple-db-fixtures.js";
import { RemindersDbHelper } from "./reminders-db.js";

function seedStore(path: string, titles: string[]): void {
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZREMCDREMINDER (
      Z_PK INTEGER PRIMARY KEY,
      ZTITLE TEXT,
      ZMARKEDFORDELETION INTEGER DEFAULT 0
    );
  `);
  const insert = db.prepare("INSERT INTO ZREMCDREMINDER (Z_PK, ZTITLE) VALUES (?, ?)");
  titles.forEach((t, i) => insert.run(i + 1, t));
  db.close();
}

describe("RemindersDbHelper — unreadable stores", () => {
  let dir: string;
  let good: string;
  let broken: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-reminders-db-test-"));
    good = join(dir, "Data-11111111-1111-1111-1111-111111111111.sqlite");
    broken = join(dir, "Data-22222222-2222-2222-2222-222222222222.sqlite");
    seedStore(good, ["Renew passport"]);
    seedStore(broken, ["Book dentist"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("all stores readable — nothing is reported as skipped", () => {
    const helper = new RemindersDbHelper(dir);
    try {
      expect(helper.getDbs().size).toBe(2);
      expect(helper.getSkippedStores()).toEqual([]);
    } finally {
      helper.close();
    }
  });

  test("a store that cannot be opened is recorded with a reason, not dropped in silence", () => {
    writeFileSync(broken, "not a sqlite database at all");
    const helper = new RemindersDbHelper(dir);
    try {
      expect(helper.getDbs().size).toBe(1);
      const gaps = helper.getSkippedStores();
      expect(gaps).toHaveLength(1);
      expect(gaps[0].partition).toContain("Data-22222222");
      expect(gaps[0].reason).toMatch(/cannot be opened|unreadable/);
    } finally {
      helper.close();
    }
  });

  test("the skipped store is warned about at a level an operator sees", () => {
    writeFileSync(broken, "not a sqlite database at all");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const helper = new RemindersDbHelper(dir);
    try {
      helper.open();
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toContain("Data-22222222");
    } finally {
      warn.mockRestore();
      helper.close();
    }
  });

  test("a store that comes back stops being reported as skipped", () => {
    writeFileSync(broken, "not a sqlite database at all");
    const helper = new RemindersDbHelper(dir);
    try {
      expect(helper.getSkippedStores()).toHaveLength(1);
      seedStore(broken, ["Book dentist"]);
      expect(helper.getSkippedStores()).toEqual([]);
      expect(helper.getDbs().size).toBe(2);
    } finally {
      helper.close();
    }
  });
});

describe("RemindersDbHelper — the reason nothing could be read", () => {
  let dir: string;
  let store: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-reminders-failure-test-"));
    store = join(dir, "Data-33333333-3333-3333-3333-333333333333.sqlite");
    seedStore(store, ["Renew passport"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a readable store is no failure at all", () => {
    const helper = new RemindersDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(true);
      expect(helper.getLastOpenFailure()).toBeNull();
    } finally {
      helper.close();
    }
  });

  // One readable store is enough to sync: the ones that would not open are
  // reported as snapshot gaps instead, which is what stops a partial read from
  // deleting the reminders it could not see.
  test("a partial read is a gap, not a failure", () => {
    writeFileSync(join(dir, "Data-44444444-4444-4444-4444-444444444444.sqlite"), "not sqlite");
    const helper = new RemindersDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(true);
      expect(helper.getLastOpenFailure()).toBeNull();
      expect(helper.getSkippedStores()).toHaveLength(1);
    } finally {
      helper.close();
    }
  });

  test("no readable store at all names the store and why", () => {
    writeFileSync(store, "not a sqlite database at all");
    const helper = new RemindersDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(false);
      const failure = helper.getLastOpenFailure();
      expect(failure?.kind).toBe("error");
      expect(failure?.message).toContain("Data-33333333");
    } finally {
      helper.close();
    }
  });

  // The provider opens every Apple database in one pass, so a directory this
  // process cannot even list must not end that pass.
  test.skipIf(!canDenyReads)("a directory that cannot be listed is recorded, not thrown", () => {
    chmodSync(dir, 0o000);
    const helper = new RemindersDbHelper(dir);
    try {
      expect(() => helper.open()).not.toThrow();
      expect(helper.getLastOpenFailure()).toMatchObject({
        kind: "denied",
        remediation: { summary: expect.stringMatching(/full disk access is required/i) },
      });
    } finally {
      chmodSync(dir, 0o755);
      helper.close();
    }
  });

  // An empty Reminders directory is an answer, not a problem to report.
  test("a directory with no stores is not a failure", () => {
    const empty = mkdtempSync(join(tmpdir(), "omnesis-reminders-empty-test-"));
    const helper = new RemindersDbHelper(empty);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(false);
      expect(helper.getLastOpenFailure()).toBeNull();
    } finally {
      helper.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
