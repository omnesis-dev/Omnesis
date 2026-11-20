// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

import { readLocalFileBytes } from "./file-read.js";
import { exactFileIdentity } from "./identity.js";
import definition from "./index.js";
import type { LocalFileEntry, LocalFilesSyncCursor } from "./types.js";

let directory: string;
let root: string;
beforeEach(() => {
  // Windows temp lives under protected AppData; keep these invented roots outside it.
  directory = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? homedir() : tmpdir(), "local-file-read-")),
  );
  root = join(directory, "Docs");
  mkdirSync(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function discovered(path = join(root, "note.txt")): LocalFileEntry {
  const stat = statSync(path);
  return {
    absolutePath: realpathSync(path),
    displayPath: path,
    dirSegments: [],
    mimeType: "text/plain",
    via: "text",
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    size: stat.size,
    inode: stat.ino,
    device: stat.dev,
    fileIdentity: exactFileIdentity(statSync(path, { bigint: true })),
  };
}

function original(): LocalFileEntry {
  const path = join(root, "note.txt");
  writeFileSync(path, "Allowed fictional note");
  return discovered(path);
}

const options = () => ({ roots: [root], platform: "win32" as const, env: {} });

describe("Windows guarded local file reads", () => {
  test("reads a matching regular file and closes the owned descriptor", () => {
    const file = original();
    const close = vi.spyOn(fs, "closeSync");
    expect(new TextDecoder().decode(readLocalFileBytes(file, options()))).toBe(
      "Allowed fictional note",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("valid same-entry case variants still pass all guarded-read checks", () => {
    const file = original();
    const alternate = join(dirname(root), "dOCS");
    const nativeLstat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path, opts) =>
      nativeLstat(String(path) === alternate ? root : path, opts)) as typeof fs.lstatSync);
    expect(
      new TextDecoder().decode(
        readLocalFileBytes(file, {
          roots: [alternate],
          platform: "win32",
          env: {},
        }),
      ),
    ).toBe("Allowed fictional note");
  });

  test("post-read checks reject a simulated case-only root substitution on every filesystem", () => {
    const file = original();
    const alternateRoot = join(dirname(root), "docs");
    const alternateFile = join(alternateRoot, "note.txt");
    const replacement = join(directory, "outside-note.txt");
    writeFileSync(replacement, "Fictional excluded replacement");
    const nativeRead = fs.readFileSync,
      nativeRealpath = fs.realpathSync,
      nativeLstat = fs.lstatSync;
    let readComplete = false;
    vi.spyOn(fs, "realpathSync").mockImplementation(((path, opts) =>
      readComplete && String(path) === file.absolutePath
        ? alternateFile
        : Reflect.apply(nativeRealpath, fs, [path, opts])) as typeof fs.realpathSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((path, opts) => {
      const observed =
        readComplete && String(path) === alternateFile
          ? replacement
          : readComplete && String(path) === alternateRoot
            ? root
            : path;
      return nativeLstat(observed, opts);
    }) as typeof fs.lstatSync);
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((...args) => {
      const bytes = Reflect.apply(nativeRead, fs, args);
      expect(bytes.toString()).toBe("Allowed fictional note");
      readComplete = true;
      return bytes;
    }) as typeof fs.readFileSync);
    expect(() => readLocalFileBytes(file, options())).toThrow(/changed|outside/);
    expect(read).toHaveBeenCalledOnce();
  });

  test.each([undefined, "", "1:0", "not-an-identity"])(
    "refuses unverifiable exact identity %s before opening or reading",
    (fileIdentity) => {
      const file = { ...original(), fileIdentity };
      const open = vi.spyOn(fs, "openSync");
      const read = vi.spyOn(fs, "readFileSync");
      expect(() => readLocalFileBytes(file, options())).toThrow(/identity/);
      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  test("a wrong opened file with an NTFS ID that rounds to the same Number is rejected before reading", () => {
    const real = original();
    const first = 9_007_199_254_740_992n;
    const second = first + 1n;
    expect(Number(first)).toBe(Number(second));
    const file = { ...real, device: 42, inode: Number(first), fileIdentity: `42:${first}` };
    const originalLstat = fs.lstatSync;
    const originalFstat = fs.fstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path, opts) => {
      const result = originalLstat(path, opts);
      if (result === undefined || String(path) !== file.absolutePath) return result;
      const big = typeof result.ino === "bigint";
      return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
        dev: big ? 42n : 42,
        ino: big ? first : Number(first),
      });
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, opts) => {
      const result = originalFstat(fd, opts);
      const big = typeof result.ino === "bigint";
      return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
        dev: big ? 42n : 42,
        ino: big ? second : Number(second),
      });
    }) as typeof fs.fstatSync);
    const read = vi.spyOn(fs, "readFileSync");
    expect(() => readLocalFileBytes(file, options())).toThrow(/changed/);
    expect(read).not.toHaveBeenCalled();
  });

  test.each(["replacement", "symlink"] as const)(
    "a final-component %s swap cannot read another file's bytes",
    (kind) => {
      const file = original();
      const outside = join(directory, "private.txt");
      writeFileSync(outside, "Private fictional text");
      utimesSync(outside, new Date(file.mtime), new Date(file.mtime));
      const realOpen = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementationOnce((path, flags) => {
        rmSync(file.absolutePath);
        if (kind === "symlink") symlinkSync(outside, file.absolutePath);
        else renameSync(outside, file.absolutePath);
        return realOpen(path, flags);
      });
      const read = vi.spyOn(fs, "readFileSync");
      const close = vi.spyOn(fs, "closeSync");
      expect(() => readLocalFileBytes(file, options())).toThrow(/changed/);
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  test("an observed directory junction swap is refused before any bytes are read", () => {
    const folder = join(root, "folder");
    const outside = join(directory, "outside");
    mkdirSync(folder);
    mkdirSync(outside);
    writeFileSync(join(folder, "note.txt"), "Allowed fictional note");
    writeFileSync(join(outside, "note.txt"), "Private fictional text");
    const file = discovered(join(folder, "note.txt"));
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((path, flags) => {
      renameSync(folder, `${folder}-old`);
      symlinkSync(outside, folder, "junction");
      return realOpen(path, flags);
    });
    const read = vi.spyOn(fs, "readFileSync");
    expect(() => readLocalFileBytes(file, options())).toThrow(/changed/);
    expect(read).not.toHaveBeenCalled();
  });

  test("refuses an observed nonregular final path before opening", () => {
    const file = original();
    rmSync(file.absolutePath);
    mkdirSync(file.absolutePath);
    const open = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readFileSync");
    expect(() => readLocalFileBytes(file, options())).toThrow(/changed/);
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  test("a protected configured root cannot bypass the absolute-path policy", () => {
    const protectedRoot = join(directory, "AppData");
    mkdirSync(protectedRoot);
    const path = join(protectedRoot, "settings.json");
    writeFileSync(path, '{"fictional":"private"}');
    const file = discovered(path);
    const read = vi.spyOn(fs, "readFileSync");
    expect(() =>
      readLocalFileBytes(file, { roots: [protectedRoot], platform: "win32", env: {} }),
    ).toThrow(/protected/);
    expect(read).not.toHaveBeenCalled();
  });
});

test.each(["file symlink", "directory junction"] as const)(
  "a %s replacing tracked data retains prior records across repeated incomplete scans",
  async (kind) => {
    const folder = kind === "directory junction" ? join(root, "folder") : root;
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "note.txt");
    writeFileSync(path, "Fictional selected note");
    const file = discovered(path);
    writeFileSync(
      join(root, "gone.txt"),
      "A fictional sibling removed during the unsafe replacement",
    );
    const source = await definition.create!({
      accountId: "host",
      sourceId: SourceId("local-files:host"),
      providerId: ProviderId("local-files:host"),
      config: { roots: [root], exclude: [] },
    });
    const first = await source.sync(null);
    const id = first.documents.find((document) => document.title === "note.txt")!.externalId;
    rmSync(join(root, "gone.txt"));
    const outside = join(directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "note.txt"), "Fictional private text outside the chosen folder");
    if (kind === "directory junction") {
      renameSync(folder, join(directory, "parked-folder"));
      symlinkSync(outside, folder, "junction");
    } else {
      rmSync(file.absolutePath);
      symlinkSync(join(outside, "note.txt"), file.absolutePath);
    }
    const read = vi.spyOn(fs, "readFileSync");
    let cursor = first.cursor;
    for (let cycle = 0; cycle < 3; cycle++) {
      const page = await source.sync(cursor);
      expect(page.documents).toEqual([]);
      expect(page.deletedExternalIds ?? []).toEqual([]);
      expect(page.presentExternalIds).toEqual([id]);
      expect(page.issues).toEqual([]);
      expect((page.cursor as LocalFilesSyncCursor).fileMap[file.absolutePath]?.stableId).toBe(id);
      cursor = page.cursor;
    }
    expect(read).not.toHaveBeenCalled();
    const excluded = await definition.create!({
      accountId: "host",
      sourceId: SourceId("local-files:host"),
      providerId: ProviderId("local-files:host"),
      config: {
        roots: [root],
        exclude: [kind === "directory junction" ? "folder/**" : "note.txt"],
      },
    });
    const removed = await excluded.sync(cursor);
    expect(removed.presentExternalIds).toEqual([]);
    expect((removed.cursor as LocalFilesSyncCursor).fileMap[file.absolutePath]).toBeUndefined();
  },
);

