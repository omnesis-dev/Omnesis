// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGatewayLock } from "@omnesis/core";
import { afterEach, describe, expect, test } from "vitest";
import { retireDesktopApplication } from "./application-retirement.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity, readDesktopRetirement } from "./retirement.js";
import { readDesktopUpdateState, writeDesktopUpdateState } from "./update-state.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture(installed = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-app-retirement-")));
  homes.push(home);
  const profile = desktopProfile(home);
  if (installed) {
    await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(profile.configDir, "desktop-install.json"),
      JSON.stringify({
        version: 1,
        owner: "omnesis-desktop",
        mode: "home",
        instance: profile.instance,
        secretService: profile.secretService,
        embedder: null,
        memoryLimitMb: 512,
        phase: "configured",
      }),
      { mode: 0o600 },
    );
    await writeFile(join(profile.configDir, "library.data"), "invented sealed library", {
      mode: 0o600,
    });
  }
  return profile;
}
describe.skipIf(process.platform === "win32")("native application retirement", () => {
  test("an unused removed shell does not create managed state", async () => {
    const profile = await fixture(false);
    expect(await retireDesktopApplication(profile, signal())).toBe("absent");
    await expect(access(`${profile.configDir}.bootstrap`)).rejects.toThrow();
  });
  test("confirmed stop is followed by all real leases; personal data remains", async () => {
    const profile = await fixture();
    expect(await retireDesktopApplication(profile, signal(), { stop: async () => false })).toBe(
      "retired",
    );
    expect(await readDesktopRetirement(profile)).toMatchObject({
      mode: "keep-data",
      phase: "complete",
    });
    expect(await readFile(join(profile.configDir, "library.data"), "utf8")).toBe(
      "invented sealed library",
    );
  });
  test("a surviving standalone gateway leaves a durable pending fence rather than false success", async () => {
    const profile = await fixture();
    const owner = await acquireGatewayLock(profile.configDir);
    try {
      await expect(
        retireDesktopApplication(profile, signal(), { stop: async () => false }),
      ).rejects.toThrow();
      expect(await readDesktopRetirement(profile)).toMatchObject({
        mode: "keep-data",
        phase: "requested",
      });
    } finally {
      owner.release();
    }
    expect(await retireDesktopApplication(profile, signal(), { stop: async () => false })).toBe(
      "retired",
    );
  });
  test("Finder deletion during update quiesces without overwriting the update recovery intent", async () => {
    const profile = await fixture();
    await withDesktopInstallLease(profile, signal(), async () =>
      writeDesktopUpdateState(profile, {
        format: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId: randomUUID(),
        phase: "stopping",
        mode: "home",
        oldEpoch: "a".repeat(64),
        candidateEpoch: "b".repeat(64),
        oldVersion: "1.2.2",
        candidateVersion: "1.2.3",
        artifactSha256: "c".repeat(64),
        root: (await desktopRootIdentity(profile))!,
        backup: null,
      }),
    );
    expect(await retireDesktopApplication(profile, signal(), { stop: async () => false })).toBe(
      "stopped",
    );
    expect(await readDesktopRetirement(profile)).toBeNull();
    expect((await readDesktopUpdateState(profile))?.phase).toBe("stopping");
  });
});
