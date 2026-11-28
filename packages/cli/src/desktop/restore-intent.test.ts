// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { realpath, mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import {
  desktopRestoreBlocked,
  readDesktopRestoreIntent,
  writeDesktopRestoreIntent,
  type DesktopRestoreIntent,
} from "./restore-intent.js";

let dir: string;
let profile: DesktopProfile;
let intent: DesktopRestoreIntent;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-restore-intent-")));
  profile = desktopProfile(dir);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  intent = {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "stopping",
    root: (await desktopRootIdentity(profile))!,
    targetKeyDigest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 512,
    backup: null,
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("every unfinished restore phase fences startup; only completed or explicitly rolled-back work permits it", async () => {
  expect(await desktopRestoreBlocked(profile)).toBe(false);
  for (const phase of [
    "stopping",
    "backed-up",
    "staged",
    "publishing",
    "published",
    "verifying",
    "rolling-back",
    "recovery-required",
  ] as const) {
    await writeDesktopRestoreIntent(profile, {
      ...intent,
      phase,
      backup: { manifestSha256: "c".repeat(64), bytes: 1024 },
    });
    expect(await desktopRestoreBlocked(profile)).toBe(true);
  }
  for (const phase of ["complete", "rolled-back"] as const) {
    await writeDesktopRestoreIntent(profile, {
      ...intent,
      phase,
      backup: { manifestSha256: "c".repeat(64), bytes: 1024 },
    });
    expect(await desktopRestoreBlocked(profile)).toBe(false);
  }
});

test("a missing protective snapshot cannot be represented as published or complete", async () => {
  await expect(
    writeDesktopRestoreIntent(profile, { ...intent, phase: "publishing" }),
  ).rejects.toThrow();
  await expect(
    writeDesktopRestoreIntent(profile, { ...intent, phase: "complete" }),
  ).rejects.toThrow();
  expect(await readDesktopRestoreIntent(profile)).toBeNull();
});

test("foreign, malformed and public records fail closed without accepting arbitrary startup permission", async () => {
  const path = join(`${profile.configDir}.bootstrap`, "restore.json");
  await writeFile(path, JSON.stringify({ ...intent, secretService: "foreign-test-service" }), {
    mode: 0o600,
  });
  await expect(desktopRestoreBlocked(profile)).rejects.toThrow("another managed library");
  await writeFile(path, "not-json", { mode: 0o600 });
  await expect(desktopRestoreBlocked(profile)).rejects.toThrow();
  await writeFile(path, JSON.stringify(intent));
  await chmod(path, 0o644);
  await expect(desktopRestoreBlocked(profile)).rejects.toThrow("private and owned by you");
});
