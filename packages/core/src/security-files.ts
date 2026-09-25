// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local filesystem security defaults for Omnesis-owned state.
 *
 * These helpers deliberately cover only the POSIX owner-only boundary:
 * directories at 0700, files at 0600, and daemon umask 077. They do not
 * claim to protect against same-user malware, root/admin, or plaintext
 * database reads while application-level encryption is still absent.
 */

import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_UMASK = 0o077;

/**
 * A path whose existence could not be determined — the process may not stat it,
 * or may not traverse a directory on the way to it.
 */
export class SecretPathUnreadableError extends Error {
  override readonly name = "SecretPathUnreadableError";
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(
      `Cannot determine whether ${path} exists: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Omnesis will not treat unreadable key material as absent. The containing directory must be " +
        "readable by the account this process runs as.",
    );
  }
}

/**
 * Whether a piece of key material exists, refusing to guess.
 *
 * `existsSync` answers `false` both for a path that is not there and for one
 * this process is not allowed to look at. For keyring material those are
 * opposite facts: absent means nothing was ever armed and running without
 * encryption is legitimate, while unreadable means something *is* armed and out
 * of reach. Collapsing the second into the first is how a fully armed install
 * boots plaintext, so this reports absence only when absence is proven and
 * throws otherwise.
 */
export function secretPathExists(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT can still surface via a symlink chain; ENOTDIR means an ancestor
    // is a file, so nothing can exist at this path. Both are proven absence.
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new SecretPathUnreadableError(path, err);
  }
}

/** Set the process umask so newly-created files are owner-only by default. */
export function applyPrivateUmask(): number | null {
  if (typeof process.umask !== "function") return null;
  return process.umask(PRIVATE_UMASK);
}

/** Ensure an Omnesis-owned directory exists and is not group/world-readable. */
export function ensurePrivateDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(path, PRIVATE_DIR_MODE);
}

/** Tighten an existing Omnesis-owned file to owner read/write only. */
export function ensurePrivateFileSync(path: string): void {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (!st.isFile()) return;
  chmodSync(path, PRIVATE_FILE_MODE);
}
