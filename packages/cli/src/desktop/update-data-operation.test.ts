// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import {
  writeDesktopUpdateState,
  readDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import {
  measureDesktopUpdateSnapshot,
  createDesktopUpdateSnapshot,
  desktopUpdateSnapshotPath,
  MAX_MANIFEST_BYTES,
} from "./update-snapshot.js";
import {
  desktopRestoreReserveBytes,
  DESKTOP_RESTORE_ENTRY_HEADROOM_BYTES,
} from "./restore-capacity.js";
import { finishDesktopUpdateSnapshot } from "./update-data-operation.js";
import { desktopEpochMayStart } from "./update-admission.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-capacity-")));
  homes.push(home);
  const profile = desktopProfile(home),
    signal = new AbortController().signal;
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  await writeFile(
    join(profile.configDir, "omnesis.json"),
    JSON.stringify({ gateway: { minFreeDiskMb: 7 } }),
    { mode: 0o600 },
  );
  await writeFile(join(profile.configDir, "omnesis.db"), "fictional encrypted fixture store", {
    mode: 0o600,
  });
  const state: DesktopUpdateState = {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "stopping",
    mode: "home",
    oldEpoch: "a".repeat(64),
    candidateEpoch: "b".repeat(64),
    oldVersion: "1.0.0",
    candidateVersion: "1.0.1",
    artifactSha256: "c".repeat(64),
    root: (await desktopRootIdentity(profile))!,
    backup: null,
  };
  await writeDesktopUpdateState(profile, state);
  const inventory = await measureDesktopUpdateSnapshot(profile, signal);
  const reserve = await desktopRestoreReserveBytes(profile);
  const copyBytes = BigInt(
    inventory.bytes +
      (inventory.entries + 2) * DESKTOP_RESTORE_ENTRY_HEADROOM_BYTES +
      MAX_MANIFEST_BYTES,
  );
  const snapshot = vi.fn(createDesktopUpdateSnapshot),
    stop = vi.fn(async () => true);
  return { profile, state, signal, inventory, copyBytes, reserve, snapshot, stop };
}

test("update host refuses disk pressure after successful earlier measurement before first copied byte", async () => {
  const f = await fixture();
  const available = vi.fn(async () => f.reserve - 1n);
  await expect(
    finishDesktopUpdateSnapshot(f.profile, f.state.operationId, f.signal, {
      authorize: () => {},
      stop: f.stop,
      snapshot: f.snapshot,
      available,
    }),
  ).rejects.toThrow("write reserve");
  expect(f.stop).toHaveBeenCalled();
  expect(available).toHaveBeenCalledWith(f.profile);
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(await readDesktopUpdateState(f.profile)).toEqual(f.state);
  expect(await desktopEpochMayStart(f.profile, f.state.oldEpoch)).toBe(false);
  await expect(
    realpath(desktopUpdateSnapshotPath(f.profile, f.state.operationId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("growing library is remeasured under exclusive ownership rather than using preview size", async () => {
  const f = await fixture();
  await writeFile(join(f.profile.configDir, "added-store"), Buffer.alloc(8192), { mode: 0o600 });
  const previewFree = f.copyBytes + f.reserve + 1n;
  await expect(
    finishDesktopUpdateSnapshot(f.profile, f.state.operationId, f.signal, {
      authorize: () => {},
      stop: f.stop,
      snapshot: f.snapshot,
      available: async () => previewFree,
    }),
  ).rejects.toThrow("recovery copy");
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(await readDesktopUpdateState(f.profile)).toEqual(f.state);
});

test("measured snapshot plus existing configured reserve admits an actual verified recovery copy", async () => {
  const f = await fixture();
  expect(f.reserve).toBe(7n * 1024n * 1024n);
  const result = await finishDesktopUpdateSnapshot(f.profile, f.state.operationId, f.signal, {
    authorize: () => {},
    stop: f.stop,
    snapshot: f.snapshot,
    available: async () => f.copyBytes + f.reserve,
  });
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(result.phase).toBe("backed-up");
  expect(result.backup?.bytes).toBe(f.inventory.bytes);
});

test("cancelled capacity measurement does not start snapshot publication", async () => {
  const f = await fixture(),
    controller = new AbortController();
  await expect(
    finishDesktopUpdateSnapshot(f.profile, f.state.operationId, controller.signal, {
      authorize: () => {},
      stop: f.stop,
      snapshot: f.snapshot,
      available: async () => {
        controller.abort();
        return f.copyBytes + f.reserve;
      },
    }),
  ).rejects.toThrow();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(await readDesktopUpdateState(f.profile)).toEqual(f.state);
});

test("many tiny files whose logical bytes fit cannot consume the configured reserve through allocation overhead", async () => {
  const f = await fixture();
  const directory = join(f.profile.configDir, "tiny-files");
  await mkdir(directory, { mode: 0o700 });
  for (let index = 0; index < 200; index++)
    await writeFile(join(directory, String(index)), "x", { mode: 0o600 });
  const current = await measureDesktopUpdateSnapshot(f.profile, f.signal);
  expect(current.entries).toBeGreaterThan(200);
  const available = BigInt(current.bytes + MAX_MANIFEST_BYTES) + f.reserve + 1024n;
  expect(available).toBeGreaterThan(BigInt(current.bytes) + f.reserve);
  await expect(
    finishDesktopUpdateSnapshot(f.profile, f.state.operationId, f.signal, {
      authorize: () => {},
      stop: f.stop,
      snapshot: f.snapshot,
      available: async () => available,
    }),
  ).rejects.toThrow("write reserve");
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(await readDesktopUpdateState(f.profile)).toEqual(f.state);
});
