// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  acquireGatewayLock,
  generateInstallRootKey,
  sealSecretFileValueAsync,
  decodeSecretTextFileValue,
  secretFileScope,
} from "@omnesis/core";
import { desktopRootIdentity, desktopRetirementPath, readDesktopRetirement } from "./retirement.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import { desktopProfile } from "./environment.js";
import {
  previewDesktopRemoval,
  removeDesktopInstall,
  resumeRetiredDesktop,
  finishDesktopErase,
  type DesktopRemovalDependencies,
} from "./removal.js";
import type { KeyringPurgeResult } from "../uninstall/keyring-purge.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-removal-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function signal() {
  return new AbortController().signal;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  const install = {
    version: 1,
    owner: "omnesis-desktop",
    mode: "home",
    instance: profile.instance,
    secretService: profile.secretService,
    embedder: null,
    memoryLimitMb: 512,
    phase: "configured",
  };
  await writeFile(join(profile.configDir, "desktop-install.json"), JSON.stringify(install), {
    mode: 0o600,
  });
  await writeFile(join(profile.configDir, "library.data"), "invented library material", {
    mode: 0o600,
  });
  const purge = vi.fn<() => Promise<KeyringPurgeResult>>(async () => ({
    markersCleared: true,
    rootKey: "deleted" as const,
    keptFor: [],
    notes: [],
  }));
  const stop = vi.fn(async () => false);
  const deps = {
    purge,
    stopDaemon: stop,
    authorize: () => {},
    executeErase: ((profile, id, signal, operations) =>
      finishDesktopErase(
        profile,
        id,
        signal,
        operations,
      )) satisfies DesktopRemovalDependencies["executeErase"],
  };
  const preview = (eraseData = false) =>
    previewDesktopRemoval(profile, { eraseData, signal: signal() }, deps);
  const remove = async (eraseData = false, extra = {}) => {
    const plan = await preview(eraseData);
    return removeDesktopInstall(
      profile,
      { eraseData, confirmationId: plan.confirmationId!, signal: signal(), ...extra },
      deps,
    );
  };
  return { profile, install, purge, stop, deps, preview, remove };
}

