// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * macOS keeps one address book per account. What the Contacts helper reports
 * when some or all of them cannot be read decides two different things: which
 * stores the source may leave out of a snapshot, and whether the source has a
 * failure to raise at all.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { CONTACTS_DB_FILENAME } from "../paths.js";
import { canDenyReads } from "../testing/apple-db-fixtures.js";
import { ContactsDbHelper } from "./contacts-db.js";

function seedAddressBook(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CONTACTS_DB_FILENAME);
  const db = new Database(path);
  db.exec("CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER)");
  db.prepare("INSERT INTO ZABCDRECORD (Z_PK, Z_ENT) VALUES (1, 22)").run();
  db.close();
  return path;
}

describe("ContactsDbHelper — the reason nothing could be read", () => {
  let dir: string;
  let sourcesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-contacts-db-test-"));
    sourcesDir = join(dir, "Sources");
    mkdirSync(sourcesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a readable address book is no failure at all", () => {
    seedAddressBook(join(sourcesDir, "AAAA-1111"));
    const helper = new ContactsDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(true);
      expect(helper.getLastOpenFailure()).toBeNull();
    } finally {
      helper.close();
    }
  });

  // One readable address book is enough to sync; the unreadable one is
  // reported as an unavailable store, which is what withholds the snapshot.
  test("a partial read is a gap, not a failure", () => {
    seedAddressBook(join(sourcesDir, "AAAA-1111"));
    const broken = join(sourcesDir, "BBBB-2222");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, CONTACTS_DB_FILENAME), "not sqlite");

    const helper = new ContactsDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(true);
      expect(helper.getLastOpenFailure()).toBeNull();
      expect(helper.getStores().filter((s) => s.kind === "unavailable")).toHaveLength(1);
    } finally {
      helper.close();
    }
  });

  // An address book iCloud has not finished downloading is a hole in what the
  // scan covers — reported, so no snapshot claims to be complete — but not
  // something an operator can act on, so it is no source failure.
  test("an address book still downloading is a gap and nothing more", () => {
    mkdirSync(join(sourcesDir, "CCCC-3333"), { recursive: true });

    const helper = new ContactsDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(false);
      expect(helper.getStores().filter((s) => s.kind === "unavailable")).toHaveLength(1);
      expect(helper.getLastOpenFailure()).toBeNull();
    } finally {
      helper.close();
    }
  });

  test.skipIf(!canDenyReads)("a denied address book is the failure the source raises", () => {
    const path = seedAddressBook(join(sourcesDir, "DDDD-4444"));
    chmodSync(path, 0o000);

    const helper = new ContactsDbHelper(dir);
    try {
      helper.open();
      expect(helper.hasOpenDb()).toBe(false);
      const failure = helper.getLastOpenFailure();
      expect(failure?.kind).toBe("denied");
      expect(failure?.message).toContain("DDDD-4444");
      expect(failure?.remediation).toMatchObject({
        summary: expect.stringMatching(/full disk access is required/i),
      });
    } finally {
      chmodSync(path, 0o644);
      helper.close();
    }
  });

  // A denial is the one an operator can act on, so it wins over a store that
  // merely has not downloaded yet.
  test.skipIf(!canDenyReads)("a denial outranks an address book that is merely missing", () => {
    mkdirSync(join(sourcesDir, "AAAA-0000"), { recursive: true });
    const path = seedAddressBook(join(sourcesDir, "EEEE-5555"));
    chmodSync(path, 0o000);

    const helper = new ContactsDbHelper(dir);
    try {
      helper.open();
      expect(helper.getLastOpenFailure()?.kind).toBe("denied");
      expect(helper.getLastOpenFailure()?.message).toContain("EEEE-5555");
    } finally {
      chmodSync(path, 0o644);
      helper.close();
    }
  });

  // The provider opens every Apple database in one pass, so a directory this
  // process cannot even list must not end that pass.
  test.skipIf(!canDenyReads)("a directory that cannot be listed is recorded, not thrown", () => {
    seedAddressBook(join(sourcesDir, "FFFF-6666"));
    chmodSync(sourcesDir, 0o000);

    const helper = new ContactsDbHelper(dir);
    try {
      expect(() => helper.open()).not.toThrow();
      expect(helper.getLastOpenFailure()).toMatchObject({
        kind: "denied",
        remediation: { summary: expect.stringMatching(/full disk access is required/i) },
      });
    } finally {
      chmodSync(sourcesDir, 0o755);
      helper.close();
    }
  });
});
