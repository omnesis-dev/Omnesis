// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: vi.fn(original.readFileSync),
    openSync: vi.fn(original.openSync),
    readSync: vi.fn(original.readSync),
    closeSync: vi.fn(original.closeSync),
  };
});
vi.mock("@omnesis/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/core")>()),
  readStorageKey: vi.fn(async () => null),
}));
import { inspectMessageStore } from "./message-store.js";

const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const header = Buffer.from("SQLite format 3\0");
let root: string;
let path: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fs.readSync).mockReset().mockImplementation(originalFs.readSync);
  root = await mkdtemp(join(tmpdir(), "archive-header-"));
  path = join(root, "store.db");
  await writeFile(path, header);
  // A sparse tail distinguishes the header from the complete archive without allocating it.
  await truncate(path, 1024 * 1024);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("A header inspection must not read the complete archive");
  });
});
afterEach(async () => {
  // Close only descriptors this fixture observed opening, even if an assertion exposes a leak.
  const closed = new Set(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd));
  for (const result of vi.mocked(fs.openSync).mock.results) {
    if (result.type === "return" && !closed.has(result.value)) originalFs.closeSync(result.value);
  }
  vi.mocked(fs.readSync).mockReset().mockImplementation(originalFs.readSync);
  vi.mocked(fs.readFileSync).mockImplementation(originalFs.readFileSync);
  await rm(root, { recursive: true, force: true });
});

test("plaintext inspection reads exactly the 16-byte header and closes its read-only handle", async () => {
  await expect(inspectMessageStore(root)).resolves.toMatchObject({ state: "plaintext" });
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.openSync).toHaveBeenCalledExactlyOnceWith(path, "r");
  const fd = vi.mocked(fs.openSync).mock.results[0]!.value;
  expect(fs.readSync).toHaveBeenCalledExactlyOnceWith(fd, expect.any(Buffer), 0, 16, 0);
  expect(vi.mocked(fs.readSync).mock.calls[0]![1].byteLength).toBe(16);
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fd);
});

test("an ordinary header read failure is propagated after the owned handle closes", async () => {
  const failure = new Error("invented header read failure");
  vi.mocked(fs.readSync).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(inspectMessageStore(root)).rejects.toBe(failure);
  const fd = vi.mocked(fs.openSync).mock.results[0]!.value;
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fd);
});

test("a short header read cannot classify an incomplete SQLite signature as plaintext", async () => {
  vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
    const buffer = args[1];
    if (!Buffer.isBuffer(buffer)) throw new Error("Expected a bounded header buffer");
    header.copy(buffer, 0, 0, 15);
    return 15;
  });
  await expect(inspectMessageStore(root)).resolves.toMatchObject({ state: "locked" });
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.closeSync).toHaveBeenCalledOnce();
});

test("a file smaller than the SQLite header needs no file-content read", async () => {
  await truncate(path, 8);
  await expect(inspectMessageStore(root)).resolves.toMatchObject({ state: "locked" });
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(fs.readSync).not.toHaveBeenCalled();
  expect(fs.closeSync).not.toHaveBeenCalled();
});
