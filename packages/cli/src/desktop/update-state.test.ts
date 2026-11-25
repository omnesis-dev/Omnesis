// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { desktopProfile } from "./environment.js";
import {
  desktopUpdateStateSchema,
  desktopRuntimeEpoch,
  desktopUpdateEpochDisposition,
  desktopUpdateStatePath,
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-state-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function record(): DesktopUpdateState {
  const profile = desktopProfile(home);
  return {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "verified",
    mode: "home",
    oldEpoch: "a".repeat(64),
    candidateEpoch: "b".repeat(64),
    oldVersion: "1.2.2",
    candidateVersion: "1.2.3",
    artifactSha256: "c".repeat(64),
    root: { device: "1", inode: "2" },
    backup: null,
  };
}
test("runtime epoch comes from the immutable executable directory, never ambient environment", () => {
  expect(desktopRuntimeEpoch(`/example/runtime/${"a".repeat(64)}/node`)).toBe("a".repeat(64));
  expect(desktopRuntimeEpoch("/usr/local/bin/node")).toBeNull();
});
test("every phase fences old and candidate epochs according to migration and backup boundaries", () => {
  const state = record();
  expect(desktopUpdateEpochDisposition(null, null)).toBe("allow");
  for (const phase of ["verified", "resumed"] as const) {
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.oldEpoch)).toBe("allow");
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.candidateEpoch)).toBe("block");
  }
  for (const phase of ["stopping", "recovery-required"] as const) {
    for (const epoch of [state.oldEpoch, state.candidateEpoch])
      expect(desktopUpdateEpochDisposition({ ...state, phase }, epoch)).toBe("block");
  }
  for (const phase of ["backed-up", "installer-opened"] as const) {
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.candidateEpoch)).toBe("claim");
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.oldEpoch)).toBe("block");
  }
  for (const phase of ["candidate-started", "complete"] as const) {
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.candidateEpoch)).toBe("allow");
    expect(desktopUpdateEpochDisposition({ ...state, phase }, state.oldEpoch)).toBe("block");
  }
  expect(desktopUpdateEpochDisposition(state, null)).toBe("block");
});
test.skipIf(process.platform === "win32")(
  "private journal persists outside the data root and validates installation identity",
  async () => {
    const profile = desktopProfile(home);
    await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
    const state = record();
    await writeDesktopUpdateState(profile, state);
    expect(await readDesktopUpdateState(profile)).toEqual(state);
    await expect(
      writeDesktopUpdateState(profile, { ...state, secretService: "dev.other.app" }),
    ).rejects.toThrow("another installation");
    await expect(
      writeDesktopUpdateState(profile, { ...state, phase: "candidate-started" }),
    ).rejects.toThrow("recovery snapshot");
  },
);
test.skipIf(process.platform === "win32")(
  "missing records are absent; symlinks, public permissions and oversized records are refused",
  async () => {
    const profile = desktopProfile(home);
    expect(await readDesktopUpdateState(profile)).toBeNull();
    await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
    const path = desktopUpdateStatePath(profile);
    await writeFile(path, JSON.stringify(record()), { mode: 0o644 });
    await expect(readDesktopUpdateState(profile)).rejects.toThrow("private");
    await chmod(path, 0o600);
    await writeFile(path, "x".repeat(16_385));
    await expect(readDesktopUpdateState(profile)).rejects.toThrow("too large");
    await rm(path);
    await symlink(join(home, "missing"), path);
    await expect(readDesktopUpdateState(profile)).rejects.toThrow();
  },
);

test("same-version replacement requires explicit current-application source and a different epoch", () => {
  const state = { ...record(), candidateVersion: "1.2.2" };
  expect(desktopUpdateStateSchema.safeParse(state).success).toBe(false);
  expect(
    desktopUpdateStateSchema.safeParse({ ...state, source: "current-application" }).success,
  ).toBe(true);
  expect(
    desktopUpdateStateSchema.safeParse({
      ...state,
      source: "current-application",
      candidateVersion: "1.2.1",
    }).success,
  ).toBe(false);
  expect(
    desktopUpdateStateSchema.safeParse({
      ...state,
      source: "current-application",
      candidateEpoch: state.oldEpoch,
    }).success,
  ).toBe(false);
});
