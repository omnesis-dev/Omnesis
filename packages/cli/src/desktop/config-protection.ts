// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { omnesisConfigSchema } from "@omnesis/config";
import { readDesktopRestoreFile } from "./restore-files.js";
import { DesktopRestoreFailure } from "./restore-errors.js";
import type { DesktopProfile } from "./environment.js";

/** A managed snapshot must not duplicate legacy inline model credentials as plaintext. */
export async function assertDesktopConfigSecretsProtected(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const body = await readDesktopRestoreFile(join(profile.configDir, "omnesis.json"), 1024 * 1024);
  try {
    const config = omnesisConfigSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
    if (
      Object.values(config.inference?.backends ?? {}).some(
        (backend) => backend.apiKey !== undefined,
      )
    )
      throw new DesktopRestoreFailure("RESTORE_TARGET_SECRETS_UNPROTECTED");
  } finally {
    body.fill(0);
  }
  signal.throwIfAborted();
}
