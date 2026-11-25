// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, statfs, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  produceEncryptedArtifact,
  readInstallRootKey,
  type CreateSecretStoreOptions,
} from "@omnesis/core";
import { readDesktopInstall } from "./bootstrap.js";
import { withDesktopPublication } from "./publication.js";
import { desktopRootIdentity, sameDesktopRoot, type DesktopRootIdentity } from "./retirement.js";
import { extractDesktopBackupArchive, type DesktopBackupArchive } from "./restore-archive.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRestoreImportSlot {
  kind: "desktopRestoreImport";
  importId: string;
  maxBytes: number;
}
interface ImportSlot {
  id: string;
  directory: string;
  identity: DesktopRootIdentity;
  target: DesktopRootIdentity;
  expires: number;
  maxBytes: number;
  state: "empty" | "reading" | "copied" | "validated";
  receipt?: { sha256: string; bytes: number };
  controller: AbortController;
  operation?: Promise<unknown>;
  timer?: NodeJS.Timeout;
}
/** Owned transport staging only. An unpacked archive has not been authorized for publication. */
export class DesktopRestoreImports {
  private readonly slots = new Map<string, ImportSlot>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly profile: DesktopProfile,
    private readonly dependencies: {
      readRootKey(options: CreateSecretStoreOptions): Promise<string | null>;
      onRelease?(id: string): void;
    } = { readRootKey: readInstallRootKey },
  ) {}
  private async rootKey(): Promise<string> {
    const key = await this.dependencies.readRootKey({
      backend: "macos-keychain",
      service: this.profile.secretService,
      configDir: this.profile.configDir,
    });
    if (!key) throw new Error("Unlock or recover this Mac's library key before importing a backup");
    return key;
  }

  async prepare(signal: AbortSignal): Promise<DesktopRestoreImportSlot> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    return this.track(
      withDesktopPublication(this.profile, combined, async () => {
        const install = await readDesktopInstall(this.profile);
        if (install?.mode !== "home")
          throw new Error("Restore a backup on the Mac that owns your library");
        combined.throwIfAborted();
        await this.rootKey();
        const target = await desktopRootIdentity(this.profile);
        if (!target) throw new Error("The managed library is unavailable");
        for (const slot of this.slots.values())
          if (slot.expires < Date.now() && slot.state !== "reading") await this.release(slot.id);
        if (this.slots.size >= 2)
          throw new Error("Finish or cancel the selected backup before importing another");
        const parent = join(`${this.profile.configDir}.bootstrap`, "restore-imports");
        try {
          await mkdir(parent, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
        await privateDirectory(parent);
        const capacity = await statfs(parent, { bigint: true });
        // Input, extraction and a transformed private stage coexist. Never reserve the last free bytes.
        const maxBytes = Number(
          (capacity.bavail * capacity.bsize) / 4n < 1024n ** 4n
            ? (capacity.bavail * capacity.bsize) / 4n
            : 1024n ** 4n,
        );
        if (maxBytes < 1024 * 1024)
          throw new Error("Free storage before selecting a backup to restore");
        const id = randomUUID();
        const directory = join(parent, id);
        await mkdir(directory, { mode: 0o700 });
        const identity = await privateDirectory(directory);
        const slot: ImportSlot = {
          id,
          directory,
          identity,
          target,
          expires: Date.now() + 30 * 60_000,
          maxBytes,
          state: "empty",
          controller: new AbortController(),
        };
        this.slots.set(id, slot);
        slot.timer = setTimeout(() => {
          void this.track(this.cancel(id)).catch(() => undefined);
        }, 30 * 60_000);
        slot.timer.unref();
        if (combined.aborted) {
          await this.release(id);
          combined.throwIfAborted();
        }
        return {
          kind: "desktopRestoreImport",
          importId: id,
          maxBytes,
        };
      }),
    );
  }

  /** Native selection is local private-pipe authority, never a gateway path API. */
  async ingest(
    id: string,
    selection: DesktopRestoreFileSelection,
    callerSignal: AbortSignal,
  ): Promise<{ sha256: string; bytes: number }> {
    const slot = this.slots.get(id);
    if (
      !slot ||
      slot.state !== "empty" ||
      slot.expires < Date.now() ||
      !isAbsolute(selection.path) ||
      selection.path.includes("\0") ||
      selection.path.length > 4096 ||
      !Number.isSafeInteger(selection.bytes) ||
      selection.bytes <= 0 ||
      selection.bytes > slot.maxBytes ||
      ![
        selection.device,
        selection.inode,
        selection.mtimeSeconds,
        selection.mtimeNanoseconds,
      ].every((value) => /^\d+$/u.test(value))
    )
      throw new Error("Select the backup again before importing it");
    slot.state = "reading";
    const signal = AbortSignal.any([callerSignal, slot.controller.signal, this.lifetime.signal]);
    const operation = this.track(
      (async () => {
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          signal.throwIfAborted();
          await this.assertSlot(slot);
          const rootKey = await this.rootKey();
          file = await open(
            selection.path,
            constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
          );
          const before = await file.stat({ bigint: true });
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size !== BigInt(selection.bytes) ||
            String(before.dev) !== selection.device ||
            String(before.ino) !== selection.inode ||
            String(before.mtimeNs / 1_000_000_000n) !== selection.mtimeSeconds ||
            String(before.mtimeNs % 1_000_000_000n) !== selection.mtimeNanoseconds ||
            (process.getuid && before.uid !== BigInt(process.getuid())) ||
            (await realpath(selection.path)) !== resolve(selection.path)
          )
            throw new Error("Changed selected backup");
          const digest = createHash("sha256");
          let bytes = 0;
          await produceEncryptedArtifact(
            join(slot.directory, "input.tar.enc"),
            { rootKey, scope: `desktop-restore:${id}:archive` },
            async (output) => {
              for await (const raw of file!.createReadStream({ autoClose: false })) {
                signal.throwIfAborted();
                const chunk = Buffer.from(raw as Uint8Array);
                bytes += chunk.length;
                if (bytes > selection.bytes) throw new Error("Changed selected backup");
                digest.update(chunk);
                if (!output.write(chunk)) await once(output, "drain", { signal });
              }
            },
          );
          const after = await file.stat({ bigint: true });
          if (
            bytes !== selection.bytes ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            after.nlink !== 1n
          )
            throw new Error("Changed selected backup");
          await this.assertSlot(slot);
          signal.throwIfAborted();
          slot.receipt = { sha256: digest.digest("hex"), bytes };
          slot.state = "copied";
          return { ...slot.receipt };
        } catch {
          slot.state = "validated";
          await this.release(id);
          if (signal.aborted) signal.throwIfAborted();
          throw new Error("The selected backup changed or could not be imported; select it again");
        } finally {
          await file?.close();
        }
      })(),
    );
    slot.operation = operation;
    return operation;
  }

  /** Returns an internal stage; callers must still recover, reconcile and confirm it. */
  async unpack(
    id: string,
    options: { sha256: string; bytes: number; currentVersion: string; signal: AbortSignal },
  ): Promise<{ archive: DesktopBackupArchive; directory: string }> {
    const slot = this.slots.get(id);
    if (
      !slot ||
      slot.state !== "copied" ||
      slot.expires < Date.now() ||
      options.bytes > slot.maxBytes ||
      options.bytes !== slot.receipt?.bytes ||
      options.sha256 !== slot.receipt.sha256
    )
      throw new Error("Select the backup again before restoring it");
    slot.state = "reading";
    const signal = AbortSignal.any([options.signal, slot.controller.signal, this.lifetime.signal]);
    const operation = this.track(
      (async () => {
        try {
          await this.assertSlot(slot);
          const directory = join(slot.directory, "unpacked");
          const rootKey = await this.rootKey();
          const archive = await extractDesktopBackupArchive({
            ...options,
            signal,
            archivePath: join(slot.directory, "input.tar.enc"),
            seal: { rootKey, scope: `desktop-restore:${id}` },
            inputProtection: { rootKey, scope: `desktop-restore:${id}:archive` },
            destination: directory,
            limits: { maxBytes: slot.maxBytes },
          });
          await this.assertSlot(slot);
          signal.throwIfAborted();
          slot.state = "validated";
          return { archive, directory };
        } catch {
          slot.state = "validated";
          await this.release(id);
          if (signal.aborted) signal.throwIfAborted();
          throw new Error("The selected backup changed or could not be validated; select it again");
        }
      })(),
    );
    slot.operation = operation;
    return operation;
  }

  async withImport<T>(
    id: string,
    callerSignal: AbortSignal,
    work: (directory: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const slot = this.slots.get(id);
    if (!slot || slot.state !== "validated" || slot.expires < Date.now())
      throw new Error("Preview the selected backup again before restoring");
    clearTimeout(slot.timer);
    slot.state = "reading";
    const signal = AbortSignal.any([callerSignal, slot.controller.signal, this.lifetime.signal]);
    const operation = this.track(
      (async () => {
        try {
          await this.assertSlot(slot);
          signal.throwIfAborted();
          return await work(slot.directory, signal);
        } finally {
          slot.state = "validated";
          if (
            this.slots.has(id) &&
            !this.lifetime.signal.aborted &&
            !slot.controller.signal.aborted
          ) {
            slot.expires = Date.now() + 30 * 60_000;
            slot.timer = setTimeout(() => {
              void this.track(this.cancel(id)).catch(() => undefined);
            }, 30 * 60_000);
            slot.timer.unref();
          }
        }
      })(),
    );
    slot.operation = operation;
    return operation;
  }

  async cancel(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.controller.abort();
    await slot.operation?.catch(() => undefined);
    await this.release(id);
  }

  async release(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.state === "reading")
      throw new Error("Cancel backup validation before removing its temporary files");
    this.slots.delete(id);
    clearTimeout(slot.timer);
    this.dependencies.onRelease?.(id);
    // Never remove a replacement directory, even if it occupies our old staging name.
    if (!sameDesktopRoot(slot.identity, await privateDirectory(slot.directory)))
      throw new Error("The backup import folder changed; its replacement was retained");
    await rm(slot.directory, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.slots.keys()].map((id) => this.release(id)));
  }
  private async assertSlot(slot: ImportSlot): Promise<void> {
    if (
      !sameDesktopRoot(slot.identity, await privateDirectory(slot.directory)) ||
      !sameDesktopRoot(slot.target, await desktopRootIdentity(this.profile))
    )
      throw new Error("The library or selected backup folder changed");
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
}
async function privateDirectory(path: string): Promise<DesktopRootIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077n) !== 0n ||
    (process.getuid && metadata.uid !== BigInt(process.getuid())) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The backup import folder must be private and owned by this app");
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface DesktopRestoreFileSelection {
  path: string;
  device: string;
  inode: string;
  bytes: number;
  mtimeSeconds: string;
  mtimeNanoseconds: string;
}
