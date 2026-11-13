// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { win32 } from "node:path";

/** Host tools never resolve from an indexed folder or an update target's PATH. */
export function windowsPowerShellExecutable(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
