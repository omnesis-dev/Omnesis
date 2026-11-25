// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { acquireGatewayLock, createLogger } from "@omnesis/core";
import { readDesktopInstall } from "./bootstrap.js";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { readDesktopRetirement } from "./retirement.js";
import { publishDesktopHint } from "./publication.js";
import { installDesktopParentLifetime } from "./parent-lifetime.js";
import { desktopComponentOwner } from "./runtime-leases.js";
import { desktopUpdateBlocked } from "./update-admission.js";
import {
  readDesktopRestoreActivationArguments,
  type DesktopRestoreActivation,
} from "./restore-start-arguments.js";
import { desktopRuntimeEpoch } from "./update-state.js";
export { desktopComponentOwner } from "./runtime-leases.js";

export type DesktopManagedComponent = "gateway" | "collector";

/** The real CLI callback never resolves while its component is live; OS exit retains the lease until death. */
export async function withDesktopComponentOwnership(
  profile: DesktopProfile,
  component: DesktopManagedComponent,
  run: () => Promise<void>,
  restoreActivation?: DesktopRestoreActivation,
): Promise<void> {
  if (
    (await readDesktopRetirement(profile)) ||
    (await desktopUpdateBlocked(
      profile,
      desktopRuntimeEpoch(),
      component === "gateway" ? restoreActivation : undefined,
    ))
  )
    return;
  const install = await readDesktopInstall(profile);
  if (!install || install.phase !== "configured")
    throw new Error("The managed installation is not ready");
  const directory = desktopComponentOwner(profile, component);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error("The managed component owner folder must be private");
  const lock = await acquireGatewayLock(directory, { waitMs: 0 });
  try {
    if (
      (await readDesktopRetirement(profile)) ||
      (await desktopUpdateBlocked(
        profile,
        desktopRuntimeEpoch(),
        component === "gateway" ? restoreActivation : undefined,
      ))
    )
      return;
    const current = await readDesktopInstall(profile);
    if (!current || current.phase !== "configured" || current.mode !== install.mode)
      throw new Error("The managed installation changed before the component could start");
    await run();
  } finally {
    lock.release();
  }
}

async function main(): Promise<void> {
  const component = process.argv[2];
  if (component !== "gateway" && component !== "collector")
    throw new Error("Expected one managed component name");
  const restoreActivation = readDesktopRestoreActivationArguments(process.argv.slice(3));
  if (component === "collector" && restoreActivation)
    throw new Error("A restore must verify the gateway before collection starts");
  const profile = desktopProfile();
  if (
    process.env.OMNESIS_CONFIG_DIR !== profile.configDir ||
    process.env.OMNESIS_SECRET_SERVICE !== profile.secretService ||
    process.env.OMNESIS_SECRET_STORE !== "macos-keychain" ||
    typeof process.send !== "function"
  )
    throw new Error(
      "The managed component requires its application's owner channel and scoped environment",
    );
  const dispose = installDesktopParentLifetime();
  try {
    await withDesktopComponentOwnership(
      profile,
      component,
      async () => {
        if (!process.connected) return;
        if (component === "collector") {
          const { initializePairedDeviceTransport } =
            await import("@omnesis/cloud-relay/bootstrap");
          await initializePairedDeviceTransport(
            process.env,
            {
              start: async (env) => {
                const { runRelayCommand, saveDirectCandidates } =
                  await import("@omnesis/cloud-relay/runtime");
                const transport = await runRelayCommand("client", env, {
                  persistDirectCandidates: (...args) =>
                    publishDesktopHint(profile, () => saveDirectCandidates(...args)),
                });
                if (!transport?.gatewayUrl) {
                  await transport?.close();
                  throw new Error("The managed paired transport is unavailable");
                }
                return { ...transport, gatewayUrl: transport.gatewayUrl };
              },
            },
            [],
            "collector",
          );
        }
        process.argv.splice(
          2,
          process.argv.length - 2,
          component,
          component === "gateway" ? "serve" : "run",
        );
        // The existing entry preserves dotenv/paired-transport ordering and daemon shutdown behavior.
        await import("../index.js");
      },
      restoreActivation,
    );
  } finally {
    dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
    process.exit(0);
  } catch {
    createLogger("cli:desktop:component").error("The managed background component could not start");
    process.exit(1);
  }
}
