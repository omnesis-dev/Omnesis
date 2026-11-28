// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import {
  acquireGatewayLock,
  invalidateSecretFileKeyCache,
  assertManagedDesktopDataAuthority,
} from "@omnesis/core";
import { purgeConfigDirKeyring, type KeyringPurgeResult } from "../uninstall/keyring-purge.js";
import { runDesktopEraseOperation } from "./removal-operation.js";
import { removeDesktopRestoreStaging } from "./restore-staging.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { purgeDesktopCodexKeyring } from "./codex-keyring.js";
import {
  desktopRetirementPath,
  desktopRootIdentity,
  readDesktopRetirement,
  sameDesktopRoot,
  writeDesktopRetirement,
  type DesktopRetirement,
} from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRemovalPlan {
  available: boolean;
  mode: "keep-data" | "erase-data";
  confirmationId: string | null;
  summary: string;
  dataKept: boolean;
  keyKept: boolean;
}
export interface DesktopRemovalResult {
  status: "not-installed" | "retired" | "key-cleanup-pending";
  data: "absent" | "retained" | "erased";
  keyring: "unchanged" | "retained" | "cleared" | "pending";
}
export interface DesktopRemovalDependencies {
  readInstall: typeof readDesktopInstall;
  stopDaemon: typeof stopDesktopDaemon;
  lock: typeof acquireGatewayLock;
  removeData(profile: DesktopProfile): Promise<void>;
  purge(profile: DesktopProfile): Promise<KeyringPurgeResult>;
  executeErase(
    profile: DesktopProfile,
    operationId: string,
    signal: AbortSignal,
    dependencies: Partial<DesktopRemovalDependencies>,
  ): Promise<DesktopRemovalResult>;
  authorize: typeof assertManagedDesktopDataAuthority;
}
const defaults: DesktopRemovalDependencies = {
  executeErase: runDesktopEraseOperation,
  authorize: assertManagedDesktopDataAuthority,
  readInstall: readDesktopInstall,
  stopDaemon: stopDesktopDaemon,
  lock: acquireGatewayLock,
  removeData: (profile) => rm(profile.configDir, { recursive: true, force: true }),
  purge: async (profile) => {
    await purgeDesktopCodexKeyring(profile);
    return purgeConfigDirKeyring(homedir(), profile.configDir, undefined, {
      service: profile.secretService,
      backend: "macos-keychain",
      exclusiveService: true,
    });
  },
};

export async function previewDesktopRemoval(
  profile: DesktopProfile,
  options: { eraseData?: boolean; signal: AbortSignal },
  overrides: Partial<DesktopRemovalDependencies> = {},
): Promise<DesktopRemovalPlan> {
  options.signal.throwIfAborted();
  const deps = { ...defaults, ...overrides };
  const state = await removalState(profile, deps);
  options.signal.throwIfAborted();
  const mode = options.eraseData ? "erase-data" : "keep-data";
  if (!state.install && !state.retirement)
    return {
      available: false,
      mode,
      confirmationId: null,
      summary: "This Mac has no managed Omnesis installation to remove.",
      dataKept: true,
      keyKept: true,
    };
  if (
    state.retirement?.mode === "erase-data" &&
    state.retirement.phase !== "complete" &&
    mode !== "erase-data"
  )
    throw new Error("Finish the requested data removal before changing this installation");
  return {
    available: true,
    mode,
    confirmationId: confirmation(profile, mode, state),
    summary: options.eraseData
      ? "Stop Omnesis on this Mac and erase its library, saved connections and local copies. Your original sources stay where they are."
      : "Stop Omnesis on this Mac and keep its library and saved connections for a later installation.",
    dataKept: !options.eraseData,
    keyKept: !options.eraseData,
  };
}

/** Data deletion follows ownership proof, retirement intent, cooperative stop and the runtime lease. */
export async function removeDesktopInstall(
  profile: DesktopProfile,
  options: { eraseData?: boolean; confirmationId: string; signal: AbortSignal },
  overrides: Partial<DesktopRemovalDependencies> = {},
): Promise<DesktopRemovalResult> {
  const deps = { ...defaults, ...overrides };
  options.signal.throwIfAborted();
  const initial = await removalState(profile, deps);
  if (!initial.install && !initial.retirement)
    return { status: "not-installed", data: "absent", keyring: "unchanged" };
  const restoreSession = options.eraseData
    ? await acquireDesktopRestoreSessionLease(profile, options.signal, { createParent: true })
    : undefined;
  try {
    const prepared = await withDesktopInstallLease<DesktopRemovalResult | { operationId: string }>(
      profile,
      options.signal,
      async () => {
        const state = await removalState(profile, deps);
        const mode = options.eraseData ? "erase-data" : "keep-data";
        if (!state.install && !state.retirement)
          return { status: "not-installed", data: "absent", keyring: "unchanged" };
        if (confirmation(profile, mode, state) !== options.confirmationId)
          throw new Error("This installation changed. Review the removal choice again.");
        if (
          state.retirement?.mode === "erase-data" &&
          state.retirement.phase !== "complete" &&
          mode !== "erase-data"
        )
          throw new Error("Finish the requested data removal before changing this installation");
        await assertDesktopProcessAuthority(profile);
        const root = state.root ?? state.retirement?.root;
        if (!root) throw new Error("The managed installation's ownership cannot be verified");
        const record: DesktopRetirement =
          state.retirement?.mode === mode
            ? state.retirement
            : {
                version: 1,
                owner: "omnesis-desktop",
                instance: profile.instance,
                secretService: profile.secretService,
                operationId: randomUUID(),
                mode,
                phase: "requested",
                root,
              };
        await writeDesktopRetirement(profile, record);
        options.signal.throwIfAborted();
        const stopped = await deps.stopDaemon(profile, options.signal);
        if (mode === "erase-data") return { operationId: record.operationId };
        if (!state.root || !state.install)
          throw new Error("The retained library's ownership cannot be verified");
        const owners = await acquireDesktopRuntimeLeases(
          profile,
          {
            signal: options.signal,
            expectedRoot: root,
            runtimeWaitMs: stopped ? 5_000 : 0,
          },
          deps.lock,
        );
        try {
          options.signal.throwIfAborted();
          await writeDesktopRetirement(profile, { ...record, phase: "complete" });
          return { status: "retired", data: "retained", keyring: "retained" };
        } finally {
          owners.release();
        }
      },
    );
    if (!("operationId" in prepared)) return prepared;
    try {
      return await deps.executeErase(profile, prepared.operationId, options.signal, deps);
    } finally {
      // The host has its own cache. The still-running controller must also forget
      // any key it read before delegating removal, including partial cleanup.
      invalidateSecretFileKeyCache();
    }
  } finally {
    restoreSession?.release();
  }
}

