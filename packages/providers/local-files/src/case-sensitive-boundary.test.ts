// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { readLocalFileBytes } from "./file-read.js";
import { exactFileIdentity } from "./identity.js";
import definition from "./index.js";
import type { LocalFileEntry, LocalFilesSyncCursor } from "./types.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function pair(context: { skip: (reason?: string) => never }) {
  const base = fs.realpathSync(
    fs.mkdtempSync(
      join(process.platform === "win32" ? homedir() : tmpdir(), "local-case-boundary-"),
    ),
  );
  fixtures.push(base);
  const parent = join(base, "case-sensitive");
  fs.mkdirSync(parent);
  if (process.platform === "win32") {
    const result = spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "fsutil.exe"),
      ["file", "setCaseSensitiveInfo", parent, "enable"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (result.status !== 0)
      context.skip(
        `Owned NTFS case-sensitive fixture unavailable (exit ${result.status ?? result.error?.message})`,
      );
  }
  const declared = join(parent, "Docs"),
    outside = join(parent, "docs");
  fs.mkdirSync(declared);
  try {
    fs.mkdirSync(outside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      context.skip(
        "Filesystem has no case-distinct directory entries; portable identity contracts still run",
      );
    throw error;
  }
  expect(exactFileIdentity(fs.lstatSync(declared, { bigint: true }))).not.toBe(
    exactFileIdentity(fs.lstatSync(outside, { bigint: true })),
  );
  return { parent, declared, outside };
}
function entry(path: string): LocalFileEntry {
  const stat = fs.statSync(path);
  return {
    absolutePath: path,
    displayPath: path,
    dirSegments: [],
    mimeType: "text/plain",
    via: "text",
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    size: stat.size,
    inode: stat.ino,
    device: stat.dev,
    fileIdentity: exactFileIdentity(fs.statSync(path, { bigint: true })),
  };
}
async function source(root: string) {
  return definition.create!({
    accountId: "host",
    sourceId: SourceId("local-files:host"),
    providerId: ProviderId("local-files:host"),
    config: { roots: [root], exclude: [] },
  });
}
async function windows<T>(run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

test("Windows guarded reads never open a case-distinct sibling outside the declared root", (context) => {
  const { declared, outside } = pair(context);
  const path = join(outside, "private.txt");
  fs.writeFileSync(path, "Fictional outside-root bytes");
  const file = entry(path);
  const read = vi.spyOn(fs, "readFileSync"),
    open = vi.spyOn(fs, "openSync");
  expect(() => readLocalFileBytes(file, { roots: [declared], platform: "win32", env: {} })).toThrow(
    /outside/,
  );
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test("a case-distinct outside directory cannot enter a scan through an alias", async (context) => {
  const { declared, outside } = pair(context);
  const tracked = join(declared, "door");
  fs.mkdirSync(tracked);
  const oldPath = join(tracked, "note.txt");
  fs.writeFileSync(oldPath, "Fictional previously indexed note");
  fs.writeFileSync(join(outside, "private.txt"), "Fictional excluded private note");
  await windows(async () => {
    const instance = await source(declared);
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(1);
    fs.rmSync(tracked, { recursive: true });
    fs.symlinkSync(outside, tracked, "junction");
    const read = vi.spyOn(fs, "readFileSync");
    const page = await instance.sync(first.cursor);
    expect(page.documents).toEqual([]);
    expect(page.presentExternalIds).toEqual([first.documents[0]!.externalId]);
    expect((page.cursor as LocalFilesSyncCursor).fileMap[oldPath]).toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});

test("a configured root redirected to its case-distinct sibling is a root gap", async (context) => {
  const { parent, declared, outside } = pair(context);
  const oldPath = join(declared, "note.txt");
  fs.writeFileSync(oldPath, "Fictional declared-root note");
  fs.writeFileSync(join(outside, "private.txt"), "Fictional excluded sibling note");
  await windows(async () => {
    const instance = await source(declared),
      first = await instance.sync(null);
    fs.renameSync(declared, join(parent, "old-location"));
    fs.symlinkSync(outside, declared, "junction");
    const read = vi.spyOn(fs, "readFileSync");
    const page = await instance.sync(first.cursor);
    expect(page.documents).toEqual([]);
    expect(page.presentExternalIds).toBeUndefined();
    expect(page.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    expect((page.cursor as LocalFilesSyncCursor).fileMap[oldPath]).toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});

test("post-read checks reject a root redirected to a case-distinct sibling", (context) => {
  const { parent, declared, outside } = pair(context);
  const path = join(declared, "note.txt");
  fs.writeFileSync(path, "Fictional allowed original note");
  fs.writeFileSync(join(outside, "note.txt"), "Fictional outside replacement note");
  const file = entry(path),
    nativeRead = fs.readFileSync;
  const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((...args) => {
    const bytes = Reflect.apply(nativeRead, fs, args);
    expect(bytes.toString()).toBe("Fictional allowed original note");
    fs.renameSync(declared, join(parent, "old-location"));
    fs.symlinkSync(outside, declared, "junction");
    return bytes;
  }) as typeof fs.readFileSync);
  expect(() => readLocalFileBytes(file, { roots: [declared], platform: "win32", env: {} })).toThrow(
    /changed|outside/,
  );
  expect(read).toHaveBeenCalledOnce();
});
