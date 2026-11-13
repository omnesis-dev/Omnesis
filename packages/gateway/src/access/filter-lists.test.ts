// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publishing a list through the source's stored profile: the profile decides
 * whether a field has a list at all, whose device it belongs to, and what an
 * item of it may carry. All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSourceDocumentProfilesTable,
  upsertSourceDocumentProfiles,
} from "../data/repositories/SourceDocumentProfileRepository.js";
import {
  createSourceFilterListTables,
  stageFilterListPart,
  type StageFilterListPartArgs,
} from "../data/repositories/SourceFilterListRepository.js";
import {
  filterListDigestsFor,
  getFilterListItems,
  getFilterListMembers,
  getFilterListVersion,
  publishFilterLists,
} from "./filter-lists.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { FilterListPublication } from "@omnesis/types";

let db: Database.Database;

const SOURCE = "ledger:northstar";

beforeEach(() => {
  db = new Database(":memory:");
  createSourceDocumentProfilesTable(db);
  createSourceFilterListTables(db);
  db.exec("CREATE TABLE removed_sources (id TEXT PRIMARY KEY)");
  upsertSourceDocumentProfiles(
    db,
    [
      {
        sourceType: "ledger",
        outputRevision: 1,
        profile: {
          documentTypes: ["entry"],
          personRoles: [],
          metadataFields: [
            {
              path: "extra.labelIds",
              type: "string-array",
              description: "Label ids.",
              filter: {
                capability: "membership",
                minVersion: 0,
                scope: "global",
                noun: { one: "label", many: "labels" },
                picker: "search",
              },
            },
            {
              path: "extra.chatId",
              type: "string",
              description: "Chat id.",
              filter: {
                capability: "membership",
                minVersion: 0,
                scope: "global",
                noun: { one: "chat", many: "chats" },
                picker: "search",
                listsMembers: true,
              },
            },
            {
              path: "extra.directory",
              type: "string",
              description: "Directory.",
              filter: {
                capability: "tree",
                minVersion: 0,
                scope: "device",
                noun: { one: "folder", many: "folders" },
                picker: "tree",
              },
            },
            {
              path: "extra.region",
              type: "string",
              description: "Region.",
              filter: {
                capability: "radius",
                minVersion: 0,
                scope: "global",
                noun: { one: "region", many: "regions" },
                picker: "search",
              },
            },
            { path: "extra.threadId", type: "string", description: "Thread id." },
          ],
        } as unknown as DocumentEventProfile,
      },
    ],
    1000,
  );
});

afterEach(() => db.close());

const deps = () => ({
  db,
  now: () => 5000,
  writeGate: {
    stageFilterListPart: async (args: Omit<StageFilterListPartArgs, "resume">) => {
      const result = stageFilterListPart(db, args);
      if (result.kind !== "done") throw new Error("unexpected yield");
      return result.outcome;
    },
  },
});

const digestOf = (name: string): string => name.padEnd(64, "0").replace(/[^0-9a-f]/g, "a");

const list = (
  field: string,
  name: string,
  items: FilterListPublication["items"],
): FilterListPublication => ({ field, digest: digestOf(name), part: 0, final: true, items });

const HOLDER = { streamId: "", holder: true };