/** Called only by the fixed native EX host, or an explicit test-owned OS adapter. */
export async function finishDesktopErase(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  overrides: Partial<DesktopRemovalDependencies> = {},
): Promise<DesktopRemovalResult> {
  const deps = { ...defaults, ...overrides };
  deps.authorize(profile, "erase", operationId);
  await assertDesktopProcessAuthority(profile);
  return withDesktopInstallLease(profile, signal, async () => {
    const state = await removalState(profile, deps);
    let record = state.retirement;
    if (!record || record.mode !== "erase-data" || record.operationId !== operationId)
      throw new Error("The requested data removal changed");
    const root = record.root;
    const stopped = await deps.stopDaemon(profile, signal);
    let owners: { release(): void } | undefined;
    try {
      if (state.root) {
        owners = await acquireDesktopRuntimeLeases(
          profile,
          {
            signal: signal,
            expectedRoot: root,
            runtimeWaitMs: stopped ? 5_000 : 0,
          },
          deps.lock,
        );
      }
      signal.throwIfAborted();
      if (state.root) {
        record = { ...record, phase: "stopped" };
        await writeDesktopRetirement(profile, record);
        signal.throwIfAborted();
      }
      await removeDesktopRestoreStaging(profile, root, signal);
      const currentRoot = await desktopRootIdentity(profile);
      if (state.root ? !sameDesktopRoot(currentRoot, root) : currentRoot !== null)
        throw new Error(
          "The library folder changed during cleanup. Its protection key has been kept.",
        );
      if (state.root) {
        await deps.removeData(profile);
        if (await desktopRootIdentity(profile))
          throw new Error(
            "Some managed data could not be removed. Its protection key has been kept.",
          );
      }
      record = { ...record, phase: "dataRemoved" };
      await writeDesktopRetirement(profile, record);
      signal.throwIfAborted();
      if (await desktopRootIdentity(profile))
        throw new Error(
          "A library folder appeared before key cleanup. Its protection key has been kept.",
        );
      let cleanup: KeyringPurgeResult;
      try {
        try {
          cleanup = await deps.purge(profile);
        } finally {
          invalidateSecretFileKeyCache();
        }
      } catch {
        await writeDesktopRetirement(profile, { ...record, phase: "keyCleanupPending" });
        return { status: "key-cleanup-pending", data: "erased", keyring: "pending" };
      }
      if (!cleanup.markersCleared || cleanup.rootKey !== "deleted") {
        await writeDesktopRetirement(profile, { ...record, phase: "keyCleanupPending" });
        return { status: "key-cleanup-pending", data: "erased", keyring: "pending" };
      }
      await writeDesktopRetirement(profile, { ...record, phase: "complete" });
      return { status: "retired", data: "erased", keyring: "cleared" };
    } finally {
      owners?.release();
    }
  });
}

/** Only an explicit user start/reinstall clears a completed retirement; daemons never call this. */
export async function resumeRetiredDesktop(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<boolean> {
  return withDesktopInstallLease(profile, signal, async () => {
    const record = await readDesktopRetirement(profile);
    if (!record) return false;
    if (record.mode !== "keep-data" || record.phase !== "complete")
      throw new Error("Finish removing this installation before starting it again");
    if (record.mode === "keep-data") {
      const install = await readDesktopInstall(profile);
      if (!install || !sameDesktopRoot(await desktopRootIdentity(profile), record.root))
        throw new Error("The retained library changed and must be checked before starting");
    }
    signal.throwIfAborted();
    await assertDesktopProcessAuthority(profile);
    await unlink(desktopRetirementPath(profile));
    return true;
  });
}

async function removalState(profile: DesktopProfile, deps: DesktopRemovalDependencies) {
  const root = await desktopRootIdentity(profile);
  const retirement = await readDesktopRetirement(profile);
  const install = await deps.readInstall(profile);
  if (
    root &&
    !install &&
    !(retirement?.mode === "erase-data" && sameDesktopRoot(root, retirement.root))
  )
    throw new Error("This folder does not contain a managed Omnesis installation");
  if (root && retirement && !sameDesktopRoot(root, retirement.root))
    throw new Error("The managed library folder was replaced. Its files will be kept.");
  return { root, retirement, install };
}
function confirmation(
  profile: DesktopProfile,
  mode: string,
  state: Awaited<ReturnType<typeof removalState>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        instance: profile.instance,
        service: profile.secretService,
        mode,
        root: state.root,
        operation: state.retirement?.operationId,
        phase: state.retirement?.phase,
        install: state.install,
      }),
    )
    .digest("hex");
}
