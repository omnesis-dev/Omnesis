// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { pathScopeFolders } from "./path-scopes.js";
import { PATH_SCOPE_CURSOR_KEY, withPathScopes } from "./path-scope-sync.js";
import type { PathScopeBookmark } from "./path-scope-sync.js";
import type { PathScopeLayout } from "./path-scopes.js";
import type { SourceInstance, SyncOptions } from "./define-source.js";
import type { SyncCursor, SyncResult } from "./source.js";
import type { DocumentInput } from "@omnesis/types";

const LAYOUT: PathScopeLayout = { home: "/home/maya", caseSensitive: true };
const SUPPORTED: SyncOptions = { scopeFactsSupported: true, scopeHierarchySupported: true };
const folder = (directory: string, layout = LAYOUT) => pathScopeFolders(directory, layout)![0]!.id;

interface Cursor extends SyncCursor {
  /** External id to directory, for every document the fake source has emitted. */
  known: Record<string, string | null>;
  calls: number;
}

/**
 * A source over a fixed set of documents: each call emits those its cursor
 * does not hold yet, `perPage` at a time, and ends the run with a snapshot.
 */
function fakeSource(
  files: Record<string, string | null>,
  perPage = 100,
): SourceInstance<Cursor> & { seen: Array<Cursor | null> } {
  const seen: Array<Cursor | null> = [];
  return {
    seen,
    async sync(cursor) {
      seen.push(cursor);
      const known = { ...cursor?.known };
      const fresh = Object.keys(files)
        .filter((id) => !(id in known))
        .slice(0, perPage);
      for (const id of fresh) known[id] = files[id]!;
      const hasMore = Object.keys(files).some((id) => !(id in known));
      return {
        documents: fresh.map((externalId): DocumentInput => ({
          providerId: ProviderId("fake"),
          sourceId: SourceId("fake:one"),
          externalId,
          title: externalId,
          content: externalId,
          contentHash: externalId,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
          sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
          metadata: { documentType: "file" },
        })),
        deletedExternalIds: [],
        cursor: { known, calls: (cursor?.calls ?? 0) + 1 },
        hasMore,
        ...(hasMore ? {} : { presentExternalIds: Object.keys(known) }),
      };
    },
  };
}
const scoped = (source: SourceInstance<Cursor>, layout = LAYOUT) =>
  withPathScopes(source, {
    layout,
    inventory: (cursor) =>
      Object.entries(cursor.known).map(([externalId, directory]) => ({ externalId, directory })),
  });
const bookmarkOf = (result: SyncResult<Cursor>) =>
  result.cursor[PATH_SCOPE_CURSOR_KEY] as PathScopeBookmark | undefined;

/** Run until the source says it is done, as the collector would. */
async function run(
  source: SourceInstance<Cursor>,
  cursor: Cursor | null,
  options: SyncOptions = SUPPORTED,
): Promise<{ pages: Array<SyncResult<Cursor>>; cursor: Cursor }> {
  const pages: Array<SyncResult<Cursor>> = [];
  for (let page = 0; page < 500; page++) {
    const result = await source.sync(cursor, options);
    pages.push(result);
    cursor = result.cursor;
    if (!result.hasMore) return { pages, cursor };
  }
  throw new Error("The source never finished");
}
const nodesOf = (pages: Array<SyncResult<Cursor>>) =>
  pages.flatMap((page) => page.scopeUpdates?.hierarchy?.nodes ?? []);
const edgesOf = (pages: Array<SyncResult<Cursor>>) =>
  pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? []);

const FILES = {
  "atlas-notes": "/home/maya/work/atlas-api",
  "garden-notes": "/home/maya/personal/garden-notes",
  "bench-notes": "/home/maya/workshop",
  "no-directory": null,
};

