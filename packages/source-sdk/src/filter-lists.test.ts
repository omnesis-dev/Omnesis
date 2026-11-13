// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list a source produces for a filterable field: its canonical form, its
 * digest, how it is cut into pages, and the one knob that decides how often
 * it is refreshed. All fixture data is invented.
 */

import { describe, expect, it } from "vitest";
import { FILTER_LIST_LIMITS, type FilterListItem } from "@omnesis/types";
import {
  FILTER_LIST_REFRESH,
  FilterListError,
  collectFilterList,
  filterListDigest,
  filterListRefreshDue,
  packFilterListPages,
  splitFilterList,
  withFilterLists,
} from "./filter-lists.js";
import type { SourceInstance } from "./define-source.js";

const context = () => ({ signal: new AbortController().signal });
const collect = (items: FilterListItem[]) => collectFilterList(() => items, context());

const FOLDERS: FilterListItem[] = [
  { id: "f-work", label: "Work" },
  { id: "f-atlas", label: "Atlas API", parentId: "f-work" },
  { id: "f-home", label: "Home" },
];

describe("collectFilterList", () => {
  it("sorts items by id whatever order the producer listed them in", async () => {
    expect((await collect(FOLDERS)).map((item) => item.id)).toEqual([
      "f-atlas",
      "f-home",
      "f-work",
    ]);
  });

  it("reads a producer that is a list, a promise of one, or an async generator", async () => {
    const fromPromise = await collectFilterList(async () => FOLDERS, context());
    const fromGenerator = await collectFilterList(async function* () {
      yield* FOLDERS;
    }, context());
    expect(fromPromise).toEqual(await collect(FOLDERS));
    expect(fromGenerator).toEqual(await collect(FOLDERS));
  });

  it("sorts and deduplicates the members of an item", async () => {
    const [chat] = await collect([
      {
        id: "c-1",
        label: "Atlas team",
        members: [
          { type: "phone", value: "+15550100142" },
          { type: "email", value: "maya.reeves@example.com" },
          { type: "email", value: "jamie.lopez@example.com" },
          { type: "email", value: "maya.reeves@example.com" },
        ],
      },
    ]);
    expect(chat?.members).toEqual([
      { type: "email", value: "jamie.lopez@example.com" },
      { type: "email", value: "maya.reeves@example.com" },
      { type: "phone", value: "+15550100142" },
    ]);
  });

  it("cuts an overlong label, which is only ever displayed", async () => {
    const [item] = await collect([{ id: "f-1", label: "x".repeat(2000) }]);
    expect(item?.label).toHaveLength(FILTER_LIST_LIMITS.labelLength);
  });

  it.each<[string, FilterListItem[]]>([
    ["an item listed twice", [FOLDERS[0]!, { id: "f-work", label: "Work again" }]],
    ["an empty id", [{ id: "", label: "Nameless" }]],
    ["an id over the bound", [{ id: "f".repeat(FILTER_LIST_LIMITS.idLength + 1), label: "Long" }]],
    ["an item that is its own parent", [{ id: "f-1", label: "Loop", parentId: "f-1" }]],
    ["a parent the list does not contain", [{ id: "f-1", label: "Orphan", parentId: "f-gone" }]],
    [
      "a cycle",
      [
        { id: "f-1", label: "One", parentId: "f-3" },
        { id: "f-2", label: "Two", parentId: "f-1" },
        { id: "f-3", label: "Three", parentId: "f-2" },
      ],
    ],
    [
      "a member of an unknown kind",
      [{ id: "c-1", label: "Chat", members: [{ type: "handle" as "email", value: "maya" }] }],
    ],
  ])("refuses %s", async (_name, items) => {
    await expect(collect(items)).rejects.toBeInstanceOf(FilterListError);
  });

  it("refuses an item with more members than one may carry, rather than dropping some", async () => {
    const members = Array.from({ length: FILTER_LIST_LIMITS.membersPerItem + 1 }, (_, i) => ({
      type: "email" as const,
      value: `member${i}@example.com`,
    }));
    await expect(collect([{ id: "c-1", label: "Everyone", members }])).rejects.toThrow(/members/);
  });

  it("passes on what the producer throws", async () => {
    await expect(
      collectFilterList(() => {
        throw new Error("the account could not be listed");
      }, context()),
    ).rejects.toThrow("the account could not be listed");
  });

  it("stops when the listing is aborted", async () => {
    const abort = new AbortController();
    const listing = collectFilterList(
      async function* () {
        yield FOLDERS[0]!;
        abort.abort(new Error("stopped"));
        yield FOLDERS[2]!;
      },
      { signal: abort.signal },
    );
    await expect(listing).rejects.toThrow("stopped");
  });
});

