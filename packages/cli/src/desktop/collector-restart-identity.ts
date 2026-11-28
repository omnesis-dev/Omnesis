// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { join } from "node:path";
import { z } from "zod";
import {
  readCollectorPairingState,
  readSecretTextFile,
  secretFileEncryptionRequired,
  storageEncryptionRequired,
  tokenFingerprint,
} from "@omnesis/core";
import { assertDesktopProfileGeneration } from "./generation.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";
import type { DesktopProfile } from "./environment.js";
import type { CollectorIdentity } from "./collector-restart.js";

export async function readDesktopRestartIdentity(
  profile: DesktopProfile,
): Promise<CollectorIdentity> {
  assertDesktopProfileGeneration(profile);
  await assertDesktopProcessAuthority(profile);
  await assertDesktopMutationAllowed(profile);
  if (
    !secretFileEncryptionRequired(profile.configDir) ||
    !storageEncryptionRequired(profile.configDir)
  )
    throw new Error("Protected storage is required before collection can restart");
  const state = readCollectorPairingState(profile.configDir);
  const token = await readSecretTextFile(join(profile.configDir, "collector-token"), {
    configDir: profile.configDir,
    service: profile.secretService,
    backend: "macos-keychain",
  });
  if (
    !state ||
    state.state !== "paired" ||
    !token ||
    state.tokenFingerprint !== tokenFingerprint(token.trim()) ||
    !z.string().uuid().safeParse(state.deviceId).success ||
    typeof state.tokenFingerprint !== "string"
  )
    throw new Error("A saved paired collector is required before restarting collection");
  return { deviceId: z.string().uuid().parse(state.deviceId), fingerprint: state.tokenFingerprint };
}
