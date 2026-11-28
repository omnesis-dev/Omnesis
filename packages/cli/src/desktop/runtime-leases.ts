// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireGatewayLock } from "@omnesis/core";
import { desktopRootIdentity, sameDesktopRoot, type DesktopRootIdentity } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRuntimeLeases {
  release(): void;
}
const heldLeases = new WeakMap<
  DesktopRuntimeLeases,
  {
    profile: DesktopProfile;
    root: DesktopRootIdentity;
    held: boolean;
  }
>();

export async function assertDesktopRuntimeLeases(
  profile: DesktopProfile,
  leases: DesktopRuntimeLeases,
): Promise<void> {
  const proof = heldLeases.get(leases);
  if (
    !proof?.held ||
    proof.profile.configDir !== profile.configDir ||
    proof.profile.secretService !== profile.secretService ||
    proof.profile.instance !== profile.instance ||
    !sameDesktopRoot(await desktopRootIdentity(profile), proof.root)
  )
    throw new Error("The managed stores must remain exclusively reserved for this operation");
}

export function desktopComponentOwner(
  profile: DesktopProfile,
  component: "gateway" | "collector",
): string {
  return join(profile.configDir, `${component}-owner`);
}

/** A missing supervisor never proves that its children or manually started gateway have exited. */
export async function acquireDesktopRuntimeLeases(
  profile: DesktopProfile,
  options: { signal: AbortSignal; expectedRoot: DesktopRootIdentity; runtimeWaitMs?: number },
  lock: typeof acquireGatewayLock = acquireGatewayLock,
): Promise<DesktopRuntimeLeases> {
  const owners: Awaited<ReturnType<typeof acquireGatewayLock>>[] = [];
  const release = () => {
    for (const owner of owners.splice(0).reverse()) owner.release();
  };
  try {
    if (!sameDesktopRoot(await desktopRootIdentity(profile), options.expectedRoot))
      throw new Error("The managed library folder changed before its stores could be reserved");
    const directories = [
      join(profile.configDir, "runtime-owner"),
      desktopComponentOwner(profile, "gateway"),
      desktopComponentOwner(profile, "collector"),
    ];
    for (const [index, directory] of directories.entries()) {
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
        throw new Error("The managed runtime owner folder must be private and owned by you");
      owners.push(
        await lock(directory, {
          signal: options.signal,
          waitMs: index === 0 ? (options.runtimeWaitMs ?? 0) : 0,
        }),
      );
    }
    // Covers a manually started home gateway, independently of desktop ownership records.
    owners.push(await lock(profile.configDir, { signal: options.signal, waitMs: 0 }));
    if (!sameDesktopRoot(await desktopRootIdentity(profile), options.expectedRoot))
      throw new Error("The managed library folder changed while reserving its stores");
    const proof = { profile: { ...profile }, root: options.expectedRoot, held: true };
    const leases = {
      release() {
        proof.held = false;
        release();
      },
    };
    heldLeases.set(leases, proof);
    return leases;
  } catch (error) {
    release();
    throw error;
  }
}
