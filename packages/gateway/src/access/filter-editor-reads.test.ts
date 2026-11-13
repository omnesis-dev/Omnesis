// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the filter editor reads: a field's entries by search and by tree
 * level, people, the count beside each entry, and the preview of a draft
 * filter. Every count is held against the real check. All fixture data is
 * invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILTER_OPTIONS_PAGE,
  countFilterEntries,
  filterPersonIdentifiers,
  readFilterOptions,
  readFilterPreview,
  shortFilterLabel,
  type FilterOption,
  type FilterOptionsRequest,
} from "./filter-editor-reads.js";
import { filterFieldsFor } from "./filter-fields.js";
import { compileSourceFilter, filterAllowSql } from "./filter-sql.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  chat,
  directory,
  folder,
  hide,
  insertDocument,
  label,
  openFilterFixture,
  person,
  publishList,
  publishProfile,
  shareOnly,
  tag,
  type FilterFixture,
} from "./filter-test-utils.js";
import type { Db } from "../data/types.js";
import type { FilterRef, SourceFilter } from "@omnesis/types";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const LAPTOP = "dev-laptop";
const DESKTOP = "dev-desktop";
const MAYA = "+15550100123";
const JAMIE = "+15550100456";

let fixture: FilterFixture;
let db: Db;

function entry(
  id: string,
  extra: Record<string, unknown>,
  options: { version?: number; streamId?: string; people?: unknown } = {},
): void {
  insertDocument(db, {
    id,
    sourceId: LEDGER,
    version: options.version ?? 3,
    streamId: options.streamId,
    metadata: {
      documentType: "entry",
      ...(options.people === undefined ? {} : { people: options.people }),
      extra,
    },
  });
}

function knownPerson(
  id: string,
  name: string,
  aliases: Array<[string, string]>,
  mergedInto?: string,
) {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, 'fixture', 'now', 'now', 'now', 'now')`,
  ).run(id, name, mergedInto ?? null);
  aliases.forEach(([type, alias], index) => {
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, ?, ?, 'now')",
    ).run(`${id}-alias-${index}`, id, alias, type);
  });
}

beforeEach(() => {
  fixture = openFilterFixture();
  db = fixture.db;
  for (const [id, name] of [
    [LAPTOP, "Studio Mac"],
    [DESKTOP, "Workshop PC"],
  ]) {
    db.prepare("INSERT INTO devices (id, name, kind, paired_at) VALUES (?, ?, 'collector', 1)").run(
      id,
      name,
    );
  }
  for (const id of [LEDGER, PARLEY]) {
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`,
    ).run(id, id.split(":")[0], id.split(":")[1], LAPTOP);
  }
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
  publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, [
    { id: "L-finance", label: "Finance" },
    { id: "L-clients", label: "Clients" },
    { id: "L-archive", label: "archive" },
    { id: "L-percent", label: "100% done_list" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "drive", label: "My drive" },
    { id: "finance", label: "Finance", parentId: "drive" },
    { id: "invoices", label: "Invoices", parentId: "finance" },
    { id: "clients", label: "Clients", parentId: "drive" },
    { id: "empty", label: "Empty", parentId: "drive" },
    { id: "orphan", label: "Shared with me", parentId: "not-listed" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: LAPTOP }, [
    { id: "/home/maya/work", label: "~/work" },
    { id: "/home/maya/work/atlas-api", label: "~/work/atlas-api", parentId: "/home/maya/work" },
    { id: "/home/maya/workshop", label: "~/workshop" },
  ]);
  publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [
    {
      id: "c-team",
      label: "Studio team",
      members: [
        { type: "phone", value: MAYA },
        { type: "phone", value: JAMIE },
      ],
    },
    { id: "c-solo", label: "Jamie Lopez", members: [{ type: "phone", value: JAMIE }] },
  ]);

  entry("m1", { labelIds: ["L-finance"], folderIds: ["invoices"] });
  entry("m2", { labelIds: ["L-finance", "L-clients"], folderIds: ["finance"] });
  entry("m3", { labelIds: ["L-clients"], folderIds: ["clients"] });
  entry("m4", { labelIds: [], folderIds: [] });
  entry("m-old", { labelIds: ["L-finance"], folderIds: ["finance"] }, { version: 1 });
  entry("m-unknown", {});
  entry("m-unlisted", { labelIds: ["L-finance"], folderIds: ["vanished"] });
  insertDocument(db, {
    id: "m1-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "m1" } },
  });
  entry("s1", { directory: "/home/maya/work/atlas-api", tagIds: ["red"] }, { streamId: LAPTOP });
  entry("s2", { directory: "/home/maya/workshop", tagIds: ["red", "blue"] }, { streamId: LAPTOP });
  entry("s3", { directory: "/home/maya/work", tagIds: [] }, { streamId: LAPTOP });
  entry(
    "p1",
    {},
    {
      people: [
        { role: "sender", emails: ["maya@example.org"] },
        { role: "recipient", emails: ["jamie@example.io"] },
      ],
    },
  );
  entry("p2", {}, { people: [{ role: "sender", emails: ["jamie@example.io"] }] });
  entry("p3", {}, { people: [{ role: "sender", phones: [MAYA] }] });
  for (const [id, chatId, people] of [
    ["w1", "c-team", [{ role: "participant", phones: [JAMIE] }]],
    ["w2", "c-team", []],
    ["w3", "c-solo", [{ role: "participant", phones: [JAMIE] }]],
  ] as const) {
    insertDocument(db, {
      id,
      sourceId: PARLEY,
      metadata: { documentType: "day", people, extra: { chatId } },
    });
  }
  knownPerson("person-maya", "Maya Reeves", [
    ["email", "Maya@Example.org"],
    ["phone", "+1 555 010 0123"],
    ["name", "Maya"],
    ["lid", "parley:1"],
  ]);
  knownPerson("person-maya-old", "M. Reeves", [["email", "maya.reeves@example.io"]], "person-maya");
  knownPerson("person-jamie", "Jamie Lopez", [["email", "jamie@example.io"]]);
  knownPerson("person-nameless", "Riverside Estate", [["name", "Riverside Estate"]]);
});

