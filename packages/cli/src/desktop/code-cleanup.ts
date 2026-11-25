// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { desktopRootIdentity, readDesktopRetirement } from "./retirement.js";
import { desktopRestoreBlocked, readDesktopRestoreIntent } from "./restore-intent.js";
import { readDesktopActiveRuntime } from "./update-active.js";
import { desktopRuntimeEpoch, readDesktopUpdateState } from "./update-state.js";
import { verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import type { DesktopUpdateResult } from "./update-controller.js";

const execute = promisify(execFile);
const epochPattern = /^[a-f0-9]{64}$/u;
const codeManifestSchema = z
  .object({
    format: z.literal(1),
    codeUsageProtocol: z.literal(1),
    runtimeLauncher: z.literal("runtime-exec"),
  })
  .passthrough();
const ownershipSchema = z
  .object({
    format: z.literal(1),
    owner: z.literal("omnesis-desktop-application-archive"),
    epoch: z.string().regex(epochPattern),
    identity: z
      .object({
        device: z.number().int().safe(),
        inode: z.number().int().safe(),
        appDevice: z.number().int().safe(),
        appInode: z.number().int().safe(),
      })
      .strict(),
  })
  .strict();
const cleanupReceiptSchema = z
  .object({
    format: z.union([z.literal(1), z.literal(2)]),
    owner: z.literal("omnesis-desktop-runtime-cleanup"),
    epoch: z.string().regex(epochPattern),
    device: z.number().int().safe(),
    inode: z.number().int().safe(),
    archive: ownershipSchema.shape.identity.optional(),
  })
  .strict();
interface Epoch {
  epoch: string;
  bytes: number;
  identity: string;
  disposition: "keep" | "candidate" | "uncertain";
}
export interface DesktopCodeCleanupSummary {
  phase: "preview" | "complete";
  confirmationId?: string;
  reclaimableBytes: number;
  removedBytes: number;
  removedEpochs: number;
  retainedEpochs: number;
}
interface CleanupDependencies {
  epoch(): string | null;
  verifySnapshot: typeof verifyDesktopUpdateSnapshot;
  ready(signal: AbortSignal): Promise<{ phase: string; encrypted?: boolean }>;
  remove(
    profile: DesktopProfile,
    cache: string,
    current: string,
    epoch: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}
export class DesktopCodeCleanup {
  private readonly dependencies: CleanupDependencies;
  constructor(
    private readonly profile: DesktopProfile,
    operations: Pick<CleanupDependencies, "ready"> & Partial<CleanupDependencies>,
  ) {
    this.dependencies = {
      epoch: desktopRuntimeEpoch,
      verifySnapshot: verifyDesktopUpdateSnapshot,
      remove: async (profile, cache, current, epoch, signal) => {
        const executable = join(cache, current, "runtime-exec");
        // This fixed, inventory-bound adapter is the only deletion authority. No env executable override.
        if (process.execPath !== executable)
          throw new Error("Code cleanup requires the installed application runtime");
        try {
          await execute(executable, ["--gc-remove", epoch], {
            env: desktopEnvironment(profile),
            signal,
            timeout: 125_000,
            maxBuffer: 4096,
          });
          return true;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === 3) return false;
          throw new Error("Code cleanup is pending. Reopen the application and retry cleanup.", {
            cause: error,
          });
        }
      },
      ...operations,
    };
  }
  async handle(
    command: "updateCleanupPreview" | "updateCleanup",
    params: unknown,
    signal: AbortSignal,
  ): Promise<DesktopUpdateResult> {
    let id: string | undefined;
    if (command === "updateCleanup") {
      id = z
        .object({ confirmationId: z.string().regex(epochPattern) })
        .strict()
        .parse(params).confirmationId;
    } else {
      z.object({})
        .strict()
        .parse(params ?? {});
    }
    const ready = await this.dependencies.ready(signal);
    if (ready.phase !== "ready" || ready.encrypted !== true)
      throw new Error("Start a protected library before cleaning up application code");
    return withDesktopInstallLease(this.profile, signal, async () => {
      if (
        (await readDesktopRetirement(this.profile)) ||
        (await desktopRestoreBlocked(this.profile))
      )
        throw new Error("Finish removal or backup recovery before cleaning up application code");
      const current = this.dependencies.epoch();
      const state = await readDesktopUpdateState(this.profile);
      const active = await readDesktopActiveRuntime(this.profile);
      if (
        !current ||
        !state ||
        state.phase !== "complete" ||
        active?.epoch !== current ||
        state.candidateEpoch !== current
      )
        throw new Error("Verify the replacement application before cleaning up old code");
      if (!state.backup) throw new Error("The previous verified app needs its recovery snapshot");
      await this.dependencies.verifySnapshot(this.profile, {
        operationId: state.operationId,
        manifestSha256: state.backup.manifestSha256,
        signal,
      });
      const restore = await readDesktopRestoreIntent(this.profile);
      const protectedEpochs = new Set([
        current,
        active.epoch,
        state.oldEpoch,
        state.candidateEpoch,
        restore?.activation?.epoch,
      ]);
      const cache = join(dirname(this.profile.configDir), "Omnesis Desktop Runtime", "runtime");
      await privateDirectory(cache);
      const epochs = await inspectDesktopCodeEpochs(cache, protectedEpochs, signal);
      const root = await desktopRootIdentity(this.profile);
      if (!root || root.device !== state.root.device || root.inode !== state.root.inode)
        throw new Error("The library changed before code cleanup");
      const confirmationId = createHash("sha256")
        .update(JSON.stringify({ operationId: state.operationId, root, current, epochs }))
        .digest("hex");
      const candidates = epochs.filter((entry) => entry.disposition === "candidate");
      const summary: DesktopCodeCleanupSummary = {
        phase: id === undefined ? "preview" : "complete",
        confirmationId: id === undefined ? confirmationId : undefined,
        reclaimableBytes: candidates.reduce((bytes, entry) => bytes + entry.bytes, 0),
        removedBytes: 0,
        removedEpochs: 0,
        retainedEpochs: epochs.length,
      };
      if (id !== undefined) {
        if (id !== confirmationId)
          throw new Error("Code cleanup changed. Preview it again before continuing");
        for (const entry of candidates) {
          signal.throwIfAborted();
          if (await this.dependencies.remove(this.profile, cache, current, entry.epoch, signal)) {
            summary.removedBytes += entry.bytes;
            summary.removedEpochs++;
            summary.retainedEpochs--;
          }
        }
      }
      return {
        kind: "desktopUpdate",
        phase: "complete",
        currentVersion: active.productVersion,
        codeCleanup: summary,
        message:
          id === undefined
            ? "Cleanup removes only inactive application code. The current app, one previous verified app, recovery snapshots and personal backups are retained."
            : `Removed ${summary.removedEpochs} inactive code versions. Active or uncertain versions and all recovery snapshots and personal backups were retained.`,
      };
    });
  }
}

/** Bounded private code-only inventory. Kernel ownership is rechecked atomically by the native adapter. */
export async function inspectDesktopCodeEpochs(
  cache: string,
  protectedEpochs: ReadonlySet<string | null | undefined>,
  signal: AbortSignal,
): Promise<Epoch[]> {
  const names = (await readdir(cache)).sort();
  if (names.length > 2048) throw new Error("The code cache needs manual review before cleanup");
  const result: Epoch[] = [];
  const epochs = new Set(names.filter((name) => epochPattern.test(name)));
  for (const name of names) {
    const match = /^\.cleanup-([a-f0-9]{64})\.json$/u.exec(name);
    if (match) epochs.add(match[1]!);
  }
  for (const epoch of [...epochs].sort()) {
    signal.throwIfAborted();
    const runtime = join(cache, epoch),
      archive = join(dirname(cache), "applications", epoch);
    const receiptName = `.cleanup-${epoch}.json`;
    const receipt = names.includes(receiptName)
      ? cleanupReceiptSchema.parse(
          JSON.parse((await privateFile(join(cache, receiptName), 4096)).toString()),
        )
      : null;
    if (receipt && receipt.epoch !== epoch)
      throw new Error("An interrupted cleanup belongs to another code version");
    const info = await lstat(runtime).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && receipt)
        return null;
      throw error;
    });
    if (
      info &&
      (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid()))
    )
      throw new Error("An application code version has uncertain ownership");
    let disposition: Epoch["disposition"] = protectedEpochs.has(epoch) ? "keep" : "candidate";
    const identities = [String(info?.dev), String(info?.ino)];
    if (receipt) {
      identities.push(createHash("sha256").update(JSON.stringify(receipt)).digest("hex"));
      if (info && (receipt.device !== info.dev || receipt.inode !== info.ino))
        disposition = "uncertain";
      try {
        await privateDirectory(archive);
        const directory = await lstat(archive);
        if (
          !receipt.archive ||
          receipt.archive.device !== directory.dev ||
          receipt.archive.inode !== directory.ino
        )
          disposition = "uncertain";
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          disposition = "uncertain";
      }
    } else
      try {
        const manifest = await privateFile(
          join(runtime, "desktop-runtime.json"),
          32 * 1024 ** 2,
          false,
        );
        codeManifestSchema.parse(JSON.parse(manifest.toString()));
        if (createHash("sha256").update(manifest).digest("hex") !== epoch)
          disposition = "uncertain";
        try {
          await privateDirectory(archive);
          const identity = ownershipSchema.parse(
            JSON.parse(
              (await privateFile(join(archive, ".desktop-archive.json"), 4096)).toString(),
            ),
          );
          const directory = await lstat(archive),
            app = await lstat(join(archive, "Omnesis.app"));
          if (
            identity.epoch !== epoch ||
            !app.isDirectory() ||
            app.isSymbolicLink() ||
            identity.identity.device !== directory.dev ||
            identity.identity.inode !== directory.ino ||
            identity.identity.appDevice !== app.dev ||
            identity.identity.appInode !== app.ino
          )
            disposition = "uncertain";
          identities.push(String(directory.dev), String(directory.ino));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            disposition = "uncertain";
          // A missing archive is allowed only when its epoch directory itself does not exist.
          try {
            await lstat(archive);
            disposition = "uncertain";
          } catch (missing) {
            if (!(missing instanceof Error && "code" in missing && missing.code === "ENOENT"))
              throw missing;
          }
        }
      } catch {
        disposition = "uncertain";
      }
    let bytes = info ? await treeBytes(runtime, signal) : 0;
    try {
      bytes += await treeBytes(archive, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    result.push({ epoch, bytes, identity: identities.join(":"), disposition });
  }
  return result;
}
async function privateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw new Error("The application code cache is not private and owned by you");
}
async function privateFile(path: string, limit: number, privateMode = true): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (privateMode && (info.mode & 0o077) !== 0) ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size > limit
    )
      throw new Error("Application code ownership cannot be verified");
    const bytes = Buffer.alloc(info.size + 1),
      read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size) throw new Error("Application code ownership changed");
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await file.close();
  }
}
async function treeBytes(root: string, signal: AbortSignal): Promise<number> {
  let bytes = 0,
    entries = 0;
  async function visit(path: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    if (++entries > 300_000 || depth > 64)
      throw new Error("An application code version is too large to inventory safely");
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory())
      for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
    else if (info.isFile()) bytes += info.size;
    else throw new Error("An application code version contains an unsupported entry");
    if (!Number.isSafeInteger(bytes))
      throw new Error("Application code size exceeds the supported limit");
  }
  await visit(root, 0);
  return bytes;
}
