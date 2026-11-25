// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  createRecoveryEnvelope,
  generateInstallRootKey,
  generateRecoveryCode,
  isInstallRootKey,
  renderSecureMarker,
  secureMarkerPath,
  type SecureMarkerKind,
} from "@omnesis/core";
import { desktopProfile } from "./environment.js";
import { DesktopRecoveryImportService } from "./recovery-import.js";
import { desktopRootIdentity, writeDesktopRetirement } from "./retirement.js";
import type { DesktopInstall } from "./bootstrap.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture(options: { existing?: string | null; mode?: "home" | "joined" } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-recovery-import-")));
  roots.push(home);
  const profile = desktopProfile(home);
  await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await mkdir(join(profile.configDir, "keyring"), { recursive: true, mode: 0o700 });
  const install = {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    mode: options.mode ?? "home",
    phase: "configured",
    embedder: null,
    memoryLimitMb: 512,
  } satisfies DesktopInstall;
  await writeFile(join(profile.configDir, "desktop-install.json"), JSON.stringify(install), {
    mode: 0o600,
  });
  const key = generateInstallRootKey();
  const code = generateRecoveryCode();
  const envelope = createRecoveryEnvelope(key, code);
  for (const kind of ["storage-encryption", "secret-files"] as const)
    await writeFile(secureMarkerPath(kind, profile.configDir), renderSecureMarker(kind, key), {
      mode: 0o600,
    });
  let existing = options.existing ?? null;
  const mirrors = new Map<SecureMarkerKind, "required">();
  const inspect = vi.fn(() =>
    Promise.resolve({
      keyName: "install-root-key-v1",
      present: existing !== null,
      valid: existing !== null && isInstallRootKey(existing),
      store: {
        requestedBackend: "macos-keychain" as const,
        backend: "macos-keychain" as const,
        available: true,
        secure: true,
        detail: "Fictional test Keychain",
        writeExposure: "process-argv" as const,
      },
    }),
  );
  const read = vi.fn(() => Promise.resolve(existing));
  const insert = vi.fn((value: string) => {
    if (existing !== null) return Promise.reject(new Error("Concurrent entry exists"));
    existing = value;
    return Promise.resolve();
  });
  const mirror = vi.fn((kind: SecureMarkerKind) => {
    mirrors.set(kind, "required");
    return Promise.resolve();
  });
  const readMirror = vi.fn((kind: SecureMarkerKind) => Promise.resolve(mirrors.get(kind) ?? null));
  const service = new DesktopRecoveryImportService(profile, {
    inspect,
    read,
    insert,
    mirror,
    readMirror,
  });
  return {
    profile,
    key,
    code,
    envelope,
    service,
    insert,
    mirror,
    mirrors,
    read,
    existing: () => existing,
    setExisting: (value: string | null) => {
      existing = value;
    },
  };
}

test("restores matching key and both Keychain marker mirrors without changing local markers", async () => {
  const f = await fixture();
  const before = await readFile(
    secureMarkerPath("storage-encryption", f.profile.configDir),
    "utf8",
  );
  await expect(f.service.restore(f.envelope, f.code, signal())).resolves.toEqual({
    kind: "desktopRecoveryImport",
    status: "restored",
  });
  expect(f.existing()).toBe(f.key);
  expect(f.mirrors.size).toBe(2);
  expect(await readFile(secureMarkerPath("storage-encryption", f.profile.configDir), "utf8")).toBe(
    before,
  );
  expect(f.insert).toHaveBeenCalledWith(f.key, {
    backend: "macos-keychain",
    configDir: f.profile.configDir,
    service: f.profile.secretService,
  });
});

test("wrong code or foreign key/markers refuses before Keychain mutation", async () => {
  const f = await fixture();
  await expect(f.service.restore(f.envelope, generateRecoveryCode(), signal())).rejects.toThrow();
  const other = createRecoveryEnvelope(generateInstallRootKey(), f.code);
  await expect(f.service.restore(other, f.code, signal())).rejects.toThrow("does not match");
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.mirror).not.toHaveBeenCalled();
});

