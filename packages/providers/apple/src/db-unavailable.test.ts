// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Apple source does about a database that will not open.
 *
 * The rule under test is the one that separates the seven Apple sources from
 * each other: an unreadable database is raised by the source that reads it, as
 * a typed error the operator can act on. A lock or a corrupt file is invisible
 * to the rest — it belongs to this one database. A denial is not: full-disk
 * access is one grant behind all seven, so a source reporting it is reporting
 * a connection-wide condition, and its `SyncError` says so via `scope`.
 */

import { chmodSync, rmSync } from "node:fs";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SyncError } from "@omnesis/types";
import { AppleNotesSource } from "./notes.js";
import { AppleIMessageSource } from "./imessage.js";
import { AppleCalendarSource } from "./calendar.js";
import { AppleCallLogSource } from "./call-log.js";
import { describeListingGap, throwOnOpenFailure } from "./db-helpers/internal.js";
import {
  canDenyReads,
  makeAppleDbFixture,
  type AppleDbFixture,
} from "./testing/apple-db-fixtures.js";
import type { AppleProvider } from "./provider.js";

const IDS = {
  sourceId: "apple-notes:tester@example.com",
  providerId: "apple:tester@example.com",
};

describe("an unreadable database costs only the source that reads it", () => {
  let fixture: AppleDbFixture;

  beforeEach(() => {
    fixture = makeAppleDbFixture();
  });

  afterEach(async () => {
    await fixture.provider.disconnect();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  test.skipIf(!canDenyReads)(
    "the notes source reports the denial while imessage syncs its messages",
    async () => {
      chmodSync(fixture.notesPath, 0o000);
      await fixture.provider.authenticate();

      const notes = new AppleNotesSource(fixture.provider, IDS);
      const imessage = new AppleIMessageSource(fixture.provider, {
        sourceId: "apple-imessage:tester@example.com",
        providerId: IDS.providerId,
      });

      const denial = await notes.sync(null).then(
        () => null,
        (err: unknown) => err,
      );
      expect(denial).toBeInstanceOf(SyncError);
      expect((denial as SyncError).kind).toBe("permission");
      // full-disk access is denied to the executable, not to Notes alone —
      // iMessage syncing fine below is a race this source has not lost yet,
      // not proof the grant only ever covered Notes.
      expect((denial as SyncError).scope).toBe("connection");
      expect((denial as SyncError).message).toMatch(/full disk access/i);
      expect((denial as SyncError).remediation).toMatchObject({
        summary: expect.stringMatching(/full disk access is required/i),
        executable: process.execPath,
        restartRequired: true,
      });

      const result = await imessage.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("Are we still on for Thursday?");
    },
  );

  // Every single-file source shares one rule, so it is worth proving on more
  // than the one database the report was filed about.
  test.skipIf(!canDenyReads)("every source raises its own database's denial", async () => {
    for (const path of [
      fixture.notesPath,
      fixture.imessagePath,
      fixture.calendarPath,
      fixture.callLogPath,
    ]) {
      chmodSync(path, 0o000);
    }
    // Every database is refused, so the provider itself refuses; the sources
    // are constructed directly to reach their own reporting.
    await expect(fixture.provider.authenticate()).rejects.toThrow();

    const sources = [
      new AppleNotesSource(fixture.provider, IDS),
      new AppleIMessageSource(fixture.provider, {
        sourceId: "apple-imessage:tester@example.com",
        providerId: IDS.providerId,
      }),
      new AppleCalendarSource(fixture.provider, {
        sourceId: "apple-calendar:tester@example.com",
        providerId: IDS.providerId,
      }),
      new AppleCallLogSource(fixture.provider, {
        sourceId: "apple-call-log:tester@example.com",
        providerId: IDS.providerId,
      }),
    ];

    for (const source of sources) {
      const failure = await source.sync(null).then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure, String(source.id)).toBeInstanceOf(SyncError);
      expect((failure as SyncError).kind, String(source.id)).toBe("permission");
      expect((failure as SyncError).scope, String(source.id)).toBe("connection");
    }
  });

  test("a Mac with no Notes database at all syncs nothing, quietly", async () => {
    rmSync(fixture.notesPath, { force: true });
    await fixture.provider.authenticate();

    const result = await new AppleNotesSource(fixture.provider, IDS).sync(null);

    expect(result.documents).toEqual([]);
    // Nothing was read, so nothing may be claimed about what is still there.
    expect(result.presentExternalIds).toBeUndefined();
  });
});

describe("the reminders source — no store to read", () => {
  let dir: string;
  let provider: AppleProvider;

  beforeEach(() => {
    const fixture = makeAppleDbFixture();
    dir = fixture.dir;
    provider = fixture.provider;
  });

  afterEach(async () => {
    await provider.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  // A host with no reminders directory has nothing to sync and nothing to fix.
  test("an absent Reminders directory is not a failure", async () => {
    await provider.authenticate();
    expect(provider.getRemindersOpenFailure()).toBeNull();
  });
});

describe("describeListingGap", () => {
  test("a listing macOS refused is the denial, with its remedy", () => {
    const gap = describeListingGap(
      Object.assign(new Error("EPERM"), { code: "EPERM" }),
      "cannot list",
    );
    expect(gap.kind).toBe("denied");
    expect(gap.reason).toMatch(/full disk access/i);
    expect(gap.remediation).toMatchObject({ executable: process.execPath });
  });

  test("a listing that failed for any other reason claims no grant", () => {
    const gap = describeListingGap(
      Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }),
      "cannot list",
    );
    expect(gap).toEqual({ kind: "error", reason: "cannot list: ENOTDIR" });
  });
});

describe("throwOnOpenFailure", () => {
  // full-disk access is granted to the collector's executable, not to one
  // database — a denial reading this database means every other Apple
  // database behind the same grant is refused the same way, whether or not
  // its own source has noticed yet. That is the connection, not this source.
  test("a denial is permanent until someone acts on it, and costs every source on the grant", () => {
    expect(() => throwOnOpenFailure({ kind: "denied", message: "denied" })).toThrow(
      expect.objectContaining({ kind: "permission", scope: "connection" }),
    );
  });

  test("a denial's remedy rides on the error it raises", () => {
    const remediation = {
      summary: "Access is required",
      steps: ["Grant it."],
      restartRequired: true,
    };
    expect(() => throwOnOpenFailure({ kind: "denied", message: "denied", remediation })).toThrow(
      expect.objectContaining({ kind: "permission", scope: "connection", remediation }),
    );
  });

  // A locked database is the normal state of a Mac whose Messages or Notes is
  // mid-write. Classifying it as anything but transient would disable a source
  // over a condition that clears by itself. It belongs to this one database,
  // not the grant, so it keeps the default source scope.
  test("a lock leaves the source retryable, scoped to itself", () => {
    expect(() => throwOnOpenFailure({ kind: "busy", message: "locked" })).toThrow(
      expect.objectContaining({ kind: "transient", scope: "source" }),
    );
  });

  test("anything else is unclassified rather than mislabelled, scoped to itself", () => {
    expect(() => throwOnOpenFailure({ kind: "error", message: "corrupt" })).toThrow(
      expect.objectContaining({ kind: "unknown", scope: "source" }),
    );
  });

  test("an absent database is not a failure", () => {
    expect(() => throwOnOpenFailure(null)).not.toThrow();
  });
});
