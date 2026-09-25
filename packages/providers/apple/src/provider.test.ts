// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * This provider opens seven independent macOS databases. A host can let
 * the collector read some of them and not others — most often because the
 * privacy grant covers a different binary than the one actually running — so
 * the tests below pin the rule that decides what happens next: one unreadable
 * database costs exactly the sources that read it, and nothing else.
 */

import { chmodSync, existsSync, rmSync } from "node:fs";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  canDenyReads,
  makeAppleDbFixture,
  type AppleDbFixture,
} from "./testing/apple-db-fixtures.js";

describe("AppleProvider — per-database tolerance", () => {
  let fixture: AppleDbFixture;

  beforeEach(() => {
    fixture = makeAppleDbFixture();
  });

  afterEach(async () => {
    await fixture.provider.disconnect();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  // The suite is worthless if the denial silently stops being stageable, and a
  // skipped test reads exactly like a passing one.
  test("the environment can stage a denied read", () => {
    if (process.env.CI) expect(canDenyReads).toBe(true);
  });

  test.skipIf(!canDenyReads)(
    "an unreadable Notes database leaves the other databases open and usable",
    async () => {
      chmodSync(fixture.notesPath, 0o000);

      await expect(fixture.provider.authenticate()).resolves.toBeUndefined();

      expect(fixture.provider.getIMessageDb()).not.toBeNull();
      expect(fixture.provider.getCalendarDb()).not.toBeNull();
      expect(fixture.provider.getNotesDb()).toBeNull();
    },
  );

  test.skipIf(!canDenyReads)("the failure is attributed to Notes and no one else", async () => {
    chmodSync(fixture.notesPath, 0o000);
    await fixture.provider.authenticate();

    expect(fixture.provider.getNotesOpenFailure()).toMatchObject({ kind: "denied" });
    expect(fixture.provider.getNotesOpenFailure()?.message).toMatch(/full disk access/i);
    expect(fixture.provider.getIMessageOpenFailure()).toBeNull();
    expect(fixture.provider.getCalendarOpenFailure()).toBeNull();
  });

  test.skipIf(!canDenyReads)(
    "a host where every database is refused fails rather than registering dead sources",
    async () => {
      for (const path of [
        fixture.notesPath,
        fixture.imessagePath,
        fixture.calendarPath,
        fixture.callLogPath,
      ]) {
        chmodSync(path, 0o000);
      }

      await expect(fixture.provider.authenticate()).rejects.toThrow(/full disk access/i);
      // The refusal is the same typed failure a single source would raise, so
      // the collector reports the remedy beside every source it costs — and
      // scopes it to the connection, since every Apple source on this host
      // shares the one full-disk access grant that was just refused.
      await expect(fixture.provider.authenticate()).rejects.toMatchObject({
        kind: "permission",
        scope: "connection",
        remediation: {
          summary: expect.stringMatching(/full disk access is required/i),
          executable: process.execPath,
        },
      });
      await expect(fixture.provider.isAuthenticated()).resolves.toBe(false);
    },
  );

  test("a readable Notes database carries no failure", async () => {
    await fixture.provider.authenticate();

    expect(fixture.provider.getNotesDb()).not.toBeNull();
    expect(fixture.provider.getNotesOpenFailure()).toBeNull();
  });

  test.skipIf(!canDenyReads)(
    "a database that becomes readable again opens, without a restart",
    async () => {
      chmodSync(fixture.notesPath, 0o000);
      await fixture.provider.authenticate();
      expect(fixture.provider.getNotesDb()).toBeNull();

      chmodSync(fixture.notesPath, 0o644);

      expect(fixture.provider.getNotesDb()).not.toBeNull();
      expect(fixture.provider.getNotesOpenFailure()).toBeNull();
    },
  );

  // A denial that outlives the database it was recorded against would tell the
  // operator to grant access to a file that is no longer there.
  test.skipIf(!canDenyReads)("a database that disappears stops being a failure", async () => {
    chmodSync(fixture.notesPath, 0o000);
    await fixture.provider.authenticate();
    expect(fixture.provider.getNotesOpenFailure()).not.toBeNull();

    chmodSync(fixture.notesPath, 0o644);
    rmSync(fixture.notesPath, { force: true });

    expect(fixture.provider.getNotesDb()).toBeNull();
    expect(fixture.provider.getNotesOpenFailure()).toBeNull();
    expect(existsSync(fixture.notesPath)).toBe(false);
  });

  // Only a refusal is a host-wide problem with one remedy. A schema this
  // provider has not been taught belongs to the one source that reads it.
  test("a database the provider cannot read does not veto the ones it can", async () => {
    const unsupported = makeAppleDbFixture();
    try {
      rmSync(unsupported.imessagePath, { force: true });
      rmSync(unsupported.calendarPath, { force: true });
      rmSync(unsupported.callLogPath, { force: true });

      await expect(unsupported.provider.authenticate()).resolves.toBeUndefined();
      expect(unsupported.provider.getNotesDb()).not.toBeNull();
    } finally {
      await unsupported.provider.disconnect();
      rmSync(unsupported.dir, { recursive: true, force: true });
    }
  });
});
