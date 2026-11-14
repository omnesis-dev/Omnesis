// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, win32 } from "node:path";

/** Git Bash runs checkout shell fixtures; the Windows WSL launcher does not. */
export function bashExecutable({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return "bash";
  const prefixes = [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs"),
  ];
  for (const prefix of prefixes) {
    if (!prefix || !win32.isAbsolute(prefix)) continue;
    const executable = win32.join(prefix, "Git", "bin", "bash.exe");
    if (exists(executable)) return executable;
  }
  throw new Error("Git for Windows Bash is required to run the checkout shell fixtures");
}

export function prependPath(directory, path = process.env.PATH ?? "", separator = delimiter) {
  return path ? `${directory}${separator}${path}` : directory;
}

/** Paths printed by Bash are not subject to MSYS's child-environment conversion. */
export function nativeBashPath(path) {
  if (process.platform !== "win32") return path;
  return execFileSync(bashExecutable(), ["-c", '/usr/bin/cygpath -w -- "$1"', "--", path], {
    encoding: "utf8",
  }).trim();
}

/** A local bridge stand-in; no guard test can fall through to an actual host. */
export function localSshFixturePath(directory) {
  const shell = bashExecutable().replaceAll("\\", "/");
  const quoted = "'" + shell.replaceAll("'", "'\\''") + "'";
  const ssh = join(directory, "ssh");
  writeFileSync(ssh, `#!/usr/bin/env bash\nshift\nexec ${quoted} -c "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(directory, "rsync"),
    '#!/usr/bin/env bash\necho "Unexpected transfer in a path-guard fixture" >&2\nexit 91\n',
    { mode: 0o755 },
  );
  const path = prependPath(directory);
  const selected = execFileSync(bashExecutable(), ["-c", "command -v ssh"], {
    env: { ...process.env, PATH: path },
    encoding: "utf8",
  }).trim();
  const same = realpathSync(nativeBashPath(selected)) === realpathSync(ssh);
  if (!same) throw new Error("The local SSH fixture must shadow every real SSH executable");
  return path;
}