describe.skipIf(process.platform === "win32")("owned desktop removal", () => {
  test("a missing installation has nothing to remove and creates no new managed state", async () => {
    const profile = desktopProfile(home);
    expect(await previewDesktopRemoval(profile, { signal: signal() })).toMatchObject({
      available: false,
      confirmationId: null,
    });
    expect(await removeDesktopInstall(profile, { confirmationId: "", signal: signal() })).toEqual({
      status: "not-installed",
      data: "absent",
      keyring: "unchanged",
    });
    await expect(access(`${profile.configDir}.bootstrap`)).rejects.toThrow();
  });

  test("the default stops only the owned runtime and retains data, identity and keys", async () => {
    const f = await fixture();
    expect(await f.preview()).toMatchObject({ mode: "keep-data", dataKept: true, keyKept: true });
    expect(await f.remove()).toEqual({ status: "retired", data: "retained", keyring: "retained" });
    expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
      "invented library material",
    );
    expect(
      JSON.parse(await readFile(join(f.profile.configDir, "desktop-install.json"), "utf8")),
    ).toEqual(f.install);
    expect(f.purge).not.toHaveBeenCalled();
    expect(await readDesktopRetirement(f.profile)).toMatchObject({
      phase: "complete",
      mode: "keep-data",
      secretService: f.profile.secretService,
    });
    expect(await resumeRetiredDesktop(f.profile, signal())).toBe(true);
    expect(await readDesktopRetirement(f.profile)).toBeNull();
  });

  test("erase removes the managed root before its key and preserves source files and headless installs", async () => {
    const f = await fixture();
    const original = join(home, "original-source.txt");
    await writeFile(original, "original source fixture");
    await symlink(original, join(f.profile.configDir, "linked-original.txt"));
    const headless = join(home, ".config/omnesis");
    await mkdir(headless, { recursive: true });
    await writeFile(join(headless, "keep.txt"), "independent installation");
    f.purge.mockImplementationOnce(async () => {
      await expect(access(f.profile.configDir)).rejects.toThrow();
      return { markersCleared: true, rootKey: "deleted", keptFor: [], notes: [] };
    });
    expect(await f.remove(true)).toEqual({ status: "retired", data: "erased", keyring: "cleared" });
    expect(await readFile(original, "utf8")).toBe("original source fixture");
    expect(await readFile(join(headless, "keep.txt"), "utf8")).toBe("independent installation");
    expect(f.purge).toHaveBeenCalledExactlyOnceWith(f.profile);
    expect(await readDesktopRetirement(f.profile)).toMatchObject({
      phase: "complete",
      mode: "erase-data",
    });
    await expect(resumeRetiredDesktop(f.profile, signal())).rejects.toThrow(/Finish removing/);
  });

  test("the retirement is durable before waiting for the background process to drain", async () => {
    const f = await fixture();
    const requested = deferred<void>(),
      drained = deferred<boolean>();
    f.stop.mockImplementationOnce(async () => {
      requested.resolve();
      return drained.promise;
    });
    const remove = f.remove(true);
    await requested.promise;
    expect(await readDesktopRetirement(f.profile)).toMatchObject({ phase: "requested" });
    await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
    expect(f.purge).not.toHaveBeenCalled();
    drained.resolve(true);
    expect(await remove).toMatchObject({ data: "erased" });
  });

  test("a missing control listener is insufficient when an actual runtime owner still holds the lease", async () => {
    const f = await fixture();
    const directory = join(f.profile.configDir, "runtime-owner");
    await mkdir(directory, { mode: 0o700 });
    const lease = await acquireGatewayLock(directory, { waitMs: 0 });
    try {
      await expect(f.remove(true)).rejects.toThrow();
      await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
      expect(f.purge).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });

  test("confirmation cannot apply to a replacement installation at the same path", async () => {
    const f = await fixture();
    const plan = await f.preview(true);
    await rename(f.profile.configDir, `${f.profile.configDir}.previous`);
    await mkdir(f.profile.configDir, { mode: 0o700 });
    await writeFile(join(f.profile.configDir, "desktop-install.json"), JSON.stringify(f.install), {
      mode: 0o600,
    });
    await writeFile(join(f.profile.configDir, "keep-new.txt"), "replacement library");
    await expect(
      removeDesktopInstall(
        f.profile,
        { eraseData: true, confirmationId: plan.confirmationId!, signal: signal() },
        f.deps,
      ),
    ).rejects.toThrow(/changed/);
    expect(await readFile(join(f.profile.configDir, "keep-new.txt"), "utf8")).toBe(
      "replacement library",
    );
    expect(f.purge).not.toHaveBeenCalled();
  });

  test("unowned folders and symlinked roots are refused without stopping anything", async () => {
    const f = await fixture();
    await rm(join(f.profile.configDir, "desktop-install.json"));
    await expect(f.preview(true)).rejects.toThrow(/does not contain a managed/);
    expect(f.stop).not.toHaveBeenCalled();
    await rename(f.profile.configDir, `${f.profile.configDir}.keep`);
    await symlink(`${f.profile.configDir}.keep`, f.profile.configDir);
    await expect(f.preview(true)).rejects.toThrow(/private directory/);
    await expect(
      access(join(`${f.profile.configDir}.keep`, "library.data")),
    ).resolves.toBeUndefined();
  });

  test("partial deletion retains the key and a same-inode retirement can finish on retry", async () => {
    const f = await fixture();
    const plan = await f.preview(true);
    await expect(
      removeDesktopInstall(
        f.profile,
        { eraseData: true, confirmationId: plan.confirmationId!, signal: signal() },
        {
          ...f.deps,
          removeData: async (profile) => {
            await rm(join(profile.configDir, "desktop-install.json"));
            throw new Error("Invented filesystem removal refusal");
          },
        },
      ),
    ).rejects.toThrow(/filesystem removal refusal/);
    expect(f.purge).not.toHaveBeenCalled();
    expect(await readDesktopRetirement(f.profile)).toMatchObject({ phase: "stopped" });
    expect(await f.remove(true)).toMatchObject({ status: "retired", data: "erased" });
    expect(f.purge).toHaveBeenCalledOnce();
  });

  test("key cleanup failure remains explicit and retryable after the data is gone", async () => {
    const f = await fixture();
    f.purge.mockRejectedValueOnce(new Error("Invented locked Keychain"));
    expect(await f.remove(true)).toEqual({
      status: "key-cleanup-pending",
      data: "erased",
      keyring: "pending",
    });
    expect(await readDesktopRetirement(f.profile)).toMatchObject({ phase: "keyCleanupPending" });
    await expect(f.preview(false)).rejects.toThrow(/Finish the requested data removal/);
    await expect(resumeRetiredDesktop(f.profile, signal())).rejects.toThrow(/Finish removing/);
    expect(await f.remove(true)).toMatchObject({ status: "retired", keyring: "cleared" });
    expect(f.purge).toHaveBeenCalledTimes(2);
  });

  test("an unsuccessful purge result is not reported as cleared", async () => {
    const f = await fixture();
    f.purge.mockResolvedValueOnce({
      markersCleared: false,
      rootKey: "deleted",
      keptFor: [],
      notes: [],
    });
    expect(await f.remove(true)).toMatchObject({
      status: "key-cleanup-pending",
      keyring: "pending",
    });
  });

  test.each(["no-keyring", "kept"] as const)(
    "an OS key result of %s is not authoritative absence",
    async (rootKey) => {
      const f = await fixture();
      f.purge.mockResolvedValueOnce({ markersCleared: true, rootKey, keptFor: [], notes: [] });
      expect(await f.remove(true)).toMatchObject({
        status: "key-cleanup-pending",
        keyring: "pending",
      });
      expect((await readDesktopRetirement(f.profile))?.phase).toBe("keyCleanupPending");
    },
  );

  test("cancellation after data deletion records progress and keeps the remaining key", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const plan = await f.preview(true);
    await expect(
      removeDesktopInstall(
        f.profile,
        { eraseData: true, confirmationId: plan.confirmationId!, signal: controller.signal },
        {
          ...f.deps,
          removeData: async (profile) => {
            await rm(profile.configDir, { recursive: true });
            controller.abort();
          },
        },
      ),
    ).rejects.toThrow();
    expect(f.purge).not.toHaveBeenCalled();
    expect(await readDesktopRetirement(f.profile)).toMatchObject({ phase: "dataRemoved" });
    expect(await f.remove(true)).toMatchObject({ data: "erased", keyring: "cleared" });
  });

  test("a retirement from another namespace cannot authorize any cleanup", async () => {
    const f = await fixture();
    await f.remove();
    const file = desktopRetirementPath(f.profile);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, secretService: "dev.omnesis" }), {
      mode: 0o600,
    });
    await expect(f.preview(true)).rejects.toThrow(/another installation/);
    expect(f.purge).not.toHaveBeenCalled();
  });
});

