// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { desktopProfile } from "./environment.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopEpochMayStart, desktopUpdateBlocked } from "./update-admission.js";
import {
  desktopSourceDevelopment,
  readDesktopActiveRuntime,
  writeDesktopActiveRuntime,
} from "./update-active.js";
import { claimDesktopUpdateEpoch } from "./update-claim.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-active-epoch-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
describe.skipIf(process.platform === "win32")("active desktop runtime identity", () => {
  test("source development without a managed epoch is deliberate and identified by source layout", async () => {
    const profile = desktopProfile(home);
    expect(desktopSourceDevelopment()).toBe(true);
    expect(await desktopEpochMayStart(profile, null)).toBe(true);
    expect(await desktopUpdateBlocked(profile, null)).toBe(false);
    expect(await claimDesktopUpdateEpoch(profile, signal(), null)).toBe(true);
    expect(await readDesktopActiveRuntime(profile)).toBeNull();
  });
  test("an existing managed epoch rejects both an unmatched replacement and an undefined source epoch", async () => {
    const profile = desktopProfile(home);
    await withDesktopInstallLease(profile, signal(), () =>
      writeDesktopActiveRuntime(profile, "a".repeat(64), "1.2.2"),
    );
    expect(await desktopEpochMayStart(profile, "a".repeat(64))).toBe(true);
    expect(await desktopUpdateBlocked(profile, "a".repeat(64))).toBe(false);
    for (const epoch of [null, "b".repeat(64)]) {
      expect(await desktopEpochMayStart(profile, epoch)).toBe(false);
      expect(await desktopUpdateBlocked(profile, epoch)).toBe(true);
      expect(await claimDesktopUpdateEpoch(profile, signal(), epoch)).toBe(false);
    }
    expect((await readDesktopActiveRuntime(profile))?.epoch).toBe("a".repeat(64));
  });
  test("missing packaged metadata cannot claim a fabricated immutable epoch", async () => {
    const profile = desktopProfile(home);
    await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
    await expect(claimDesktopUpdateEpoch(profile, signal(), "a".repeat(64))).rejects.toThrow();
    expect(await readDesktopActiveRuntime(profile)).toBeNull();
  });
  test("a copied or corrupt marker fails closed rather than falling back to source development", async () => {
    const profile = desktopProfile(home);
    await withDesktopInstallLease(profile, signal(), () =>
      writeDesktopActiveRuntime(profile, "a".repeat(64), "1.2.2"),
    );
    const path = join(`${profile.configDir}.bootstrap`, "active-runtime.json");
    const active = (await readDesktopActiveRuntime(profile))!;
    await writeFile(path, JSON.stringify({ ...active, secretService: "dev.other.app" }), {
      mode: 0o600,
    });
    await expect(desktopEpochMayStart(profile, null)).rejects.toThrow("another installation");
    await writeFile(path, "{}", { mode: 0o600 });
    await expect(desktopEpochMayStart(profile, null)).rejects.toThrow();
  });
});
