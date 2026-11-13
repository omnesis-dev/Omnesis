// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PATH_SCOPE_CURSOR_KEY,
  pathScopeFolders,
  withPathScopes,
  type PathScopeLayout,
  type SourceInstance,
  type SyncCursor,
  type SyncOptions,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId, type DocumentInput, type ScopePolicy } from "@omnesis/types";
import { runSchemaSetup } from "../data/schema.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { upsertWithCursor } from "../data/repositories/DocumentRepository.js";
import { seedPackagedSourceScopes } from "./packaged-source-scopes.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { drainHierarchyWork } from "./scope-hierarchy-work.js";
import { readSourceScopeOptions, readSourceScopePreview } from "./scope-editor-reads.js";
import {
  restartEveryNativeScopeRefresh,
  sourceScopeRefreshState,
} from "./scope-refresh-requirements.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";

/**
 * The pages a directory-reading source produces, written by the gateway's own
 * page writer under the declarations it ships for those sources, and read
 * back through the predicate every corpus read enforces.
 */

// Facts are kept only while source filters are in use, which these tests take
// as given.
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const PATH_SOURCE_TYPES = ["claude-code", "codex", "pi", "local-files"] as const;
const sourceId = SourceId("claude-code:local");
const providerId = ProviderId("claude-code:local");
let db: SqliteDatabase.Database;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  runSchemaSetup(db);
  seedPackagedSourceScopes(db);
  const device = createDevice(db, {
    name: "Invented laptop",
    kind: "collector",
    capabilities: { sourceScopes: { min: 1, max: 2 } },
  });
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'claude-code','local',?,1,1)",
  ).run(sourceId, device.id);
  db.prepare(
    "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'claude-code','{}',1)",
  ).run(sourceId);
});
afterEach(() => db.close());

