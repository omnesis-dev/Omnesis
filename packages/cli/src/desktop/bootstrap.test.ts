// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDesktopInstall, readDesktopInstall } from "./bootstrap.js";
import { desktopProfile, desktopJournalPath } from "./profile.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "omnesis-desktop-bootstrap-"));
  roots.push(home);
  const profile = desktopProfile(home);
  const controller = new AbortController();
  const state = {
    keyName: "install-root-key-v1" as const,
    store: {
      requestedBackend: "macos-keychain" as const,
      backend: "macos-keychain" as const,
      available: true,
      secure: true,
      detail: "test-keychain",
      writeExposure: "process-argv" as const,
    },
    present: true,
    valid: true,
  };
  const dependencies = {
    ensureInstallRootKey: vi.fn(async () => ({ ...state, created: true })),
    inspectInstallRootKey: vi.fn(async () => state),
    markSecretFileEncryptionRequired: vi.fn(async () => {}),
    markStorageEncryptionRequired: vi.fn(async () => {}),
  };
  const options = {
    mode: "home" as const,
    totalMemoryBytes: 8 * 1024 ** 3,
    signal: controller.signal,
  };
  return { profile, controller, dependencies, options };
}

describe("encrypted desktop bootstrap", () => {
  it("arms both protections before writing configuration and preserves edits on retry", async () => {
    const { profile, options, dependencies } = await fixture();
    dependencies.markStorageEncryptionRequired.mockImplementation(async () => {
      await expect(stat(join(profile.configDir, "omnesis.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    const install = await prepareDesktopInstall(profile, options, dependencies);
    expect(install.phase).toBe("configured");
    expect(dependencies.ensureInstallRootKey).toHaveBeenCalledWith(
      expect.objectContaining({ service: profile.secretService }),
    );
    expect(dependencies.markStorageEncryptionRequired.mock.invocationCallOrder[0]).toBeGreaterThan(
      dependencies.markSecretFileEncryptionRequired.mock.invocationCallOrder[0]!,
    );
    const path = join(profile.configDir, "omnesis.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.inference.allowRemoteInference).toBe(true);
    expect(config.inference.assignments.embedder).toBe(install.embedder);
    config.inference.assignments.agent = "example-model";
    await writeFile(path, JSON.stringify(config));
    dependencies.markStorageEncryptionRequired.mockResolvedValue();
    await prepareDesktopInstall(profile, options, dependencies);
    expect(JSON.parse(await readFile(path, "utf8")).inference.assignments.agent).toBe(
      "example-model",
    );
    expect(dependencies.ensureInstallRootKey).toHaveBeenCalledTimes(1);
    expect(dependencies.inspectInstallRootKey).toHaveBeenCalledTimes(1);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("resumes interrupted protection without configuring an unprotected library", async () => {
    const { profile, options, dependencies } = await fixture();
    dependencies.markStorageEncryptionRequired.mockRejectedValueOnce(new Error("Keychain locked"));
    await expect(prepareDesktopInstall(profile, options, dependencies)).rejects.toThrow(
      "Keychain locked",
    );
    expect((await readDesktopInstall(profile))?.phase).toBe("claimed");
    await expect(stat(join(profile.configDir, "omnesis.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await prepareDesktopInstall(profile, options, dependencies)).phase).toBe("configured");
  });

  it("requires recovery when a completed installation loses its key", async () => {
    const { profile, options, dependencies } = await fixture();
    await prepareDesktopInstall(profile, options, dependencies);
    dependencies.inspectInstallRootKey.mockResolvedValueOnce({
      ...(await dependencies.inspectInstallRootKey()),
      present: false,
      valid: false,
    });
    await expect(prepareDesktopInstall(profile, options, dependencies)).rejects.toThrow(/Keychain/);
    expect(dependencies.ensureInstallRootKey).toHaveBeenCalledTimes(1);
  });

  it("refuses unrelated existing files and leaves them intact", async () => {
    const { profile, options, dependencies } = await fixture();
    await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
    await writeFile(join(profile.configDir, "existing-data"), "unrelated");
    await expect(prepareDesktopInstall(profile, options, dependencies)).rejects.toThrow(
      /another installation/,
    );
    expect(await readFile(join(profile.configDir, "existing-data"), "utf8")).toBe("unrelated");
    expect(dependencies.ensureInstallRootKey).not.toHaveBeenCalled();
  });

  it("refuses a symbolic-link data root before writing keys or configuration", async () => {
    const { profile, options, dependencies } = await fixture();
    const target = join(roots.at(-1)!, "unrelated");
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(profile.configDir, ".."), { recursive: true });
    await symlink(target, profile.configDir);
    await expect(prepareDesktopInstall(profile, options, dependencies)).rejects.toThrow(
      /symbolic link/,
    );
    expect(dependencies.ensureInstallRootKey).not.toHaveBeenCalled();
  });

  it("does not change a home into a joining installation", async () => {
    const { profile, options, dependencies } = await fixture();
    await prepareDesktopInstall(profile, options, dependencies);
    await expect(
      prepareDesktopInstall(profile, { ...options, mode: "joined" }, dependencies),
    ).rejects.toThrow(/different role/);
  });

  it("does not mint keys after cancellation", async () => {
    const { profile, options, dependencies, controller } = await fixture();
    controller.abort();
    await expect(prepareDesktopInstall(profile, options, dependencies)).rejects.toThrow();
    expect(dependencies.ensureInstallRootKey).not.toHaveBeenCalled();
    expect(await readDesktopInstall(profile)).toBeNull();
  });

  it("rejects an identity record copied from a different installation", async () => {
    const { profile, options, dependencies } = await fixture();
    await prepareDesktopInstall(profile, options, dependencies);
    const record = JSON.parse(await readFile(desktopJournalPath(profile), "utf8"));
    record.secretService = "dev.omnesis";
    await writeFile(desktopJournalPath(profile), JSON.stringify(record));
    await expect(readDesktopInstall(profile)).rejects.toThrow(/identity/);
  });
});