afterEach(() => fixture.close());

function options(request: Partial<FilterOptionsRequest> & { field: string }) {
  const result = readFilterOptions(db, { sourceId: LEDGER, ...request });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** How many records a share-only filter holding only `ref` shares, by the real check. */
function sharedBy(sourceId: string, ref: FilterRef): number {
  const compiled = compileSourceFilter(
    shareOnly(sourceId, [ref]),
    filterFieldsFor(db, sourceId.split(":")[0]!),
  );
  const allow = filterAllowSql(compiled, { row: "d" });
  return db
    .prepare<unknown[], { n: number }>(
      `SELECT count(*) AS n FROM documents d WHERE d.source_id = ? AND ${allow.sql}`,
    )
    .get(sourceId, ...allow.params)!.n;
}

function expectCountsMatchTheCheck(sourceId: string, items: FilterOption[]): void {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect([item.label, item.count]).toEqual([item.label, sharedBy(sourceId, item.ref)]);
  }
}

describe("a searchable list", () => {
  it("lists every entry by name, with the count of each", () => {
    const { items, nextCursor } = options({ field: "extra.labelIds" });
    expect(items.map((item) => [item.label, item.count, item.ref])).toEqual([
      ["100% done_list", 0, label("L-percent")],
      ["archive", 0, label("L-archive")],
      // m3 and m2.
      ["Clients", 2, label("L-clients")],
      // m1, its attachment and m2: not the too-old one, nor the one in an unlisted folder.
      ["Finance", 4, label("L-finance")],
    ]);
    expect(nextCursor).toBeUndefined();
    expect(items.every((item) => item.shortLabel === item.label)).toBe(true);
    expectCountsMatchTheCheck(LEDGER, items);
  });

  it("searches names without regard to case, and reads % and _ as themselves", () => {
    expect(options({ field: "extra.labelIds", q: "ARCH" }).items.map((item) => item.label)).toEqual(
      ["archive"],
    );
    expect(options({ field: "extra.labelIds", q: "100%" }).items.map((item) => item.label)).toEqual(
      ["100% done_list"],
    );
    expect(options({ field: "extra.labelIds", q: "e_l" }).items.map((item) => item.label)).toEqual([
      "100% done_list",
    ]);
    expect(options({ field: "extra.labelIds", q: "%" }).items).toHaveLength(1);
    expect(options({ field: "extra.labelIds", q: "nothing like this" }).items).toEqual([]);
  });

  it("pages through a long list without repeating or skipping an entry", () => {
    const many = Array.from({ length: 120 }, (_unused, index) => ({
      id: `L-${index}`,
      // Several entries share a name, so the id has to break the tie.
      label: `Label ${String(Math.floor(index / 3)).padStart(2, "0")}`,
    }));
    publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, many);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = options({ field: "extra.labelIds", cursor });
      expect(page.items.length).toBeLessThanOrEqual(FILTER_OPTIONS_PAGE);
      seen.push(...page.items.map((item) => (item.ref as { id: string }).id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toHaveLength(120);
  });

  it("refuses a cursor from another listing, and one that is not a cursor", () => {
    publishList(
      db,
      { sourceId: LEDGER, field: "extra.labelIds" },
      Array.from({ length: 60 }, (_unused, index) => ({
        id: `L-${index}`,
        label: `Label ${index}`,
      })),
    );
    const { nextCursor } = options({ field: "extra.labelIds" });
    expect(nextCursor).toBeDefined();
    for (const request of [
      { field: "extra.labelIds", q: "Label", cursor: nextCursor },
      { field: "extra.folderIds", cursor: nextCursor },
      { field: "extra.labelIds", cursor: "not-a-cursor" },
      { field: "extra.labelIds", cursor: Buffer.from("[1]").toString("base64url") },
      { field: "extra.labelIds", cursor: "x".repeat(9000) },
    ]) {
      expect(readFilterOptions(db, { sourceId: LEDGER, ...request })).toEqual({
        ok: false,
        error: "invalid-cursor",
      });
    }
  });
});

describe("a tree", () => {
  it("lists the top level, treating a node whose parent is not listed as a root", () => {
    const { items } = options({ field: "extra.folderIds" });
    expect(items.map((item) => [item.label, item.hasChildren, item.depth, item.count])).toEqual([
      // Everything filed in a listed folder: m1, its attachment, m2, m3.
      ["My drive", true, 0, 4],
      ["Shared with me", false, 0, 0],
    ]);
    expect(items[1]!.parentId).toBeUndefined();
    expectCountsMatchTheCheck(LEDGER, items);
  });

  it("lists one level under a node, counting what sits anywhere inside each", () => {
    const { items } = options({ field: "extra.folderIds", parentId: "drive" });
    expect(items.map((item) => [item.label, item.hasChildren, item.depth, item.count])).toEqual([
      ["Clients", false, 1, 1],
      // An empty folder is offered, so a filter can be made before it holds anything.
      ["Empty", false, 1, 0],
      ["Finance", true, 1, 3],
    ]);
    expect(items.every((item) => item.parentId === "drive")).toBe(true);
    expectCountsMatchTheCheck(LEDGER, items);
    expect(options({ field: "extra.folderIds", parentId: "finance" }).items).toMatchObject([
      { label: "Invoices", depth: 2, count: 2, ref: folder("invoices") },
    ]);
    expect(options({ field: "extra.folderIds", parentId: "invoices" }).items).toEqual([]);
  });

  it("searches the whole tree and shows each result with its full name", () => {
    const { items } = options({ field: "extra.folderIds", q: "in" });
    expect(items.map((item) => [item.label, item.shortLabel, item.depth])).toEqual([
      ["Finance", "Finance", 1],
      ["Invoices", "Invoices", 2],
    ]);
  });
});

describe("a field whose ids belong to a device", () => {
  it("skips the device level for an account with one device, and still names the device", () => {
    const { items } = options({ field: "extra.directory" });
    expect(items.map((item) => [item.label, item.shortLabel, item.ref, item.count])).toEqual([
      ["~/work", "~/work", directory(LAPTOP, "/home/maya/work"), 2],
      ["~/workshop", "~/workshop", directory(LAPTOP, "/home/maya/workshop"), 1],
    ]);
    expectCountsMatchTheCheck(LEDGER, items);
  });

  it("shows the last part of a name under its parent, and the full name in a search", () => {
    const under = options({ field: "extra.directory", parentId: "/home/maya/work" }).items;
    expect(under.map((item) => [item.label, item.shortLabel])).toEqual([
      ["~/work/atlas-api", "atlas-api"],
    ]);
    const found = options({ field: "extra.directory", q: "atlas" }).items;
    expect(found.map((item) => [item.label, item.shortLabel])).toEqual([
      ["~/work/atlas-api", "~/work/atlas-api"],
    ]);
  });

  it("lists the devices first when there are several, each covering its whole machine", () => {
    publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: DESKTOP }, [
      { id: "/home/maya/work", label: "~/work" },
    ]);
    entry("s4", { directory: "/home/maya/work" }, { streamId: DESKTOP });
    const { items } = options({ field: "extra.directory" });
    expect(items.map((item) => [item.label, item.ref, item.count, item.hasChildren])).toEqual([
      ["Studio Mac", directory(LAPTOP, ""), 3, true],
      ["Workshop PC", directory(DESKTOP, ""), 1, true],
    ]);
    expectCountsMatchTheCheck(LEDGER, items);
    // The same path on the two devices is two entries.
    const laptop = options({ field: "extra.directory", device: LAPTOP }).items;
    const desktop = options({ field: "extra.directory", device: DESKTOP }).items;
    expect(laptop.map((item) => [item.label, item.count])).toEqual([
      ["~/work", 2],
      ["~/workshop", 1],
    ]);
    expect(desktop.map((item) => [item.ref, item.count])).toEqual([
      [directory(DESKTOP, "/home/maya/work"), 1],
    ]);
    // A search with no device chosen covers both, and each result names its device.
    const found = options({ field: "extra.directory", q: "~/work" }).items;
    expect(found.map((item) => (item.ref as { device?: string }).device).sort()).toEqual([
      DESKTOP,
      LAPTOP,
      LAPTOP,
      LAPTOP,
    ]);
    expectCountsMatchTheCheck(LEDGER, found);
  });

  it("counts a membership field per device too", () => {
    publishList(db, { sourceId: LEDGER, field: "extra.tagIds", deviceId: LAPTOP }, [
      { id: "red", label: "Red" },
      { id: "blue", label: "Blue" },
    ]);
    const { items } = options({ field: "extra.tagIds" });
    expect(items.map((item) => [item.label, item.ref, item.count])).toEqual([
      ["Blue", tag(LAPTOP, "blue"), 1],
      ["Red", tag(LAPTOP, "red"), 2],
    ]);
    expectCountsMatchTheCheck(LEDGER, items);
  });
});

