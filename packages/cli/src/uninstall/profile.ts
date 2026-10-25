// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The PATH lines the installer appends to a shell profile (`print_path_hint`
 * in `scripts/install.sh`): a blank line, the marker comment, and the line
 * that puts `~/.local/bin` on PATH in that shell's syntax. Only that exact
 * block is removed; a PATH line the operator wrote themselves, or one the
 * marker does not introduce, stays.
 */

import { join } from "node:path";

export const PROFILE_MARKER = "# Added by the Omnesis installer";

/** Every profile `shell_profile_file` may have chosen, whatever `$SHELL` is now. */
export function profileCandidates(home: string): string[] {
  return [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".config", "fish", "config.fish"),
  ];
}

/** The lines `path_export_line` renders for `binDir`, in every shell syntax. */
function pathLines(binDir: string): Set<string> {
  return new Set([`export PATH="${binDir}:$PATH"`, `fish_add_path ${binDir}`]);
}

export interface ProfileEdit {
  /** The profile with every installer block for `binDir` removed. */
  text: string;
  /** How many blocks were removed. */
  removed: number;
}

/**
 * Remove the installer's PATH blocks for `binDir` from a profile's text. The
 * blank line the installer wrote before the marker goes with it, so a profile
 * that gained a block and lost it again reads as it did before.
 */
export function removeInstallerPathLines(text: string, binDir: string): ProfileEdit {
  const expected = pathLines(binDir);
  const lines = text.split("\n");
  const kept: string[] = [];
  let removed = 0;
  // The last block ended the file and had no blank line before it: the newline
  // the installer wrote ended a last line that had none, so it goes too.
  let bareEnd = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (line.trimEnd() === PROFILE_MARKER && next !== undefined && expected.has(next.trimEnd())) {
      const blankBefore = kept.length > 0 && kept[kept.length - 1]!.trim() === "";
      if (blankBefore) kept.pop();
      bareEnd =
        !blankBefore &&
        kept.length > 0 &&
        index + 2 === lines.length - 1 &&
        lines[index + 2] === "";
      index += 1;
      removed += 1;
      continue;
    }
    if (index < lines.length - 1) bareEnd = false;
    kept.push(line);
  }
  if (removed === 0) return { text, removed };
  if (bareEnd) kept.pop();
  return { text: kept.join("\n"), removed };
}
