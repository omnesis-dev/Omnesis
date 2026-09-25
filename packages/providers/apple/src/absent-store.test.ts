// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source does when the store it reads is not on this machine at all.
 *
 * Distinct from a database that exists and will not open, which raises a typed
 * error from the source that reads it. Here there is nothing to open: the
 * operator has not granted full disk access, an account is signed out, or an
 * app has never been opened and so has never written its database. The source
 * is created anyway and reports empty pages until the store appears.
 *
 * The cursor is what makes that dangerous. The collector persists whatever
 * cursor a page reports, on every page, so a source answering an empty page
 * with an empty cursor erases its own bookmark. Nothing looks wrong at the
 * time. The cost arrives later, when the store comes back and the source reads
 * its entire history again as though it had never run.
 */

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { isStateEnvelope, resolveSourceState, withVersionedState } from "@omnesis/source-sdk";
import provider from "./index.js";

/** A provider context reporting every store as absent. */
const noStores = {
  provider: {
    hasNotes: false,
    hasIMessage: false,
    hasContacts: false,
    hasCalendar: false,
    hasCallLog: false,
    hasVoicemail: false,
    getRemindersStoresWithAccounts: () => [],
    getRemindersOpenFailure: () => null,
  },
} as never;

const entry = (id: string) => provider.sources.find((s) => s.id === id)!;
const options = (id: string) =>
  ({
    accountId: "local",
    sourceId: SourceId(`${id}:local`),
    providerId: ProviderId("apple:local"),
  }) as never;

/**
 * Every source that answers an absent store with empty pages. Voicemail is
 * absent from this list on purpose — see the last test.
 */
const REPORTING = [
  "apple-notes",
  "apple-reminders",
  "apple-imessage",
  "apple-contacts",
  "apple-calendar",
  "apple-call-log",
];

describe("a source whose store is absent", () => {
  test.each(REPORTING)("%s keeps the cursor it was given", async (id) => {
    const instance = await entry(id).create(options(id), noStores);
    const stored = { lastModified: 1_700_000_000, seen: 4211 };

    const result = await instance.sync(stored as never);

    expect(result.documents).toEqual([]);
    expect(result.deletedExternalIds).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    // The whole point: the bookmark survives the outage.
    expect(result.cursor).toEqual(stored);
  });

  test.each(REPORTING)(
    "%s reports a decodable seed and resumes without repeated rebootstrap",
    async (id) => {
      const instance = await entry(id).create(options(id), noStores);
      const spec = entry(id).contract!.state!;
      const seed = (await instance.sync(null)).cursor;
      expect(spec.decode(seed)).toEqual(seed);
      expect(resolveSourceState(spec, {})).toEqual({ kind: "fresh" });
      const unencodable: string[] = [];
      const wrapped = withVersionedState(instance, spec, {
        sourceId: `${id}:local`,
        onUnencodable: ({ sourceId }) => unencodable.push(sourceId),
      });
      let cursor = (await wrapped.sync({})).cursor;
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(isStateEnvelope(cursor)).toBe(true);
        expect(resolveSourceState(spec, cursor).kind).toBe("resume");
        cursor = (await wrapped.sync(cursor)).cursor;
      }
      expect(unencodable).toEqual([]);
    },
  );

  test.each(REPORTING)("%s claims to have observed nothing", async (id) => {
    // An empty page that also claimed a complete observation would be read as
    // "every document this source ever produced is gone".
    const instance = await entry(id).create(options(id), noStores);
    const result = await instance.sync(null);
    expect(result.presentExternalIds ?? []).toEqual([]);
    expect(result.watermark).toBeUndefined();
  });

  test("apple-voicemail refuses to be created instead, because its absence is not temporary", async () => {
    // The others can lose their store to a permission an operator can grant.
    // This one needs an OS version, so reporting empty pages forever would be
    // a source that looks configured and can never produce anything.
    await expect(
      entry("apple-voicemail").create(options("apple-voicemail"), noStores),
    ).rejects.toThrow(/macOS 26/);
  });
});
