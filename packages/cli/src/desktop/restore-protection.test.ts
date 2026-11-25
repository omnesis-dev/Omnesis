// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import {
  generateInstallRootKey,
  renderSecureMarker,
  secureMarkerPath,
  type CreateSecretStoreOptions,
} from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopJournalPath } from "./profile.js";
import {
  DesktopRestoreProtection,
  type DesktopRestoreProtectionDependencies,
} from "./restore-protection.js";
let dir: string, profile: DesktopProfile, key: string;
let dependencies: DesktopRestoreProtectionDependencies;
const signal = new AbortController().signal;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-restore-protection-"));
  profile = desktopProfile(dir);
  key = generateInstallRootKey();
  await mkdir(join(profile.configDir, "keyring"), { recursive: true, mode: 0o700 });
  await writeFile(
    desktopJournalPath(profile),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      mode: "home",
      phase: "configured",
      embedder: null,
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  for (const kind of ["storage-encryption", "secret-files"] as const)
    await writeFile(secureMarkerPath(kind, profile.configDir), renderSecureMarker(kind, key), {
      mode: 0o600,
    });
  dependencies = {
    inspect: vi.fn((options: CreateSecretStoreOptions | undefined) => {
      expect(options).toEqual({
        backend: "macos-keychain" as const,
        service: profile.secretService,
        configDir: profile.configDir,
      });
      return Promise.resolve({
        keyName: "install-root-key-v1",
        present: true,
        valid: true,
        store: {
          requestedBackend: "macos-keychain" as const,
          backend: "macos-keychain" as const,
          available: true,
          secure: true,
          detail: "Invented fixture Keychain",
        },
      });
    }),
    read: vi.fn(() => Promise.resolve(key)),
    mirror: vi.fn(() => Promise.resolve("required" as const)),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
test("captures only an owned protected home and binds existing root, marker and filesystem identities without serializing key", async () => {
  const before = await readFile(secureMarkerPath("secret-files", profile.configDir));
  const protection = await DesktopRestoreProtection.capture(profile, signal, dependencies),
    identity = protection.identity();
  expect(identity.keyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(identity.markerDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(protection.key()).toBe(key);
  expect(JSON.stringify(protection)).toBe("{}");
  const current = await DesktopRestoreProtection.capture(profile, signal, dependencies);
  expect(current.matches(identity)).toBe(true);
  expect(await readFile(secureMarkerPath("secret-files", profile.configDir))).toEqual(before);
  protection.close();
  expect(() => protection.key()).toThrow("no longer held");
  current.close();
});
test("a missing mirror, legacy marker, foreign-root marker or public marker refuses without repair", async () => {
  const path = secureMarkerPath("secret-files", profile.configDir);
  for (const raw of [
    "omnesis.secret-files.required.v1\n",
    renderSecureMarker("secret-files", generateInstallRootKey()),
  ]) {
    await writeFile(path, raw);
    await expect(DesktopRestoreProtection.capture(profile, signal, dependencies)).rejects.toThrow(
      "protected and unlocked",
    );
    expect(await readFile(path, "utf8")).toBe(raw);
  }
  await writeFile(path, renderSecureMarker("secret-files", key));
  await chmod(path, 0o644);
  await expect(DesktopRestoreProtection.capture(profile, signal, dependencies)).rejects.toThrow(
    "protected and unlocked",
  );
  await chmod(path, 0o600);
  await expect(
    DesktopRestoreProtection.capture(profile, signal, {
      ...dependencies,
      mirror: () => Promise.resolve(null),
    }),
  ).rejects.toThrow("protected and unlocked");
});
test("another root or changed marker cannot reuse the protected confirmation identity", async () => {
  const captured = await DesktopRestoreProtection.capture(profile, signal, dependencies),
    identity = captured.identity();
  await writeFile(
    secureMarkerPath("secret-files", profile.configDir),
    renderSecureMarker("secret-files", key),
  );
  const changed = await DesktopRestoreProtection.capture(profile, signal, dependencies);
  expect(changed.matches(identity)).toBe(false);
  changed.close();
  captured.close();
});
test("joined installs and cancelled operations never become permission to restore or create keys", async () => {
  const journal = JSON.parse(await readFile(desktopJournalPath(profile), "utf8"));
  await writeFile(desktopJournalPath(profile), JSON.stringify({ ...journal, mode: "joined" }));
  await expect(DesktopRestoreProtection.capture(profile, signal, dependencies)).rejects.toThrow(
    "protected and unlocked",
  );
  expect(dependencies.read).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(
    DesktopRestoreProtection.capture(profile, controller.signal, dependencies),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("an install directory mutation invalidates an old confirmation even after its entry is removed", async () => {
  const first = await DesktopRestoreProtection.capture(profile, signal, dependencies),
    identity = first.identity();
  const path = join(profile.configDir, "invented-lifecycle-entry");
  await writeFile(path, "metadata", { mode: 0o600 });
  await rm(path, { force: true });
  const after = await DesktopRestoreProtection.capture(profile, signal, dependencies);
  expect(after.matches(identity)).toBe(false);
  expect(after.matchesProtection(identity)).toBe(true);
  first.close();
  after.close();
});
