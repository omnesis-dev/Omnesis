// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  realpath,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopRootIdentity, type DesktopRootIdentity } from "./retirement.js";
import { removeDesktopRestoreStaging } from "./restore-staging.js";
let home: string, profile: DesktopProfile, root: DesktopRootIdentity, parent: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-staging-remove-")));
  profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  root = (await desktopRootIdentity(profile))!;
  parent = join(`${profile.configDir}.bootstrap`, "restore-imports");
  await mkdir(parent, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
async function slot() {
  const id = randomUUID(),
    directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const identity = (await desktopRootIdentity({ ...profile, configDir: directory }))!;
  await writeFile(
    join(directory, "owner.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop-restore",
      instance: profile.instance,
      secretService: profile.secretService,
      importId: id,
      root,
      directory: identity,
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "input.tar.enc"), "invented encrypted staging", { mode: 0o600 });
  return directory;
}
test("bounded cleanup makes explicit retryable progress instead of reporting erase while ciphertext remains", async () => {
  for (let i = 0; i < 33; i++) await slot();
  await expect(
    removeDesktopRestoreStaging(profile, root, new AbortController().signal),
  ).rejects.toMatchObject({ code: "RESTORE_CLEANUP_PENDING" });
  expect(await readdir(parent)).toHaveLength(1);
  await removeDesktopRestoreStaging(profile, root, new AbortController().signal);
  await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
});
test("a linked original is retained and unrecognized staging never authorizes recursive deletion", async () => {
  const original = join(home, "original.txt");
  await writeFile(original, "invented original source", { mode: 0o600 });
  const directory = await slot();
  await symlink(original, join(directory, "linked.enc"));
  await expect(
    removeDesktopRestoreStaging(profile, root, new AbortController().signal),
  ).rejects.toThrow("linked restore staging");
  expect(await readFile(original, "utf8")).toBe("invented original source");
  expect(await readFile(join(directory, "input.tar.enc"), "utf8")).toBe(
    "invented encrypted staging",
  );
});
test("copying a valid owner record to a replacement directory does not transfer directory ownership", async () => {
  const directory = await slot(),
    kept = join(home, "retained-slot");
  await rename(directory, kept);
  await mkdir(directory, { mode: 0o700 });
  await copyFile(join(kept, "owner.json"), join(directory, "owner.json"));
  await writeFile(join(directory, "unrelated"), "invented unrelated material", { mode: 0o600 });
  await expect(
    removeDesktopRestoreStaging(profile, root, new AbortController().signal),
  ).rejects.toThrow("was replaced");
  expect(await readFile(join(directory, "unrelated"), "utf8")).toBe("invented unrelated material");
});
