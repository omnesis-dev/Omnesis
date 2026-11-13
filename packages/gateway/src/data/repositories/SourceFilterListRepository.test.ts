// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The store of published filter lists: a new version replaces the old one in
 * a single step, however many pages and sub-batches it took to write, and a
 * reader only ever sees one whole version. All fixture data is invented.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSourceFilterListTables,
  deleteFilterLists,
  getFilterListAncestors,
  getFilterListDescendants,
  getFilterListItems,
  getFilterListMembers,
  getFilterListVersion,
  listFilterListDigests,
  listFilterListItemsByParent,
  stageFilterListPart,
  sweepFilterListRows,
  type FilterListKey,
  type FilterListStagedRow,
  type StageFilterListPartArgs,
} from "./SourceFilterListRepository.js";
import type { FilterListOutcome } from "@omnesis/types";

let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = open();
  createSourceFilterListTables(db);
  db.exec("CREATE TABLE removed_sources (id TEXT PRIMARY KEY)");
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function open(): Database.Database {
  const handle = new Database(path);
  handle.pragma("journal_mode = WAL");
  return handle;
}

const FOLDERS: FilterListKey = {
  sourceId: "filing:northstar",
  field: "extra.folderIds",
  deviceId: "",
};
const GROUPS: FilterListKey = {
  sourceId: "filing:northstar",
  field: "extra.groupId",
  deviceId: "",
};

const digestOf = (name: string): string => name.padEnd(64, "0").replace(/[^0-9a-f]/g, "a");

const item = (id: string, label: string, parentId: string | null = null): FilterListStagedRow => [
  "item",
  id,
  parentId,
  label,
];

const TREE: FilterListStagedRow[] = [
  item("f-work", "Work"),
  item("f-atlas", "Atlas API", "f-work"),
  item("f-budget", "Budget", "f-work"),
  item("f-home", "Home"),
  item("f-receipts", "Receipts", "f-home"),
  item("f-receipts-2026", "2026", "f-receipts"),
];

/** Apply one page to the end, following every yield, and return its outcome. */
function stage(
  args: Omit<StageFilterListPartArgs, "now" | "resume"> & { now?: number },
  options: { batchRows?: number } = {},
  handle: Database.Database = db,
): FilterListOutcome {
  let resume: StageFilterListPartArgs["resume"];
  for (;;) {
    const result = stageFilterListPart(handle, { now: 1000, ...args, resume }, options);
    if (result.kind === "done") return result.outcome;
    resume = result.resume;
  }
}

/** Publish a whole list in one page. */
function publish(key: FilterListKey, name: string, rows: FilterListStagedRow[], now = 1000) {
  return stage({ key, digest: digestOf(name), part: 0, final: true, rows, now });
}

const rootsOf = (key: FilterListKey, handle: Database.Database = db) =>
  listFilterListItemsByParent(handle, key, null, { limit: 100 }).map((entry) => entry.id);

