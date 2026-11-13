// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { win32 } from "node:path";
import { isProtectedAbsolutePath } from "./policy.js";
import { exactFileIdentity, isExactFileIdentity } from "./identity.js";
import { containsLocalPath, sameLocalPath } from "./path-boundary.js";
import type { LocalFileEntry } from "./types.js";

interface ReadOptions {
  roots: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function matchesDiscovery(stat: Stats, file: LocalFileEntry, numericIdentity = true): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    (!numericIdentity || (stat.dev === file.device && stat.ino === file.inode)) &&
    stat.size === file.size &&
    stat.mtimeMs === file.mtime
  );
}

/**
 * Windows has no O_NOFOLLOW. Reject observed links/junctions and require the
 * opened regular file to have the identity discovered inside a declared root.
 * These are identity/race checks, not an atomic no-follow path operation.
 */
function verifyWindowsPath(file: LocalFileEntry, options: ReadOptions): void {
  if (!isExactFileIdentity(file.fileIdentity)) {
    throw new Error("Cannot verify local file identity on this filesystem");
  }
  const canonical = realpathSync(file.absolutePath);
  if (
    !sameLocalPath(file.absolutePath, canonical, "file", { platform: "win32" }) ||
    isProtectedAbsolutePath(canonical, { platform: "win32", env: options.env })
  ) {
    throw new Error("Local file path changed or is protected");
  }
  const inside = options.roots.some((root) =>
    containsLocalPath(root, canonical, { platform: "win32" }),
  );
  if (!inside) throw new Error("Local file is outside the declared folders");
  const observed = lstatSync(file.absolutePath);
  if (
    observed.isSymbolicLink() ||
    !matchesDiscovery(observed, file, false) ||
    exactFileIdentity(lstatSync(file.absolutePath, { bigint: true })) !== file.fileIdentity ||
    observed.ctimeMs !== file.ctime
  ) {
    throw new Error("Local file changed after discovery");
  }
  // Canonical roots have no intentional aliases left in their spelling.
  // Checking ancestors also detects an observed directory junction swap.
  let parent = win32.dirname(file.absolutePath);
  while (true) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Local file ancestor changed after discovery");
    const next = win32.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

/** Read only the discovered regular file, keeping the POSIX no-follow guard. */
export function readLocalFileBytes(file: LocalFileEntry, options: ReadOptions): Uint8Array {
  const windows = (options.platform ?? process.platform) === "win32";
  if (windows) verifyWindowsPath(file, options);
  const fd = openSync(file.absolutePath, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd);
    if (
      !matchesDiscovery(stat, file, !windows) ||
      (windows &&
        (stat.ctimeMs !== file.ctime ||
          exactFileIdentity(fstatSync(fd, { bigint: true })) !== file.fileIdentity))
    ) {
      throw new Error(`Local file changed after discovery: ${file.displayPath}`);
    }
    if (windows) verifyWindowsPath(file, options);
    const bytes = readFileSync(fd);
    if (windows) {
      const after = fstatSync(fd);
      if (
        !matchesDiscovery(after, file, false) ||
        after.ctimeMs !== file.ctime ||
        exactFileIdentity(fstatSync(fd, { bigint: true })) !== file.fileIdentity
      ) {
        throw new Error("Local file changed while it was being read");
      }
      verifyWindowsPath(file, options);
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } finally {
    closeSync(fd);
  }
}
