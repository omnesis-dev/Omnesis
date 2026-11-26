// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { DesktopProcessAuthorityFailure } from "./process-authority-errors.js";
import { DesktopRestoreFailure } from "./restore-errors.js";
import { DesktopFreshInstallFailure } from "./fresh-install-errors.js";
import { readDesktopGeneration, desktopProfileForGeneration } from "./generation.js";
import type {
  DesktopFreshInstallService,
  DesktopFreshInstallPreview,
  DesktopFreshInstallResult,
} from "./fresh-install.js";
import type { DesktopProfile } from "./environment.js";
export type DesktopFreshInstallCommand = "freshInstallPreview" | "freshInstall";
export function isDesktopFreshInstallCommand(
  command: string,
): command is DesktopFreshInstallCommand {
  return command === "freshInstallPreview" || command === "freshInstall";
}
export async function handleDesktopFreshInstall(
  service: DesktopFreshInstallService,
  profile: DesktopProfile,
  command: DesktopFreshInstallCommand,
  params: unknown,
  signal: AbortSignal,
  close: () => Promise<void>,
): Promise<DesktopFreshInstallPreview | DesktopFreshInstallResult> {
  try {
    if (command === "freshInstallPreview") {
      z.object({})
        .strict()
        .parse(params ?? {});
      return await service.preview(signal);
    }
    const input = z
      .object({ confirmationId: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .parse(params);
    await close();
    signal.throwIfAborted();
    return await service.commit(input.confirmationId, signal);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof DesktopRestoreFailure || error instanceof DesktopProcessAuthorityFailure)
      throw error;
    const generation = readDesktopGeneration(profile.configDir);
    if (
      generation &&
      desktopProfileForGeneration(profile.configDir, generation.generation).instance !==
        profile.instance
    )
      throw new DesktopFreshInstallFailure("FRESH_INSTALL_RECONNECT_REQUIRED");
    throw new DesktopFreshInstallFailure("FRESH_INSTALL_REFUSED");
  }
}