test("erase refuses a live restore session before stop or key purge", async () => {
  const f = await fixture(),
    lease = await acquireDesktopRestoreSessionLease(f.profile, signal(), { createParent: true });
  try {
    await expect(f.remove(true)).rejects.toThrow("Cancel the active backup restore");
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.purge).not.toHaveBeenCalled();
    await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
  } finally {
    lease.release();
  }
});
test("erase removes only validated owned external restore staging before purging its key", async () => {
  const f = await fixture(),
    root = (await desktopRootIdentity(f.profile))!,
    id = randomUUID(),
    slot = join(`${f.profile.configDir}.bootstrap`, "restore-imports", id);
  await mkdir(slot, { recursive: true, mode: 0o700 });
  const directory = await import("./retirement.js").then(({ desktopRootIdentity }) =>
    desktopRootIdentity({ ...f.profile, configDir: slot }),
  );
  await writeFile(
    join(slot, "owner.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop-restore",
      instance: f.profile.instance,
      secretService: f.profile.secretService,
      importId: id,
      root,
      directory,
    }),
    { mode: 0o600 },
  );
  await writeFile(join(slot, "input.tar.enc"), "invented sealed backup", { mode: 0o600 });
  f.purge.mockImplementation(async () => {
    await expect(access(slot)).rejects.toThrow();
    return { markersCleared: true, rootKey: "deleted", keptFor: [], notes: [] };
  });
  expect(await f.remove(true)).toMatchObject({ data: "erased", keyring: "cleared" });
});
test("unknown or replaced external staging retains the library and protection key", async () => {
  const f = await fixture(),
    slot = join(`${f.profile.configDir}.bootstrap`, "restore-imports", randomUUID());
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await writeFile(join(slot, "unrecognized"), "invented unrelated material", { mode: 0o600 });
  await expect(f.remove(true)).rejects.toThrow();
  expect(f.purge).not.toHaveBeenCalled();
  await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
  expect(await readFile(join(slot, "unrecognized"), "utf8")).toBe("invented unrelated material");
});
test("keep-data removal retains pending restore staging and its protection key", async () => {
  const f = await fixture(),
    slot = join(`${f.profile.configDir}.bootstrap`, "restore-imports", randomUUID());
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await writeFile(join(slot, "input.tar.enc"), "invented pending sealed backup", { mode: 0o600 });
  expect(await f.remove(false)).toMatchObject({ data: "retained", keyring: "retained" });
  expect(await readFile(join(slot, "input.tar.enc"), "utf8")).toBe(
    "invented pending sealed backup",
  );
  expect(f.purge).not.toHaveBeenCalled();
});