test.each(["valid", "malformed"])("existing %s root entries are never replaced", async (kind) => {
  const existing = kind === "valid" ? generateInstallRootKey() : "malformed fictional entry";
  const f = await fixture({ existing });
  await expect(f.service.restore(f.envelope, f.code, signal())).rejects.toThrow("will not replace");
  expect(f.existing()).toBe(existing);
  expect(f.insert).not.toHaveBeenCalled();
});

test("already matching key repairs missing marker mirrors and reports no key replacement", async () => {
  const f = await fixture();
  f.setExisting(f.key);
  await expect(f.service.restore(f.envelope, f.code, signal())).resolves.toEqual({
    kind: "desktopRecoveryImport",
    status: "already-available",
  });
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.mirrors.size).toBe(2);
});

test.each(["missing", "corrupt", "legacy"])(
  "%s required-encryption marker refuses recovery",
  async (kind) => {
    const f = await fixture();
    const path = secureMarkerPath("secret-files", f.profile.configDir);
    if (kind === "missing") await rm(path, { force: true });
    else
      await writeFile(path, kind === "legacy" ? "omnesis.secret-files.required.v1\n" : "corrupt", {
        mode: 0o600,
      });
    await expect(f.service.restore(f.envelope, f.code, signal())).rejects.toThrow();
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.mirror).not.toHaveBeenCalled();
  },
);

test("cancellation and a joined profile never insert key material", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.service.restore(f.envelope, f.code, controller.signal)).rejects.toThrow();
  const joined = await fixture({ mode: "joined" });
  await expect(joined.service.restore(joined.envelope, joined.code, signal())).rejects.toThrow(
    "owns this library",
  );
  expect(f.insert).not.toHaveBeenCalled();
  expect(joined.insert).not.toHaveBeenCalled();
});

test("concurrent insertion and mirror failure never report restored success", async () => {
  const f = await fixture();
  const winner = generateInstallRootKey();
  f.insert.mockImplementation(() => {
    f.setExisting(winner);
    return Promise.reject(new Error("Concurrent entry exists"));
  });
  await expect(f.service.restore(f.envelope, f.code, signal())).rejects.toThrow("Concurrent");
  expect(f.existing()).toBe(winner);
  const partial = await fixture();
  partial.mirror.mockImplementation(() => Promise.reject(new Error("Locked marker mirror")));
  await expect(partial.service.restore(partial.envelope, partial.code, signal())).rejects.toThrow(
    "Locked marker",
  );
  expect(partial.existing()).toBe(partial.key);
});

test("retired installation cannot be revived through recovery import", async () => {
  const f = await fixture();
  await writeDesktopRetirement(f.profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: f.profile.instance,
    secretService: f.profile.secretService,
    operationId: "00000000-0000-4000-8000-000000000002",
    mode: "keep-data",
    phase: "complete",
    root: (await desktopRootIdentity(f.profile))!,
  });
  await expect(f.service.restore(f.envelope, f.code, signal())).rejects.toThrow("retired");
  expect(f.insert).not.toHaveBeenCalled();
});

test("a symbolic-link marker cannot redirect recovery verification", async () => {
  const f = await fixture();
  const path = secureMarkerPath("secret-files", f.profile.configDir);
  const target = join(f.profile.configDir, "original-marker");
  await writeFile(target, await readFile(path), { mode: 0o600 });
  await rm(path, { force: true });
  await symlink(target, path);
  await expect(f.service.restore(f.envelope, f.code, signal())).rejects.toThrow();
  expect(f.insert).not.toHaveBeenCalled();
});

test("cancellation after code validation still refuses before atomic insertion", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.read.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve(null);
  });
  await expect(f.service.restore(f.envelope, f.code, controller.signal)).rejects.toThrow();
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.mirror).not.toHaveBeenCalled();
});

test("cancellation after atomic insertion still completes fail-closed marker mirrors", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.insert.mockImplementation((key) => {
    f.setExisting(key);
    controller.abort();
    return Promise.resolve();
  });
  await f.service.restore(f.envelope, f.code, controller.signal);
  expect(controller.signal.aborted).toBe(true);
  expect(f.existing()).toBe(f.key);
  expect(f.mirrors.size).toBe(2);
});