test("an in-root alias cannot expose a protected configuration subtree", async () => {
  original();
  const protectedDirectory = join(root, ".config");
  mkdirSync(protectedDirectory);
  writeFileSync(join(protectedDirectory, "settings.json"), '{"fictional":"private"}');
  symlinkSync(protectedDirectory, join(root, "ordinary-name"), "junction");
  const source = await definition.create!({
    accountId: "host",
    sourceId: SourceId("local-files:host"),
    providerId: ProviderId("local-files:host"),
    config: { roots: [root], exclude: [] },
  });
  const read = vi.spyOn(fs, "readFileSync");
  const page = await source.sync(null);
  expect(page.documents.map(({ title }) => title)).toEqual(["note.txt"]);
  expect(page.documents[0]!.content).not.toContain('{"fictional":"private"}');
  expect(read).toHaveBeenCalledOnce();
});

test("a permanent never-indexed outside alias does not hide an unrelated sibling deletion", async () => {
  original();
  const removed = join(root, "removed.txt");
  writeFileSync(removed, "Fictional sibling to remove");
  const outside = join(directory, "outside.txt");
  writeFileSync(outside, "Fictional outside document");
  symlinkSync(outside, join(root, "permanent-alias.txt"));
  const source = await definition.create!({
    accountId: "host",
    sourceId: SourceId("local-files:host"),
    providerId: ProviderId("local-files:host"),
    config: { roots: [root], exclude: [] },
  });
  const first = await source.sync(null);
  expect(first.documents).toHaveLength(2);
  const kept = first.documents.find(({ title }) => title === "note.txt")!.externalId;
  rmSync(removed);
  let cursor = first.cursor;
  for (let cycle = 0; cycle < 3; cycle++) {
    const page = await source.sync(cursor);
    expect(page.documents).toEqual([]);
    expect(page.presentExternalIds).toEqual([kept]);
    expect(page.issues).toEqual([]);
    expect((page.cursor as LocalFilesSyncCursor).fileMap[removed]).toBeUndefined();
    cursor = page.cursor;
  }
});