test("a completed OS key purge invalidates the same-process secret-file root cache", async () => {
  const f = await fixture();
  let activeRoot: string | null = generateInstallRootKey();
  const path = join(f.profile.configDir, "invented-secret.json"),
    raw = await sealSecretFileValueAsync("invented secret contents", {
      rootKey: activeRoot,
      scope: secretFileScope(path, f.profile.configDir),
    });
  const options = {
    backend: "macos-keychain" as const,
    service: f.profile.secretService,
    configDir: f.profile.configDir,
    runCommand: async (_command: string, args: string[]) =>
      args[0] === "-h"
        ? { code: 0, stdout: "", stderr: "" }
        : activeRoot
          ? { code: 0, stdout: activeRoot, stderr: "" }
          : { code: 44, stdout: "", stderr: "" },
  };
  expect(await decodeSecretTextFileValue(path, raw, options)).toBe("invented secret contents");
  f.purge.mockImplementation(async () => {
    activeRoot = null;
    return { markersCleared: true, rootKey: "deleted", keptFor: [], notes: [] };
  });
  expect(await f.remove(true)).toMatchObject({ keyring: "cleared" });
  await expect(decodeSecretTextFileValue(path, raw, options)).rejects.toThrow(
    "without the install root key",
  );
});

test("the controller retains its session across host handoff while releasing the install lease", async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  f.deps.executeErase = async (profile, id, active, operations) => {
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect((await readDesktopRetirement(profile))?.operationId).toBe(id);
    await expect(acquireDesktopRestoreSessionLease(profile, active)).rejects.toMatchObject({
      code: "RESTORE_BUSY",
    });
    entered.resolve();
    await release.promise;
    return finishDesktopErase(profile, id, active, operations);
  };
  const pending = f.remove(true);
  await entered.promise;
  expect(f.purge).not.toHaveBeenCalled();
  await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
  release.resolve();
  expect(await pending).toMatchObject({ data: "erased", keyring: "cleared" });
  const lease = await acquireDesktopRestoreSessionLease(f.profile, signal());
  lease.release();
});

test("an unavailable native operation adapter leaves retirement pending and never purges keys", async () => {
  const f = await fixture();
  const plan = await f.preview(true);
  await expect(
    removeDesktopInstall(
      f.profile,
      { eraseData: true, confirmationId: plan.confirmationId!, signal: signal() },
      {
        purge: f.purge,
        stopDaemon: f.stop,
      },
    ),
  ).rejects.toThrow("protected data operation did not finish");
  expect(f.purge).not.toHaveBeenCalled();
  expect((await readDesktopRetirement(f.profile))?.phase).toBe("requested");
  await expect(access(join(f.profile.configDir, "library.data"))).resolves.toBeUndefined();
});

test("key-cleanup retry retains a new folder that appears after the host inspected absent data", async () => {
  const f = await fixture();
  f.purge.mockRejectedValueOnce(new Error("Invented locked keyring"));
  expect(await f.remove(true)).toMatchObject({ keyring: "pending" });
  f.stop.mockImplementation(async () => {
    if (f.stop.mock.calls.length === 4) {
      await mkdir(f.profile.configDir, { mode: 0o700 });
      await writeFile(join(f.profile.configDir, "unrelated"), "invented unrelated material", {
        mode: 0o600,
      });
    }
    return false;
  });
  await expect(f.remove(true)).rejects.toThrow("folder changed during cleanup");
  expect(f.purge).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.profile.configDir, "unrelated"), "utf8")).toBe(
    "invented unrelated material",
  );
});
