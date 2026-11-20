// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { exactNoteIdentity } from "./identity.js";
import { obsidianStateSpec } from "./state.js";
import definition from "./index.js";
import type { ObsidianSyncCursor } from "./types.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
let root: string;
let vault: string;
const first = 9_007_199_254_740_992n;
const second = first + 1n;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "obsidian-exact-identity-")));
  vault = join(root, "InventedVault");
  fs.mkdirSync(vault);
  fs.mkdirSync(join(vault, ".obsidian"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function create() {
  return definition.create!({
    accountId: "InventedVault",
    sourceId: SourceId("obsidian-notes:InventedVault"),
    providerId: ProviderId("obsidian:InventedVault"),
    config: { vaultPath: vault, exclude: [] },
  });
}
function collide() {
  const stat = fs.statSync;
  const fstat = fs.fstatSync;
  const identities = new Map<string, bigint>();
  for (const [path, identity] of [
    ["one.md", first],
    ["two.md", second],
  ] as const) {
    fs.writeFileSync(join(vault, path), `Invented note ${path}`);
    identities.set(exactNoteIdentity(stat(join(vault, path), { bigint: true })), identity);
  }
  const substitute = <T extends fs.Stats | fs.BigIntStats | undefined>(
    value: T,
    exact: fs.BigIntStats,
  ): T => {
    if (!value) return value;
    const key = exactNoteIdentity(exact);
    const identity = identities.get(key);
    if (identity === undefined) return value;
    const big = typeof value.ino === "bigint";
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
      dev: big ? 42n : 42,
      ino: big ? identity : Number(identity),
    }) as T;
  };
  vi.spyOn(fs, "statSync").mockImplementation(((...args) =>
    substitute(
      Reflect.apply(stat, fs, args),
      stat(args[0], { bigint: true }),
    )) as typeof fs.statSync);
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args) =>
    substitute(
      Reflect.apply(fstat, fs, args),
      fstat(args[0], { bigint: true }),
    )) as typeof fs.fstatSync);
  return { fstat, substitute };
}

test("rounded 64-bit file IDs keep separate note identities through simultaneous rename and edit", async () => {
  expect(Number(first)).toBe(Number(second));
  collide();
  const instance = await create();
  const initial = await instance.sync(null);
  const ids = new Map(
    initial.documents.map((doc) => [doc.metadata.extra?.relativePath, doc.externalId]),
  );
  expect(new Set(ids.values()).size).toBe(2);
  expect(ids.get("one.md")).toBe(`inode:42:${first}`);
  expect(ids.get("two.md")).toBe(`inode:42:${second}`);
  for (const [from, to] of [
    ["one.md", "renamed-one.md"],
    ["two.md", "renamed-two.md"],
  ]) {
    fs.renameSync(join(vault, from!), join(vault, to!));
    fs.writeFileSync(join(vault, to!), `An independently edited fictional note ${to}`);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(join(vault, to!), future, future);
  }
  const moved = await instance.sync(initial.cursor);
  expect(moved.documents).toHaveLength(2);
  for (const doc of moved.documents) {
    const path = String(doc.metadata.extra?.relativePath).replace("renamed-", "");
    expect(doc.externalId).toBe(ids.get(path));
  }
  expect(moved.deletedExternalIds).toEqual([]);
});

test("numeric-only installed cursors upgrade once while retaining both inherited external IDs", async () => {
  collide();
  const instance = await create();
  const initial = await instance.sync(null);
  const installed = structuredClone(initial.cursor) as ObsidianSyncCursor;
  const one = installed.fileMap["one.md"]!;
  const two = installed.fileMap["two.md"]!;
  delete one.fileIdentity;
  delete two.fileIdentity;
  one.stableId = `inode:${Number(first)}`;
  two.stableId = "path:two.md";
  expect(obsidianStateSpec.decode(installed)).toEqual(installed);
  const upgraded = await instance.sync(installed);
  expect(upgraded.documents).toEqual([]);
  const current = upgraded.cursor as ObsidianSyncCursor;
  expect(current.fileMap["one.md"]).toMatchObject({
    stableId: one.stableId,
    fileIdentity: `42:${first}`,
  });
  expect(current.fileMap["two.md"]).toMatchObject({
    stableId: two.stableId,
    fileIdentity: `42:${second}`,
  });
  const read = vi.spyOn(fs, "readFileSync");
  const unchanged = await instance.sync(current);
  expect(unchanged.documents).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  expect(unchanged.cursor).toEqual(current);
  const invalid = structuredClone(current);
  invalid.fileMap["one.md"]!.fileIdentity = "not-an-identity";
  expect(obsidianStateSpec.decode(invalid)).toBeNull();
});

test("a wrong opened identity cannot pass the read guard through Number rounding", async () => {
  const { fstat, substitute } = collide();
  fs.rmSync(join(vault, "two.md"));
  const instance = await create();
  vi.mocked(fs.fstatSync).mockImplementation(((...args) => {
    const value = substitute(Reflect.apply(fstat, fs, args), fstat(args[0], { bigint: true }));
    return typeof value.ino === "bigint"
      ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: second })
      : value;
  }) as typeof fs.fstatSync);
  const read = vi.spyOn(fs, "readFileSync");
  const page = await instance.sync(null);
  expect(page.documents).toEqual([]);
  expect(page.presentExternalIds).toBeUndefined();
  expect(page.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  expect(read).not.toHaveBeenCalled();
});

test("a different safe inode replacing a numeric-only installed note does not inherit its identity", async () => {
  const path = join(vault, "note.md");
  fs.writeFileSync(path, "Invented original note");
  const instance = await create();
  const initial = await instance.sync(null);
  const installed = structuredClone(initial.cursor) as ObsidianSyncCursor;
  const previous = installed.fileMap["note.md"]!;
  delete previous.fileIdentity;
  previous.inode = 7;
  previous.stableId = "inode:7";
  const replacement = join(vault, "replacement.tmp");
  fs.writeFileSync(replacement, "A different invented replacement note");
  fs.renameSync(replacement, path);
  const stat = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation(((...args) => {
    const value = Reflect.apply(stat, fs, args);
    return String(args[0]) === path && value && typeof value.ino === "number"
      ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: 9 })
      : value;
  }) as typeof fs.statSync);
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path, future, future);
  const replaced = await instance.sync(installed);
  expect(replaced.documents).toHaveLength(1);
  expect(replaced.documents[0]!.externalId).toBe("inode:9");
  expect(replaced.deletedExternalIds).toContain(previous.stableId);
});