describe("people", () => {
  it("offers the people the gateway knows, with the identifiers a filter can name them by", () => {
    const { items } = options({ field: "$people" });
    expect(items.map((item) => [item.label, item.personId])).toEqual([
      ["Jamie Lopez", "person-jamie"],
      ["Maya Reeves", "person-maya"],
    ]);
    // Her own addresses and those of the person merged into her, read by the one reader.
    expect(items[1]!.ref).toEqual({
      capability: "person",
      label: "Maya Reeves",
      identifiers: [
        { type: "email", value: "maya.reeves@example.io" },
        { type: "email", value: "maya@example.org" },
        { type: "phone", value: MAYA },
      ],
    });
    expect(items.map((item) => item.count)).toEqual([2, 2]);
    expectCountsMatchTheCheck(LEDGER, items);
  });

  it("searches by name or by address", () => {
    expect(options({ field: "$people", q: "reev" }).items.map((item) => item.label)).toEqual([
      "Maya Reeves",
    ]);
    expect(
      options({ field: "$people", q: "JAMIE@example" }).items.map((item) => item.label),
    ).toEqual(["Jamie Lopez"]);
  });

  it("offers only the identifier kinds the source declares, and counts chat members", () => {
    const { items } = options({ sourceId: PARLEY, field: "$people" });
    expect(items).toMatchObject([
      {
        label: "Maya Reeves",
        ref: { capability: "person", identifiers: [{ type: "phone", value: MAYA }] },
        // Both days of the team chat, where she never speaks.
        count: 2,
      },
    ]);
    expectCountsMatchTheCheck(PARLEY, items);
  });

  it("does not offer a partial identity for someone with more identifiers than a filter holds", () => {
    knownPerson(
      "person-many",
      "Aliases Unlimited",
      Array.from({ length: 300 }, (_unused, index): [string, string] => [
        "email",
        `alias${index}@example.io`,
      ]),
    );
    expect(filterPersonIdentifiers(db, "person-many", ["email"])).toBeNull();
    expect(options({ field: "$people", q: "Aliases" }).items).toEqual([]);
    expect(filterPersonIdentifiers(db, "person-maya", ["phone"])).toEqual([
      { type: "phone", value: MAYA },
    ]);
    expect(filterPersonIdentifiers(db, "nobody", ["email"])).toEqual([]);
  });
});

