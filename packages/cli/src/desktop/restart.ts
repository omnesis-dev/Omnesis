// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DesktopState } from "./coordinator.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";
import type { DesktopProfile } from "./environment.js";

type RestartOperations = Pick<
  CoordinatorDependencies,
  "readInstall" | "protected" | "stopDaemon" | "startDaemon"
> & {
  blocked(): Promise<DesktopState | null | undefined>;
  close(): Promise<void>;
  waitForHome(signal: AbortSignal): Promise<void>;
  status(signal: AbortSignal): Promise<DesktopState>;
};

/** Apply startup-only settings through the exact managed runtime's stop acknowledgement. */
export async function restartDesktopHome(
  profile: DesktopProfile,
  signal: AbortSignal,
  operations: RestartOperations,
): Promise<DesktopState> {
  signal.throwIfAborted();
  const install = await operations.readInstall(profile);
  if (!install || install.mode !== "home")
    return {
      phase: "error",
      ...(install ? { mode: install.mode } : {}),
      message:
        "Restart your library on the computer that keeps it. This Mac's collection has not been restarted.",
    };
  const blocked = await operations.blocked();
  if (blocked) return blocked;
  if (!(await operations.protected(profile)))
    return {
      phase: "error",
      mode: "home",
      message: "Unlock your Mac's Keychain before restarting your library.",
    };
  await operations.close();
  if (!(await operations.stopDaemon(profile, signal)))
    return {
      phase: "error",
      mode: "home",
      message: "Omnesis could not confirm that background collection stopped. Try again.",
    };
  signal.throwIfAborted();
  const stopped = await operations.blocked();
  if (stopped) return stopped;
  await operations.startDaemon(profile);
  await operations.waitForHome(signal);
  return operations.status(signal);
}
