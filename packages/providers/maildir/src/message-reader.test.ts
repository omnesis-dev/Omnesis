// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readWindowsRegularFilePrefix } from "@omnesis/core";
import { readMessagePrefix } from "./message-reader.js";

vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  readWindowsRegularFilePrefix: vi.fn(),
}));
let root: string;
let path: string;
beforeEach(() => {
  vi.mocked(readWindowsRegularFilePrefix).mockReset();
  root = mkdtempSync(join(tmpdir(), "maildir-read-boundary-"));
  path = join(root, "message");
  writeFileSync(path, "Subject: invented\n\nmessage bytes");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("Windows uses the held-parent native reader for both prefix and full message limits", async () => {
  vi.mocked(readWindowsRegularFilePrefix).mockResolvedValue({
    bytes: Buffer.from("Subject:"),
    size: 128n,
  });
  for (const limit of [8, 32 * 1024 * 1024]) {
    expect(await readMessagePrefix(path, limit, "win32")).toEqual({
      bytes: Buffer.from("Subject:"),
      size: 128,
    });
    expect(readWindowsRegularFilePrefix).toHaveBeenLastCalledWith(path, limit);
  }
});

test("a refused native path never falls back to a path-based JavaScript read", async () => {
  const refused = Object.assign(new Error("Invented unsafe path"), { code: "EUNSAFEPATH" });
  vi.mocked(readWindowsRegularFilePrefix).mockRejectedValue(refused);
  // The actual file is readable. Returning its bytes after native refusal would
  // silently remove the Windows containment boundary.
  await expect(readMessagePrefix(path, 100, "win32")).rejects.toBe(refused);
});

test.skipIf(process.platform === "win32")(
  "POSIX still bounds the native regular-file read and refuses leaf links",
  async () => {
    expect(await readMessagePrefix(path, 8)).toEqual({ bytes: Buffer.from("Subject:"), size: 32 });
    symlinkSync(path, join(root, "alias"));
    await expect(readMessagePrefix(join(root, "alias"), 100)).rejects.toMatchObject({
      code: "ELOOP",
    });
    mkdirSync(join(root, "folder"));
    await expect(readMessagePrefix(join(root, "folder"), 100)).rejects.toMatchObject({
      code: "ENOTREGULAR",
    });
    expect(readWindowsRegularFilePrefix).not.toHaveBeenCalled();
  },
);
