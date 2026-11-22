// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` (its `import.meta.url`) is the script Node
 * was started with, so it should run its command-line entry point.
 *
 * Node loads the entry script from its real path, so `import.meta.url` names
 * the file with every symlink resolved, while `process.argv[1]` keeps the path
 * the script was started by. Both are compared as real paths: a path reached
 * through a symlink (a linked checkout, or macOS's temporary directory under
 * /var -> /private/var) still counts as the entry script.
 *
 * A script shipped or copied on its own, without this directory, asks Node
 * instead with `import.meta.main`, which follows the same rule. The few that may
 * run under a Node predating `import.meta.main` (npm's preinstall, a workflow
 * on the runner's own Node) or as TypeScript under tsx, where it is undefined,
 * compare real paths inline.
 */
export function isEntryScript(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
