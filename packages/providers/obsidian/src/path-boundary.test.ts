// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import definition from "./index.js";
import type { NodePathEntry } from "@omnesis/source-sdk/node-path-boundary";
import type { ObsidianSyncCursor } from "./types.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
vi.mock("@omnesis/source-sdk/node-path-boundary", async (original) => {
  const actual = await original<typeof import("@omnesis/source-sdk/node-path-boundary")>();
  // Test real entry identities with Windows path semantics on every host.
  // Windows uses the unmodified native paths, including actual NTFS fixtures.
  const readEntry = (path: string): NodePathEntry => {
    const native = process.platform === "win32" ? path : path.replaceAll("\\", "/");
    const stat = fs.lstatSync(native, { bigint: true });
    if (stat.isSymbolicLink()) return { kind: "link" };
    const identity = `${stat.dev}:${stat.ino}`;
    if (stat.isDirectory()) return { kind: "directory", identity };
    if (stat.isFile()) return { kind: "file", identity };
    return { kind: "other" };
  };
  const options = { platform: "win32" as const, readEntry };
  return {
    ...actual,
    containsCanonicalPath: (root: string, path: string) =>
      actual.containsCanonicalPath(root, path, options),
    sameCanonicalPath: (left: string, right: string, kind: "directory" | "file") =>
      actual.sameCanonicalPath(left, right, kind, options),
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function pair(context: { skip: (reason?: string) => never }) {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      join(process.platform === "win32" ? homedir() : tmpdir(), "obsidian-case-boundary-"),
    ),
  );
  roots.push(root);
  const parent = join(root, "case-sensitive");
  fs.mkdirSync(parent);
  if (process.platform === "win32") {
    const run = spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "fsutil.exe"),
      ["file", "setCaseSensitiveInfo", parent, "enable"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (run.status !== 0)
      context.skip(
        `Owned NTFS case-sensitive fixture unavailable (exit ${run.status ?? run.error?.message})`,
      );
  }
  const declared = join(parent, "Vault");
  const outside = join(parent, "vault");
  fs.mkdirSync(declared);
  try {
    fs.mkdirSync(outside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      context.skip(
        "Filesystem has no case-distinct directory entries; portable boundary identity contracts still run",
      );
    throw error;
  }
  fs.mkdirSync(join(declared, ".obsidian"));
  fs.writeFileSync(join(outside, "private.md"), "Fictional excluded sibling note");
  return { parent, declared, outside };
}
function source(vaultPath: string, exclude: string[] = []) {
  return definition.create!({
    accountId: "InventedVault",
    sourceId: SourceId("obsidian-notes:InventedVault"),
    providerId: ProviderId("obsidian:InventedVault"),
    config: { vaultPath, exclude },
  });
}

test("a Windows case-distinct sibling never enters the vault through a junction", async (context) => {
  const { declared, outside } = pair(context);
  fs.writeFileSync(join(declared, "allowed.md"), "Fictional allowed note");
  fs.symlinkSync(outside, join(declared, "door"), "junction");
  const instance = await source(declared);
  const read = vi.spyOn(fs, "readFileSync");
  const page = await instance.sync(null);
  expect(page.documents.map((doc) => doc.title)).toEqual(["allowed"]);
  expect(page.documents[0]!.content).toBe("Fictional allowed note");
  expect(read).toHaveBeenCalledOnce();
  expect(page.issues).toEqual([]);
});

test("a refused junction replacing known notes preserves them while readable sibling deletion proceeds", async (context) => {
  const { parent, declared, outside } = pair(context);
  const folder = join(declared, "folder");
  fs.mkdirSync(folder);
  fs.writeFileSync(join(folder, "retained.md"), "Fictional retained note");
  fs.writeFileSync(join(declared, "gone.md"), "Fictional removed note");
  const instance = await source(declared);
  const first = await instance.sync(null);
  const retained = first.documents.find((doc) => doc.title === "retained")!.externalId;
  const gone = first.documents.find((doc) => doc.title === "gone")!.externalId;
  fs.renameSync(folder, join(parent, "parked"));
  fs.symlinkSync(outside, folder, "junction");
  fs.rmSync(join(declared, "gone.md"));
  const read = vi.spyOn(fs, "readFileSync");
  const page = await instance.sync(first.cursor);
  expect(page.documents).toEqual([]);
  expect(page.deletedExternalIds).toEqual([gone]);
  expect((page.cursor as ObsidianSyncCursor).fileMap[join("folder", "retained.md")]?.stableId).toBe(
    retained,
  );
  expect(page.presentExternalIds).toBeUndefined();
  expect(page.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  expect(read).not.toHaveBeenCalled();
  const excluded = await source(declared, ["folder/**"]);
  const removed = await excluded.sync(page.cursor);
  expect(removed.deletedExternalIds).toEqual([retained]);
  expect(removed.issues).toEqual([]);
});

test("redirecting a configured vault to its case-distinct sibling refuses the sync before reading", async (context) => {
  const { parent, declared, outside } = pair(context);
  fs.writeFileSync(join(declared, "retained.md"), "Fictional selected vault note");
  const instance = await source(declared);
  const first = await instance.sync(null);
  const checkpoint = structuredClone(first.cursor);
  fs.renameSync(declared, join(parent, "parked"));
  fs.symlinkSync(outside, declared, "junction");
  const read = vi.spyOn(fs, "readFileSync");
  await expect(instance.sync(first.cursor)).rejects.toThrow(/resolves to a different location/);
  expect(first.cursor).toEqual(checkpoint);
  expect(read).not.toHaveBeenCalled();
});
