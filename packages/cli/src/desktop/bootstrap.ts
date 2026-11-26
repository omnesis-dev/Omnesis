// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, mkdir, readFile, realpath, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { omnesisConfigSchema } from "@omnesis/config";
import {
  acquireGatewayLock,
  atomicWriteFile,
  ensureInstallRootKey,
  inspectInstallRootKey,
  markSecretFileEncryptionRequired,
  markStorageEncryptionRequired,
  secretFileEncryptionRequired,
  storageEncryptionRequired,
} from "@omnesis/core";
import { desktopJournalPath, recommendDesktopResources, type DesktopProfile } from "./profile.js";
import {
  assertDesktopProcessAuthority,
  certifyFreshDesktopProcessAuthority,
} from "./process-authority.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";

const installSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    mode: z.enum(["home", "joined"]),
    instance: z.string(),
    secretService: z.string(),
    embedder: z.string().nullable(),
    memoryLimitMb: z.number().int().min(256),
    phase: z.enum(["claimed", "protected", "configured"]),
    processAuthorityVersion: z.literal(3).optional(),
  })
  .strict();

export type DesktopInstall = z.infer<typeof installSchema>;

const protections = {
  ensureInstallRootKey,
  inspectInstallRootKey,
  markSecretFileEncryptionRequired,
  markStorageEncryptionRequired,
};

/** See #1313 — managed state and encryption precede the desktop's first daemon launch. */
export async function prepareDesktopInstall(
  profile: DesktopProfile,
  options: { mode: "home" | "joined"; totalMemoryBytes: number; signal: AbortSignal },
  dependencies: typeof protections = protections,
): Promise<DesktopInstall> {
  return withDesktopInstallLease(profile, options.signal, () =>
    prepareLockedInstall(profile, options, dependencies),
  );
}

export async function withDesktopInstallLease<T>(
  profile: DesktopProfile,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  // Use the existing process-identity lease in a separate folder: its lock
  // records must not make an otherwise fresh data directory look occupied.
  const lockDir = `${profile.configDir}.bootstrap`;
  signal.throwIfAborted();
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(lockDir);
  const lease = await acquireGatewayLock(lockDir, { signal });
  try {
    return await work();
  } finally {
    lease.release();
  }
}

async function prepareLockedInstall(
  profile: DesktopProfile,
  options: { mode: "home" | "joined"; totalMemoryBytes: number; signal: AbortSignal },
  dependencies: typeof protections,
): Promise<DesktopInstall> {
  const { signal } = options;
  signal.throwIfAborted();
  await assertDesktopMutationAllowed(profile);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(profile.configDir);
  const journalPath = desktopJournalPath(profile);
  const resources = recommendDesktopResources(options.totalMemoryBytes);
  let journal = await readDesktopInstall(profile);
  if (!journal) {
    // Claiming an arbitrary existing installation would let later uninstall or
    // config writes modify data the application never created.
    if ((await readdir(profile.configDir)).length !== 0) {
      throw new Error("This folder contains another installation; it cannot be managed by the app");
    }
    journal = {
      version: 1,
      owner: "omnesis-desktop",
      mode: options.mode,
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: options.mode === "home" ? resources.embedder.id : null,
      memoryLimitMb: resources.memoryLimitMb,
      phase: "claimed",
      processAuthorityVersion: 3,
    };
    await atomicWriteFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  }
  if (journal.phase === "claimed" && journal.processAuthorityVersion === 3)
    await certifyFreshDesktopProcessAuthority(profile, journal);
  await assertDesktopProcessAuthority(profile);
  if (journal.mode !== options.mode) {
    throw new Error(
      "This Mac already has a different role; changing the library's home is unavailable",
    );
  }

  // Revalidate the key even on a completed retry: a locked or missing Keychain
  // is a recovery state, never permission to boot a plaintext replacement.
  signal.throwIfAborted();
  const keyOptions = {
    backend: "macos-keychain" as const,
    service: profile.secretService,
    configDir: profile.configDir,
  };
  const key =
    journal.phase === "claimed" &&
    !secretFileEncryptionRequired(profile.configDir) &&
    !storageEncryptionRequired(profile.configDir)
      ? await dependencies.ensureInstallRootKey(keyOptions)
      : await dependencies.inspectInstallRootKey(keyOptions);
  if (!key.valid || !key.store.secure || key.store.backend !== "macos-keychain") {
    throw new Error("Unlock the macOS Keychain to protect your Omnesis library");
  }
  signal.throwIfAborted();
  await dependencies.markSecretFileEncryptionRequired(profile.configDir, keyOptions);
  await dependencies.markStorageEncryptionRequired(profile.configDir, keyOptions);
  signal.throwIfAborted();
  if (journal.phase === "claimed") {
    journal = { ...journal, phase: "protected" };
    await atomicWriteFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  }

  if (journal.phase === "protected") {
    const config = omnesisConfigSchema.parse({
      gateway: { memoryLimitMb: journal.memoryLimitMb, localMcp: { enabled: false } },
      inference: {
        allowRemoteInference: true,
        ...(journal.embedder ? { assignments: { embedder: journal.embedder } } : {}),
      },
    });
    // The install lease excludes another preparer. Preserve later settings
    // if power was lost between publishing config and recording completion.
    try {
      await assertPrivateFile(join(profile.configDir, "omnesis.json"));
      omnesisConfigSchema.parse(
        JSON.parse(await readFile(join(profile.configDir, "omnesis.json"), "utf8")),
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      await atomicWriteFile(
        join(profile.configDir, "omnesis.json"),
        JSON.stringify(config, null, 2),
        { mode: 0o600 },
      );
    }
    journal = { ...journal, phase: "configured" };
    await atomicWriteFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  }
  return journal;
}

export async function readDesktopInstall(profile: DesktopProfile): Promise<DesktopInstall | null> {
  const path = desktopJournalPath(profile);
  try {
    await assertOwnedDirectory(profile.configDir);
    await assertPrivateFile(path);
    const contents = await readFile(path, "utf8");
    if (contents.length > 16_384) throw new Error("Invalid desktop installation record");
    const journal = installSchema.parse(JSON.parse(contents));
    if (journal.instance !== profile.instance || journal.secretService !== profile.secretService) {
      throw new Error("The desktop installation identity does not match this folder");
    }
    return journal;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (await realpath(path)) !== resolve(path) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "The desktop data folder must be private, owned by you and not a symbolic link",
    );
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("The desktop installation record is not a private regular file");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