test("a configured root replaced by an outside junction stays an actual root gap", async () => {
  const file = original();
  const source = await definition.create!({
    accountId: "host",
    sourceId: SourceId("local-files:host"),
    providerId: ProviderId("local-files:host"),
    config: { roots: [root], exclude: [] },
  });
  const first = await source.sync(null);
  const outside = join(directory, "different-folder");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.txt"), "Fictional outside note");
  renameSync(root, `${root}-old`);
  symlinkSync(outside, root, "junction");
  const read = vi.spyOn(fs, "readFileSync");
  const page = await source.sync(first.cursor);
  expect(page.documents).toEqual([]);
  expect(page.presentExternalIds).toBeUndefined();
  expect(page.deletedExternalIds ?? []).toEqual([]);
  expect((page.cursor as LocalFilesSyncCursor).fileMap[file.absolutePath]).toBeDefined();
  expect(page.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  expect(read).not.toHaveBeenCalled();
});

test("fresh access probes apply nested exclusion globs to native relative paths", async () => {
  const publicDirectory = join(root, "Nested", "Public");
  const privateDirectory = join(root, "Nested", "Private");
  mkdirSync(publicDirectory, { recursive: true });
  mkdirSync(privateDirectory, { recursive: true });
  const publicFile = join(publicDirectory, "note.txt");
  writeFileSync(publicFile, "Fictional public note");
  writeFileSync(join(privateDirectory, "note.txt"), "Fictional excluded note");
  const source = await definition.create!({
    accountId: "host",
    sourceId: SourceId("local-files:host"),
    providerId: ProviderId("local-files:host"),
    config: { roots: [root], exclude: ["Nested/Private/**"] },
  });
  const open = vi.spyOn(fs, "open");
  expect(await source.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
    status: "readable",
  });
  expect(open.mock.calls.map(([path]) => path)).toEqual([realpathSync(publicFile)]);
});