const rowCount = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("publishing a list", () => {
  it("stores a list sent as one page and reports its version", () => {
    expect(getFilterListVersion(db, FOLDERS)).toBeNull();
    expect(publish(FOLDERS, "v1", TREE, 4242)).toBe("published");
    expect(getFilterListVersion(db, FOLDERS)).toEqual({
      generation: 1,
      digest: digestOf("v1"),
      itemCount: 6,
      publishedAt: 4242,
    });
    expect(rootsOf(FOLDERS)).toEqual(["f-home", "f-work"]);
  });

  it("changes nothing when the digest is the one already published", () => {
    publish(FOLDERS, "v1", TREE, 1000);
    const before = db.prepare("SELECT * FROM source_filter_lists").all();
    const items = db.prepare("SELECT * FROM source_filter_items").all();
    // Even with different rows: the digest is the list's identity.
    expect(publish(FOLDERS, "v1", [item("f-other", "Other")], 2000)).toBe("current");
    expect(db.prepare("SELECT * FROM source_filter_lists").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM source_filter_items").all()).toEqual(items);
  });

  it("stores an empty list as published and empty, not as never published", () => {
    expect(publish(FOLDERS, "empty", [])).toBe("published");
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ generation: 1, itemCount: 0 });
    expect(rootsOf(FOLDERS)).toEqual([]);
  });

  it("drops the items a new version no longer lists", () => {
    publish(FOLDERS, "v1", TREE);
    publish(
      FOLDERS,
      "v2",
      TREE.filter((row) => row[1] !== "f-budget"),
    );
    expect(getFilterListItems(db, FOLDERS, ["f-budget", "f-atlas"])).toEqual(
      new Map([["f-atlas", { id: "f-atlas", label: "Atlas API", parentId: "f-work" }]]),
    );
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ generation: 2, itemCount: 5 });
  });

  it("shows a rename and a move from the version that carries them", () => {
    publish(FOLDERS, "v1", TREE);
    publish(FOLDERS, "v2", [
      ...TREE.filter((row) => row[1] !== "f-atlas" && row[1] !== "f-work"),
      item("f-work", "Office"),
      item("f-atlas", "Atlas API", "f-home"),
    ]);
    expect(getFilterListItems(db, FOLDERS, ["f-work", "f-atlas"])).toEqual(
      new Map([
        ["f-work", { id: "f-work", label: "Office", parentId: null }],
        ["f-atlas", { id: "f-atlas", label: "Atlas API", parentId: "f-home" }],
      ]),
    );
  });

  it("refuses to bring back the list of a source that was removed", () => {
    db.prepare("INSERT INTO removed_sources (id) VALUES (?)").run(FOLDERS.sourceId);
    expect(publish(FOLDERS, "v1", TREE)).toBe("superseded");
    expect(rowCount("source_filter_lists")).toBe(0);
    expect(rowCount("source_filter_items")).toBe(0);
  });
});

describe("a list sent over several pages", () => {
  const page = (part: number, final: boolean, rows: FilterListStagedRow[], name = "v2") => ({
    key: FOLDERS,
    digest: digestOf(name),
    part,
    final,
    rows,
  });

  it("is published by its last page and holds every page's items", () => {
    expect(stage(page(0, false, TREE.slice(0, 2)))).toBe("staged");
    expect(stage(page(1, false, TREE.slice(2, 4)))).toBe("staged");
    expect(getFilterListVersion(db, FOLDERS)).toBeNull();
    expect(stage(page(2, true, TREE.slice(4)))).toBe("published");
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ generation: 1, itemCount: 6 });
    expect(getFilterListDescendants(db, FOLDERS, "f-home", 100).ids.sort()).toEqual([
      "f-receipts",
      "f-receipts-2026",
    ]);
  });

  it("keeps serving the published version until the last page arrives", () => {
    publish(FOLDERS, "v1", TREE);
    stage(page(0, false, [item("f-new", "New")]));
    stage(page(1, false, [item("f-newer", "Newer")]));
    expect(rootsOf(FOLDERS)).toEqual(["f-home", "f-work"]);
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ digest: digestOf("v1") });
    stage(page(2, true, []));
    expect(rootsOf(FOLDERS)).toEqual(["f-new", "f-newer"]);
  });

  it("acknowledges a page it already applied and refuses one that skips ahead", () => {
    stage(page(0, false, TREE.slice(0, 2)));
    stage(page(1, false, TREE.slice(2, 4)));
    expect(stage(page(0 + 1, false, TREE.slice(2, 4)))).toBe("staged");
    expect(stage(page(3, true, []))).toBe("out-of-sequence");
    expect(stage(page(2, true, TREE.slice(4)))).toBe("published");
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ itemCount: 6 });
  });

  it("refuses a later page of a list whose first page it never saw", () => {
    expect(stage(page(1, true, TREE))).toBe("out-of-sequence");
    expect(rowCount("source_filter_items")).toBe(0);
  });

  it("starts over when page 0 arrives again, without mixing in the abandoned pages", () => {
    stage(page(0, false, [item("f-abandoned", "Abandoned")]));
    stage(page(0, false, TREE.slice(0, 3)));
    stage(page(1, true, TREE.slice(3)));
    expect(getFilterListItems(db, FOLDERS, ["f-abandoned"]).size).toBe(0);
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ itemCount: 6 });
  });

  it("gives up the version being written when a different digest starts", () => {
    publish(FOLDERS, "v1", TREE);
    stage(page(0, false, [item("f-two", "Two")], "v2"));
    stage(page(0, false, [item("f-three", "Three")], "v3"));
    // The interrupted publication's next page no longer has anything to join.
    expect(stage(page(1, true, [], "v2"))).toBe("out-of-sequence");
    expect(rootsOf(FOLDERS)).toEqual(["f-home", "f-work"]);
    expect(stage(page(1, true, [], "v3"))).toBe("published");
    expect(rootsOf(FOLDERS)).toEqual(["f-three"]);
  });

  it("abandons the version being written when the published digest is sent again", () => {
    publish(FOLDERS, "v1", TREE);
    stage(page(0, false, [item("f-two", "Two")], "v2"));
    expect(publish(FOLDERS, "v1", TREE)).toBe("current");
    expect(stage(page(1, true, [], "v2"))).toBe("out-of-sequence");
    expect(rootsOf(FOLDERS)).toEqual(["f-home", "f-work"]);
  });

  it("carries on after the gateway restarts between two pages", () => {
    publish(FOLDERS, "v1", TREE);
    stage(page(0, false, [item("f-new", "New")]));
    db.close();
    db = open();
    expect(rootsOf(FOLDERS)).toEqual(["f-home", "f-work"]);
    expect(stage(page(1, true, [item("f-newer", "Newer")]))).toBe("published");
    expect(rootsOf(FOLDERS)).toEqual(["f-new", "f-newer"]);
  });
});

