// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  HOST_HOME_ENV,
  pathScopeFolders,
  type SyncOptions,
  type SyncResult,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { scopeContracts } from "./scope-contracts.js";
import source from "./index.js";
import type { LocalAgentSessionCursor } from "@omnesis/source-sdk/local-agent-sessions";

const SUPPORTED: SyncOptions = { scopeFactsSupported: true, scopeHierarchySupported: true };
const folder = (directory: string) => pathScopeFolders(directory, { home: "/home/maya" })![0]!.id;
type Page = SyncResult<LocalAgentSessionCursor>;
const AT = new Date(2026, 0, 7, 9).toISOString();

/** A Codex rollout: the directory in its header, then one per later turn. */
function records(id: string, directories: string[]): Array<Record<string, unknown>> {
  const [first, ...later] = directories;
  const turn = (index: number) => [
    {
      type: "event_msg",
      timestamp: AT,
      payload: { type: "user_message", message: `Invented question ${id} ${index}` },
    },
    {
      type: "response_item",
      timestamp: AT,
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: `Invented answer ${id} ${index}` }],
      },
    },
  ];
  return [
    {
      type: "session_meta",
      timestamp: AT,
      payload: { id, source: "cli", ...(first ? { cwd: first } : {}) },
    },
    ...turn(0),
    ...later.flatMap((cwd, index) => [
      { type: "turn_context", timestamp: AT, payload: { cwd } },
      ...turn(index + 1),
    ]),
  ];
}

describe("Codex sessions filed by project folder", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-folders-"));
    // Sessions name directories as the machine that ran them does.
    vi.stubEnv(HOST_HOME_ENV, "/home/maya");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(id: string, directories: string[]): void {
    const path = join(root, "sessions", `${id}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${records(id, directories)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
  }
  async function run(options: SyncOptions = SUPPORTED): Promise<Page[]> {
    const instance = await source.create!({
      accountId: "local",
      sourceId: SourceId("codex:local"),
      providerId: ProviderId("codex:local"),
      config: { codexHome: root },
    });
    const pages: Page[] = [];
    let cursor: LocalAgentSessionCursor | null = null;
    for (let page = 0; page < 20; page++) {
      const result = await instance.sync(cursor, options);
      pages.push(result);
      cursor = result.cursor;
      if (!result.hasMore) return pages;
    }
    throw new Error("The source never finished");
  }
  const hierarchies = (pages: Page[]) =>
    pages.flatMap((page) => page.documents).map((doc) => doc.metadata.scopeHierarchy![0]!);

  test("declares a project-folder filter browsed as a tree", () => {
    expect(source.scopes).toBe(scopeContracts["codex"]);
    expect(source.scopes!.items).toEqual([
      {
        kind: "folder",
        noun: { one: "project folder", many: "project folders" },
        picker: "tree",
        link: "hierarchy",
      },
    ]);
  });

  test("files each session under its working directory and publishes that folder with its ancestors", async () => {
    writeSession("atlas", ["/home/maya/work/atlas-api"]);
    writeSession("garden", ["/home/maya/personal/garden-notes"]);
    writeSession("bench", ["/srv/workshop"]);
    const pages = await run();
    const byText = (text: string) =>
      pages.flatMap((page) => page.documents).find((doc) => doc.content.includes(text))!.metadata
        .scopeHierarchy;
    expect(byText("Invented question atlas")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
    ]);
    expect(byText("Invented question garden")).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/personal/garden-notes")], complete: true },
    ]);
    expect(byText("Invented question bench")).toEqual([
      { kind: "folder", parentIds: [folder("/srv/workshop")], complete: true },
    ]);
    const labels = pages.flatMap((page) =>
      (page.scopeUpdates?.hierarchy?.nodes ?? []).map((node) => node.label),
    );
    expect([...new Set(labels)].sort()).toEqual([
      "/srv",
      "/srv/workshop",
      "~",
      "~/personal",
      "~/personal/garden-notes",
      "~/work",
      "~/work/atlas-api",
    ]);
    expect(pages.at(-1)!.scopeUpdates!.readiness).toEqual([{ kind: "folder", complete: true }]);
    expect(pages.at(-1)!.progress).toMatchObject({ coverage: "unknown" });
  });

  test("a session that steps into a subdirectory stays under the directory it started in", async () => {
    writeSession("atlas", ["/home/maya/work/atlas-api", "/home/maya/work/atlas-api/packages/core"]);
    const pages = await run();
    expect(hierarchies(pages)).toEqual([
      { kind: "folder", parentIds: [folder("/home/maya/work/atlas-api")], complete: true },
    ]);
  });

  test("a session that moves to an unrelated directory has no folder a filter can name", async () => {
    writeSession("roaming", ["/home/maya/work/atlas-api", "/home/maya/personal/garden-notes"]);
    const pages = await run();
    expect(hierarchies(pages)).toEqual([{ kind: "folder", parentIds: [], complete: false }]);
    expect(pages.flatMap((page) => page.scopeUpdates?.hierarchy?.nodes ?? [])).toEqual([]);
  });

  test("a session that recorded no directory has no folder a filter can name", async () => {
    writeSession("nowhere", []);
    const pages = await run();
    expect(hierarchies(pages)).toEqual([{ kind: "folder", parentIds: [], complete: false }]);
  });

  test("says nothing about folders to a gateway that takes no folder facts", async () => {
    writeSession("atlas", ["/home/maya/work/atlas-api"]);
    const pages = await run({});
    expect(pages).toHaveLength(1);
    expect(pages[0]!.scopeUpdates).toBeUndefined();
    expect(pages[0]!.documents[0]!.metadata.scopeHierarchy).toBeUndefined();
    expect(pages[0]!.documents[0]!.metadata.extra).toMatchObject({
      cwd: "/home/maya/work/atlas-api",
    });
  });
});