test("Windows exact identities distinguish rounded IDs and upgrade legacy cursors once", async () => {
  const firstId = 9_007_199_254_740_992n;
  const paths = [join(root, "one.txt"), join(root, "two.txt")];
  paths.forEach((path, index) => writeFileSync(path, `Fictional document ${index}`));
  const identities = new Map(paths.map((path, index) => [path, firstId + BigInt(index)]));
  const originalStat = fs.statSync;
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const originalOpen = fs.openSync;
  const descriptors = new Map<number, string>();
  const withIdentity = (result: fs.Stats | fs.BigIntStats | undefined, path: string) => {
    if (result === undefined) return result;
    const ino = identities.get(path);
    if (ino === undefined) return result;
    const big = typeof result.ino === "bigint";
    return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
      dev: big ? 42n : 42,
      ino: big ? ino : Number(ino),
    });
  };
  vi.spyOn(fs, "statSync").mockImplementation(((path, opts) =>
    withIdentity(originalStat(path, opts), String(path))) as typeof fs.statSync);
  vi.spyOn(fs, "lstatSync").mockImplementation(((path, opts) =>
    withIdentity(originalLstat(path, opts), String(path))) as typeof fs.lstatSync);
  vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    const fd = originalOpen(path, flags, mode);
    descriptors.set(fd, String(path));
    return fd;
  });
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd, opts) =>
    withIdentity(originalFstat(fd, opts), descriptors.get(fd) ?? "")) as typeof fs.fstatSync);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const create = (dataCutoff?: string) =>
      definition.create!({
        accountId: "host",
        sourceId: SourceId("local-files:host"),
        providerId: ProviderId("local-files:host"),
        config: { roots: [root], exclude: [] },
        ...(dataCutoff === undefined ? {} : { dataCutoff }),
      });
    const source = await create();
    const first = await source.sync(null);
    expect(first.documents.map((doc) => doc.externalId).sort()).toEqual([
      `ino:42:${firstId}`,
      `ino:42:${firstId + 1n}`,
    ]);
    const legacy = structuredClone(first.cursor) as LocalFilesSyncCursor;
    const legacyIds = paths.map((path, index) => {
      const entry = legacy.fileMap[path]!;
      delete entry.fileIdentity;
      entry.stableId = `legacy-${index}`;
      return entry.stableId;
    });
    const read = vi.spyOn(fs, "readFileSync");
    writeFileSync(join(root, "outside-cutoff.txt"), "Fictional old note outside the cutoff");
    const upgradedSource = await create("2099-01-01");
    const upgraded = await upgradedSource.sync(legacy);
    expect(read).toHaveBeenCalledTimes(2);
    expect(upgraded.documents).toEqual([]);
    const states = paths.map((path) => (upgraded.cursor as LocalFilesSyncCursor).fileMap[path]!);
    expect(
      (upgraded.cursor as LocalFilesSyncCursor).fileMap[join(root, "outside-cutoff.txt")],
    ).toBeUndefined();
    expect(states.map((state) => state.stableId)).toEqual(legacyIds);
    expect(states.map((state) => state.fileIdentity)).toEqual([
      `42:${firstId}`,
      `42:${firstId + 1n}`,
    ]);
    read.mockClear();
    const unchanged = await upgradedSource.sync(upgraded.cursor);
    expect(read).not.toHaveBeenCalled();
    expect(unchanged.documents).toEqual([]);
    expect(unchanged.cursor).toEqual(upgraded.cursor);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test.each([true, false])(
  "Windows case-sensitive=%s aliases preserve only the matching previously indexed entry",
  async (caseSensitive) => {
    original();
    const previousFolder = join(root, "Foo");
    mkdirSync(previousFolder);
    const historical = join(previousFolder, "historical.txt");
    writeFileSync(historical, "Fictional case-sensitive folder note");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const source = await definition.create!({
        accountId: "host",
        sourceId: SourceId("local-files:host"),
        providerId: ProviderId("local-files:host"),
        config: { roots: [root], exclude: [] },
      });
      const first = await source.sync(null);
      const keptId = first.documents.find((doc) => doc.title === "note.txt")!.externalId;
      const historicalId = first.documents.find(
        (doc) => doc.title === "historical.txt",
      )!.externalId;
      const oldPath = Object.entries((first.cursor as LocalFilesSyncCursor).fileMap).find(
        ([, state]) => state.stableId === historicalId,
      )![0];
      rmSync(previousFolder, { recursive: true });
      const outside = join(directory, "different-folder");
      mkdirSync(outside);
      writeFileSync(join(outside, "private.txt"), "Fictional outside text");
      const refused = join(root, "foo");
      symlinkSync(outside, refused, "junction");
      const nativeLstat = fs.lstatSync;
      // Model either NTFS per-directory case setting on every test host.
      // Both cases exercise real sync and real no-follow alias identities.
      vi.spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
        if (normalize(String(path)) === normalize(dirname(oldPath))) {
          if (caseSensitive)
            throw Object.assign(new Error("Fictional absent prefix"), { code: "ENOENT" });
          return nativeLstat(refused, options);
        }
        return nativeLstat(path, options);
      }) as typeof fs.lstatSync);
      const read = vi.spyOn(fs, "readFileSync");
      let cursor = first.cursor;
      for (let cycle = 0; cycle < 3; cycle++) {
        const page = await source.sync(cursor);
        expect(page.documents).toEqual([]);
        expect(page.presentExternalIds?.slice().sort()).toEqual(
          (caseSensitive ? [keptId] : [keptId, historicalId]).sort(),
        );
        expect((page.cursor as LocalFilesSyncCursor).fileMap[oldPath] !== undefined).toBe(
          !caseSensitive,
        );
        expect(page.issues).toEqual([]);
        cursor = page.cursor;
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);
