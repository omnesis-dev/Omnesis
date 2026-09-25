// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appleFileReadAccess, probeAppleStoresReadAccess } from "./read-access.js";
import { contactsDbFile } from "./paths.js";
import {
  canDenyReads,
  makeAppleDbFixture,
  type AppleDbFixture,
} from "./testing/apple-db-fixtures.js";
import apple from "./index.js";

describe("Apple fresh read-access probes", () => {
  let fixture: AppleDbFixture;
  const signal = () => new AbortController().signal;
  beforeEach(() => {
    fixture = makeAppleDbFixture();
  });
  afterEach(async () => {
    await fixture.provider.disconnect();
    rmSync(fixture.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.skipIf(!canDenyReads)(
    "detects revoked access despite an existing sync handle, then recovery",
    async () => {
      await fixture.provider.authenticate();
      const cached = fixture.provider.getNotesDb();
      const definition = apple.sources.find((source) => source.id === "apple-notes")!;
      const source = await definition.create(
        { sourceId: "apple-notes:test", providerId: "apple:test" } as never,
        { provider: fixture.provider } as never,
      );
      expect(await source.probeReadAccess!({ signal: signal() })).toEqual({ status: "readable" });
      chmodSync(fixture.notesPath, 0o000);
      const denied = await source.probeReadAccess!({ signal: signal() });
      expect(denied).toMatchObject({
        status: "denied",
        remediation: { executable: "<collector-executable>" },
      });
      expect(JSON.stringify(denied)).not.toContain(fixture.dir);
      expect(fixture.provider.getNotesDb()).toBe(cached);
      expect(fixture.provider.getNotesOpenFailure()).toBeNull();
      chmodSync(fixture.notesPath, 0o600);
      expect(await source.probeReadAccess!({ signal: signal() })).toEqual({ status: "readable" });
    },
  );

  it("every Apple source has a probe, including temporarily absent stores", async () => {
    vi.spyOn(fixture.provider, "hasVoicemail", "get").mockReturnValue(true);
    for (const definition of apple.sources) {
      const source = await definition.create(
        { sourceId: `${definition.id}:test`, providerId: "apple:test" } as never,
        { provider: fixture.provider } as never,
      );
      expect(source.probeReadAccess, definition.id).toBeTypeOf("function");
      const result = await source.probeReadAccess!({ signal: signal() });
      expect(["readable", "unavailable"]).toContain(result.status);
      await source.dispose?.();
    }
  });

  it("rediscovers contact stores and refuses partial success for a missing account DB", async () => {
    const root = join(fixture.dir, "contacts");
    mkdirSync(join(root, "Sources", "first"), { recursive: true });
    writeFileSync(contactsDbFile(join(root, "Sources", "first")), "");
    expect(await probeAppleStoresReadAccess(root, "contacts", signal())).toEqual({
      status: "readable",
    });
    mkdirSync(join(root, "Sources", "second"));
    expect(await probeAppleStoresReadAccess(root, "contacts", signal())).toEqual({
      status: "unavailable",
    });
    writeFileSync(contactsDbFile(join(root, "Sources", "second")), "");
    expect(await probeAppleStoresReadAccess(root, "contacts", signal())).toEqual({
      status: "readable",
    });
  });

  it("an absent iMessage store preserves its bookmark and probes the supplied host cache", async () => {
    vi.spyOn(fixture.provider, "hasIMessage", "get").mockReturnValue(false);
    const definition = apple.sources.find((source) => source.id === "apple-imessage")!;
    const source = await definition.create(
      {
        sourceId: "apple-imessage:test",
        providerId: "apple:test",
        host: { configDir: fixture.dir },
      } as never,
      { provider: fixture.provider } as never,
    );
    const cursor = { lastRowId: 42 };
    expect((await source.sync!(cursor)).cursor).toEqual(cursor);
    expect(await source.probeLocalStores!({ signal: signal() })).toEqual([
      { keyName: "imessage-transcripts", label: "iMessage transcript cache", state: "absent" },
    ]);
  });

  it("probes only Reminders database names, without requiring optional WAL files", async () => {
    const root = join(fixture.dir, "reminders");
    mkdirSync(root);
    writeFileSync(join(root, "Data-fiction.sqlite"), "");
    writeFileSync(join(root, "unrelated"), "");
    expect(await probeAppleStoresReadAccess(root, "reminders", signal())).toEqual({
      status: "readable",
    });
    rmSync(join(root, "Data-fiction.sqlite"));
    expect(await probeAppleStoresReadAccess(root, "reminders", signal())).toEqual({
      status: "unavailable",
    });
  });

  it("a bound Reminders source probes its actual store without rescanning unrelated stores", async () => {
    const root = join(fixture.dir, "reminders");
    mkdirSync(root);
    const file = join(root, "Data-bound.sqlite");
    writeFileSync(file, "");
    const getStores = vi.fn(() => [{ filename: "Data-bound.sqlite", db: {} }]);
    const definition = apple.sources.find((source) => source.id === "apple-reminders")!;
    const source = await definition.create(
      { sourceId: "apple-reminders:test", providerId: "apple:test" } as never,
      {
        provider: { getRemindersStoresWithAccounts: getStores, remindersDirFilePath: root },
      } as never,
    );
    getStores.mockClear();
    expect(await source.probeReadAccess!({ signal: signal() })).toEqual({ status: "readable" });
    rmSync(file);
    writeFileSync(join(root, "Data-other.sqlite"), "");
    expect(await source.probeReadAccess!({ signal: signal() })).toEqual({ status: "unavailable" });
    expect(getStores).not.toHaveBeenCalled();
  });

  it.skipIf(!canDenyReads)(
    "one denied Contacts store fails the source and voicemail does not prescribe FDA",
    async () => {
      const root = join(fixture.dir, "contacts");
      for (const name of ["first", "second"]) {
        mkdirSync(join(root, "Sources", name), { recursive: true });
        writeFileSync(contactsDbFile(join(root, "Sources", name)), "");
      }
      chmodSync(contactsDbFile(join(root, "Sources", "second")), 0o000);
      expect(await probeAppleStoresReadAccess(root, "contacts", signal())).toMatchObject({
        status: "denied",
      });
      chmodSync(fixture.notesPath, 0o000);
      expect(await appleFileReadAccess(fixture.notesPath, false)({ signal: signal() })).toEqual({
        status: "denied",
      });
    },
  );
});
