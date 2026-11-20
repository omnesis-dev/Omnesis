// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  accountRowLabel,
  groupExpanded,
  groupSourceRows,
  groupStateSummary,
  sourceRowState,
  sourceStateLabel,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./source-grouping.js";

type Row = {
  id: string;
  removing?: boolean;
  displayCount?: number;
  documentCount?: number;
  unitName?: string | null;
  syncStatus?: { state?: string; lastSyncAt?: string; unitName?: string } | null;
};

const row = (id: string, state: string, count: number, extra: Partial<Row> = {}): Row => ({
  id,
  displayCount: count,
  documentCount: count,
  unitName: "conversation days",
  syncStatus: { state, lastSyncAt: "2026-03-02T10:00:00Z" },
  ...extra,
});

describe("groupSourceRows", () => {
  test("a type with one row stays a plain row, in place", () => {
    const rows = [row("calendar:maya@example.com", "synced", 12), row("notes:local", "idle", 3)];
    const entries = groupSourceRows(rows);
    expect(entries).toEqual([
      { kind: "single", type: "calendar", row: rows[0] },
      { kind: "single", type: "notes", row: rows[1] },
    ]);
  });

  test("a type with several rows folds under one group with its summary", () => {
    const rows = [
      row("calendar:maya@example.com", "synced", 12),
      row("team-chat:workspace-01", "syncing", 100, { syncStatus: { state: "syncing", lastSyncAt: "2026-03-02T09:00:00Z" } }),
      row("team-chat:workspace-02", "error", 5, { syncStatus: { state: "error", lastSyncAt: "2026-03-02T11:30:00Z" } }),
      row("team-chat:workspace-03", "syncing", 20),
      row("team-chat:workspace-04", "synced", 0),
      row("notes:local", "idle", 3),
    ];
    const entries = groupSourceRows(rows);
    expect(entries.map((e: { kind: string; type: string }) => [e.kind, e.type])).toEqual([
      ["single", "calendar"],
      ["group", "team-chat"],
      ["single", "notes"],
    ]);
    const group = entries[1];
    expect(group.rows.map((r: Row) => r.id)).toEqual([
      "team-chat:workspace-01",
      "team-chat:workspace-02",
      "team-chat:workspace-03",
      "team-chat:workspace-04",
    ]);
    expect(group.states).toEqual([
      { state: "error", count: 1 },
      { state: "syncing", count: 2 },
      { state: "synced", count: 1 },
    ]);
    expect(group.total).toBe(125);
    expect(group.unitName).toBe("conversation days");
    expect(group.lastSyncAt).toBe("2026-03-02T11:30:00Z");
    expect(group.attention).toBe(true);
  });

  test("a group sits where its type's first row was, even when its rows are not adjacent", () => {
    const rows = [row("mail", "synced", 1), row("mail-archive:x", "synced", 1), row("mail:b@example.org", "synced", 1)];
    const entries = groupSourceRows(rows);
    expect(entries.map((e: { kind: string; type: string }) => [e.kind, e.type])).toEqual([
      ["group", "mail"],
      ["single", "mail-archive"],
    ]);
    expect(entries[0].rows.map((r: Row) => r.id)).toEqual(["mail", "mail:b@example.org"]);
  });

  test("a removing row counts as removing, and an unsynced row as idle", () => {
    const rows = [
      row("team-chat:workspace-01", "synced", 4, { removing: true, syncStatus: null }),
      row("team-chat:workspace-02", "synced", 6, { syncStatus: null }),
    ];
    const [group] = groupSourceRows(rows);
    expect(group.states).toEqual([
      { state: "removing", count: 1 },
      { state: "idle", count: 1 },
    ]);
    expect(group.lastSyncAt).toBeNull();
    expect(group.attention).toBe(false);
  });

  test("rows that disagree on their unit leave the group without one", () => {
    const rows = [
      row("files:a", "synced", 2, { unitName: "files" }),
      row("files:b", "synced", 3, { unitName: "folders" }),
    ];
    const [group] = groupSourceRows(rows);
    expect(group.unitName).toBeNull();
    expect(group.total).toBe(5);
  });

  test("needs auth, an expiring sign-in and a stale feed all ask for attention", () => {
    for (const state of ["needs-auth", "auth-expiring", "stale"]) {
      const [group] = groupSourceRows([row("t:a", "synced", 1), row("t:b", state, 1)]);
      expect(group.attention).toBe(true);
    }
    const [calm] = groupSourceRows([row("t:a", "synced", 1), row("t:b", "rate-limited", 1)]);
    expect(calm.attention).toBe(false);
  });
});

describe("groupStateSummary", () => {
  test("reads each state with its count, attention first", () => {
    const [group] = groupSourceRows([
      ...Array.from({ length: 14 }, (_, i) => row(`team-chat:workspace-${i}`, "syncing", 1)),
      row("team-chat:workspace-X", "needs-auth", 1),
      row("team-chat:workspace-Y", "synced", 1),
    ]);
    expect(groupStateSummary(group.states)).toBe("1 needs auth · 14 syncing · 1 synced");
  });
});

describe("groupExpanded", () => {
  const calm = { type: "team-chat", attention: false };
  const alarmed = { type: "team-chat", attention: true };

  test("starts open only when a row needs attention", () => {
    expect(groupExpanded(calm, {})).toBe(false);
    expect(groupExpanded(alarmed, {})).toBe(true);
  });

  test("the operator's own toggle wins either way", () => {
    expect(groupExpanded(calm, { "team-chat": true })).toBe(true);
    expect(groupExpanded(alarmed, { "team-chat": false })).toBe(false);
    expect(groupExpanded(calm, { mail: true })).toBe(false);
  });
});

describe("accountRowLabel", () => {
  test("uses the account's own label", () => {
    expect(accountRowLabel("team-chat:workspace-01", "Northstar", "Team chat")).toBe("Northstar");
  });

  test("falls back to the account half when the label only repeats the family", () => {
    expect(accountRowLabel("team-chat:workspace-01", "Team chat", "Team chat")).toBe("workspace-01");
    expect(accountRowLabel("team-chat:workspace-01", "", "Team chat")).toBe("workspace-01");
  });

  test("an id naming no account keeps the id itself", () => {
    expect(accountRowLabel("team-chat", "Team chat", "Team chat")).toBe("team-chat");
  });
});

describe("state words", () => {
  test("a row's state and its label", () => {
    expect(sourceRowState({ id: "a", syncStatus: { state: "error" } })).toBe("error");
    expect(sourceRowState({ id: "a", removing: true, syncStatus: { state: "syncing" } })).toBe("removing");
    expect(sourceRowState({ id: "a" })).toBe("idle");
    expect(sourceStateLabel("needs-auth")).toBe("needs auth");
    expect(sourceStateLabel("rate-limited")).toBe("rate limited");
    expect(sourceStateLabel("auth-expiring")).toBe("expiring");
    expect(sourceStateLabel("synced")).toBe("synced");
  });
});
