// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DesktopState } from "./coordinator.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopRetirement } from "./retirement.js";

type Operations = Pick<
  CoordinatorDependencies,
  "readRetirement" | "readInstall" | "resumeRetirement" | "updateBlocked"
>;

export async function readDesktopLifecycleBlock(
  profile: DesktopProfile,
  operations: Operations,
  close: () => Promise<void>,
): Promise<DesktopState | null> {
  const record = await operations.readRetirement(profile);
  if (record) {
    await close();
    return retiredState(record);
  }
  if (await operations.updateBlocked(profile)) {
    await close();
    return {
      phase: "waiting",
      message:
        "Finish installing or recovering the pending Omnesis update or backup restore before starting this library.",
    };
  }
  return null;
}

export async function resumeKeptDesktopLibrary(
  profile: DesktopProfile,
  options: { signal: AbortSignal; expectedMode?: "home" | "joined" },
  operations: Operations,
  close: () => Promise<void>,
): Promise<DesktopState | null> {
  if (await operations.updateBlocked(profile))
    return readDesktopLifecycleBlock(profile, operations, close);
  const retirement = await operations.readRetirement(profile);
  if (!retirement) return null;
  if (retirement.mode !== "keep-data" || retirement.phase !== "complete")
    return retiredState(retirement);
  if (
    options.expectedMode &&
    (await operations.readInstall(profile))?.mode !== options.expectedMode
  )
    return {
      phase: "error",
      retired: true,
      retirement: { mode: retirement.mode, phase: retirement.phase },
      message: "This library already has a home. Reconnect using its existing role.",
    };
  await operations.resumeRetirement(profile, options.signal);
  options.signal.throwIfAborted();
  return null;
}

function retiredState(record: DesktopRetirement): DesktopState {
  let message = "Removal has not finished. Finish removing Omnesis before starting it again.";
  if (record.phase === "keyCleanupPending")
    message =
      "Your local data was erased, but its Keychain cleanup still needs attention. Finish removal before starting Omnesis again.";
  else if (record.phase === "complete")
    message =
      record.mode === "keep-data"
        ? "Omnesis has stopped on this Mac. Your encrypted library was kept. Choose Look again to use it again."
        : "Your local Omnesis data and its protection key have been removed. You can now remove the app.";
  return {
    phase: "waiting",
    retired: true,
    retirement: { mode: record.mode, phase: record.phase },
    message,
  };
}

/** Only a content-free allowlisted remote code becomes native remediation text. */
export function desktopStorageProtectionFailure(error: unknown): DesktopState | null {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "STORAGE_PROTECTION_REQUIRED"
  )
    return null;
  return {
    phase: "error",
    mode: "joined",
    encrypted: false,
    message: "Protect the library's storage on its home computer before connecting this Mac.",
  };
}
