// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { probeTreeReadAccess } from "./read-access-tree.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "read-access-tree-"));
  roots.push(path);
  return path;
}

test("opens matching descendants freshly without reading or copying their contents", async () => {
  const root = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "note.md"), "unparsed content");
  await writeFile(join(root, "ignored.bin"), "ignored");
  const open = vi.spyOn(fs, "open");
  const read = vi.spyOn(fs, "readFile");
  const copy = vi.spyOn(fs, "copyFile");
  const options = {
    roots: [{ path: root }],
    signal: new AbortController().signal,
    fileExtensions: [".md"],
  };
  expect(await probeTreeReadAccess(options)).toEqual({ status: "readable" });
  expect(await probeTreeReadAccess(options)).toEqual({ status: "readable" });
  expect(open.mock.calls.map(([path]) => path)).toEqual([
    join(root, "nested", "note.md"),
    join(root, "nested", "note.md"),
  ]);
  expect(read).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
});

test("does not bless a readable root whose matching descendant is denied", async () => {
  const root = await fixture();
  await writeFile(join(root, "note.md"), "fixture");
  const open = vi.spyOn(fs, "open").mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    (callback as (error: Error) => void)(
      Object.assign(new Error("private path"), { code: "EACCES" }),
    );
  });
  const options = {
    roots: [{ path: root }],
    signal: new AbortController().signal,
    fileExtensions: [".md"],
  };
  expect(await probeTreeReadAccess(options)).toEqual({ status: "denied" });
  open.mockRestore();
  expect(await probeTreeReadAccess(options)).toEqual({ status: "readable" });
});

test("bounds discovery across the whole tree and refuses symlinks", async () => {
  const root = await fixture();
  await mkdir(join(root, "first"));
  await mkdir(join(root, "second"));
  await Promise.all(
    Array.from({ length: 128 }, (_, index) =>
      Promise.all([
        writeFile(join(root, "first", `${index}.md`), ""),
        writeFile(join(root, "second", `${index}.md`), ""),
      ]),
    ),
  );
  expect(
    await probeTreeReadAccess({
      roots: [{ path: root }],
      signal: new AbortController().signal,
      fileExtensions: [".md"],
    }),
  ).toEqual({ status: "unavailable" });
  const linked = await fixture();
  await symlink(root, join(linked, "outside"));
  expect(
    await probeTreeReadAccess({
      roots: [{ path: linked }],
      signal: new AbortController().signal,
      fileExtensions: [".md"],
    }),
  ).toEqual({ status: "unavailable" });
});

test("honors exclusions, missing optional roots and cancellation without parsing", async () => {
  const root = await fixture();
  await symlink(root, join(root, "excluded"));
  const options = {
    roots: [{ path: root }, { path: join(root, "missing"), optional: true }],
    signal: new AbortController().signal,
    fileExtensions: [".md"],
    exclude: (path: string) => path === "excluded",
  };
  expect(await probeTreeReadAccess(options)).toEqual({ status: "readable" });
  expect(
    await probeTreeReadAccess({
      ...options,
      roots: [{ path: join(root, "missing"), optional: true }],
    }),
  ).toEqual({ status: "unavailable" });
  expect(await probeTreeReadAccess({ ...options, signal: AbortSignal.abort() })).toEqual({
    status: "unavailable",
  });
});

test("optional means missing is allowed, not that permission denials are ignored", async () => {
  const root = await fixture();
  vi.spyOn(fsPromises, "opendir").mockRejectedValueOnce(
    Object.assign(new Error("private directory"), { code: "EACCES" }),
  );
  expect(
    await probeTreeReadAccess({
      roots: [{ path: root, optional: true }],
      signal: new AbortController().signal,
      fileExtensions: [".md"],
    }),
  ).toEqual({ status: "denied" });
});

test("deep discovery is unavailable instead of partially verified", async () => {
  const root = await fixture();
  await mkdir(join(root, ...Array.from({ length: 33 }, () => "nested")), { recursive: true });
  expect(
    await probeTreeReadAccess({
      roots: [{ path: root }],
      signal: new AbortController().signal,
      fileExtensions: [".md"],
    }),
  ).toEqual({ status: "unavailable" });
});
