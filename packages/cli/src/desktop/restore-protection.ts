// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  classifySecureMarker,
  inspectInstallRootKey,
  readInstallRootKey,
  readMarkerKeyringState,
  secureMarkerPath,
  installRootKeyBytes,
} from "@omnesis/core";
import { readDesktopInstall } from "./bootstrap.js";
import { desktopRootIdentity, sameDesktopRoot, type DesktopRootIdentity } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRestoreProtectionDependencies {
  inspect: typeof inspectInstallRootKey;
  read: typeof readInstallRootKey;
  mirror: typeof readMarkerKeyringState;
}
export interface DesktopRestoreProtectionIdentity {
  root: DesktopRootIdentity;
  keyDigest: string;
  markerDigest: string;
  rootChangeTime: string;
}
/** No setup, key creation, mirror repair or root replacement is permitted here. */
export class DesktopRestoreProtection {
  #key: string;
  #identity: DesktopRestoreProtectionIdentity;
  private constructor(key: string, identity: DesktopRestoreProtectionIdentity) {
    this.#key = key;
    this.#identity = identity;
  }
  static async capture(
    profile: DesktopProfile,
    signal: AbortSignal,
    dependencies: Partial<DesktopRestoreProtectionDependencies> = {},
  ): Promise<DesktopRestoreProtection> {
    try {
      return await this.captureVerified(profile, signal, dependencies);
    } catch {
      if (signal.aborted) signal.throwIfAborted();
      throw new Error(
        "This Mac's managed library must be protected and unlocked before restoring a backup",
      );
    }
  }
  private static async captureVerified(
    profile: DesktopProfile,
    signal: AbortSignal,
    dependencies: Partial<DesktopRestoreProtectionDependencies>,
  ): Promise<DesktopRestoreProtection> {
    const deps = {
      inspect: inspectInstallRootKey,
      read: readInstallRootKey,
      mirror: readMarkerKeyringState,
      ...dependencies,
    };
    signal.throwIfAborted();
    const install = await readDesktopInstall(profile);
    if (install?.mode !== "home" || install.phase !== "configured")
      throw new Error("Restore a backup on this Mac's configured library home");
    const root = await desktopRootIdentity(profile);
    const directoryBefore = await lstat(profile.configDir, { bigint: true });
    if (!root) throw new Error("The managed library is unavailable");
    const options = {
      backend: "macos-keychain" as const,
      service: profile.secretService,
      configDir: profile.configDir,
    };
    const state = await deps.inspect(options);
    if (
      !state.store.available ||
      !state.store.secure ||
      state.store.backend !== "macos-keychain" ||
      !state.present ||
      !state.valid
    )
      throw new Error("Unlock or recover this Mac's library key before restoring a backup");
    const key = await deps.read(options);
    if (!key) throw new Error("This Mac's existing library key is unavailable");
    const markers = createHash("sha256");
    for (const kind of ["storage-encryption", "secret-files"] as const) {
      signal.throwIfAborted();
      const path = secureMarkerPath(kind, profile.configDir),
        parent = dirname(path),
        metadata = await lstat(parent);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (await realpath(parent)) !== resolve(parent)
      )
        throw new Error(
          "The library encryption metadata must remain private and owned by this Mac",
        );
      const raw = await privateText(path);
      if (
        classifySecureMarker(kind, raw, key) !== "valid" ||
        (await deps.mirror(kind, options)) !== "required"
      )
        throw new Error(
          "Reopen this Mac's library to confirm its encryption protection before restoring",
        );
      markers.update(kind).update("\0").update(raw);
    }
    if (!sameDesktopRoot(root, await desktopRootIdentity(profile)))
      throw new Error("The managed library changed; preview the backup again");
    signal.throwIfAborted();
    const directoryAfter = await lstat(profile.configDir, { bigint: true });
    if (directoryBefore.ctimeNs !== directoryAfter.ctimeNs)
      throw new Error("The managed library changed during inspection");
    const bytes = installRootKeyBytes(key);
    try {
      return new DesktopRestoreProtection(key, {
        root,
        keyDigest: createHash("sha256").update(bytes).digest("hex"),
        markerDigest: markers.digest("hex"),
        rootChangeTime: String(directoryAfter.ctimeNs),
      });
    } finally {
      bytes.fill(0);
    }
  }
  identity(): DesktopRestoreProtectionIdentity {
    return { ...this.#identity, root: { ...this.#identity.root } };
  }
  key(): string {
    if (!this.#key) throw new Error("The library key is no longer held for this restore");
    return this.#key;
  }
  matches(expected: DesktopRestoreProtectionIdentity): boolean {
    return (
      this.matchesProtection(expected) && this.#identity.rootChangeTime === expected.rootChangeTime
    );
  }
  matchesProtection(expected: DesktopRestoreProtectionIdentity): boolean {
    return (
      sameDesktopRoot(this.#identity.root, expected.root) &&
      this.#identity.keyDigest === expected.keyDigest &&
      this.#identity.markerDigest === expected.markerDigest
    );
  }
  close(): void {
    this.#key = "";
  }
}
async function privateText(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 16_384n ||
      (process.getuid && before.uid !== BigInt(process.getuid()))
    )
      throw new Error("The encryption metadata is invalid");
    const bytes = Buffer.alloc(16_385);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      offset > 16_384 ||
      BigInt(offset) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    )
      throw new Error("The encryption metadata changed");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}
