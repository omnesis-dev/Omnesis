// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "@omnesis/core";
import { withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";
import type { DesktopProfile } from "./environment.js";

const runtimeSchema = z
  .object({ version: z.literal(1), port: z.number().int().min(1024).max(65535) })
  .strict();
export type DesktopRuntime = z.infer<typeof runtimeSchema>;

export async function readDesktopRuntime(profile: DesktopProfile): Promise<DesktopRuntime | null> {
  const path = join(profile.configDir, "runtime.json");
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 4096
    ) {
      throw new Error("The desktop runtime record is not a private regular file");
    }
    return runtimeSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** A port collision fails startup rather than adopting an unrelated listener. */
export async function prepareDesktopRuntime(
  profile: DesktopProfile,
  signal: AbortSignal = new AbortController().signal,
): Promise<DesktopRuntime> {
  return withDesktopInstallLease(profile, signal, () => prepareLockedRuntime(profile));
}

async function prepareLockedRuntime(profile: DesktopProfile): Promise<DesktopRuntime> {
  await assertDesktopMutationAllowed(profile);
  const existing = await readDesktopRuntime(profile);
  if (existing) return existing;
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a private gateway port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const runtime = runtimeSchema.parse({ version: 1, port });
  await atomicWriteFile(join(profile.configDir, "runtime.json"), JSON.stringify(runtime), {
    mode: 0o600,
  });
  return runtime;
}
