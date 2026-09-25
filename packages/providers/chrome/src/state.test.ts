// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isStateEnvelope, withVersionedState, type StateOutcome } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { chromeBookmarksStateSpec } from "./state.js";
import chromeBookmarksSource from "./index.js";
import type { ChromeBookmarksFile } from "./types.js";

const SOURCE_ID = SourceId("chrome-bookmarks:test");
const PROVIDER_ID = ProviderId("chrome:test");

function makeBookmarksFile(checksum: string, urls: string[]): ChromeBookmarksFile {
  return {
    checksum,
    version: 1,
    roots: {
      bookmark_bar: {
        name: "Bookmarks bar",
        type: "folder",
        date_added: "13348540800000000",
        id: "1",
        children: urls.map((url, i) => ({
          name: `Example ${i}`,
          url,
          type: "url" as const,
          date_added: "13348540800000000",
          id: `${10 + i}`,
        })),
      },
      other: {
        name: "Other bookmarks",
        type: "folder",
        date_added: "13348540800000000",
        id: "2",
        children: [],
      },
      synced: {
        name: "Mobile bookmarks",
        type: "folder",
        date_added: "13348540800000000",
        id: "3",
        children: [],
      },
    },
  };
}

describe("chromeBookmarksStateSpec via the host decorator", () => {
  let baseDir: string;

  afterEach(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  async function makeVersionedInstance() {
    baseDir = mkdtempSync(join(tmpdir(), "chrome-state-"));
    mkdirSync(join(baseDir, "Default"), { recursive: true });
    writeFileSync(
      join(baseDir, "Default", "Bookmarks"),
      JSON.stringify(makeBookmarksFile("checksum-1", ["https://example.com/a"])),
    );

    const raw = await chromeBookmarksSource.create!({
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      accountId: "tester@example.com",
      config: { basePath: baseDir, profileDir: "Default" },
    });
    const outcomes: StateOutcome[] = [];
    const instance = withVersionedState(raw, chromeBookmarksStateSpec, {
      sourceId: "chrome-bookmarks:test",
      onResolve: (outcome) => outcomes.push(outcome),
    });
    return { instance, outcomes };
  }

  test("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const first = await instance.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await instance.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  test("repeated complete snapshots repair deletions even after the old cursor is lost", async () => {
    const { instance } = await makeVersionedInstance();
    await instance.sync(null);
    writeFileSync(
      join(baseDir, "Default", "Bookmarks"),
      JSON.stringify(makeBookmarksFile("checksum-2", ["https://example.com/b"])),
    );
    const rebuilt = await instance.sync({ unreadable: true });
    expect(rebuilt.deletedExternalIds).toEqual([]);
    expect(rebuilt.presentExternalIds).toEqual(["https://example.com/b"]);
    let cursor = rebuilt.cursor;
    for (let cycle = 0; cycle < 3; cycle++) {
      const unchanged = await instance.sync(cursor);
      expect(unchanged.documents).toEqual([]);
      expect(unchanged.presentExternalIds).toEqual(["https://example.com/b"]);
      expect(unchanged.presentExternalIds).not.toContain("https://example.com/a");
      cursor = unchanged.cursor;
    }
  });

  test("a complete empty file continues asserting empty presence on unchanged cycles", async () => {
    const { instance } = await makeVersionedInstance();
    const first = await instance.sync(null);
    writeFileSync(
      join(baseDir, "Default", "Bookmarks"),
      JSON.stringify(makeBookmarksFile("empty", [])),
    );
    const empty = await instance.sync(first.cursor);
    expect(empty.deletedExternalIds).toEqual(["https://example.com/a"]);
    expect(empty.presentExternalIds).toEqual([]);
    expect((await instance.sync(empty.cursor)).presentExternalIds).toEqual([]);
  });

  test.each(["missing", "invalid-json"])(
    "%s file preserves the cursor and asserts no deletion",
    async (failure) => {
      const { instance } = await makeVersionedInstance();
      const first = await instance.sync(null);
      const path = join(baseDir, "Default", "Bookmarks");
      if (failure === "missing") rmSync(path);
      else writeFileSync(path, "{incomplete-json");
      for (let cycle = 0; cycle < 3; cycle++) {
        const result = await instance.sync(first.cursor);
        expect(result.cursor).toEqual(first.cursor);
        expect(result.presentExternalIds).toBeUndefined();
        expect(result.deletedExternalIds).toEqual([]);
        expect(result.issues).toMatchObject([{ code: "snapshot-withheld" }]);
      }
      writeFileSync(
        path,
        JSON.stringify(makeBookmarksFile("checksum-1", ["https://example.com/a"])),
      );
      const recovered = await instance.sync(first.cursor);
      expect(recovered.documents).toEqual([]);
      expect(recovered.issues).toEqual([]);
    },
  );

  test("malformed trees with an unchanged checksum cannot assert empty presence", async () => {
    const { instance } = await makeVersionedInstance();
    const first = await instance.sync(null);
    const malformed = makeBookmarksFile("checksum-1", []);
    delete malformed.roots.bookmark_bar.children;
    writeFileSync(join(baseDir, "Default", "Bookmarks"), JSON.stringify(malformed));
    await expect(instance.sync(first.cursor)).rejects.toThrow("withholding reconciliation");
  });

  test("resumes a cursor written mid-cycle exactly like a settled one — this source never returns a partial shape", async () => {
    // Every cursor `sync` can return has the same two fields; there is no
    // settled-vs-partial distinction for `decode` to make, unlike a source
    // with a paging phase machine. This proves the decoder accepts the one
    // shape actually produced, not a shape this test invented.
    const { instance, outcomes } = await makeVersionedInstance();
    const midCycleShaped = { fileChecksum: "checksum-0", knownIds: ["https://example.com/old"] };

    const result = await instance.sync(midCycleShaped);
    expect(outcomes[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("an unrecognised stored value rebootstraps rather than silently wedging", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const result = await instance.sync({ somethingElse: true } as never);
    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    // The bookmark that exists on disk is still produced — a rebootstrap
    // behaves exactly like a first run, not like a failure.
    expect(result.documents).toHaveLength(1);
  });
});
