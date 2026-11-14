// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync as writeNativeFileSync } from "node:fs";
import { privateWindowsFiles } from "../src/windows-files.js";

/** Positive credential fixtures must cross the real native privacy boundary. */
export const writePrivateFixture: typeof writeNativeFileSync = (path, data, options) => {
  if (process.platform !== "win32") return writeNativeFileSync(path, data, options);
  if (typeof path !== "string" || typeof data !== "string")
    throw new Error("Private fixture expects a string path and text");
  privateWindowsFiles().writeWindowsPrivateFileAtomicSync(path, Buffer.from(data, "utf8"));
};
