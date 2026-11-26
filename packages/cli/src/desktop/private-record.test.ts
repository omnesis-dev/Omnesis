// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { desktopProfileForGeneration } from "./generation.js";
import { readDesktopPrivateRecord, writeDesktopPrivateRecord } from "./private-record.js";
import { readDesktopRetirement } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

let root: string;
let profile: DesktopProfile;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-lifecycle-record-")));
  profile = desktopProfileForGeneration(join(root, "library"));
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a private regular lifecycle record still reaches its parser", async () => {
  await writeDesktopPrivateRecord(profile, "update.json", { step: "fixture" });
  expect(await readDesktopPrivateRecord(profile, "update.json", (value) => value)).toEqual({
    step: "fixture",
  });
});

test.skipIf(process.platform === "win32").each([
  {
    name: "lifecycle",
    file: "update.json",
    read: (p: DesktopProfile) => readDesktopPrivateRecord(p, "update.json", (value) => value),
    message: "The desktop lifecycle record must be private and owned by you",
  },
  {
    name: "retirement",
    file: "retirement.json",
    read: readDesktopRetirement,
    message: "The desktop retirement record must be private and owned by you",
  },
])("a $name FIFO refuses without waiting for a writer", async ({ file, read, message }) => {
  const path = join(`${profile.configDir}.bootstrap`, file);
  execFileSync("mkfifo", ["-m", "600", path]);
  let neededWriter = false;
  let writer: Promise<void> | undefined;
  // Release a regressed blocking open so the test cannot strand a filesystem worker.
  const rescue = setTimeout(() => {
    neededWriter = true;
    writer = open(path, constants.O_RDWR | constants.O_NONBLOCK).then((file) => file.close());
  }, 2_000);
  try {
    await expect(read(profile)).rejects.toThrow(message);
    expect(neededWriter).toBe(false);
  } finally {
    clearTimeout(rescue);
    await writer;
  }
});