describe("withPathScopes", () => {
  test("leaves a source alone when the gateway takes no folder facts", async () => {
    const inner = fakeSource(FILES);
    const { pages, cursor } = await run(scoped(inner), null, {});
    expect(pages).toHaveLength(1);
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(pages[0]!.documents.every((doc) => doc.metadata.scopeHierarchy === undefined)).toBe(
      true,
    );
    expect(PATH_SCOPE_CURSOR_KEY in cursor).toBe(false);
    expect(pages[0]!.presentExternalIds).toHaveLength(4);
  });

  test("a first run files each document in its folder and publishes the folders and their ancestors", async () => {
    const { pages, cursor } = await run(scoped(fakeSource(FILES)), null);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    const hierarchy = (id: string) =>
      page!.documents.find((doc) => doc.externalId === id)!.metadata.scopeHierarchy;
    expect(hierarchy("atlas-notes")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
    ]);
    expect(hierarchy("bench-notes")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/workshop")], complete: true },
    ]);
    expect(
      nodesOf(pages)
        .map((node) => node.label)
        .sort(),
    ).toEqual([
      "~",
      "~/personal",
      "~/personal/garden-notes",
      "~/work",
      "~/work/atlas-api",
      "~/workshop",
    ]);
    const node = (label: string) => nodesOf(pages).find((item) => item.label === label)!;
    expect(node("~").parentIds).toEqual([]);
    expect(node("~/work").parentIds).toEqual([node("~").id]);
    expect(node("~/work/atlas-api").parentIds).toEqual([node("~/work").id]);
    expect(node("~/workshop").parentIds).toEqual([node("~").id]);
    expect(nodesOf(pages).every((item) => item.complete && !item.deleted)).toBe(true);
    expect(edgesOf(pages)).toContainEqual({
      externalId: "atlas-notes",
      parentIds: [folder("/home/maya/work/atlas-api")],
      complete: true,
    });
    // The editor may list folders, and no refresh is completed that nobody asked for.
    expect(page!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(page!.scopeUpdates!.refreshes).toBeUndefined();
    expect(page!.scopeUpdates!.hierarchy!.snapshot).toBeUndefined();
    expect(page!.presentExternalIds).toHaveLength(4);
    expect(bookmarkOf(pages[0]!)).toMatchObject({ completed: true, epoch: "", actorId: "" });
    expect(cursor.known).toEqual(FILES);
  });

  test("a document with no directory says its folder is unknown, never that it is in none", async () => {
    const { pages } = await run(scoped(fakeSource(FILES)), null);
    const unknown = { kind: "folder", parentIds: [], complete: false };
    expect(
      pages[0]!.documents.find((doc) => doc.externalId === "no-directory")!.metadata.scopeHierarchy,
    ).toEqual([unknown]);
    expect(edgesOf(pages)).toContainEqual({
      externalId: "no-directory",
      parentIds: [],
      complete: false,
    });
  });

  test("a document the cursor does not account for, or outside the layout's roots, is unknown", async () => {
    const inner = fakeSource({ inside: "/srv/share/work", outside: "/srv/elsewhere" });
    const source = withPathScopes(inner, {
      layout: { roots: ["/srv/share"], caseSensitive: true },
      inventory: (cursor) =>
        Object.entries(cursor.known)
          .filter(([externalId]) => externalId !== "unaccounted")
          .map(([externalId, directory]) => ({ externalId, directory })),
    });
    const { pages } = await run(source, null);
    const complete = (id: string) =>
      pages[0]!.documents.find((doc) => doc.externalId === id)!.metadata.scopeHierarchy![0]!
        .complete;
    expect(complete("inside")).toBe(true);
    expect(complete("outside")).toBe(false);
    expect(
      nodesOf(pages)
        .map((node) => node.label)
        .sort(),
    ).toEqual(["/srv/share", "/srv/share/work"]);
  });

  test("the source never sees the bookmark, and gets its own cursor back unchanged", async () => {
    const inner = fakeSource(FILES);
    const source = scoped(inner);
    const first = await run(source, null);
    await run(source, first.cursor);
    expect(inner.seen[0]).toBeNull();
    expect(inner.seen[1]).toEqual({ known: FILES, calls: 1 });
  });

  test("documents stored before folders were published are published in a pass of their own, after the source has looked again", async () => {
    const inner = fakeSource(FILES);
    // Stored while the gateway took no folder facts.
    const before = await run(scoped(inner), null, {});
    const callsBefore = inner.seen.length;
    const { pages, cursor } = await run(scoped(inner), before.cursor);
    expect(pages).toHaveLength(3);
    // The source runs first, so the pass reads what it has just seen. Its last
    // page is not the end of the run, and what only a last page says is withheld.
    expect(pages[0]!.documents).toEqual([]);
    expect(pages[0]!.hasMore).toBe(true);
    expect(pages[0]!.presentExternalIds).toBeUndefined();
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(bookmarkOf(pages[0]!)).toMatchObject({ completed: false, observed: true });
    // The pass publishes every stored document without the source being asked.
    expect(inner.seen.length).toBe(callsBefore + 2);
    expect(pages[1]!.documents).toEqual([]);
    expect(pages[1]!.hasMore).toBe(true);
    expect(edgesOf([pages[1]!]).map((edge) => edge.externalId)).toEqual([
      "atlas-notes",
      "bench-notes",
      "garden-notes",
      "no-directory",
    ]);
    expect(nodesOf([pages[1]!])).toHaveLength(6);
    expect(pages[1]!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    // Then the source ends the run, with nothing new.
    expect(pages[2]!.documents).toEqual([]);
    expect(pages[2]!.presentExternalIds).toHaveLength(4);
    expect(bookmarkOf(pages[2]!)).toMatchObject({ completed: true });
    expect(bookmarkOf(pages[2]!)!.observed).toBeUndefined();
    // A later run publishes nothing again.
    const later = await run(scoped(inner), cursor);
    expect(later.pages).toHaveLength(1);
    expect(later.pages[0]!.scopeUpdates).toEqual({
      readiness: [{ kind: "folder", complete: true }],
    });
  });

  test("a document that changed directory since the last run is published where the source now sees it", async () => {
    const files: Record<string, string | null> = { ...FILES };
    const inner: SourceInstance<Cursor> = {
      async sync(cursor) {
        // Notices a move without emitting the document again.
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: { known: { ...files }, calls: (cursor?.calls ?? 0) + 1 },
          hasMore: false,
        };
      },
    };
    const before = await run(scoped(inner), null, {});
    files["atlas-notes"] = "/home/maya/personal/atlas-notes";
    const { pages } = await run(scoped(inner), before.cursor);
    expect(edgesOf(pages)).toContainEqual({
      externalId: "atlas-notes",
      parentIds: [folder("/home/maya/personal/atlas-notes")],
      complete: true,
    });
  });

  test("a large backlog is published in bounded pages, resumed from the bookmark, each document once", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 700; index++)
      files[`doc-${String(index).padStart(4, "0")}`] =
        `/srv/projects/p${index % 300}/a/b/c/d${index % 7}`;
    const inner = fakeSource(files, 1000);
    const before = await run(scoped(inner), null, {});
    const { pages } = await run(scoped(inner), before.cursor);
    const metadata = pages.slice(1, -1);
    expect(metadata.length).toBeGreaterThan(5);
    for (const page of metadata) {
      expect(page.documents).toEqual([]);
      expect(page.scopeUpdates!.hierarchy!.documents!.length).toBeLessThanOrEqual(128);
      expect(page.scopeUpdates!.hierarchy!.nodes!.length).toBeLessThanOrEqual(256);
      expect(page.hasMore).toBe(true);
    }
    const edges = edgesOf(pages).map((edge) => edge.externalId);
    expect(edges).toEqual(Object.keys(files).sort());
    // Only the page that ends the pass says it is complete.
    expect(metadata.filter((page) => page.scopeUpdates!.readiness).length).toBe(1);
    expect(metadata.at(-1)!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(bookmarkOf(metadata[0]!)).toMatchObject({
      completed: false,
      after: edges[metadata[0]!.scopeUpdates!.hierarchy!.documents!.length - 1],
    });
    // Every folder a document names was published in or before its page.
    const published = new Set<string>();
    for (const page of metadata) {
      for (const node of page.scopeUpdates!.hierarchy!.nodes!) published.add(node.id);
      for (const edge of page.scopeUpdates!.hierarchy!.documents!)
        for (const id of edge.parentIds) expect(published.has(id)).toBe(true);
    }
  });

  test("a page whose folders do not fit publishes the rest before the source reads on, and only then ends the run", async () => {
    const files: Record<string, string> = { seed: "/srv/seed" };
    const inner = fakeSource(files, 400);
    const first = await run(scoped(inner), null);
    for (let index = 0; index < 300; index++)
      files[`doc-${String(index).padStart(3, "0")}`] = `/srv/p${index}/a/b`;
    const { pages } = await run(scoped(inner), first.cursor);
    expect(pages[0]!.documents).toHaveLength(300);
    expect(pages[0]!.documents.every((doc) => doc.metadata.scopeHierarchy![0]!.complete)).toBe(
      true,
    );
    // The source's last page carried a snapshot; the run is not over, so it is withheld.
    expect(pages[0]!.hasMore).toBe(true);
    expect(pages[0]!.presentExternalIds).toBeUndefined();
    expect(pages[0]!.scopeUpdates!.readiness).toBeUndefined();
    const waiting = bookmarkOf(pages[0]!)!.pending!;
    expect(waiting.length).toBe(300 - pages[0]!.scopeUpdates!.hierarchy!.documents!.length);
    for (const page of pages) {
      expect(page.scopeUpdates?.hierarchy?.documents?.length ?? 0).toBeLessThanOrEqual(128);
      expect(page.scopeUpdates?.hierarchy?.nodes?.length ?? 0).toBeLessThanOrEqual(256);
    }
    // Each document is published once: the waiting ones alone follow, not the whole cursor.
    expect(
      edgesOf(pages)
        .map((edge) => edge.externalId)
        .sort(),
    ).toEqual(Object.keys(files).filter((id) => id !== "seed"));
    for (const page of pages.slice(1, -1)) expect(page.documents).toEqual([]);
    const last = pages.at(-1)!;
    expect(last.hasMore).toBe(false);
    expect(last.documents).toEqual([]);
    expect(last.presentExternalIds).toHaveLength(301);
    expect(last.scopeUpdates).toEqual({ readiness: [{ kind: "folder", complete: true }] });
    expect(bookmarkOf(last)).toEqual({
      version: 1,
      layout: bookmarkOf(last)!.layout,
      epoch: "",
      actorId: "",
      completed: true,
    });
  });

  test("a first page whose folders do not fit is followed by a pass that ends the publication", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 300; index++)
      files[`doc-${String(index).padStart(3, "0")}`] = `/srv/p${index}/a/b`;
    const options = { ...SUPPORTED, scopeRefreshEpochs: { folder: "epoch-one" } };
    const { pages } = await run(scoped(fakeSource(files, 300)), null, options);
    expect(pages[0]!.documents).toHaveLength(300);
    expect(pages[0]!.hasMore).toBe(true);
    expect(pages[0]!.scopeUpdates!.readiness).toBeUndefined();
    expect(pages[0]!.scopeUpdates!.refreshes).toBeUndefined();
    expect(bookmarkOf(pages[0]!)).toMatchObject({ completed: false });
    expect(new Set(edgesOf(pages).map((edge) => edge.externalId))).toEqual(
      new Set(Object.keys(files)),
    );
    const completing = pages.filter((page) => page.scopeUpdates?.refreshes);
    expect(completing).toHaveLength(1);
    expect(completing[0]!.scopeUpdates!.refreshes).toEqual([
      { kind: "folder", active: false, epoch: "epoch-one" },
    ]);
    expect(pages.at(-1)!.hasMore).toBe(false);
    expect(pages.at(-1)!.presentExternalIds).toHaveLength(300);
  });

  test("a waiting document the cursor no longer accounts for is dropped, not waited on", async () => {
    const inner = fakeSource({ kept: "/srv/a" });
    const first = await run(scoped(inner), null);
    const cursor = {
      ...first.cursor,
      [PATH_SCOPE_CURSOR_KEY]: { ...bookmarkOf(first.pages[0]!)!, pending: ["gone", "kept"] },
    };
    const { pages } = await run(scoped(inner), cursor);
    expect(edgesOf(pages).map((edge) => edge.externalId)).toEqual(["kept"]);
    expect(bookmarkOf(pages.at(-1)!)!.pending).toBeUndefined();
  });

  test("a gateway refresh is answered by publishing every document again under its epoch, then completing it", async () => {
    const inner = fakeSource(FILES);
    const first = await run(scoped(inner), null);
    const options = { ...SUPPORTED, scopeRefreshEpochs: { folder: "epoch-two" } };
    const { pages, cursor } = await run(scoped(inner), first.cursor, options);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(pages[1]!.scopeUpdates!.hierarchy!.refreshEpoch).toBe("epoch-two");
    expect(edgesOf([pages[1]!])).toHaveLength(4);
    expect(edgesOf([pages[1]!]).every((edge) => edge.refreshEpoch === "epoch-two")).toBe(true);
    expect(pages[1]!.scopeUpdates!.refreshes).toEqual([
      { kind: "folder", active: false, epoch: "epoch-two" },
    ]);
    expect(pages[1]!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(bookmarkOf(pages[2]!)).toMatchObject({ epoch: "epoch-two", completed: true });
    // The same epoch again asks for nothing; a newer one for everything once more.
    expect((await run(scoped(inner), cursor, options)).pages).toHaveLength(1);
    const third = await run(scoped(inner), cursor, {
      ...SUPPORTED,
      scopeRefreshEpochs: { folder: "epoch-three" },
    });
    expect(edgesOf(third.pages).every((edge) => edge.refreshEpoch === "epoch-three")).toBe(true);
    expect(edgesOf(third.pages)).toHaveLength(4);
  });

  test("never starts or restarts a refresh, which would take another device's publication with it", async () => {
    const inner = fakeSource(FILES);
    const before = await run(scoped(inner), null, {});
    const { pages } = await run(scoped(inner), before.cursor, {
      ...SUPPORTED,
      scopeRefreshEpochs: { folder: "epoch-two" },
      scopeRefreshRequestIds: { folder: "00000000-0000-4000-8000-000000000000" },
    });
    for (const page of pages)
      for (const refresh of page.scopeUpdates?.refreshes ?? []) {
        expect(refresh.active).toBe(false);
        expect(refresh.restart).toBeUndefined();
        expect(refresh.requestId).toBeUndefined();
      }
  });

  test("documents read during a refresh carry its epoch, and a first run completes it at once", async () => {
    const options = { ...SUPPORTED, scopeRefreshEpochs: { folder: "epoch-one" } };
    const { pages } = await run(scoped(fakeSource(FILES)), null, options);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.documents[0]!.metadata.scopeHierarchy![0]!.refreshEpoch).toBe("epoch-one");
    expect(pages[0]!.scopeUpdates!.hierarchy!.refreshEpoch).toBe("epoch-one");
    expect(pages[0]!.scopeUpdates!.refreshes).toEqual([
      { kind: "folder", active: false, epoch: "epoch-one" },
    ]);
  });

  test("a cursor that moved to another device, or a changed layout, publishes everything again", async () => {
    const inner = fakeSource(FILES);
    const laptop = { ...SUPPORTED, scopeRefreshActorId: "device-laptop" };
    const first = await run(scoped(inner), null, laptop);
    expect((await run(scoped(inner), first.cursor, laptop)).pages).toHaveLength(1);
    const moved = await run(scoped(inner), first.cursor, {
      ...SUPPORTED,
      scopeRefreshActorId: "device-desktop",
    });
    expect(edgesOf(moved.pages)).toHaveLength(4);
    expect(bookmarkOf(moved.pages.at(-1)!)!.actorId).toBe("device-desktop");

    const rehomed = await run(
      scoped(inner, { home: "/home", caseSensitive: true }),
      first.cursor,
      laptop,
    );
    expect(edgesOf(rehomed.pages)).toHaveLength(4);
    expect(nodesOf(rehomed.pages).map((node) => node.label)).toContain("~/maya/work");
  });

  test("support that went away and came back publishes everything again", async () => {
    const inner = fakeSource(FILES);
    const first = await run(scoped(inner), null);
    const without = await run(scoped(inner), first.cursor, {});
    expect(PATH_SCOPE_CURSOR_KEY in without.cursor).toBe(false);
    const back = await run(scoped(inner), without.cursor);
    expect(edgesOf(back.pages)).toHaveLength(4);
  });

  test("a bookmark it cannot read is treated as none", async () => {
    const inner = fakeSource(FILES);
    const first = await run(scoped(inner), null);
    for (const broken of [
      null,
      "done",
      { version: 2 },
      { ...bookmarkOf(first.pages[0]!), pending: [7] },
    ]) {
      const { pages } = await run(scoped(inner), {
        ...first.cursor,
        [PATH_SCOPE_CURSOR_KEY]: broken,
      });
      expect(edgesOf(pages)).toHaveLength(4);
    }
  });

  test("a member of a shared source publishes nothing: the holder owns the hierarchy", async () => {
    const options = {
      ...SUPPORTED,
      run: { id: "run", reason: "schedule", start: "resume", page: 0, role: "member" },
    } as unknown as SyncOptions;
    const { pages } = await run(scoped(fakeSource(FILES)), null, options);
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(pages[0]!.documents[0]!.metadata.scopeHierarchy).toBeUndefined();
  });

  test("new documents on a later run are published with the page that carries them", async () => {
    const files: Record<string, string | null> = { ...FILES };
    const inner = fakeSource(files);
    const first = await run(scoped(inner), null);
    files["billing-notes"] = "/home/maya/work/billing";
    const { pages } = await run(scoped(inner), first.cursor);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.documents.map((doc) => doc.externalId)).toEqual(["billing-notes"]);
    expect(nodesOf(pages).map((node) => node.label)).toEqual(["~/work/billing", "~/work", "~"]);
    expect(edgesOf(pages)).toEqual([
      {
        externalId: "billing-notes",
        parentIds: [folder("/home/maya/work/billing")],
        complete: true,
      },
    ]);
    expect(pages[0]!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
  });

  test("a multi-page run keeps the source's own paging and says it is ready once, at the end", async () => {
    const { pages } = await run(scoped(fakeSource(FILES, 1)), null);
    expect(pages).toHaveLength(4);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, true, false]);
    expect(pages.slice(1, 3).every((page) => page.scopeUpdates?.readiness === undefined)).toBe(
      true,
    );
    expect(pages[3]!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(pages[3]!.presentExternalIds).toHaveLength(4);
  });
});