interface Cursor extends SyncCursor {
  known: Record<string, string | null>;
}
/** One device's reader: emits whatever its cursor does not hold in its current directory. */
function device(
  streamId: string,
  layout: PathScopeLayout,
  files: Record<string, string | null>,
): { sync(supported?: boolean): Promise<void>; files: Record<string, string | null> } {
  const inner: SourceInstance<Cursor> = {
    async sync(cursor) {
      const known = { ...cursor?.known };
      const changed = Object.keys(files).filter((id) => known[id] !== files[id] || !(id in known));
      for (const id of changed) known[id] = files[id]!;
      return {
        documents: changed.map((externalId): DocumentInput => ({
          sourceId,
          providerId,
          externalId,
          title: `Invented session ${externalId}`,
          content: `Fictional transcript ${externalId} in ${files[externalId]}`,
          contentHash: `${externalId}:${files[externalId]}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
          sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
          metadata: { documentType: "conversation" },
        })),
        deletedExternalIds: [],
        cursor: { known },
        hasMore: false,
      };
    },
  };
  const source = withPathScopes(inner, {
    layout,
    inventory: (cursor) =>
      Object.entries(cursor.known).map(([externalId, directory]) => ({ externalId, directory })),
  });
  let cursor: Cursor | null = null;
  return {
    files,
    async sync(supported = true) {
      for (let page = 0; page < 50; page++) {
        const refresh = sourceScopeRefreshState(db, sourceId);
        const options: SyncOptions = supported
          ? {
              scopeFactsSupported: true,
              scopeHierarchySupported: true,
              scopeRefreshEpochsSupported: true,
              scopeRefreshEpochs: refresh.epochs,
              scopeRefreshRequestIds: refresh.requestIds,
              scopeRefreshActorId: streamId,
            }
          : {};
        const result = await source.sync(cursor, options);
        upsertWithCursor(db, {
          sourceId,
          providerId,
          streamId,
          documents: result.documents,
          scopeUpdates: supported ? result.scopeUpdates : undefined,
          hasMore: result.hasMore,
          cursor: result.cursor,
        });
        cursor = result.cursor;
        if (!result.hasMore) {
          // The gateway's background pass that files documents under folders
          // published after them.
          settle();
          return;
        }
      }
      throw new Error("The source never finished");
    },
  };
}
function settle(): void {
  let passes = 0;
  while (drainHierarchyWork(db, 128))
    if (++passes > 50) throw new Error("Hierarchy did not settle");
}
function policy(ids: string[], action: "share" | "hide"): ScopePolicy {
  return {
    sourceId,
    audience: { accessLevel: "level", capability: "direct" },
    rules: [{ match: ids.map((id) => ({ kind: "folder" as const, id })), action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}
/** External ids, tagged with their stream, that the enforcement predicate lets through. */
function visible(action: "share" | "hide", ...ids: string[]): string[] {
  const sql = sourceScopeInclusionSql([policy(ids, action)], "d.id", "d.source_id");
  return db
    .prepare<unknown[], { name: string }>(
      `SELECT d.stream_id || '/' || d.external_id AS name FROM documents d WHERE ${sql.sql} ORDER BY name`,
    )
    .all(...sql.params)
    .map((row) => row.name);
}

const LINUX: PathScopeLayout = { home: "/home/maya", caseSensitive: true };
const MAC: PathScopeLayout = { home: "/Users/maya", caseSensitive: false };
const id = (directory: string, layout = LINUX) => pathScopeFolders(directory, layout)![0]!.id;
const laptopFiles = () => ({
  atlas: "/home/maya/work/atlas-api",
  "atlas-core": "/home/maya/work/atlas-api/packages/core",
  billing: "/home/maya/work/billing",
  garden: "/home/maya/personal/garden-notes",
  bench: "/home/maya/workshop",
  scratch: "/tmp/scratch",
  "no-directory": null,
});

describe("declarations", () => {
  it.each(PATH_SOURCE_TYPES)("%s ships a hierarchical folder filter with its own noun", (type) => {
    const scopes = getSourceScopes(db, type)!;
    expect(scopes.items).toHaveLength(1);
    expect(scopes.items[0]).toMatchObject({ kind: "folder", picker: "tree", link: "hierarchy" });
    const noun = (scopes.items[0] as { noun: { one: string; many: string } }).noun;
    expect(noun).toEqual(
      type === "local-files"
        ? { one: "folder", many: "folders" }
        : { one: "project folder", many: "project folders" },
    );
  });
});

describe("a directory-reading source's pages, enforced", () => {
  it("shares only a folder: what is in it at any depth, not a sibling whose name starts the same", async () => {
    await device("laptop", LINUX, laptopFiles()).sync();
    expect(visible("share", id("/home/maya/work"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/billing",
    ]);
    expect(visible("share", id("/home/maya/work/atlas-api"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
    ]);
    expect(visible("share", id("/home/maya/workshop"))).toEqual(["laptop/bench"]);
    expect(visible("share", id("/home/maya"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/bench",
      "laptop/billing",
      "laptop/garden",
    ]);
    expect(visible("share", id("/tmp"))).toEqual(["laptop/scratch"]);
  });

  it("hides a folder: everything else stays, and a document with no known directory is withheld either way", async () => {
    await device("laptop", LINUX, laptopFiles()).sync();
    expect(visible("hide", id("/home/maya/personal"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/bench",
      "laptop/billing",
      "laptop/scratch",
    ]);
    expect(visible("hide", id("/home/maya/work"))).toEqual([
      "laptop/bench",
      "laptop/garden",
      "laptop/scratch",
    ]);
    expect(visible("share", id("/home/maya"), id("/tmp"))).not.toContain("laptop/no-directory");
    expect(visible("hide", id("/srv/never"))).not.toContain("laptop/no-directory");
  });

  it("a folder nothing was ever in shares nothing and hides nothing", async () => {
    await device("laptop", LINUX, laptopFiles()).sync();
    expect(visible("share", id("/home/maya/retired"))).toEqual([]);
    expect(visible("hide", id("/home/maya/retired"))).toHaveLength(6);
  });

  it("a filter saved under one set of configured folders keeps hiding its folder once a folder above is configured", async () => {
    const files = {
      plan: "/home/maya/Documents/work",
      diary: "/home/maya/Documents/private",
      letter: "/home/maya/Documents/private/letters",
    };
    const narrow: PathScopeLayout = { ...LINUX, roots: ["/home/maya/Documents"] };
    await device("laptop", narrow, files).sync();
    const saved = id("/home/maya/Documents/private", narrow);
    expect(visible("hide", saved)).toEqual(["laptop/plan"]);

    const wide: PathScopeLayout = { ...LINUX, roots: ["/home/maya", "/home/maya/Documents"] };
    await device("laptop", wide, { ...files, note: "/home/maya/Desktop" }).sync();
    expect(visible("hide", saved)).toEqual(["laptop/note", "laptop/plan"]);
    expect(visible("share", saved)).toEqual(["laptop/diary", "laptop/letter"]);
    // The folder that was the top of the tree now sits under the new one.
    expect(visible("share", id("/home/maya", wide))).toEqual([
      "laptop/diary",
      "laptop/letter",
      "laptop/note",
      "laptop/plan",
    ]);
  });

  it("the editor's tree starts at ~ and the first segment of other paths, with the documents each folder governs", async () => {
    await device("laptop", LINUX, laptopFiles()).sync();
    const options = (parentId?: string, q?: string) => {
      const read = readSourceScopeOptions(db, { sourceId, kind: "folder", parentId, q });
      if (!read.ok) throw new Error(read.error);
      return read.value;
    };
    const roots = options();
    expect(roots.readiness).toEqual([expect.objectContaining({ kind: "folder", ready: true })]);
    expect(roots.items.map((item) => [item.label, item.count, item.hasChildren])).toEqual([
      ["/tmp", 1, true],
      ["~", 5, true],
    ]);
    const home = options(id("/home/maya"));
    expect(home.items.map((item) => [item.label, item.count])).toEqual([
      ["~/personal", 1],
      ["~/work", 3],
      ["~/workshop", 1],
    ]);
    expect(home.items.find((item) => item.label === "~/workshop")!.hasChildren).toBe(false);
    expect(options(id("/home/maya/work")).items.map((item) => item.label)).toEqual([
      "~/work/atlas-api",
      "~/work/billing",
    ]);
    // Typing part of a path finds the folder wherever it sits.
    expect(options(undefined, "work/atlas").items.map((item) => item.label)).toEqual([
      "~/work/atlas-api",
      "~/work/atlas-api/packages",
      "~/work/atlas-api/packages/core",
    ]);
    const preview = readSourceScopePreview(db, sourceId, policy([id("/home/maya/work")], "share"));
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value).toMatchObject({ total: 7, visible: 3, unknown: 1 });
    expect(preview.value.items).toEqual([expect.objectContaining({ label: "~/work", count: 3 })]);
  });

  it("sessions stored before the gateway took folder facts are filed without being sent again", async () => {
    const laptop = device("laptop", LINUX, laptopFiles());
    await laptop.sync(false);
    expect(visible("share", id("/home/maya"))).toEqual([]);
    expect(visible("hide", id("/home/maya/personal"))).toEqual([]);
    const stored = () =>
      db.prepare("SELECT id,external_id,content,content_hash FROM documents ORDER BY 1").all();
    const before = stored();
    await laptop.sync();
    expect(stored()).toEqual(before);
    expect(visible("share", id("/home/maya/work"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/billing",
    ]);
    expect(visible("hide", id("/home/maya/work"))).toEqual([
      "laptop/bench",
      "laptop/garden",
      "laptop/scratch",
    ]);
  });

  it("a session whose directory changes follows its new folder on the page that says so", async () => {
    const laptop = device("laptop", LINUX, laptopFiles());
    await laptop.sync();
    laptop.files.billing = "/home/maya/personal/billing";
    await laptop.sync();
    expect(visible("share", id("/home/maya/work"))).toEqual(["laptop/atlas", "laptop/atlas-core"]);
    expect(visible("share", id("/home/maya/personal"))).toEqual([
      "laptop/billing",
      "laptop/garden",
    ]);
    // The folder it left is still a folder; it simply holds nothing.
    expect(visible("share", id("/home/maya/work/billing"))).toEqual([]);
    laptop.files.billing = null;
    await laptop.sync();
    expect(visible("hide", id("/srv/never"))).not.toContain("laptop/billing");
  });

  it("two devices with different homes: one filter covers both, and neither's documents are the other's", async () => {
    const laptop = device("laptop", LINUX, laptopFiles());
    const desktop = device("desktop", MAC, {
      atlas: "/Users/maya/Work/atlas-api",
      diary: "/Users/maya/personal/diary",
      volume: "/Volumes/Archive/work",
    });
    await laptop.sync();
    await desktop.sync();
    // The same external id on each device is two documents, each in its own stream.
    expect(visible("share", id("/home/maya/work"))).toEqual([
      "desktop/atlas",
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/billing",
    ]);
    expect(visible("hide", id("/home/maya/personal"))).toEqual([
      "desktop/atlas",
      "desktop/volume",
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/bench",
      "laptop/billing",
      "laptop/scratch",
    ]);
    // A folder outside both homes belongs to whichever device has it.
    expect(visible("share", id("/Volumes/Archive", MAC))).toEqual(["desktop/volume"]);
    // One device publishing again leaves the other's documents where they were.
    await laptop.sync();
    expect(visible("share", id("/home/maya/personal"))).toEqual(["desktop/diary", "laptop/garden"]);
    expect(
      db.prepare("SELECT count(*) AS n FROM scope_hierarchy_nodes WHERE deleted=1").get(),
    ).toEqual({ n: 0 });
  });

  it("when the gateway forgets its facts, each device's documents return as that device publishes again", async () => {
    const laptop = device("laptop", LINUX, laptopFiles());
    const desktop = device("desktop", MAC, { diary: "/Users/maya/personal/diary" });
    await laptop.sync();
    await desktop.sync();
    expect(visible("share", id("/home/maya"))).toHaveLength(6);

    restartEveryNativeScopeRefresh(db);
    const epoch = sourceScopeRefreshState(db, sourceId).epochs.folder;
    expect(epoch).toBeTruthy();
    expect(visible("share", id("/home/maya"))).toEqual([]);
    expect(visible("hide", id("/srv/never"))).toEqual([]);

    await laptop.sync();
    // The laptop answered the refresh; the desktop's document has no proof under it yet.
    expect(sourceScopeRefreshState(db, sourceId).epochs.folder).toBe(epoch);
    expect(
      db
        .prepare("SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind='folder'")
        .get(sourceId),
    ).toEqual({ active: 0 });
    expect(visible("share", id("/home/maya"))).toEqual([
      "laptop/atlas",
      "laptop/atlas-core",
      "laptop/bench",
      "laptop/billing",
      "laptop/garden",
    ]);
    expect(visible("hide", id("/home/maya/work"))).not.toContain("desktop/diary");

    await desktop.sync();
    // Answering it a second time neither rotates the epoch nor withdraws the first answer.
    expect(sourceScopeRefreshState(db, sourceId).epochs.folder).toBe(epoch);
    expect(visible("share", id("/home/maya/personal"))).toEqual(["desktop/diary", "laptop/garden"]);
    expect(visible("share", id("/home/maya/work"))).toHaveLength(3);
  });

  it("the bookmark travels in the cursor the gateway stores", async () => {
    const laptop = device("laptop", LINUX, laptopFiles());
    await laptop.sync();
    const row = db
      .prepare<[string], { cursor: string }>("SELECT cursor FROM sync_state WHERE source_id=?")
      .get(sourceId)!;
    expect(JSON.parse(row.cursor)[PATH_SCOPE_CURSOR_KEY]).toMatchObject({
      version: 1,
      completed: true,
      actorId: "laptop",
    });
  });
});
