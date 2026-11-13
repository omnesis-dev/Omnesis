// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  createLocalAgentSessionSource,
  type LocalAgentSessionAdapter,
  type LocalAgentSessionCursor,
  type ParsedLocalAgentSession,
} from "./local-agent-sessions.js";
import { pathScopeFolders } from "./path-scopes.js";
import { PATH_SCOPE_CURSOR_KEY } from "./path-scope-sync.js";
import type { PathScopeLayout } from "./path-scopes.js";
import type { SourceInstance, SyncOptions } from "./define-source.js";
import type { SyncResult } from "./source.js";

const LAYOUT: PathScopeLayout = { home: "/home/maya", caseSensitive: true };
const SUPPORTED: SyncOptions = { scopeFactsSupported: true, scopeHierarchySupported: true };
const DAY_ONE = new Date(2026, 0, 6, 9).getTime();
const DAY_TWO = new Date(2026, 0, 7, 9).getTime();
const folder = (directory: string) => pathScopeFolders(directory, LAYOUT)![0]!.id;

interface Fixture {
  id: string;
  cwd?: string;
  directories?: string[];
  days?: number[];
  broken?: boolean;
}
type Cursor = LocalAgentSessionCursor;

describe("local agent sessions filed by working directory", () => {
  let root: string;
  let parseSession: ReturnType<typeof vi.fn<LocalAgentSessionAdapter["parseSession"]>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-session-folders-"));
    parseSession = vi.fn(async (path: string): Promise<ParsedLocalAgentSession> => {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
      if (fixture.broken) throw new Error("An invented unreadable session");
      return {
        id: fixture.id,
        cwd: fixture.cwd,
        ...(fixture.directories ? { directories: fixture.directories } : {}),
        messages: (fixture.days ?? [DAY_ONE]).flatMap((atMs) => [
          { role: "user" as const, text: `Invented question in ${fixture.id}`, atMs },
          { role: "assistant" as const, text: `Invented answer in ${fixture.id}`, atMs: atMs + 1 },
        ]),
        complete: true,
      };
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  let clock = 1_700_000_000;
  function write(fixture: Fixture): void {
    const path = join(root, `${fixture.id}.jsonl`);
    writeFileSync(path, JSON.stringify(fixture));
    // A rewrite always moves the file's revision, whatever the filesystem's clock grain.
    clock += 10;
    utimesSync(path, clock, clock);
  }
  function source(folders: PathScopeLayout | null = LAYOUT): SourceInstance<Cursor> {
    return createLocalAgentSessionSource({
      sourceId: SourceId("fictional-agent:local"),
      providerId: ProviderId("fictional-agent:local"),
      ...(folders ? { folders } : {}),
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Fixture agent",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        parseSession,
      },
    });
  }
  async function run(
    instance: SourceInstance<Cursor>,
    cursor: Cursor | null,
    options: SyncOptions = SUPPORTED,
  ): Promise<{ pages: Array<SyncResult<Cursor>>; cursor: Cursor }> {
    const pages: Array<SyncResult<Cursor>> = [];
    for (let page = 0; page < 100; page++) {
      const result = await instance.sync(cursor, options);
      pages.push(result);
      cursor = result.cursor;
      if (!result.hasMore) return { pages, cursor };
    }
    throw new Error("The source never finished");
  }
  const hierarchyOf = (pages: Array<SyncResult<Cursor>>, session: string) =>
    pages
      .flatMap((page) => page.documents)
      .filter((doc) => doc.externalId.includes(session))
      .map((doc) => doc.metadata.scopeHierarchy![0]!);
  const stateOf = (cursor: Cursor, session: string) =>
    Object.values(cursor.files).find((state) => state.sessionId === session)!;

  test("every day of a session is filed under the directory it worked in", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api", days: [DAY_ONE, DAY_TWO] });
    write({ id: "garden", cwd: "/home/maya/personal/garden-notes" });
    const { pages, cursor } = await run(source(), null);
    expect(hierarchyOf(pages, "atlas")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
    ]);
    expect(hierarchyOf(pages, "garden")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/personal/garden-notes")], complete: true },
    ]);
    const labels = pages.flatMap((page) =>
      (page.scopeUpdates?.hierarchy?.nodes ?? []).map((node) => node.label),
    );
    expect([...new Set(labels)].sort()).toEqual([
      "~",
      "~/personal",
      "~/personal/garden-notes",
      "~/work",
      "~/work/atlas-api",
    ]);
    expect(stateOf(cursor, "atlas").directory).toBe("/home/maya/work/atlas-api");
    expect(pages.at(-1)!.presentExternalIds).toHaveLength(3);
  });

  test("a session that stepped into subdirectories stays where it started", async () => {
    write({
      id: "atlas",
      cwd: "/home/maya/work/atlas-api/packages/core",
      directories: [
        "/home/maya/work/atlas-api",
        "/home/maya/work/atlas-api/packages/core",
        "/home/maya/work/atlas-api/",
      ],
    });
    const { pages, cursor } = await run(source(), null);
    expect(hierarchyOf(pages, "atlas")[0]).toEqual({
      kind: "folder",
      parentIds: [folder("/home/maya/work/atlas-api")],
      complete: true,
    });
    expect(stateOf(cursor, "atlas").directory).toBe("/home/maya/work/atlas-api");
  });

  test("a session that worked in two unrelated directories has no folder, and neither does one that recorded none", async () => {
    write({
      id: "wandering",
      cwd: "/home/maya/personal/garden-notes",
      directories: ["/home/maya/work/atlas-api", "/home/maya/personal/garden-notes"],
    });
    write({ id: "nowhere" });
    write({ id: "relative", cwd: "work/atlas-api" });
    write({ id: "elsewhere", cwd: "C:\\Users\\maya\\work" });
    const { pages, cursor } = await run(source(), null);
    for (const session of ["wandering", "nowhere", "relative", "elsewhere"]) {
      expect(hierarchyOf(pages, session)).toEqual([
        { kind: "folder", parentIds: [], complete: false },
      ]);
      expect(stateOf(cursor, session).directory).toBeNull();
    }
    expect(pages.flatMap((page) => page.scopeUpdates?.hierarchy?.nodes ?? [])).toEqual([]);
  });

  test("a session continued in another directory moves on the page that reads it again", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api" });
    const instance = source();
    const first = await run(instance, null);
    write({ id: "atlas", cwd: "/home/maya/personal/atlas-notes" });
    const second = await run(instance, first.cursor);
    expect(hierarchyOf(second.pages, "atlas")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/personal/atlas-notes")], complete: true },
    ]);
    expect(second.pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? [])).toEqual([
      expect.objectContaining({
        parentIds: [folder("/home/maya/personal/atlas-notes")],
        complete: true,
      }),
    ]);
    // Continued in an unrelated directory as well, it has no single folder left.
    write({
      id: "atlas",
      cwd: "/srv/other",
      directories: ["/home/maya/personal/atlas-notes", "/srv/other"],
    });
    const third = await run(instance, second.cursor);
    expect(hierarchyOf(third.pages, "atlas")).toEqual([
      { kind: "folder", parentIds: [], complete: false },
    ]);
  });

  test("the directory is recorded whether or not the gateway takes folder facts", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api" });
    const { pages, cursor } = await run(source(), null, {});
    expect(pages[0]!.documents[0]!.metadata.scopeHierarchy).toBeUndefined();
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(stateOf(cursor, "atlas").directory).toBe("/home/maya/work/atlas-api");
    expect(PATH_SCOPE_CURSOR_KEY in cursor).toBe(false);
    // Once it does, the stored session is filed from the cursor alone.
    parseSession.mockClear();
    const later = await run(source(), cursor);
    expect(parseSession).not.toHaveBeenCalled();
    expect(later.pages.flatMap((page) => page.documents)).toEqual([]);
    expect(later.pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? [])).toEqual([
      expect.objectContaining({ parentIds: [folder("/home/maya/work/atlas-api")], complete: true }),
    ]);
  });

  test("a session read before directories were recorded is read once more when a filter needs it, and not before", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api" });
    write({ id: "garden", cwd: "/home/maya/personal/garden-notes" });
    const instance = source();
    const first = await run(instance, null, {});
    const legacy: Cursor = {
      ...first.cursor,
      files: Object.fromEntries(
        Object.entries(first.cursor.files).map(([key, { directory: _directory, ...state }]) => [
          key,
          state,
        ]),
      ),
    };
    parseSession.mockClear();
    const idle = await run(instance, legacy, {});
    expect(parseSession).not.toHaveBeenCalled();
    expect(stateOf(idle.cursor, "atlas").directory).toBeUndefined();

    const { pages, cursor } = await run(instance, idle.cursor);
    expect(parseSession).toHaveBeenCalledTimes(2);
    expect(hierarchyOf(pages, "atlas")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
    ]);
    expect(hierarchyOf(pages, "garden")[0]!.complete).toBe(true);
    expect(stateOf(cursor, "garden").directory).toBe("/home/maya/personal/garden-notes");
    parseSession.mockClear();
    await run(instance, cursor);
    expect(parseSession).not.toHaveBeenCalled();
  });

  test("a session that can no longer be parsed keeps the directory it was last read in", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api" });
    const instance = source();
    const first = await run(instance, null);
    write({ id: "atlas", broken: true });
    const second = await run(instance, first.cursor);
    expect(stateOf(second.cursor, "atlas")).toMatchObject({
      complete: false,
      directory: "/home/maya/work/atlas-api",
    });
    expect(stateOf(second.cursor, "atlas").externalIds).toHaveLength(1);
  });

  test("a source that publishes no folders is unchanged", async () => {
    write({ id: "atlas", cwd: "/home/maya/work/atlas-api" });
    const { pages, cursor } = await run(source(null), null);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(pages[0]!.documents[0]!.metadata.scopeHierarchy).toBeUndefined();
    expect(PATH_SCOPE_CURSOR_KEY in cursor).toBe(false);
  });
});