describe("bounded writes", () => {
  it("writes a page in sub-batches and hands the writer back between them", () => {
    const rows = Array.from({ length: 10 }, (_, i) => item(`f-${i}`, `Folder ${i}`));
    const args = { key: FOLDERS, digest: digestOf("v1"), part: 0, final: true, rows, now: 1000 };
    const steps: number[] = [];
    let result = stageFilterListPart(db, args, { batchRows: 4, shouldYield: () => true });
    while (result.kind === "yield") {
      steps.push(rowCount("source_filter_items"));
      // Nothing is readable while the page is half written.
      expect(getFilterListVersion(db, FOLDERS)).toBeNull();
      result = stageFilterListPart(
        db,
        { ...args, resume: result.resume },
        { batchRows: 4, shouldYield: () => true },
      );
    }
    expect(steps).toEqual([4, 8]);
    expect(result).toEqual({ kind: "done", outcome: "published" });
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ itemCount: 10 });
  });

  it("counts members as rows of a sub-batch", () => {
    const rows: FilterListStagedRow[] = [
      item("g-team", "Atlas team"),
      ["member", "g-team", "email", "maya.reeves@example.com"],
      ["member", "g-team", "email", "jamie.lopez@example.com"],
      ["member", "g-team", "phone", "+15550100142"],
    ];
    const args = { key: GROUPS, digest: digestOf("v1"), part: 0, final: true, rows, now: 1000 };
    const first = stageFilterListPart(db, args, { batchRows: 2, shouldYield: () => true });
    expect(first).toEqual({ kind: "yield", resume: { stagingGeneration: 1, offset: 2 } });
    expect(rowCount("source_filter_item_members")).toBe(1);
  });

  it("stops a resumed page when another publication started while it had yielded", () => {
    const rows = Array.from({ length: 6 }, (_, i) => item(`f-${i}`, `Folder ${i}`));
    const args = { key: FOLDERS, digest: digestOf("v1"), part: 0, final: true, rows, now: 1000 };
    const first = stageFilterListPart(db, args, { batchRows: 2, shouldYield: () => true });
    expect(first.kind).toBe("yield");
    expect(publish(FOLDERS, "v2", [item("f-other", "Other")])).toBe("published");
    const resumed = stageFilterListPart(
      db,
      { ...args, resume: (first as { resume: StageFilterListPartArgs["resume"] }).resume },
      { batchRows: 2 },
    );
    expect(resumed).toEqual({ kind: "done", outcome: "superseded" });
    expect(rootsOf(FOLDERS)).toEqual(["f-other"]);
  });

  it("applies an interrupted page again whole after a restart", () => {
    const rows = Array.from({ length: 6 }, (_, i) => item(`f-${i}`, `Folder ${i}`));
    const args = { key: FOLDERS, digest: digestOf("v1"), part: 0, final: true, rows, now: 1000 };
    expect(stageFilterListPart(db, args, { batchRows: 2, shouldYield: () => true }).kind).toBe(
      "yield",
    );
    db.close();
    db = open();
    expect(getFilterListVersion(db, FOLDERS)).toBeNull();
    // The collector never got an answer, so it sends the page again.
    expect(stage(args)).toBe("published");
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ itemCount: 6 });
    expect(rootsOf(FOLDERS)).toHaveLength(6);
  });
});