describe("what cannot be listed", () => {
  it("says so for an unknown account or field", () => {
    expect(
      readFilterOptions(db, { sourceId: "ledger:elsewhere", field: "extra.labelIds" }),
    ).toEqual({
      ok: false,
      error: "source-not-found",
    });
    expect(readFilterOptions(db, { sourceId: LEDGER, field: "extra.threadId" })).toEqual({
      ok: false,
      error: "unsupported-field",
    });
    db.prepare(
      "INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at) VALUES ('almanac:home', 'almanac', 'home', ?, 1, 1)",
    ).run(LAPTOP);
    expect(readFilterOptions(db, { sourceId: "almanac:home", field: "$people" })).toEqual({
      ok: false,
      error: "unsupported-field",
    });
  });

  it("lists nothing for a field whose list has not arrived", () => {
    expect(options({ field: "extra.tagIds" }).items).toEqual([]);
  });
});

describe("the count beside an entry", () => {
  it("is what a share-only filter holding only that entry shares, for every kind of entry", () => {
    const refs: FilterRef[] = [
      label("L-finance"),
      label("L-clients"),
      label("L-unused"),
      folder("drive"),
      folder("finance"),
      folder("vanished"),
      directory(LAPTOP, "/home/maya/work"),
      directory(LAPTOP, ""),
      directory(DESKTOP, "/home/maya/work"),
      tag(LAPTOP, "red"),
      person("Maya Reeves", ["email", "maya@example.org"], ["phone", MAYA]),
      person("Example", ["domain", "example.io"]),
      person("Nobody", ["email", "nobody@example.org"]),
    ];
    const counts = countFilterEntries(db, LEDGER, filterFieldsFor(db, "ledger"), refs);
    expect(counts).toEqual(refs.map((ref) => sharedBy(LEDGER, ref)));
    expect(counts.some((count) => count > 0)).toBe(true);
    const chats = [chat("c-team"), chat("c-solo"), person("Jamie Lopez", ["phone", JAMIE])];
    expect(countFilterEntries(db, PARLEY, filterFieldsFor(db, "parley"), chats)).toEqual(
      chats.map((ref) => sharedBy(PARLEY, ref)),
    );
  });

  it("is zero for an entry the field cannot take", () => {
    expect(
      countFilterEntries(db, LEDGER, filterFieldsFor(db, "ledger"), [
        { capability: "tree", field: "extra.labelIds", id: "L-finance" },
        { capability: "membership", field: "extra.threadId", id: "t" },
        { capability: "tree", field: "extra.directory", id: "/home/maya/work" },
      ]),
    ).toEqual([0, 0, 0]);
  });
});

