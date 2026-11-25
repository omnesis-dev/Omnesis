// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readDesktopInstall } from "./bootstrap.js";
import { requestDesktopGateway } from "./gateway-access.js";
import { probeDesktopRemoteHealth } from "./remote-protection.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopUpdateMetadata } from "./update-plan.js";

const generation = z.number().int().nonnegative().max(1_000_000);
const health = z.object({
  status: z.literal("ok"),
  storageProtection: z.object({ version: z.literal(1), atRest: z.literal("encrypted") }),
  compat: z.object({ schema: generation, ws: generation }),
});

/** Existing stores must already have completed their current runtime's migrations and protection. */
export async function observeDesktopUpdate(
  profile: DesktopProfile,
  current: DesktopUpdateMetadata,
  signal: AbortSignal,
) {
  const install = await readDesktopInstall(profile);
  if (!install || install.phase !== "configured")
    throw new Error("Finish setting up this library before updating");
  const live = health.parse(
    install.mode === "home"
      ? await requestDesktopGateway(profile, "/health", { signal })
      : await probeDesktopRemoteHealth(profile, signal),
  );
  let backupBytes = 0;
  let entries = 0;
  const excluded = new Set([
    "models",
    "logs",
    "backups",
    "runtime-owner",
    "gateway-owner",
    "collector-owner",
  ]);
  async function visit(directory: string, top = false): Promise<void> {
    for (const name of await readdir(directory)) {
      signal.throwIfAborted();
      if (top && excluded.has(name)) continue;
      if (++entries > 200_000)
        throw new Error("The managed library has too many files to measure safely");
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) backupBytes += info.size;
      else throw new Error("The managed library contains an unsupported file");
      if (!Number.isSafeInteger(backupBytes))
        throw new Error("The managed library size is invalid");
    }
  }
  await visit(profile.configDir, true);
  const filesystem = await statfs(profile.configDir, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The available update disk space could not be measured");
  return {
    mode: install.mode,
    observed: {
      mainDbVersion: install.mode === "home" ? live.compat.schema : 0,
      configVersion: current.compat.stores.config.version,
      ...(install.mode === "joined" ? { remoteWsVersion: live.compat.ws } : {}),
    },
    backupBytes,
    freeBytes: Number(available),
  };
}
