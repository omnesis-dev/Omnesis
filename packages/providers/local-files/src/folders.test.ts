// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

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
  PATH_SCOPE_CURSOR_KEY,
  pathScopeFolders,
  type SyncOptions,
  type SyncResult,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { scopeContracts } from "./scope-contracts.js";
import definition from "./index.js";
import type { LocalFilesSyncCursor } from "./types.js";

const SUPPORTED: SyncOptions = { scopeFactsSupported: true, scopeHierarchySupported: true };
type Cursor = LocalFilesSyncCursor;
type Page = SyncResult<Cursor>;

describe("local files filed by folder", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    // The scanner names files by real path; on macOS the temp directory is a symlink.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "local-files-folders-")));
    root = join(tmp, "Documents");
    mkdirSync(root);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function write(rel: string, content = `Invented note ${rel}`, base = root): void {
    const full = join(base, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  async function run(
    roots: string[],
    cursor: Cursor | null,
    options: SyncOptions = SUPPORTED,
  ): Promise<{ pages: Page[]; cursor: Cursor }> {
    const instance = await definition.create!({
      accountId: "host",
      sourceId: SourceId("local-files:host"),
      providerId: ProviderId("local-files:host"),
      config: { roots, exclude: [] },
    });
    const pages: Page[] = [];
    for (let page = 0; page < 50; page++) {
      const result = await instance.sync(cursor, options);
      pages.push(result);
      cursor = result.cursor;
      if (!result.hasMore) return { pages, cursor };
    }
    throw new Error("The source never finished");
  }
  const chain = (directory: string, roots: string[] = [root]) =>
    pathScopeFolders(directory, { home: homedir(), roots })!;
  const folder = (directory: string, roots?: string[]) => chain(directory, roots)[0]!.id;
  const documents = (pages: Page[]) => pages.flatMap((page) => page.documents);
  const hierarchyOf = (pages: Page[], title: string) =>
    documents(pages).find((doc) => doc.title === title)!.metadata.scopeHierarchy;
  const nodes = (pages: Page[]) =>
    pages.flatMap((page) => page.scopeUpdates?.hierarchy?.nodes ?? []);
  const edges = (pages: Page[]) =>
    pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? []);

  test("declares a folder filter browsed as a tree", () => {
    expect(definition.scopes).toBe(scopeContracts["local-files"]);
    expect(definition.scopes!.items).toEqual([
      {
        kind: "folder",
        noun: { one: "folder", many: "folders" },
        picker: "tree",
        link: "hierarchy",
      },
    ]);
  });

  test("a file is in its folder and every folder above it, up to the configured folder", async () => {
    write("work/atlas-api/plan.md");
    write("work/atlas-api/docs/guide.md");
    write("personal/garden-notes/log.md");
    write("workshop/bench.md");
    write("top.md");
    const { pages } = await run([root], null);
    expect(hierarchyOf(pages, "plan.md")).toEqual([
      { kind: "folder", parentIds: [folder(join(root, "work/atlas-api"))], complete: true },
    ]);
    expect(hierarchyOf(pages, "guide.md")).toEqual([
      { kind: "folder", parentIds: [folder(join(root, "work/atlas-api/docs"))], complete: true },
    ]);
    // A file directly in the configured folder is in that folder alone.
    expect(hierarchyOf(pages, "top.md")).toEqual([
      { kind: "folder", parentIds: [folder(root)], complete: true },
    ]);
    const published = new Map(nodes(pages).map((node) => [node.id, node]));
    expect([...published.values()].map((node) => node.label).sort()).toEqual(
      [
        root,
        `${root}/personal`,
        `${root}/personal/garden-notes`,
        `${root}/work`,
        `${root}/work/atlas-api`,
        `${root}/work/atlas-api/docs`,
        `${root}/workshop`,
      ].sort(),
    );
    // The configured folder is the top of the tree; nothing above it is named.
    expect(published.get(folder(root))!.parentIds).toEqual([]);
    expect(published.get(folder(join(root, "work")))!.parentIds).toEqual([folder(root)]);
    expect(published.get(folder(join(root, "work/atlas-api/docs")))!.parentIds).toEqual([
      folder(join(root, "work/atlas-api")),
    ]);
    // "workshop" is beside "work", not inside it.
    expect(chain(join(root, "workshop")).map((item) => item.id)).not.toContain(
      folder(join(root, "work")),
    );
    expect(pages.at(-1)!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(pages.at(-1)!.presentExternalIds).toHaveLength(5);
  });

  test("files indexed before folders were published are filed from the cursor, without being read again", async () => {
    write("work/plan.md");
    write("personal/log.md");
    const before = await run([root], null, {});
    expect(documents(before.pages).every((doc) => doc.metadata.scopeHierarchy === undefined)).toBe(
      true,
    );
    expect(PATH_SCOPE_CURSOR_KEY in before.cursor).toBe(false);
    const ids = Object.fromEntries(
      documents(before.pages).map((doc) => [doc.title, doc.externalId]),
    );
    const { pages } = await run([root], before.cursor);
    expect(documents(pages)).toEqual([]);
    expect(pages[0]!.hasMore).toBe(true);
    expect(edges(pages)).toEqual(
      expect.arrayContaining([
        { externalId: ids["plan.md"], parentIds: [folder(join(root, "work"))], complete: true },
        { externalId: ids["log.md"], parentIds: [folder(join(root, "personal"))], complete: true },
      ]),
    );
    expect(edges(pages)).toHaveLength(2);
    expect(
      nodes(pages)
        .map((node) => node.label)
        .sort(),
    ).toEqual([root, `${root}/personal`, `${root}/work`]);
    expect(pages.at(-1)!.presentExternalIds).toHaveLength(2);
  });

  test("a moved file keeps its identity and is filed under its new folder", async () => {
    write("work/plan.md", "An invented plan that will move between folders");
    const first = await run([root], null);
    const id = documents(first.pages)[0]!.externalId;
    mkdirSync(join(root, "personal"));
    renameSync(join(root, "work/plan.md"), join(root, "personal/plan.md"));
    const second = await run([root], first.cursor);
    expect(documents(second.pages).map((doc) => doc.externalId)).toEqual([id]);
    expect(hierarchyOf(second.pages, "plan.md")).toEqual([
      { kind: "folder", parentIds: [folder(join(root, "personal"))], complete: true },
    ]);
    expect(edges(second.pages)).toEqual([
      { externalId: id, parentIds: [folder(join(root, "personal"))], complete: true },
    ]);
  });

  test("a renamed folder is a new folder holding the same files", async () => {
    write("work/plan.md", "An invented plan inside a folder that will be renamed");
    const first = await run([root], null);
    const id = documents(first.pages)[0]!.externalId;
    renameSync(join(root, "work"), join(root, "clients"));
    const second = await run([root], first.cursor);
    expect(edges(second.pages)).toEqual([
      { externalId: id, parentIds: [folder(join(root, "clients"))], complete: true },
    ]);
    expect(folder(join(root, "clients"))).not.toBe(folder(join(root, "work")));
    expect(nodes(second.pages).every((node) => !node.deleted)).toBe(true);
  });

  test("a file reached through a symlinked folder is filed where it really is", async () => {
    write("work/atlas-api/plan.md");
    symlinkSync(join(root, "work/atlas-api"), join(root, "shortcut"));
    const { pages } = await run([root], null);
    expect(documents(pages)).toHaveLength(1);
    expect(hierarchyOf(pages, "plan.md")).toEqual([
      { kind: "folder", parentIds: [folder(join(root, "work/atlas-api"))], complete: true },
    ]);
    expect(nodes(pages).map((node) => node.label)).not.toContain(`${root}/shortcut`);
  });

  test("a configured folder that is a symlink is named by the folder it leads to", async () => {
    write("work/plan.md");
    const alias = join(tmp, "Alias");
    symlinkSync(root, alias);
    const { pages } = await run([`${alias}/`], null);
    expect(hierarchyOf(pages, "plan.md")).toEqual([
      { kind: "folder", parentIds: [folder(join(root, "work"))], complete: true },
    ]);
  });

  test("two configured folders are two trees", async () => {
    const other = join(tmp, "Archive");
    write("work/plan.md");
    write("work/old.md", "An invented archived note", other);
    const roots = [root, other];
    const { pages } = await run(roots, null);
    expect(hierarchyOf(pages, "plan.md")![0]!.parentIds).toEqual([
      folder(join(root, "work"), roots),
    ]);
    expect(hierarchyOf(pages, "old.md")![0]!.parentIds).toEqual([
      folder(join(other, "work"), roots),
    ]);
    expect(
      nodes(pages)
        .filter((node) => node.parentIds.length === 0)
        .map((node) => node.label)
        .sort(),
    ).toEqual([other, root].sort());
  });

  test("a configured folder inside another is a folder of the outer one", async () => {
    write("work/atlas-api/plan.md");
    const roots = [join(root, "work"), root];
    const { pages } = await run(roots, null);
    const published = new Map(nodes(pages).map((node) => [node.id, node]));
    expect(hierarchyOf(pages, "plan.md")![0]!.parentIds).toEqual([
      folder(join(root, "work/atlas-api"), roots),
    ]);
    expect(published.get(folder(join(root, "work"), roots))!.parentIds).toEqual([
      folder(root, roots),
    ]);
    expect([...published.values()].filter((node) => node.parentIds.length === 0)).toHaveLength(1);
  });

  test("configuring a folder above the one already indexed files everything again, each folder under the id it had", async () => {
    write("work/plan.md");
    const inner = join(root, "work");
    const first = await run([inner], null);
    const id = documents(first.pages)[0]!.externalId;
    expect(edges(first.pages)[0]!.parentIds).toEqual([folder(inner, [inner])]);
    const roots = [inner, root];
    const second = await run(roots, first.cursor);
    expect(edges(second.pages)).toContainEqual({
      externalId: id,
      parentIds: [folder(inner, roots)],
      complete: true,
    });
    // A filter saved on the folder before the change still names it.
    expect(folder(inner, roots)).toBe(folder(inner, [inner]));
    const published = new Map(nodes(second.pages).map((node) => [node.id, node]));
    expect(published.get(folder(inner, roots))!.parentIds).toEqual([folder(root, roots)]);
    expect(nodes(second.pages).map((node) => node.label)).toContain(root);
  });

  test("a gateway refresh files every indexed file again under its epoch and completes it", async () => {
    write("work/plan.md");
    write("personal/log.md");
    const first = await run([root], null);
    const { pages } = await run([root], first.cursor, {
      ...SUPPORTED,
      scopeRefreshEpochs: { folder: "epoch-two" },
    });
    expect(documents(pages)).toEqual([]);
    expect(edges(pages)).toHaveLength(2);
    expect(edges(pages).every((edge) => edge.refreshEpoch === "epoch-two")).toBe(true);
    expect(pages.flatMap((page) => page.scopeUpdates?.refreshes ?? [])).toEqual([
      { kind: "folder", active: false, epoch: "epoch-two" },
    ]);
  });
});