describe("publishFilterLists", () => {
  it("stores a list for a field the profile marks as filterable", async () => {
    const receipts = await publishFilterLists(
      deps(),
      SOURCE,
      [list("extra.labelIds", "v1", [{ id: "l-finance", label: "Finance" }])],
      HOLDER,
    );
    expect(receipts).toEqual([
      { field: "extra.labelIds", digest: digestOf("v1"), part: 0, outcome: "published" },
    ]);
    const key = { sourceId: SOURCE, field: "extra.labelIds", deviceId: "" };
    expect(getFilterListVersion(db, key)).toMatchObject({ publishedAt: 5000, itemCount: 1 });
  });

  it.each([
    ["a field that is not filterable", "extra.threadId"],
    ["a field the profile does not have", "extra.unknown"],
    ["a field whose capability this gateway does not have", "extra.region"],
  ])("does not store a list for %s", async (_name, field) => {
    const receipts = await publishFilterLists(
      deps(),
      SOURCE,
      [list(field, "v1", [{ id: "x", label: "X" }])],
      HOLDER,
    );
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(["undeclared"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_filter_lists").get()).toEqual({ n: 0 });
  });

  it("does not store a list for a source whose type has no published profile", async () => {
    const receipts = await publishFilterLists(
      deps(),
      "almanac:northstar",
      [list("extra.labelIds", "v1", [])],
      HOLDER,
    );
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(["undeclared"]);
  });

  it("answers for every list on the page, in order, and stores the ones it can", async () => {
    const receipts = await publishFilterLists(
      deps(),
      SOURCE,
      [
        list("extra.labelIds", "labels", [{ id: "l-1", label: "One" }]),
        list("extra.unknown", "unknown", []),
        list("extra.chatId", "chats", [{ id: "c-1", label: "Chat" }]),
      ],
      HOLDER,
    );
    expect(receipts.map((receipt) => [receipt.field, receipt.outcome])).toEqual([
      ["extra.labelIds", "published"],
      ["extra.unknown", "undeclared"],
      ["extra.chatId", "published"],
    ]);
  });

  it("keeps members only where the field lists them, and a parent only in a tree", async () => {
    const members = [{ type: "email" as const, value: "maya.reeves@example.com" }];
    await publishFilterLists(
      deps(),
      SOURCE,
      [
        list("extra.chatId", "chats", [{ id: "c-1", label: "Chat", members, parentId: "c-0" }]),
        list("extra.labelIds", "labels", [{ id: "l-1", label: "Label", members }]),
      ],
      HOLDER,
    );
    const chats = { sourceId: SOURCE, field: "extra.chatId", deviceId: "" };
    const labels = { sourceId: SOURCE, field: "extra.labelIds", deviceId: "" };
    expect(getFilterListMembers(db, chats, "c-1")).toEqual(members);
    expect(getFilterListItems(db, chats, ["c-1"]).get("c-1")?.parentId).toBeNull();
    expect(getFilterListMembers(db, labels, "l-1")).toEqual([]);
  });

  it("files a list whose ids belong to a device under the publishing device", async () => {
    const folders = (name: string, id: string) =>
      list("extra.directory", name, [{ id, label: id }]);
    await publishFilterLists(deps(), SOURCE, [folders("laptop", "/home/maya/work")], {
      streamId: "dev-laptop",
      holder: true,
    });
    await publishFilterLists(deps(), SOURCE, [folders("desktop", "/srv/atlas-api")], {
      streamId: "dev-desktop",
      holder: true,
    });
    const on = (deviceId: string) => ({ sourceId: SOURCE, field: "extra.directory", deviceId });
    expect([
      ...getFilterListItems(db, on("dev-laptop"), ["/home/maya/work", "/srv/atlas-api"]).keys(),
    ]).toEqual(["/home/maya/work"]);
    expect([
      ...getFilterListItems(db, on("dev-desktop"), ["/home/maya/work", "/srv/atlas-api"]).keys(),
    ]).toEqual(["/srv/atlas-api"]);
    expect(getFilterListVersion(db, on(""))).toBeNull();
  });

  it("files a list every device shares under no device, whoever publishes it", async () => {
    await publishFilterLists(deps(), SOURCE, [list("extra.labelIds", "v1", [])], {
      streamId: "dev-laptop",
      holder: true,
    });
    expect(
      getFilterListVersion(db, { sourceId: SOURCE, field: "extra.labelIds", deviceId: "" }),
    ).not.toBeNull();
  });

  it("takes a shared list only from the device holding the source's lease, and a device's own list from any", async () => {
    const receipts = await publishFilterLists(
      deps(),
      SOURCE,
      [
        list("extra.labelIds", "labels", [{ id: "l-1", label: "One" }]),
        list("extra.directory", "folders", [{ id: "/a", label: "a" }]),
      ],
      { streamId: "dev-laptop", holder: false },
    );
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(["not-holder", "published"]);
  });
});

describe("filterListDigestsFor", () => {
  it("reports nothing before any list is published", () => {
    expect(filterListDigestsFor(db, SOURCE, "")).toEqual({});
  });

  it("gives each device the shared lists and its own, never another device's", async () => {
    await publishFilterLists(deps(), SOURCE, [list("extra.labelIds", "labels", [])], HOLDER);
    await publishFilterLists(deps(), SOURCE, [list("extra.directory", "laptop", [])], {
      streamId: "dev-laptop",
      holder: true,
    });
    expect(filterListDigestsFor(db, SOURCE, "dev-laptop")).toEqual({
      "extra.labelIds": digestOf("labels"),
      "extra.directory": digestOf("laptop"),
    });
    expect(filterListDigestsFor(db, SOURCE, "dev-desktop")).toEqual({
      "extra.labelIds": digestOf("labels"),
    });
  });

  it("stops reporting a list once the profile no longer marks its field as filterable", async () => {
    await publishFilterLists(deps(), SOURCE, [list("extra.labelIds", "labels", [])], HOLDER);
    upsertSourceDocumentProfiles(
      db,
      [
        {
          sourceType: "ledger",
          outputRevision: 2,
          profile: { documentTypes: ["entry"], personRoles: [], metadataFields: [] },
        },
      ],
      2000,
    );
    expect(filterListDigestsFor(db, SOURCE, "")).toEqual({});
  });
});