describe("filterListDigest", () => {
  it("is the same for the same list in any order", async () => {
    const forward = filterListDigest(await collect(FOLDERS));
    const backward = filterListDigest(await collect([...FOLDERS].reverse()));
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(backward).toBe(forward);
  });

  it("does not depend on the order or repetition of members", async () => {
    const a = await collect([
      {
        id: "c-1",
        label: "Chat",
        members: [
          { type: "email", value: "a@example.com" },
          { type: "email", value: "b@example.com" },
        ],
      },
    ]);
    const b = await collect([
      {
        id: "c-1",
        label: "Chat",
        members: [
          { type: "email", value: "b@example.com" },
          { type: "email", value: "a@example.com" },
          { type: "email", value: "b@example.com" },
        ],
      },
    ]);
    expect(filterListDigest(a)).toBe(filterListDigest(b));
  });

  it("treats an item with no members and one that lists none as the same", async () => {
    const without = await collect([{ id: "c-1", label: "Chat" }]);
    const empty = await collect([{ id: "c-1", label: "Chat", members: [] }]);
    expect(filterListDigest(without)).toBe(filterListDigest(empty));
  });

  it.each<[string, FilterListItem[]]>([
    ["a rename", [{ ...FOLDERS[0]!, label: "Office" }, FOLDERS[1]!, FOLDERS[2]!]],
    ["a move", [FOLDERS[0]!, { ...FOLDERS[1]!, parentId: "f-home" }, FOLDERS[2]!]],
    ["a move to the top level", [FOLDERS[0]!, { id: "f-atlas", label: "Atlas API" }, FOLDERS[2]!]],
    ["a deletion", [FOLDERS[0]!, FOLDERS[1]!]],
    ["an addition", [...FOLDERS, { id: "f-new", label: "New" }]],
  ])("changes with %s", async (_name, changed) => {
    expect(filterListDigest(await collect(changed))).not.toBe(
      filterListDigest(await collect(FOLDERS)),
    );
  });

  it("changes when a member joins", async () => {
    const before = await collect([{ id: "c-1", label: "Chat", members: [] }]);
    const after = await collect([
      { id: "c-1", label: "Chat", members: [{ type: "email", value: "a@example.com" }] },
    ]);
    expect(filterListDigest(after)).not.toBe(filterListDigest(before));
  });

  it("does not confuse a value that moved between two fields of an item", async () => {
    const a = await collect([
      { id: "x", label: "y" },
      { id: "z", label: "" },
    ]);
    const b = await collect([
      { id: "x", label: "" },
      { id: "z", label: "y" },
    ]);
    expect(filterListDigest(a)).not.toBe(filterListDigest(b));
  });

  it("gives an empty list a digest of its own", () => {
    expect(filterListDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("splitFilterList", () => {
  it("sends a short list as one final page", async () => {
    const items = await collect(FOLDERS);
    const parts = splitFilterList("extra.folderIds", items);
    expect(parts).toEqual([
      { field: "extra.folderIds", digest: filterListDigest(items), part: 0, final: true, items },
    ]);
  });

  it("sends an empty list as one empty final page, so the gateway learns nothing exists", () => {
    expect(splitFilterList("extra.folderIds", [])).toEqual([
      { field: "extra.folderIds", digest: filterListDigest([]), part: 0, final: true, items: [] },
    ]);
  });

  it("cuts a long list into numbered pages that share its digest and lose nothing", async () => {
    const count = FILTER_LIST_LIMITS.itemsPerPart * 2 + 5;
    const items = await collect(
      Array.from({ length: count }, (_, i) => ({
        id: `f-${String(i).padStart(6, "0")}`,
        label: "F",
      })),
    );
    const parts = splitFilterList("extra.folderIds", items);
    expect(parts.map((part) => part.part)).toEqual([0, 1, 2]);
    expect(parts.map((part) => part.final)).toEqual([false, false, true]);
    expect(new Set(parts.map((part) => part.digest))).toEqual(new Set([filterListDigest(items)]));
    expect(parts.map((part) => part.items.length)).toEqual([
      FILTER_LIST_LIMITS.itemsPerPart,
      FILTER_LIST_LIMITS.itemsPerPart,
      5,
    ]);
    expect(parts.flatMap((part) => part.items)).toEqual(items);
  });

  it("cuts by size as well as by count", async () => {
    // Forty items of about 50 KB each: far fewer than a page holds by count.
    const members = (i: number) =>
      Array.from({ length: 1000 }, (_, m) => ({
        type: "email" as const,
        value: `member-${i}-${m}@example.com`,
      }));
    const items = await collect(
      Array.from({ length: 40 }, (_, i) => ({ id: `c-${i}`, label: "Chat", members: members(i) })),
    );
    const parts = splitFilterList("extra.chatId", items);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(
        FILTER_LIST_LIMITS.partBytes,
      );
    }
    expect(parts.flatMap((part) => part.items)).toEqual(items);
  });
});

describe("packFilterListPages", () => {
  const page = (field: string, part = 0) => ({
    field,
    digest: "0".repeat(64),
    part,
    final: true,
    items: [],
  });

  it("puts the lists of several fields on one sync page", () => {
    const publications = [page("a"), page("b"), page("c")];
    expect(packFilterListPages(publications)).toEqual([publications]);
  });

  it("starts a new sync page at the count a gateway accepts, keeping the order", () => {
    const publications = Array.from(
      { length: FILTER_LIST_LIMITS.publicationsPerPage + 2 },
      (_, i) => page("a", i),
    );
    const pages = packFilterListPages(publications);
    expect(pages.map((batch) => batch.length)).toEqual([FILTER_LIST_LIMITS.publicationsPerPage, 2]);
    expect(pages.flat()).toEqual(publications);
  });

  it("starts a new sync page when the size bound is reached", () => {
    const big = (part: number) => ({
      ...page("a", part),
      items: [{ id: "f", label: "x".repeat(FILTER_LIST_LIMITS.partBytes * 0.6) }],
    });
    expect(packFilterListPages([big(0), big(1), big(2)]).map((batch) => batch.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it("sends nothing when there is nothing to send", () => {
    expect(packFilterListPages([])).toEqual([]);
  });
});

describe("the refresh cadence", () => {
  it("defaults to refreshing in every sync and sending only what changed", () => {
    expect(FILTER_LIST_REFRESH).toEqual({ mode: "every-sync-when-changed" });
    expect(filterListRefreshDue(undefined, 1000)).toBe(true);
    expect(filterListRefreshDue(999, 1000)).toBe(true);
  });

  it("can hold the producers back to an interval", () => {
    const refresh = { mode: "at-most-every", intervalMs: 60_000 } as const;
    expect(filterListRefreshDue(undefined, 1000, refresh)).toBe(true);
    expect(filterListRefreshDue(1000, 60_999, refresh)).toBe(false);
    expect(filterListRefreshDue(1000, 61_000, refresh)).toBe(true);
  });
});

describe("withFilterLists", () => {
  const instance = (): SourceInstance => ({
    sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  });

  it("attaches the producers to the instance it was given", () => {
    const source = instance();
    const producer = () => FOLDERS;
    expect(withFilterLists(source, { "extra.folderIds": producer })).toBe(source);
    expect(source.filterLists).toEqual({ "extra.folderIds": producer });
  });

  it("refuses more fields than a sync page can carry lists for", () => {
    const producers = Object.fromEntries(
      Array.from({ length: FILTER_LIST_LIMITS.publicationsPerPage + 1 }, (_, i) => [
        `extra.field${i}`,
        () => [],
      ]),
    );
    expect(() => withFilterLists(instance(), producers)).toThrow(FilterListError);
  });

  it("refuses an empty field path", () => {
    expect(() => withFilterLists(instance(), { "": () => [] })).toThrow(FilterListError);
  });
});
