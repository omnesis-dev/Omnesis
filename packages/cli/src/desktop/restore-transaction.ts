// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertManagedDesktopDataAuthority,
  backupScopeEntryFor,
  BACKUP_STORE_NAMES,
  STORE_COMPANION_SUFFIXES,
  DERIVED_INDEX_FILE_PATTERN,
} from "@omnesis/core";
import { swapIntoPlace, type SwapPlan } from "../commands/restore-swap.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import {
  captureDesktopRestoreBackupRuntime,
  retainDesktopRestoreBeforeReplacement,
} from "./snapshot-retention-restore.js";
import { registerVerifiedDesktopRestoreSnapshot } from "./snapshot-retention.js";
import { assertDesktopConfigSecretsProtected } from "./config-protection.js";
import { DesktopRestoreFailure } from "./restore-errors.js";
import { assertDesktopRestoreCapacity } from "./restore-capacity.js";
import { withDesktopRestoreOperationLease } from "./restore-owner.js";
import { resumeRetiredDesktop } from "./removal.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";
import { readDesktopRetirement, desktopRootIdentity, sameDesktopRoot } from "./retirement.js";
import {
  acquireDesktopRuntimeLeases,
  assertDesktopRuntimeLeases,
  type DesktopRuntimeLeases,
} from "./runtime-leases.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import {
  createDesktopUpdateSnapshot,
  measureDesktopUpdateSnapshot,
  restoreDesktopUpdateSnapshot,
  type DesktopUpdateSnapshot,
} from "./update-snapshot.js";
import {
  writeDesktopRestoreIntent,
  readDesktopRestoreIntent,
  type DesktopRestoreIntent,
} from "./restore-intent.js";
import {
  DesktopRestoreProtection,
  type DesktopRestoreProtectionIdentity,
} from "./restore-protection.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRestorePublication {
  verification?: DesktopRestoreIntent["verification"];
  review?: DesktopRestoreIntent["review"];
  place: Array<{ rel: string; from: string }>;
  remove: string[];
  verify(): Promise<void>;
  sourcesPaused: number;
  watchesPaused: number;
}
export interface DesktopRestoreTransactionPlan {
  expandedBytes: number;
  /** Fixed native host only: adopt the controller's already durable stopping intent. */
  adoptedOperationId?: string;
  archiveSha256: string;
  archiveBytes: number;
  protection: DesktopRestoreProtectionIdentity;
  stagingRoot: string;
  build(context: {
    leases: DesktopRuntimeLeases;
    signal: AbortSignal;
  }): Promise<DesktopRestorePublication>;
}
interface TransactionDependencies {
  measure: typeof measureDesktopUpdateSnapshot;
  capacity: typeof assertDesktopRestoreCapacity;
  authorize: typeof assertManagedDesktopDataAuthority;
  /** Only the native rollback host may borrow its controller's live session lease. */
  sessionAlreadyOwned?: boolean;
  capture: typeof DesktopRestoreProtection.capture;
  stop: typeof stopDesktopDaemon;
  snapshot: typeof createDesktopUpdateSnapshot;
  rollback: typeof restoreDesktopUpdateSnapshot;
  swap: typeof swapIntoPlace;
}
const defaults: TransactionDependencies = {
  measure: measureDesktopUpdateSnapshot,
  capacity: assertDesktopRestoreCapacity,
  authorize: assertManagedDesktopDataAuthority,
  capture: DesktopRestoreProtection.capture.bind(DesktopRestoreProtection),
  stop: stopDesktopDaemon,
  snapshot: createDesktopUpdateSnapshot,
  rollback: restoreDesktopUpdateSnapshot,
  swap: swapIntoPlace,
};
export class DesktopRestoreTransactionError extends Error {
  constructor(
    readonly code: "RESTORE_ROLLED_BACK" | "RESTORE_RECOVERY_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

/** The caller has consumed a one-use preview confirmation before entering here. */
export async function applyDesktopRestoreTransaction(
  profile: DesktopProfile,
  plan: DesktopRestoreTransactionPlan,
  signal: AbortSignal,
  dependencies: Partial<TransactionDependencies> = {},
): Promise<{ operationId: string; sourcesPaused: number; watchesPaused: number }> {
  const deps = { ...defaults, ...dependencies };
  signal.throwIfAborted();
  const operationId = plan.adoptedOperationId ?? randomUUID();
  deps.authorize(profile, "restore", operationId);
  await assertDesktopProcessAuthority(profile);
  return withDesktopInstallLease(profile, signal, async () => {
    signal.throwIfAborted();
    if (plan.adoptedOperationId) {
      deps.authorize(profile, "restore", plan.adoptedOperationId);
      if (await readDesktopRetirement(profile)) throw new Error("The library has retired");
    } else await assertDesktopMutationAllowed(profile);
    await validateStagingRoot(profile, plan.stagingRoot);
    await assertDesktopConfigSecretsProtected(profile, signal);
    const protection = await deps.capture(profile, signal);
    let leases: DesktopRuntimeLeases | undefined,
      snapshot: DesktopUpdateSnapshot | null = null,
      mutated = false;
    let intent: DesktopRestoreIntent | undefined;
    try {
      if (
        !(plan.adoptedOperationId
          ? protection.matchesProtection(plan.protection)
          : protection.matches(plan.protection))
      )
        throw new Error("The library changed; preview this backup again before restoring");
      if (!plan.adoptedOperationId) await retainDesktopRestoreBeforeReplacement(profile, signal);
      const backupRuntime = await captureDesktopRestoreBackupRuntime(profile);
      deps.authorize(profile, "restore", operationId);
      const proposed: DesktopRestoreIntent = {
        version: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId,
        phase: "stopping",
        root: plan.protection.root,
        targetKeyDigest: plan.protection.keyDigest,
        archiveSha256: plan.archiveSha256,
        archiveBytes: plan.archiveBytes,
        backup: null,
        ...(backupRuntime ? { backupRuntime } : {}),
      };
      if (plan.adoptedOperationId) {
        const existing = await readDesktopRestoreIntent(profile);
        if (
          !existing ||
          existing.operationId !== operationId ||
          existing.phase !== "stopping" ||
          existing.backup !== null ||
          existing.targetKeyDigest !== proposed.targetKeyDigest ||
          existing.archiveSha256 !== proposed.archiveSha256 ||
          existing.archiveBytes !== proposed.archiveBytes ||
          !sameDesktopRoot(existing.root, proposed.root)
        )
          throw new Error("The restore intent changed");
        if (
          existing.backupRuntime &&
          backupRuntime &&
          (existing.backupRuntime.epoch !== backupRuntime.epoch ||
            existing.backupRuntime.version !== backupRuntime.version)
        )
          throw new Error("The application changed before making the recovery copy");
        intent =
          existing.backupRuntime || !backupRuntime ? existing : { ...existing, backupRuntime };
        if (intent !== existing) await writeDesktopRestoreIntent(profile, intent);
      } else {
        intent = proposed;
        await writeDesktopRestoreIntent(profile, intent);
      }
      const stopped = await deps.stop(profile, signal);
      leases = await acquireDesktopRuntimeLeases(profile, {
        signal,
        expectedRoot: plan.protection.root,
        runtimeWaitMs: stopped ? 5000 : 0,
      });
      await assertDesktopRuntimeLeases(profile, leases);
      await assertDesktopConfigSecretsProtected(profile, signal);
      const inventory = await deps.measure(profile, signal);
      await deps.capacity(profile, {
        expandedBytes: plan.expandedBytes,
        snapshotBytes: inventory.bytes,
        signal,
      });
      snapshot = await deps.snapshot(profile, { operationId, leases, signal });
      intent = { ...intent, phase: "backed-up", backup: snapshot };
      await writeDesktopRestoreIntent(profile, intent);
      await deps.capacity(profile, { expandedBytes: plan.expandedBytes, snapshotBytes: 0, signal });
      const publication = await plan.build({ leases, signal });
      await assertDesktopRuntimeLeases(profile, leases);
      await validatePublication(profile, plan.stagingRoot, publication);
      signal.throwIfAborted();
      intent = {
        ...intent,
        phase: "staged",
        verification: publication.verification,
        review: publication.review,
      };
      await writeDesktopRestoreIntent(profile, intent);
      signal.throwIfAborted();
      intent = { ...intent, phase: "publishing" };
      await writeDesktopRestoreIntent(profile, intent);
      // Finish or recover this commit even when the native session closes.
      // Runtime and installation leases remain held through every byte change.
      mutated = true;
      const commit = async () => {
        await assertDesktopRuntimeLeases(profile, leases!);
        intent = { ...intent!, phase: "published" };
        await writeDesktopRestoreIntent(profile, intent);
        intent = { ...intent, phase: "verifying" };
        await writeDesktopRestoreIntent(profile, intent);
        await publication.verify();
        if (!sameDesktopRoot(plan.protection.root, await desktopRootIdentity(profile)))
          throw new Error("The library folder changed during restore");
        intent = { ...intent, phase: "committed" };
        await writeDesktopRestoreIntent(profile, intent);
      };
      const swap: SwapPlan = {
        target: profile.configDir,
        workDir: join(profile.configDir, `.restore-swap-${operationId}`),
        place: publication.place,
        remove: publication.remove,
        commit,
      };
      await deps.swap(swap);
      return {
        operationId,
        sourcesPaused: publication.sourcesPaused,
        watchesPaused: publication.watchesPaused,
      };
    } catch (error) {
      if (!intent) throw error;
      const cleanup = AbortSignal.timeout(30 * 60_000);
      try {
        if (mutated) {
          if (!snapshot || !leases)
            throw new Error("The protected recovery copy is unavailable", { cause: error });
          intent = { ...intent, phase: "rolling-back" };
          await writeDesktopRestoreIntent(profile, intent);
          await deps.rollback(profile, {
            operationId: intent.operationId,
            snapshot,
            leases,
            signal: cleanup,
          });
        }
        if (!sameDesktopRoot(intent.root, await desktopRootIdentity(profile)))
          throw new Error("The managed folder identity changed", { cause: error });
        intent = { ...intent, phase: "rolled-back" };
        await registerVerifiedDesktopRestoreSnapshot(profile, intent, cleanup);
        await writeDesktopRestoreIntent(profile, intent);
      } catch {
        intent = { ...intent, phase: "recovery-required" };
        await writeDesktopRestoreIntent(profile, intent);
        throw new DesktopRestoreTransactionError(
          "RESTORE_RECOVERY_REQUIRED",
          "This library needs recovery before it can start. Recover the previous library in the app.",
        );
      }
      if (signal.aborted)
        throw new DOMException(
          "Backup restore was cancelled; the previous library was kept",
          "AbortError",
        );
      if (error instanceof DesktopRestoreFailure) throw error;
      throw new DesktopRestoreTransactionError(
        "RESTORE_ROLLED_BACK",
        "The backup was not restored. Your previous library was kept.",
      );
    } finally {
      leases?.release();
      protection.close();
    }
  });
}

/** An interrupted operation can recover only its own verified same-profile snapshot. */
export async function recoverDesktopRestoreTransaction(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  dependencies: Partial<TransactionDependencies> = {},
): Promise<{ recoveryCopyRetained: boolean }> {
  const deps = { ...defaults, ...dependencies };
  deps.authorize(profile, "rollback", operationId);
  await assertDesktopProcessAuthority(profile);
  const recover = async () => {
    const retirement = await readDesktopRetirement(profile);
    if (retirement?.mode === "keep-data" && retirement.phase === "complete")
      await resumeRetiredDesktop(profile, signal);
    return withDesktopInstallLease(profile, signal, async () => {
      signal.throwIfAborted();
      if (await readDesktopRetirement(profile))
        throw new Error("This installation has retired; its files were kept");
      let intent = await readDesktopRestoreIntent(profile);
      if (
        !intent ||
        intent.operationId !== operationId ||
        ["complete", "rolled-back"].includes(intent.phase)
      )
        throw new Error("There is no matching interrupted restore to recover");
      const protection = await deps.capture(profile, signal);
      let leases: DesktopRuntimeLeases | undefined;
      try {
        if (
          !sameDesktopRoot(intent.root, protection.identity().root) ||
          intent.targetKeyDigest !== protection.identity().keyDigest
        )
          throw new Error("Recover this Mac's original library key before recovering its data");
        const stopped = await deps.stop(profile, signal);
        leases = await acquireDesktopRuntimeLeases(profile, {
          signal,
          expectedRoot: intent.root,
          runtimeWaitMs: stopped ? 5000 : 0,
        });
        signal.throwIfAborted();
        const cleanup = AbortSignal.timeout(30 * 60_000);
        if (intent.backup) {
          intent = { ...intent, phase: "rolling-back" };
          await writeDesktopRestoreIntent(profile, intent);
          await deps.rollback(profile, {
            operationId,
            snapshot: intent.backup!,
            leases,
            signal: cleanup,
          });
        } else if (intent.phase !== "stopping" && intent.phase !== "recovery-required")
          throw new Error("The recovery copy is missing");
        await assertDesktopRuntimeLeases(profile, leases);
        intent = { ...intent, phase: "rolled-back" };
        await registerVerifiedDesktopRestoreSnapshot(profile, intent, cleanup);
        await writeDesktopRestoreIntent(profile, intent);
        return { recoveryCopyRetained: intent.backup !== null };
      } catch {
        intent = { ...intent, phase: "recovery-required" };
        await writeDesktopRestoreIntent(profile, intent);
        if (signal.aborted) signal.throwIfAborted();
        throw new DesktopRestoreTransactionError(
          "RESTORE_RECOVERY_REQUIRED",
          "Recovery has not finished. Keep the recovery copy and retry after unlocking this Mac's library.",
        );
      } finally {
        leases?.release();
        protection.close();
      }
    });
  };
  return deps.sessionAlreadyOwned
    ? recover()
    : withDesktopRestoreOperationLease(profile, signal, recover);
}

async function validatePublication(
  profile: DesktopProfile,
  stagingRoot: string,
  publication: DesktopRestorePublication,
): Promise<void> {
  const paths = [...publication.place.map((entry) => entry.rel), ...publication.remove];
  const sorted = [...paths].sort();
  if (sorted.some((path, index) => index > 0 && path.startsWith(`${sorted[index - 1]}/`)))
    throw new Error("The restore publication contains overlapping paths");
  if (publication.remove.includes("omnesis.json"))
    throw new Error("The managed library configuration cannot be removed");
  if (paths.length > 16384 || new Set(paths).size !== paths.length)
    throw new Error("The restore publication contains duplicate or too many paths");
  for (const rel of paths) {
    if (!allowed(rel))
      throw new Error("The restore attempted to replace machine or account authority");
    const parts = rel.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const path = join(profile.configDir, ...parts.slice(0, depth));
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (await realpath(path)) !== resolve(path)
      )
        throw new Error("A restore destination is not privately owned by this library");
    }
  }
  for (const rel of paths) {
    try {
      const path = join(profile.configDir, rel),
        metadata = await lstat(path),
        directory = rel === "sweeps" || rel === "conversations";
      if (
        metadata.isSymbolicLink() ||
        (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
        (metadata.mode & 0o077) !== 0 ||
        (!directory && metadata.nlink !== 1) ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (await realpath(path)) !== resolve(path)
      )
        throw new Error("A restore destination was replaced or contains unrelated data");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  for (const item of publication.place) {
    const inside = relative(stagingRoot, resolve(item.from));
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("The restore stage is outside its owned import slot");
    const metadata = await lstat(item.from);
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isFile() && !metadata.isDirectory()) ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.isFile() && metadata.nlink !== 1) ||
      (process.getuid && metadata.uid !== process.getuid()) ||
      (await realpath(item.from)) !== resolve(item.from)
    )
      throw new Error("A staged restore entry is not privately owned");
  }
}
function allowed(rel: string): boolean {
  if (
    !rel ||
    rel.includes("\\") ||
    rel.includes(":") ||
    rel
      .split("/")
      .some((part) => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/u.test(part))
  )
    return false;
  if (
    (BACKUP_STORE_NAMES as readonly string[]).some(
      (name) =>
        rel === name || STORE_COMPANION_SUFFIXES.some((suffix) => rel === `${name}${suffix}`),
    ) ||
    DERIVED_INDEX_FILE_PATTERN.test(rel)
  )
    return true;
  if (
    rel === "omnesis.json" ||
    rel === "desktop-restore-review.json" ||
    rel === "OMNESIS.md" ||
    rel === "sweeps" ||
    rel === "conversations" ||
    /^sweeps\/[^/]+\.md$/u.test(rel)
  )
    return true;
  if (/^keyring\/storage-keys\/(?:main-db|index-db|watch2-db|analytics-db)\.json$/u.test(rel))
    return true;
  if (
    new Set([
      "keyring",
      "tls",
      "cloud-relay",
      "config-secrets",
      "models",
      "logs",
      "backups",
      "exports",
      "conversations",
    ]).has(rel.split("/")[0]!)
  )
    return false;
  const scope = backupScopeEntryFor(rel);
  return (
    scope?.kind === "config" &&
    !new Set([
      ".env",
      "token",
      "collector-token",
      "keyring/secret-files-required",
      "keyring/storage-encryption-required",
      "keyring/recovery-envelope.json",
      "keyring/storage-keys",
      "tls",
      "config-secrets",
    ]).has(scope.name)
  );
}

async function validateStagingRoot(profile: DesktopProfile, directory: string): Promise<void> {
  const parent = resolve(`${profile.configDir}.bootstrap`, "restore-imports"),
    child = relative(parent, resolve(directory));
  if (
    child.includes(sep) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(child)
  )
    throw new Error("The restore stage is not an owned import slot");
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("The restore import slot must remain private and owned");
}
