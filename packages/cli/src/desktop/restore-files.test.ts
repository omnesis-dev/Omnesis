// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { realpath, chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readDesktopRestoreFile } from "./restore-files.js";
let dir: string, path: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-file-")));
  path = join(dir, "owned");
  await writeFile(path, "invented private metadata", { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
test("accepts only a bounded private canonical regular descriptor", async () => {
  expect((await readDesktopRestoreFile(path, 128)).toString()).toBe("invented private metadata");
  await expect(readDesktopRestoreFile(path, 4)).rejects.toThrow("bounded");
  await expect(readDesktopRestoreFile(path, 1024 ** 3)).rejects.toThrow("bound is invalid");
  await chmod(path, 0o644);
  await expect(readDesktopRestoreFile(path, 128)).rejects.toThrow("private");
});
test("refuses symlink and multiply-linked files without reading another owner path", async () => {
  const alias = join(dir, "alias");
  await symlink(path, alias);
  await expect(readDesktopRestoreFile(alias, 128)).rejects.toThrow("canonical");
  await rm(alias, { force: true });
  await link(path, alias);
  await expect(readDesktopRestoreFile(path, 128)).rejects.toThrow("private");
});
test.skipIf(process.platform === "win32")(
  "a FIFO cannot block opening before descriptor validation",
  async () => {
    const fifo = join(dir, "selected-fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    await expect(readDesktopRestoreFile(fifo, 128)).rejects.toThrow("private");
  },
);
