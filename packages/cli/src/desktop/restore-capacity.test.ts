// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpath, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import {
  assertDesktopRestoreCapacity,
  desktopRestoreExpandedBytes,
  desktopRestoreReserveBytes,
} from "./restore-capacity.js";
import type { DesktopBackupArchive } from "./restore-archive.js";
let home: string, profile: DesktopProfile;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-capacity-")));
  profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile.configDir, "omnesis.json"),
    JSON.stringify({ gateway: { minFreeDiskMb: 8 } }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
test("uses the owner's existing write reserve and the additional expanded stage/backstop budget", async () => {
  const reserve = 8n * 1024n * 1024n,
    expanded = 1024,
    snapshot = 4096;
  expect(await desktopRestoreReserveBytes(profile)).toBe(reserve);
  const required = reserve + 3n * BigInt(expanded) + BigInt(snapshot);
  await expect(
    assertDesktopRestoreCapacity(
      profile,
      { expandedBytes: expanded, snapshotBytes: snapshot, signal: signal() },
      { capacity: async () => ({ bavail: required, bsize: 1n }) },
    ),
  ).resolves.toBeUndefined();
  await expect(
    assertDesktopRestoreCapacity(
      profile,
      { expandedBytes: expanded, snapshotBytes: snapshot, signal: signal() },
      { capacity: async () => ({ bavail: required - 1n, bsize: 1n }) },
    ),
  ).rejects.toMatchObject({ code: "RESTORE_CAPACITY_REQUIRED" });
});
test("expanded authenticated entries and envelope overhead dominate a small archive receipt", () => {
  const archive: Pick<DesktopBackupArchive, "files" | "bytes"> = {
    files: new Map([
      ["data", 100_000_000],
      ["metadata", 1024],
    ]),
    bytes: 1024,
  };
  expect(desktopRestoreExpandedBytes(archive)).toBe(100_001_024 + 2 * 16_384);
  archive.bytes = 200_000_000;
  expect(desktopRestoreExpandedBytes(archive)).toBe(200_000_000);
  archive.files = new Map([["invalid", -1]]);
  expect(() => desktopRestoreExpandedBytes(archive)).toThrow("Free more storage");
});
test("default reserve matches gateway policy and malformed/unsafe capacity never authorizes writes", async () => {
  await writeFile(join(profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
  expect(await desktopRestoreReserveBytes(profile)).toBe(500n * 1024n * 1024n);
  await expect(
    assertDesktopRestoreCapacity(profile, {
      expandedBytes: Number.MAX_VALUE,
      snapshotBytes: 0,
      signal: signal(),
    }),
  ).rejects.toMatchObject({ code: "RESTORE_CAPACITY_REQUIRED" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    assertDesktopRestoreCapacity(profile, {
      expandedBytes: 0,
      snapshotBytes: 0,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