describe("a reader during a publication", () => {
  it("sees the old list or the new one, never a mix, on another connection", () => {
    publish(FOLDERS, "v1", TREE);
    const reader = open();
    try {
      const args = {
        key: FOLDERS,
        digest: digestOf("v2"),
        part: 0,
        final: true,
        rows: Array.from({ length: 9 }, (_, i) => item(`n-${i}`, `New ${i}`)),
        now: 2000,
      };
      const seen: string[][] = [];
      let result = stageFilterListPart(db, args, { batchRows: 2, shouldYield: () => true });
      seen.push(rootsOf(FOLDERS, reader));
      while (result.kind === "yield") {
        result = stageFilterListPart(
          db,
          { ...args, resume: result.resume },
          { batchRows: 2, shouldYield: () => true },
        );
        seen.push(rootsOf(FOLDERS, reader));
      }
      const oldRoots = ["f-home", "f-work"];
      const newRoots = Array.from({ length: 9 }, (_, i) => `n-${i}`);
      expect(seen.length).toBeGreaterThan(3);
      for (const roots of seen.slice(0, -1)) expect(roots).toEqual(oldRoots);
      expect(seen[seen.length - 1]).toEqual(newRoots);
    } finally {
      reader.close();
    }
  });

  it("keeps a read that began before the switch on the version it began with", () => {
    publish(FOLDERS, "v1", TREE);
    const reader = open();
    try {
      reader.exec("BEGIN");
      expect(rootsOf(FOLDERS, reader)).toEqual(["f-home", "f-work"]);
      publish(FOLDERS, "v2", [item("f-only", "Only")]);
      // The sweep may run before the reader finishes; its snapshot still holds the rows.
      expect(sweepFilterListRows(db, null, 1000).deleted).toBe(6);
      expect(rootsOf(FOLDERS, reader)).toEqual(["f-home", "f-work"]);
      expect(getFilterListDescendants(reader, FOLDERS, "f-work", 10).ids.sort()).toEqual([
        "f-atlas",
        "f-budget",
      ]);
      reader.exec("COMMIT");
      expect(rootsOf(FOLDERS, reader)).toEqual(["f-only"]);
    } finally {
      reader.close();
    }
  });
});

