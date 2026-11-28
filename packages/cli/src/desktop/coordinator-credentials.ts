// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { desktopPairPath, desktopSecretOptions } from "./coordinator-input.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";
import type { DesktopEnrollmentRole, DesktopPairing } from "./enrollment.js";
import type { DesktopProfile } from "./environment.js";

export async function readDesktopRolePair(
  profile: DesktopProfile,
  role: DesktopEnrollmentRole,
  deps: Pick<CoordinatorDependencies, "readPair">,
): Promise<DesktopPairing | null> {
  try {
    const pairing = await deps.readPair(
      desktopPairPath(profile, role),
      desktopSecretOptions(profile),
    );
    return pairing.kind === (role === "interactive" ? "cli" : "collector") ? pairing : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function persistDesktopRolePair(
  profile: DesktopProfile,
  role: DesktopEnrollmentRole,
  pairing: DesktopPairing,
  signal: AbortSignal,
  deps: Pick<CoordinatorDependencies, "publish" | "savePair" | "saveToken">,
): Promise<void> {
  signal.throwIfAborted();
  await deps.publish(profile, signal, async () => {
    await deps.savePair(desktopPairPath(profile, role), pairing, desktopSecretOptions(profile));
    signal.throwIfAborted();
    await deps.saveToken(
      join(profile.configDir, role === "interactive" ? "token" : "collector-token"),
      pairing.token,
      desktopSecretOptions(profile),
    );
  });
}
