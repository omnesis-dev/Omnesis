// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The folder a local file carries and the list of folders the source
 * publishes. Every file and folder is invented.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectFilterList,
  directoryFilterId,
  type SourceInstance,
  type SyncResult,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import definition from "./index.js";
import type { LocalFilesSyncCursor } from "./types.js";

const sourceId = SourceId("local-files:host");
const providerId = ProviderId("local-files:host");
const FIELD = "extra.folder";

/** The id the source gives a directory on the platform the test runs on. */
const id = (path: string): string => directoryFilterId(path)!;

describe("local-files folders", () => {
  let tmpDir: string;
  let root: string;

  const write = (rel: string, content: string, base = root): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  };

  const create = (roots: string[] = [root], exclude: string[] = []): Promise<SourceInstance> =>
    definition.create!({ accountId: "host", sourceId, providerId, config: { roots, exclude } });

  /** The published list as `id → parent`. */
  const list = async (instance: SourceInstance): Promise<Record<string, string | null>> => {
    const items = await collectFilterList(instance.filterLists![FIELD]!, {
      signal: new AbortController().signal,
    });
    return Object.fromEntries(items.map((item) => [item.id, item.parentId ?? null]));
  };

  const folderOf = (result: SyncResult, title: string): unknown => {
    const extra = result.documents.find((doc) => doc.title === title)!.metadata.extra!;
    return "folder" in extra ? extra.folder : "absent";
  };

  beforeEach(() => {
    // The scanner works on real paths: on macOS the temp directory is reached through a symlink.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "local-files-folders-")));
    root = join(tmpDir, "Documents");
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("declares the field from version 2 and says what a resync costs", () => {
    expect(definition.contract?.outputRevision).toBe(2);
    expect(definition.multiDevice?.mode).toBe("partitioned");
    const fields = definition.documentEventProfile?.metadataFields ?? [];
    expect(fields.find((field) => field.path === FIELD)).toMatchObject({
      type: "string",
      filter: {
        capability: "tree",
        minVersion: 2,
        scope: "device",
        noun: { one: "folder", many: "folders" },
        levels: [{ one: "folder", many: "folders" }],
        picker: "tree",
        inside: { one: "folder", many: "folders" },
      },
    });
    // The fields that were there before are still there, and are not filters.
    for (const path of ["tags", "extra.path", "extra.directory", "extra.mimeType"]) {
      const field = fields.find((candidate) => candidate.path === path);
      expect(field).toBeDefined();
      expect(field?.filter).toBeUndefined();
    }
    expect(definition.resyncCost).toMatch(/read again on the computer that holds it/);
    expect(definition.resyncCost).toMatch(/nothing is downloaded/);
  });

  test("every file carries its own directory, as an absolute path", async () => {
    write("zqfilter-inbox.md", "Invented unsorted notes kept at the top of the folder.");
    write("work/atlas-api/zqfilter-atlas.md", "Invented notes on the Atlas API cursor.");
    write("work/atlas-api/docs/zqfilter-guide.md", "Invented notes on the changelog page.");
    const result = await (await create()).sync(null);

    expect(result.documents).toHaveLength(3);
    expect(folderOf(result, "zqfilter-inbox.md")).toBe(id(root));
    expect(folderOf(result, "zqfilter-atlas.md")).toBe(id(join(root, "work", "atlas-api")));
    // Only the file's own directory: the folders above it are in the list.
    expect(folderOf(result, "zqfilter-guide.md")).toBe(id(join(root, "work/atlas-api/docs")));
    // The field older records already hold keeps its form, relative to the configured folder.
    const guide = result.documents.find((doc) => doc.title === "zqfilter-guide.md")!;
    expect(guide.metadata.extra?.directory).toBe("work/atlas-api/docs");
  });

  test("the list holds every folder under the configured folder, empty ones included", async () => {
    write("work/atlas-api/zqfilter-atlas.md", "Invented notes on the Atlas API cursor.");
    write("workshop/bench/zqfilter-bench.md", "Invented notes on the workbench drawers.");
    mkdirSync(join(root, "personal", "someday"), { recursive: true });
    const instance = await create();
    await instance.sync(null);

    expect(await list(instance)).toEqual({
      [id(root)]: null,
      [id(join(root, "work"))]: id(root),
      [id(join(root, "work/atlas-api"))]: id(join(root, "work")),
      // Beside "work", not inside it.
      [id(join(root, "workshop"))]: id(root),
      [id(join(root, "workshop/bench"))]: id(join(root, "workshop")),
      // Folders holding no file yet can be picked before they do.
      [id(join(root, "personal"))]: id(root),
      [id(join(root, "personal/someday"))]: id(join(root, "personal")),
    });
  });

  test("labels read from the home directory; ids stay absolute", async () => {
    write("zqfilter-inbox.md", "Invented unsorted notes kept at the top of the folder.");
    const instance = await create();
    await instance.sync(null);
    const items = await collectFilterList(instance.filterLists![FIELD]!, {
      signal: new AbortController().signal,
    });
    const home = homedir();
    const expected =
      root === home || root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
    expect(items).toEqual([{ id: id(root), label: expected }]);
  });

  test("folders the source never reads are not listed", async () => {
    write("kept/zqfilter-kept.md", "Invented notes that are indexed.");
    write("skipped/zqfilter-skipped.md", "Invented notes the owner excluded.");
    write("checkout/.git/HEAD", "ref: refs/heads/main");
    write("checkout/zqfilter-readme.md", "Invented notes inside a repository.");
    write(".hidden/zqfilter-hidden.md", "Invented notes in a hidden folder.");
    const instance = await create([root], ["skipped"]);
    const result = await instance.sync(null);

    expect(result.documents.map((doc) => doc.title)).toEqual(["zqfilter-kept.md"]);
    expect(await list(instance)).toEqual({
      [id(root)]: null,
      [id(join(root, "kept"))]: id(root),
    });
  });

  test("each configured folder is the top of its own tree", async () => {
    const second = join(tmpDir, "Archive");
    write("2024/zqfilter-archive.md", "Invented archived notes.", second);
    write("work/zqfilter-work.md", "Invented work notes.");
    const instance = await create([root, second]);
    await instance.sync(null);

    expect(await list(instance)).toEqual({
      [id(root)]: null,
      [id(join(root, "work"))]: id(root),
      [id(second)]: null,
      [id(join(second, "2024"))]: id(second),
    });
  });

  test("a file reached through a symlinked folder is filed where it really is", async () => {
    write("real/zqfilter-real.md", "Invented notes in the real folder.");
    symlinkSync(join(root, "real"), join(root, "alias"));
    const instance = await create();
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(folderOf(result, "zqfilter-real.md")).toBe(id(join(root, "real")));
    expect(await list(instance)).toEqual({
      [id(root)]: null,
      [id(join(root, "real"))]: id(root),
    });
  });

  test("the list depends on the folders, not on how many files they hold", async () => {
    write("work/zqfilter-0.md", "Invented notes number 0, long enough to be indexed.");
    const few = await create();
    await few.sync(null);
    const listedForFew = await list(few);

    for (let index = 1; index < 120; index++) {
      write(`work/zqfilter-${index}.md`, `Invented notes number ${index}, long enough to index.`);
    }
    const many = await create();
    const first = await many.sync(null);
    // Listed in full after the first page, while files are still waiting to be read.
    expect(first.hasMore).toBe(true);
    expect(await list(many)).toEqual(listedForFew);

    // Listing reads nothing from the disk: the tree can be gone and the list is the same.
    rmSync(root, { recursive: true, force: true });
    expect(await list(many)).toEqual(listedForFew);
  });

  test("no list before the folders have been read once", async () => {
    await expect(list(await create())).rejects.toThrow(/have not been read yet/);
  });

  test("a sync from an empty cursor re-emits every file though none changed", async () => {
    write("work/zqfilter-atlas.md", "Invented notes on the Atlas API cursor.");
    write("personal/zqfilter-garden.md", "Invented notes on the garden watering log.");
    const instance = await create();
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(2);

    const unchanged = await instance.sync(first.cursor as LocalFilesSyncCursor);
    expect(unchanged.documents).toEqual([]);

    const again = await instance.sync(null);
    expect(again.documents.map((doc) => doc.externalId).sort()).toEqual(
      first.documents.map((doc) => doc.externalId).sort(),
    );
    expect(again.documents.every((doc) => typeof doc.metadata.extra?.folder === "string")).toBe(
      true,
    );
  });

  test("a new empty folder changes the list and sends no file again", async () => {
    write("work/zqfilter-atlas.md", "Invented notes on the Atlas API cursor.");
    const instance = await create();
    const first = await instance.sync(null);
    const before = await list(instance);

    mkdirSync(join(root, "someday"));
    const second = await instance.sync(first.cursor as LocalFilesSyncCursor);

    expect(second.documents).toEqual([]);
    expect(await list(instance)).toEqual({ ...before, [id(join(root, "someday"))]: id(root) });
  });

  test("a folder moved on disk is a different folder: its files follow, under the same records", async () => {
    write("work/billing/zqfilter-billing.md", "Invented notes on rounding in the billing export.");
    write("work/atlas-api/zqfilter-atlas.md", "Invented notes on the Atlas API cursor.");
    const instance = await create();
    const first = await instance.sync(null);
    const billing = first.documents.find((doc) => doc.title === "zqfilter-billing.md")!;
    expect(billing.metadata.extra?.folder).toBe(id(join(root, "work/billing")));

    mkdirSync(join(root, "personal"));
    renameSync(join(root, "work", "billing"), join(root, "personal", "billing"));
    const second = await instance.sync(first.cursor as LocalFilesSyncCursor);

    // Only the moved file is sent again, as the same record, now in the new folder.
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]!.externalId).toBe(billing.externalId);
    expect(second.documents[0]!.metadata.extra?.folder).toBe(id(join(root, "personal/billing")));
    expect(second.presentExternalIds).toHaveLength(2);

    const listed = await list(instance);
    expect(listed[id(join(root, "personal/billing"))]).toBe(id(join(root, "personal")));
    // The old path is no longer a folder the source knows.
    expect(Object.keys(listed)).not.toContain(id(join(root, "work/billing")));
  });
});
