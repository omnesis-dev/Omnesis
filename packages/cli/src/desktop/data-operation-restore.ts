// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertManagedDesktopDataAuthority, readPackageVersion } from "@omnesis/core";
import { readDesktopRestoreFile } from "./restore-files.js";
import { readDesktopRestoreIntent } from "./restore-intent.js";
import { sameDesktopRoot } from "./retirement.js";
import { DesktopRestoreProtection } from "./restore-protection.js";
import { extractDesktopBackupArchive } from "./restore-archive.js";
import { DesktopRestoreEntries } from "./restore-entries.js";
import { DesktopRestoreStoreKeys } from "./restore-store-keys.js";
import { applyDesktopRestoreTransaction } from "./restore-transaction.js";
import { buildDesktopRestorePublication } from "./restore-publication.js";
import { assertDesktopRestoreCapacity, desktopRestoreExpandedBytes } from "./restore-capacity.js";
import type { DesktopDataRequest } from "./data-operation-channel.js";

const rootSchema = z
  .object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const payloadSchema = z
  .object({
    expandedBytes: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(1024 ** 4 + 16384 * 16384),
    sourceRootKey: z.string().min(1).max(512),
    stagingRoot: z.string().min(1).max(4096),
    protection: z
      .object({
        root: rootSchema,
        keyDigest: digest,
        markerDigest: digest,
        rootChangeTime: z.string().regex(/^\d+$/u),
      })
      .strict(),
  })
  .strict();
const ownerSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop-restore"),
    instance: z.string(),
    secretService: z.string(),
    importId: z.string().uuid(),
    root: rootSchema,
    directory: rootSchema,
  })
  .strict();

/** Independently authenticate the original owned ciphertext spool; never accept a caller's file map. */
export async function restoreUnderDesktopDataAuthority(
  request: DesktopDataRequest,
  signal: AbortSignal,
  dependencies: { authorize?: typeof assertManagedDesktopDataAuthority } = {},
): Promise<{ operationId: string; sourcesPaused: number; watchesPaused: number }> {
  const authorize = dependencies.authorize ?? assertManagedDesktopDataAuthority;
  authorize(request.profile, "restore", request.operationId);
  const payload = payloadSchema.parse(request.payload);
  const { profile, operationId } = request;
  let entries: DesktopRestoreEntries | undefined, keys: DesktopRestoreStoreKeys | undefined;
  try {
    const intent = await readDesktopRestoreIntent(profile);
    if (
      !intent ||
      intent.operationId !== operationId ||
      intent.phase !== "stopping" ||
      intent.backup !== null ||
      !sameDesktopRoot(intent.root, payload.protection.root) ||
      intent.targetKeyDigest !== payload.protection.keyDigest
    )
      throw new Error("The restore request changed");
    const id = basename(payload.stagingRoot);
    if (
      !z.string().uuid().safeParse(id).success ||
      payload.stagingRoot !== join(`${profile.configDir}.bootstrap`, "restore-imports", id)
    )
      throw new Error("The import is outside its owned slot");
    const directories = [
      dirname(dirname(payload.stagingRoot)),
      dirname(payload.stagingRoot),
      payload.stagingRoot,
    ];
    for (const path of directories) {
      const state = await lstat(path);
      if (
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        (state.mode & 0o077) !== 0 ||
        (process.getuid && state.uid !== process.getuid()) ||
        (await realpath(path)) !== resolve(path)
      )
        throw new Error("The import slot is not privately owned");
    }
    const metadata = await lstat(payload.stagingRoot, { bigint: true });
    const raw = await readDesktopRestoreFile(join(payload.stagingRoot, "owner.json"), 16_384);
    let owner: z.infer<typeof ownerSchema>;
    try {
      owner = ownerSchema.parse(JSON.parse(raw.toString("utf8")));
    } finally {
      raw.fill(0);
    }
    if (
      owner.importId !== id ||
      owner.instance !== profile.instance ||
      owner.secretService !== profile.secretService ||
      !sameDesktopRoot(owner.root, intent.root) ||
      owner.directory.device !== String(metadata.dev) ||
      owner.directory.inode !== String(metadata.ino)
    )
      throw new Error("The import slot belongs to a different operation");
    const protection = await DesktopRestoreProtection.capture(profile, signal);
    try {
      if (!protection.matchesProtection(payload.protection))
        throw new Error("The library protection changed");
      await assertDesktopRestoreCapacity(profile, {
        expandedBytes: payload.expandedBytes,
        snapshotBytes: 0,
        signal,
      });
      const directory = join(payload.stagingRoot, `operation-${operationId}`);
      await mkdir(directory, { mode: 0o700 });
      const archive = await extractDesktopBackupArchive({
        archivePath: join(payload.stagingRoot, "input.tar.enc"),
        destination: join(directory, "unpacked"),
        sha256: intent.archiveSha256,
        bytes: intent.archiveBytes,
        currentVersion: readPackageVersion(import.meta.url),
        signal,
        seal: {
          rootKey: protection.key(),
          scope: `desktop-restore:${id}:operation:${operationId}`,
        },
        inputProtection: { rootKey: protection.key(), scope: `desktop-restore:${id}:archive` },
      });
      if (desktopRestoreExpandedBytes(archive) > payload.expandedBytes)
        throw new Error("The expanded restore inventory changed");
      entries = new DesktopRestoreEntries(archive, protection.key(), signal, profile);
      await entries.adoptPrivateOperationSourceKey(payload.sourceRootKey);
      keys = await DesktopRestoreStoreKeys.prepare({
        profile,
        entries,
        directory: join(directory, "keys"),
        signal,
      });
      const ownedEntries = entries,
        ownedKeys = keys;
      return await applyDesktopRestoreTransaction(
        profile,
        {
          expandedBytes: desktopRestoreExpandedBytes(archive),
          adoptedOperationId: operationId,
          protection: payload.protection,
          stagingRoot: payload.stagingRoot,
          archiveSha256: archive.sha256,
          archiveBytes: archive.bytes,
          build: ({ signal: active }) =>
            buildDesktopRestorePublication({
              profile,
              archive,
              entries: ownedEntries,
              keys: ownedKeys,
              directory,
              signal: active,
            }),
        },
        signal,
        { authorize },
      );
    } finally {
      protection.close();
    }
  } finally {
    keys?.close();
    entries?.close();
    payload.sourceRootKey = "";
    if (
      request.payload &&
      typeof request.payload === "object" &&
      "sourceRootKey" in request.payload
    )
      request.payload.sourceRootKey = "";
  }
}
