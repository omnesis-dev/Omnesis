// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { atomicWriteFile } from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopGenerationPath } from "./generation.js";
import {
  desktopRetirementPath,
  desktopRootIdentity,
  readDesktopRetirement,
  writeDesktopRetirement,
} from "./retirement.js";
import { writeDesktopPrivateRecord } from "./private-record.js";
import { withDesktopPublication } from "./publication.js";
import { DesktopFreshInstallService } from "./fresh-install.js";
import { resumeRetiredDesktop } from "./removal.js";
let home: string, profile: DesktopProfile;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-fresh-install-")));
  profile = desktopProfile(home);
  await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await eraseReceipt(profile);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
async function eraseReceipt(target: DesktopProfile) {
  await mkdir(target.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${target.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await writeFile(
    join(`${target.configDir}.bootstrap`, "process-authority.json"),
    JSON.stringify({
      version: 3,
      owner: "omnesis-desktop",
      instance: target.instance,
      secretService: target.secretService,
    }),
    { mode: 0o600 },
  );
  const root = (await desktopRootIdentity(target))!;
  await writeDesktopRetirement(target, {
    version: 1,
    owner: "omnesis-desktop",
    instance: target.instance,
    secretService: target.secretService,
    operationId: randomUUID(),
    mode: "erase-data",
    phase: "complete",
    root,
  });
  await rm(target.configDir, { recursive: true, force: true });
}
async function confirmation(service: DesktopFreshInstallService) {
  const preview = await service.preview(signal());
  expect(preview.available).toBe(true);
  return preview.confirmationId!;
}
const keysAbsent = () =>
  vi.fn(async (_profile: DesktopProfile, _metadataGeneration?: string) => true);
test("fresh confirmation rotates only the desktop generation and requires a new bridge before creating any key or corpus", async () => {
  const before = await readFile(desktopRetirementPath(profile)),
    keys = keysAbsent(),
    service = new DesktopFreshInstallService(profile, { keysAbsent: keys });
  const id = await confirmation(service);
  expect(await service.commit(id, signal())).toEqual({
    kind: "desktopFreshInstallResult",
    status: "ready-for-relaunch",
    relaunchRequired: true,
  });
  const next = desktopProfile(home);
  const generation = JSON.parse(
    await readFile(desktopGenerationPath(profile.configDir), "utf8"),
  ) as { generation: string };
  expect(keys.mock.calls).toEqual([
    [profile],
    [next, generation.generation],
    [profile],
    [next, generation.generation],
  ]);
  expect(next.configDir).toBe(profile.configDir);
  expect(next.instance).not.toBe(profile.instance);
  expect(next.secretService).not.toBe(profile.secretService);
  expect(await readFile(desktopRetirementPath(profile))).toEqual(before);
  expect(await readDesktopRetirement(next)).toBeNull();
  await expect(readDesktopRetirement(profile)).rejects.toMatchObject({
    code: "FRESH_INSTALL_RECONNECT_REQUIRED",
  });
  await expect(stat(next.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.commit(id, signal())).rejects.toThrow("Review and confirm");
});
test("old bridges cannot publish credentials or control records into the new configured identity", async () => {
  const service = new DesktopFreshInstallService(profile, { keysAbsent: keysAbsent() });
  await service.commit(await confirmation(service), signal());
  const next = desktopProfile(home);
  await mkdir(next.configDir, { mode: 0o700 });
  await writeFile(
    join(next.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      mode: "home",
      instance: next.instance,
      secretService: next.secretService,
      embedder: null,
      memoryLimitMb: 512,
      phase: "configured",
    }),
    { mode: 0o600 },
  );
  const stale = vi.fn(async () => {});
  await expect(withDesktopPublication(profile, signal(), stale)).rejects.toMatchObject({
    code: "FRESH_INSTALL_RECONNECT_REQUIRED",
  });
  expect(stale).not.toHaveBeenCalled();
  await expect(writeDesktopPrivateRecord(profile, "active-runtime.json", {})).rejects.toMatchObject(
    { code: "FRESH_INSTALL_RECONNECT_REQUIRED" },
  );
  const current = vi.fn(async () => {});
  await withDesktopPublication(next, signal(), current);
  expect(current).toHaveBeenCalledTimes(1);
});
test("crash before the final publication leaves the completed erase receipt blocking ordinary setup", async () => {
  const service = new DesktopFreshInstallService(profile, {
    keysAbsent: keysAbsent(),
    publish: async () => {
      throw new Error("invented pre-publication failure");
    },
  });
  await writeDesktopPrivateRecord(profile, "restore.json", {
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  await expect(service.commit(await confirmation(service), signal())).rejects.toThrow(
    "pre-publication",
  );
  expect(desktopProfile(home)).toEqual(profile);
  expect((await readDesktopRetirement(profile))?.phase).toBe("complete");
  await expect(stat(desktopGenerationPath(profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(profile.configDir)).rejects.toMatchObject({ code: "ENOENT" });
});
test("crash after durable publication never rolls the generation back or revives an old bridge", async () => {
  const service = new DesktopFreshInstallService(profile, {
    keysAbsent: keysAbsent(),
    publish: async (p, value) => {
      await atomicWriteFile(desktopGenerationPath(p.configDir), JSON.stringify(value), {
        mode: 0o600,
      });
      throw new Error("invented post-publication failure");
    },
  });
  await expect(service.commit(await confirmation(service), signal())).rejects.toThrow(
    "post-publication",
  );
  const next = desktopProfile(home);
  expect(next.instance).not.toBe(profile.instance);
  expect(await readDesktopRetirement(next)).toBeNull();
  await expect(writeDesktopPrivateRecord(profile, "restore.json", {})).rejects.toMatchObject({
    code: "FRESH_INSTALL_RECONNECT_REQUIRED",
  });
  await expect(stat(next.configDir)).rejects.toMatchObject({ code: "ENOENT" });
});
test("present keys, pending cleanup, changed corpus or absent confirmation never activates a fresh generation", async () => {
  const keys = keysAbsent(),
    service = new DesktopFreshInstallService(profile, { keysAbsent: keys });
  await expect(service.commit("a".repeat(64), signal())).rejects.toThrow("Review and confirm");
  const id = await confirmation(service);
  keys.mockResolvedValue(false);
  await expect(service.commit(id, signal())).rejects.toThrow("changed");
  keys.mockResolvedValue(true);
  const second = await confirmation(service);
  await mkdir(profile.configDir, { mode: 0o700 });
  await writeFile(join(profile.configDir, "unrelated"), "invented unrelated material", {
    mode: 0o600,
  });
  await expect(service.commit(second, signal())).rejects.toThrow("old library");
  expect(await readFile(join(profile.configDir, "unrelated"), "utf8")).toBe(
    "invented unrelated material",
  );
  await rm(profile.configDir, { recursive: true, force: true });
  const record = (await readDesktopRetirement(profile))!;
  await writeDesktopRetirement(profile, { ...record, phase: "keyCleanupPending" });
  expect((await service.preview(signal())).available).toBe(false);
  expect(desktopProfile(home)).toEqual(profile);
});
test("successive deliberate fresh installations rotate identities without changing headless or keep-data derivation", async () => {
  const first = new DesktopFreshInstallService(profile, { keysAbsent: keysAbsent() });
  await first.commit(await confirmation(first), signal());
  const next = desktopProfile(home);
  await eraseReceipt(next);
  const second = new DesktopFreshInstallService(next, { keysAbsent: keysAbsent() });
  await second.commit(await confirmation(second), signal());
  const final = desktopProfile(home);
  expect(new Set([profile.secretService, next.secretService, final.secretService]).size).toBe(3);
  expect(await readDesktopRetirement(final)).toBeNull();
  const unrelated = desktopProfile(join(home, "unrelated-home"));
  expect(desktopProfile(join(home, "unrelated-home"))).toEqual(unrelated);
});

test("completed keep-data retirement resumes the same identity without publishing a generation", async () => {
  await mkdir(profile.configDir, { mode: 0o700 });
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
  await writeDesktopRetirement(profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    mode: "keep-data",
    phase: "complete",
    root: (await desktopRootIdentity(profile))!,
  });
  expect(
    (await new DesktopFreshInstallService(profile, { keysAbsent: keysAbsent() }).preview(signal()))
      .available,
  ).toBe(false);
  expect(await resumeRetiredDesktop(profile, signal())).toBe(true);
  expect(desktopProfile(home)).toEqual(profile);
  await expect(stat(desktopGenerationPath(profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a generation receipt copied into another home is refused rather than adopting its key namespace", async () => {
  const service = new DesktopFreshInstallService(profile, { keysAbsent: keysAbsent() });
  await service.commit(await confirmation(service), signal());
  const foreignHome = join(home, "another-home"),
    foreign = desktopProfile(foreignHome);
  await mkdir(`${foreign.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await writeFile(
    desktopGenerationPath(foreign.configDir),
    await readFile(desktopGenerationPath(profile.configDir)),
    { mode: 0o600 },
  );
  expect(() => desktopProfile(foreignHome)).toThrow("generation record is invalid");
});

test("fresh installation resets only an erased generation's owned retention ledger", async () => {
  const service = new DesktopFreshInstallService(profile, { keysAbsent: keysAbsent() });
  const path = join(`${profile.configDir}.bootstrap`, "code-retention.json");
  await writeDesktopPrivateRecord(profile, "code-retention.json", {
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  await service.commit(await confirmation(service), signal());
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(writeDesktopPrivateRecord(profile, "code-retention.json", {})).rejects.toMatchObject(
    { code: "FRESH_INSTALL_RECONNECT_REQUIRED" },
  );
});

test("a completed erase without the prior verified-process certificate cannot mint a new generation", async () => {
  await rm(join(`${profile.configDir}.bootstrap`, "process-authority.json"));
  const keys = keysAbsent(),
    service = new DesktopFreshInstallService(profile, { keysAbsent: keys });
  await expect(service.preview(signal())).rejects.toMatchObject({
    code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED",
  });
  expect(keys).not.toHaveBeenCalled();
  await expect(stat(desktopGenerationPath(profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