describe("the preview of a draft filter", () => {
  function preview(filter: SourceFilter) {
    const result = readFilterPreview(db, filter.sourceId, filter);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  it("counts what stays readable, what is hidden, and of that what is too old or unknown", () => {
    const total = db
      .prepare<[string], { n: number }>("SELECT count(*) AS n FROM documents WHERE source_id = ?")
      .get(LEDGER)!.n;
    const hideFinance = preview(hide(LEDGER, [label("L-finance")]));
    expect(hideFinance).toMatchObject({
      sourceId: LEDGER,
      total,
      // m3 and m4.
      visible: 2,
      hidden: total - 2,
      tooOld: 1,
      // Every record without the label detail: sessions, people-only mail, the bare one.
      unmatched: 7,
      items: [{ ref: label("L-finance"), label: "Finance", count: 4 }],
    });
    const onlyClients = preview(shareOnly(LEDGER, [folder("clients"), folder("vanished")]));
    expect(onlyClients).toMatchObject({
      visible: 1,
      hidden: total - 1,
      tooOld: 1,
      items: [
        { label: "Clients", count: 1 },
        { label: "vanished", count: 0, missing: true },
      ],
    });
    expect(onlyClients.items[0]!.missing).toBeUndefined();
  });

  it("names a device entry and a person entry", () => {
    const result = preview(
      hide(LEDGER, [directory(LAPTOP, ""), person("Maya Reeves", ["email", "maya@example.org"])]),
    );
    expect(result.items).toEqual([
      { ref: directory(LAPTOP, ""), label: "Studio Mac", count: 3 },
      { ref: person("Maya Reeves", ["email", "maya@example.org"]), label: "Maya Reeves", count: 1 },
    ]);
  });

  it("refuses a filter it cannot apply, one for another account, and one that is too long", () => {
    const refused = { ok: false, error: "invalid-filter" };
    expect(
      readFilterPreview(
        db,
        LEDGER,
        hide(LEDGER, [{ capability: "membership", field: "extra.threadId", id: "t" }]),
      ),
    ).toEqual(refused);
    expect(readFilterPreview(db, LEDGER, hide(PARLEY, [chat("c-team")]))).toEqual(refused);
    expect(
      readFilterPreview(
        db,
        LEDGER,
        hide(
          LEDGER,
          Array.from({ length: 257 }, (_unused, index) => label(`L-${index}`)),
        ),
      ),
    ).toEqual(refused);
    expect(readFilterPreview(db, LEDGER, { ...hide(LEDGER, []), rules: "x" } as never)).toEqual(
      refused,
    );
    expect(readFilterPreview(db, "ledger:elsewhere", hide("ledger:elsewhere", []))).toEqual({
      ok: false,
      error: "source-not-found",
    });
  });

  it("takes a filter holding the most entries one can hold", () => {
    const result = preview(
      hide(LEDGER, [
        ...Array.from({ length: 255 }, (_unused, index) => label(`L-${index}`)),
        label("L-finance"),
      ]),
    );
    expect(result.visible).toBe(2);
    expect(result.items).toHaveLength(256);
    expect(result.items[255]).toMatchObject({ label: "Finance", count: 4 });
  });
});

describe("the short name of an entry", () => {
  it.each([
    ["~/work/atlas-api", "~/work", "atlas-api"],
    ["northstar-labs/atlas-api", "northstar-labs", "atlas-api"],
    ["C:\\work\\atlas", "C:\\work", "atlas"],
    // Not inside its "parent" by name: shown whole.
    ["~/workshop", "~/work", "~/workshop"],
    ["Invoices", "Finance", "Invoices"],
    ["~/work/", "~/work", "~/work/"],
    ["~/work", undefined, "~/work"],
    ["~/work", "~/work", "~/work"],
  ])("%s under %s is %s", (name, parent, expected) => {
    expect(shortFilterLabel(name, parent)).toBe(expected);
  });
});