describe("reading a list", () => {
  beforeEach(() => {
    publish(FOLDERS, "v1", TREE);
  });

  it("lists the items under a parent in id order, a page at a time", () => {
    expect(listFilterListItemsByParent(db, FOLDERS, "f-work", { limit: 1 })).toEqual([
      { id: "f-atlas", label: "Atlas API", parentId: "f-work" },
    ]);
    expect(
      listFilterListItemsByParent(db, FOLDERS, "f-work", { limit: 10, after: "f-atlas" }),
    ).toEqual([{ id: "f-budget", label: "Budget", parentId: "f-work" }]);
    expect(listFilterListItemsByParent(db, FOLDERS, "f-atlas", { limit: 10 })).toEqual([]);
  });

  it("reads through the parent index", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT i.item_id FROM source_filter_lists l
           JOIN source_filter_items i INDEXED BY idx_source_filter_items_parent
             ON i.source_id = l.source_id AND i.field = l.field AND i.device_id = l.device_id
            AND i.generation = l.generation
          WHERE l.source_id = ? AND l.field = ? AND l.device_id = ? AND i.parent_id IS ?
            AND i.item_id > ? ORDER BY i.item_id LIMIT 10`,
      )
      .all("s", "f", "", null, "") as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_source_filter_items_parent");
    expect(details).not.toContain("SCAN i");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("walks up from an item to its root, nearest first", () => {
    expect(getFilterListAncestors(db, FOLDERS, "f-receipts-2026")).toEqual({
      ids: ["f-receipts", "f-home"],
      complete: true,
    });
    expect(getFilterListAncestors(db, FOLDERS, "f-work")).toEqual({ ids: [], complete: true });
  });

  it("says the chain is not known for an item the list does not hold", () => {
    expect(getFilterListAncestors(db, FOLDERS, "f-gone")).toEqual({ ids: [], complete: false });
  });

  it("says the chain is not known when a parent is missing or the chain loops", () => {
    publish(FOLDERS, "broken", [
      item("f-orphan", "Orphan", "f-missing"),
      item("f-a", "A", "f-b"),
      item("f-b", "B", "f-a"),
    ]);
    expect(getFilterListAncestors(db, FOLDERS, "f-orphan")).toEqual({ ids: [], complete: false });
    expect(getFilterListAncestors(db, FOLDERS, "f-a").complete).toBe(false);
    expect(getFilterListDescendants(db, FOLDERS, "f-a", 10).ids.sort()).toEqual(["f-a", "f-b"]);
  });

  it("collects everything beneath an item and says when there is more than asked for", () => {
    expect(getFilterListDescendants(db, FOLDERS, "f-home", 10)).toEqual({
      ids: ["f-receipts", "f-receipts-2026"],
      truncated: false,
    });
    const capped = getFilterListDescendants(db, FOLDERS, "f-home", 1);
    expect(capped.ids).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(getFilterListDescendants(db, FOLDERS, "f-atlas", 10)).toEqual({
      ids: [],
      truncated: false,
    });
  });

  it("looks labels up by id and leaves out ids the list does not hold", () => {
    const found = getFilterListItems(db, FOLDERS, ["f-budget", "f-gone", "f-home"]);
    expect([...found.keys()].sort()).toEqual(["f-budget", "f-home"]);
    expect(found.get("f-budget")?.label).toBe("Budget");
  });

  it("returns the members of an item at the published version only", () => {
    const team = (members: string[]): FilterListStagedRow[] => [
      item("g-team", "Atlas team"),
      ...members.map((value): FilterListStagedRow => ["member", "g-team", "email", value]),
      item("g-household", "Household"),
      ["member", "g-household", "phone", "+15550100142"],
    ];
    publish(GROUPS, "v1", team(["maya.reeves@example.com", "jamie.lopez@example.com"]));
    expect(getFilterListMembers(db, GROUPS, "g-team")).toEqual([
      { type: "email", value: "jamie.lopez@example.com" },
      { type: "email", value: "maya.reeves@example.com" },
    ]);
    publish(GROUPS, "v2", team(["maya.reeves@example.com"]));
    expect(getFilterListMembers(db, GROUPS, "g-team")).toEqual([
      { type: "email", value: "maya.reeves@example.com" },
    ]);
    expect(getFilterListMembers(db, GROUPS, "g-household")).toEqual([
      { type: "phone", value: "+15550100142" },
    ]);
    expect(getFilterListMembers(db, GROUPS, "g-gone")).toEqual([]);
  });
});

describe("lists of several devices and sources", () => {
  const laptop: FilterListKey = { ...FOLDERS, deviceId: "dev-laptop" };
  const desktop: FilterListKey = { ...FOLDERS, deviceId: "dev-desktop" };

  it("keeps each device's list apart, though the ids are the same", () => {
    publish(laptop, "laptop", [item("/home/maya/work", "work")]);
    publish(desktop, "desktop", [
      item("/home/maya/work", "work"),
      item("/home/maya/work/atlas-api", "atlas-api", "/home/maya/work"),
    ]);
    expect(getFilterListDescendants(db, laptop, "/home/maya/work", 10).ids).toEqual([]);
    expect(getFilterListDescendants(db, desktop, "/home/maya/work", 10).ids).toEqual([
      "/home/maya/work/atlas-api",
    ]);
    publish(laptop, "laptop-2", []);
    expect(rootsOf(laptop)).toEqual([]);
    expect(rootsOf(desktop)).toEqual(["/home/maya/work"]);
    expect(rootsOf(FOLDERS)).toEqual([]);
  });

  it("reports the digest of every published list of a source, and none being written", () => {
    publish(laptop, "laptop", []);
    publish(GROUPS, "groups", []);
    stage({ key: desktop, digest: digestOf("desktop"), part: 0, final: false, rows: [] });
    publish({ ...FOLDERS, sourceId: "filing:other" }, "other", []);
    expect(
      listFilterListDigests(db, FOLDERS.sourceId).sort((a, b) => a.field.localeCompare(b.field)),
    ).toEqual([
      { field: "extra.folderIds", deviceId: "dev-laptop", digest: digestOf("laptop") },
      { field: "extra.groupId", deviceId: "", digest: digestOf("groups") },
    ]);
  });

  it("forgets one device's lists and leaves the rest readable", () => {
    publish(laptop, "laptop", [item("/a", "a")]);
    publish(desktop, "desktop", [item("/b", "b")]);
    publish(GROUPS, "groups", [item("g-team", "Atlas team")]);
    expect(deleteFilterLists(db, FOLDERS.sourceId, "dev-laptop")).toBe(1);
    expect(rootsOf(laptop)).toEqual([]);
    expect(getFilterListVersion(db, laptop)).toBeNull();
    expect(rootsOf(desktop)).toEqual(["/b"]);
    expect(rootsOf(GROUPS)).toEqual(["g-team"]);
  });

  it("forgets every list of a source and no other source's", () => {
    const other: FilterListKey = { ...FOLDERS, sourceId: "filing:other" };
    publish(laptop, "laptop", [item("/a", "a")]);
    publish(GROUPS, "groups", [item("g-team", "Atlas team")]);
    publish(other, "other", [item("f-1", "One")]);
    expect(deleteFilterLists(db, FOLDERS.sourceId)).toBe(2);
    expect(listFilterListDigests(db, FOLDERS.sourceId)).toEqual([]);
    expect(rootsOf(laptop)).toEqual([]);
    expect(rootsOf(other)).toEqual(["f-1"]);
  });

  it("does not let a list published again share rows with one forgotten before the sweep ran", () => {
    publish(FOLDERS, "v1", TREE);
    deleteFilterLists(db, FOLDERS.sourceId);
    expect(publish(FOLDERS, "v2", [item("f-only", "Only")])).toBe("published");
    expect(rootsOf(FOLDERS)).toEqual(["f-only"]);
    expect(getFilterListVersion(db, FOLDERS)).toMatchObject({ generation: 2, itemCount: 1 });
  });
});

describe("the sweep", () => {
  /** Run the sweep to the end of a pass, a bounded call at a time. */
  function sweepAll(limit: number): { deleted: number; calls: number } {
    let cursor: FilterListKey | null = null;
    let deleted = 0;
    let calls = 0;
    do {
      const result = sweepFilterListRows(db, cursor, limit);
      expect(result.deleted).toBeLessThanOrEqual(limit);
      deleted += result.deleted;
      cursor = result.cursor;
      calls++;
    } while (cursor !== null && calls < 1000);
    return { deleted, calls };
  }

  it("finds nothing to delete when every row is the published version", () => {
    publish(FOLDERS, "v1", TREE);
    publish(GROUPS, "v1", [
      item("g-team", "Atlas team"),
      ["member", "g-team", "email", "a@example.com"],
    ]);
    expect(sweepAll(100)).toEqual({ deleted: 0, calls: 1 });
    expect(rowCount("source_filter_items")).toBe(7);
  });

  it("deletes replaced versions in bounded calls and keeps the published one", () => {
    publish(FOLDERS, "v1", TREE);
    publish(FOLDERS, "v2", TREE);
    publish(FOLDERS, "v3", TREE.slice(0, 2));
    expect(rowCount("source_filter_items")).toBe(14);
    const { deleted, calls } = sweepAll(5);
    expect(deleted).toBe(12);
    expect(calls).toBeGreaterThan(2);
    expect(rowCount("source_filter_items")).toBe(2);
    expect(rootsOf(FOLDERS)).toEqual(["f-work"]);
  });

  it("deletes the members of replaced versions with their items", () => {
    const team = (member: string): FilterListStagedRow[] => [
      item("g-team", "Atlas team"),
      ["member", "g-team", "email", member],
    ];
    publish(GROUPS, "v1", team("a@example.com"));
    publish(GROUPS, "v2", team("b@example.com"));
    expect(sweepAll(1).deleted).toBe(2);
    expect(rowCount("source_filter_item_members")).toBe(1);
    expect(getFilterListMembers(db, GROUPS, "g-team")).toEqual([
      { type: "email", value: "b@example.com" },
    ]);
  });

  it("deletes an abandoned version but not the one being written", () => {
    publish(FOLDERS, "v1", TREE);
    stage({
      key: FOLDERS,
      digest: digestOf("v2"),
      part: 0,
      final: false,
      rows: [item("f-x", "X")],
    });
    stage({
      key: FOLDERS,
      digest: digestOf("v3"),
      part: 0,
      final: false,
      rows: [item("f-y", "Y")],
    });
    expect(sweepAll(100).deleted).toBe(1);
    expect(
      stage({
        key: FOLDERS,
        digest: digestOf("v3"),
        part: 1,
        final: true,
        rows: [item("f-z", "Z")],
      }),
    ).toBe("published");
    expect(rootsOf(FOLDERS)).toEqual(["f-y", "f-z"]);
  });

  it("deletes everything under a list that was forgotten", () => {
    const other: FilterListKey = { ...FOLDERS, sourceId: "filing:other" };
    publish(FOLDERS, "v1", TREE);
    publish(GROUPS, "v1", [
      item("g-team", "Atlas team"),
      ["member", "g-team", "email", "a@example.com"],
    ]);
    publish(other, "v1", [item("f-1", "One")]);
    deleteFilterLists(db, FOLDERS.sourceId);
    expect(sweepAll(3).deleted).toBe(8);
    expect(rowCount("source_filter_items")).toBe(1);
    expect(rowCount("source_filter_item_members")).toBe(0);
    expect(rootsOf(other)).toEqual(["f-1"]);
  });

  it("reaches every list across many calls when each looks at few", () => {
    for (let i = 0; i < 12; i++) {
      const key: FilterListKey = {
        ...FOLDERS,
        sourceId: `filing:account-${String(i).padStart(2, "0")}`,
      };
      publish(key, "v1", [item("f-old", "Old")]);
      publish(key, "v2", [item("f-new", "New")]);
    }
    expect(sweepAll(2).deleted).toBe(12);
    expect(rowCount("source_filter_items")).toBe(12);
  });
});
