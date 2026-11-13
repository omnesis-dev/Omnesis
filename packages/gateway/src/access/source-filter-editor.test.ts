// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { summarizeResync } from "../http/services/SourceFilterService.js";
import {
  LEDGER_PROFILE,
  folder,
  label,
  openFilterFixture,
  publishList,
  publishProfile,
  shareOnly,
  tag,
  type FilterFixture,
} from "./filter-test-utils.js";
import { accountResyncText } from "./filter-wording.js";
import {
  readSourceFilterEditor,
  readSourceFilterPreview,
  type FilterEditorField,
} from "./source-filter-editor.js";
import type { Db } from "../data/types.js";

const LAPTOP = "device-laptop";
const LEDGER = "ledger:maya";
const GONE = "ledger:retired";

let fixture: FilterFixture;
let db: Db;

beforeEach(() => {
  fixture = openFilterFixture();
  db = fixture.db;
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES (?, 'laptop', 'collector', 1)",
  ).run(LAPTOP);
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
     VALUES (?, 'ledger', 'maya', ?, 1, 1)`,
  ).run(LEDGER, LAPTOP);
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  for (const sourceId of [LEDGER, GONE]) {
    publishList(db, { sourceId, field: "extra.folderIds" }, [
      { id: "drive", label: "My drive" },
      { id: "finance", label: "Finance", parentId: "drive" },
      { id: "invoices", label: "Invoices", parentId: "finance" },
    ]);
    publishList(db, { sourceId, field: "extra.labelIds" }, [{ id: "L-finance", label: "Finance" }]);
  }
});

afterEach(() => fixture.close());

describe("naming saved entries in a preview", () => {
  test("a tree entry carries its depth; a list entry and a missing one say what they are", () => {
    const preview = readSourceFilterPreview(
      db,
      LEDGER,
      shareOnly(LEDGER, [
        folder("drive"),
        folder("invoices"),
        label("L-finance"),
        folder("moved-away"),
        tag(LAPTOP, "T-urgent"),
      ]),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.connected).toBe(true);
    expect(
      preview.value.items.map(({ label, depth, missing, reason }) => ({
        label,
        depth,
        missing,
        reason,
      })),
    ).toEqual([
      { label: "My drive", depth: 0, missing: undefined, reason: undefined },
      { label: "Invoices", depth: 2, missing: undefined, reason: undefined },
      { label: "Finance", depth: undefined, missing: undefined, reason: undefined },
      { label: "moved-away", depth: undefined, missing: true, reason: "not-in-list" },
      { label: "T-urgent", depth: undefined, missing: true, reason: "list-gone" },
    ]);
  });
});

describe("an account that is gone while a saved filter names it", () => {
  beforeEach(() => {
    db.prepare(
      `INSERT INTO access_scope_policy_sources (owner_kind, owner_id, capability, source_id)
       VALUES ('level', 'level-review', 'direct', ?)`,
    ).run(GONE);
  });

  test("its editor lists the declared fields, every one disconnected", () => {
    const editor = readSourceFilterEditor(db, GONE);
    expect(editor).toMatchObject({
      sourceId: GONE,
      sourceType: "ledger",
      connected: false,
      devices: [],
      profileText:
        "This account is no longer connected. Its saved filter entries are kept until you remove them.",
    });
    expect(editor!.fields.map((field) => [field.field, field.state.status])).toEqual([
      ["extra.labelIds", "disconnected"],
      ["extra.folderIds", "disconnected"],
      ["extra.directory", "disconnected"],
      ["extra.tagIds", "disconnected"],
      ["$people", "disconnected"],
    ]);
    expect(editor!.fields[1]!.levels).toEqual([{ one: "folder", many: "folders" }]);
  });

  test("its preview names the saved entries from the list rows that remain, counting nothing", () => {
    const preview = readSourceFilterPreview(
      db,
      GONE,
      shareOnly(GONE, [folder("invoices"), label("L-gone")]),
    );
    expect(preview).toMatchObject({
      ok: true,
      value: {
        connected: false,
        total: 0,
        visible: 0,
        items: [
          { label: "Invoices", depth: 2, count: 0 },
          { label: "L-gone", missing: true, reason: "not-in-list", count: 0 },
        ],
      },
    });
  });

  test("an account no saved filter names is not found", () => {
    db.prepare("DELETE FROM access_scope_policy_sources").run();
    expect(readSourceFilterEditor(db, GONE)).toBeNull();
    expect(readSourceFilterPreview(db, GONE, shareOnly(GONE, [folder("invoices")]))).toEqual({
      ok: false,
      error: "source-not-found",
    });
  });
});

describe("the account's resync sentence", () => {
  const field = (
    path: string,
    noun: string,
    state: FilterEditorField["state"],
    capability: FilterEditorField["capability"] = "membership",
  ): FilterEditorField => ({
    field: path,
    capability,
    noun: { one: noun, many: capability === "person" ? "people" : `${noun}s` },
    picker: "search",
    scope: "global",
    state,
  });
  const needs = {
    status: "needs-resync" as const,
    cost: "This reads about 75,000 messages a day.",
    text: "",
  };

  test("names every field waiting on a resync, people last, with the source's word for its content", () => {
    const fields = [
      field("$people", "person", needs, "person"),
      field("extra.labelIds", "label", needs),
      field("extra.folderIds", "folder", { status: "ready" }, "tree"),
    ];
    // The editor's order already puts people last.
    const ordered = [fields[1]!, fields[2]!, fields[0]!];
    expect(summarizeResync("mailbox", ordered, "emails")).toEqual({
      state: "needs-resync",
      fields: ["extra.labelIds", "$people"],
      text: "Label and people filters need mailbox to be resynced. Your emails stay searchable meanwhile. This reads about 75,000 messages a day.",
    });
  });

  test("without a word for the content the clause stays generic", () => {
    expect(
      accountResyncText({
        status: "needs-resync",
        sourceName: "drive",
        fields: [{ noun: { one: "folder", many: "folders" }, person: false }],
        cost: null,
      }),
    ).toBe("Folder filters need drive to be resynced. Search keeps working meanwhile.");
  });

  test("reports progress once every field that is not ready is being resynced", () => {
    const resyncing = {
      status: "resyncing" as const,
      processed: 212_000,
      total: 900_000,
      text: "",
    };
    expect(
      summarizeResync("mailbox", [
        field("extra.labelIds", "label", resyncing),
        field("extra.folderIds", "folder", { status: "ready" }, "tree"),
      ]),
    ).toEqual({
      state: "resyncing",
      fields: ["extra.labelIds"],
      text: "Resyncing mailbox: 212,000 of about 900,000.",
      processed: 212_000,
      total: 900_000,
    });
    expect(
      summarizeResync("mailbox", [
        field("extra.labelIds", "label", resyncing),
        field("extra.folderIds", "folder", { status: "list-pending", text: "" }, "tree"),
      ]),
    ).toBeUndefined();
    expect(
      summarizeResync("mailbox", [field("extra.labelIds", "label", { status: "ready" })]),
    ).toBeUndefined();
  });
});
