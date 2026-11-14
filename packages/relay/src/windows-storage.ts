// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import {
  inspectWindowsPrivatePathSync,
  prepareWindowsPrivateStorageDirectorySync,
} from "@omnesis/core/private-files";

/** Align the inspected filename with SQLite's Win32 path interpretation. */
export function prepareWindowsRelayDatabase(path: string): string {
  if (!path.isWellFormed()) throw new Error("Relay database path contains invalid Unicode");
  if (path.length === 0) throw new Error("Relay storage requires a named database or :memory:");
  const filename = win32.resolve(path);
  const components = filename.slice(win32.parse(filename).root.length).split(win32.sep);
  if (
    components.some(
      (part) =>
        /[<>:"|?*]/u.test(part) ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        /[ .]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    )
  ) {
    throw new Error("Relay database path contains an unsafe Windows filename");
  }
  // The native boundary never repairs existing operator directories. It pins
  // all ancestry while validating mutation grants and actual child inheritance.
  prepareWindowsPrivateStorageDirectorySync(win32.dirname(filename));
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = filename + suffix;
    if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
    if (!inspectWindowsPrivatePathSync(candidate, "file").private)
      throw new Error("Existing relay database files require private Windows access controls");
  }
  return filename;
}
