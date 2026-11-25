// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { acquireGatewayLock } from "@omnesis/core";
import { purgeConfigDirKeyring, type KeyringPurgeResult } from "../uninstall/keyring-purge.js";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { stopDesktopDaemon } from "./daemon-control.js";
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
interface RemovalDependencies {
  readInstall: typeof readDesktopInstall;
  stopDaemon: typeof stopDesktopDaemon;
  lock: typeof acquireGatewayLock;
  removeData(profile: DesktopProfile): Promise<void>;
  purge(profile: DesktopProfile): Promise<KeyringPurgeResult>;
}
const defaults: RemovalDependencies = {
  readInstall: readDesktopInstall,
  stopDaemon: stopDesktopDaemon,
  lock: acquireGatewayLock,
  removeData: (profile) => rm(profile.configDir, { recursive: true, force: true }),
  purge: (profile) =>
    purgeConfigDirKeyring(homedir(), profile.configDir, undefined, {
      service: profile.secretService,
      exclusiveService: true,
    }),
};

export async function previewDesktopRemoval(
  profile: DesktopProfile,
  options: { eraseData?: boolean; signal: AbortSignal },
  overrides: Partial<RemovalDependencies> = {},
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
  overrides: Partial<RemovalDependencies> = {},
): Promise<DesktopRemovalResult> {
  const deps = { ...defaults, ...overrides };
  options.signal.throwIfAborted();
  const initial = await removalState(profile, deps);
  if (!initial.install && !initial.retirement)
    return { status: "not-installed", data: "absent", keyring: "unchanged" };
  return withDesktopInstallLease(profile, options.signal, async () => {
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
    const root = state.root ?? state.retirement?.root;
    if (!root) throw new Error("The managed installation's ownership cannot be verified");
    let record: DesktopRetirement =
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
    let owners: { release(): void } | undefined;
    try {
      if (state.root) {
        owners = await acquireDesktopRuntimeLeases(
          profile,
          {
            signal: options.signal,
            expectedRoot: root,
            runtimeWaitMs: stopped ? 5_000 : 0,
          },
          deps.lock,
        );
      }
      options.signal.throwIfAborted();
      if (mode === "keep-data") {
        if (!state.root || !state.install)
          throw new Error("The retained library's ownership cannot be verified");
        record = { ...record, phase: "complete" };
        await writeDesktopRetirement(profile, record);
        return { status: "retired", data: "retained", keyring: "retained" };
      }
      if (state.root) {
        record = { ...record, phase: "stopped" };
        await writeDesktopRetirement(profile, record);
        options.signal.throwIfAborted();
        await deps.removeData(profile);
        if (await desktopRootIdentity(profile))
          throw new Error(
            "Some managed data could not be removed. Its protection key has been kept.",
          );
      }
      record = { ...record, phase: "dataRemoved" };
      await writeDesktopRetirement(profile, record);
      options.signal.throwIfAborted();
      let cleanup: KeyringPurgeResult;
      try {
        cleanup = await deps.purge(profile);
      } catch {
        await writeDesktopRetirement(profile, { ...record, phase: "keyCleanupPending" });
        return { status: "key-cleanup-pending", data: "erased", keyring: "pending" };
      }
      if (!cleanup.markersCleared || cleanup.rootKey === "kept") {
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
    await unlink(desktopRetirementPath(profile));
    return true;
  });
}

async function removalState(profile: DesktopProfile, deps: RemovalDependencies) {
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
