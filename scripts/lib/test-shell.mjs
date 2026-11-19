// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, win32 } from "node:path";
import { windowsEnvironmentValue } from "@omnesis/platform/windows-powershell";

/** Bash path operations require separators even when a fixture supplies a native drive path. */
export function bashFixturePath(value, platform = process.platform) {
  return platform === "win32" && typeof value === "string" && /^[a-z]:[\\/]/iu.test(value)
    ? value.replaceAll("\\", "/")
    : value;
}

/** Only a direct script entry is path data; command operands and positional data stay literal. */
export function bashScriptArguments(args, platform = process.platform) {
  if (!Array.isArray(args) || typeof args[0] !== "string" || args[0].startsWith("-")) return args;
  return [bashFixturePath(args[0], platform), ...args.slice(1)];
}

/** Git Bash runs checkout shell fixtures; the Windows WSL launcher does not. */
export function bashExecutable({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return "bash";
  const prefixes = [
    windowsEnvironmentValue("ProgramFiles", env),
    windowsEnvironmentValue("ProgramW6432", env),
    windowsEnvironmentValue("ProgramFiles(x86)", env),
    windowsEnvironmentValue("LOCALAPPDATA", env) &&
      win32.join(windowsEnvironmentValue("LOCALAPPDATA", env), "Programs"),
  ];
  for (const prefix of prefixes) {
    if (!prefix || !win32.isAbsolute(prefix)) continue;
    // Git/bin/bash.exe is a compatibility redirector that prepends real
    // Git tools ahead of fixture PATH. Use the interpreter without that rewrite.
    const executable = win32.join(prefix, "Git", "usr", "bin", "bash.exe");
    if (exists(executable)) return executable;
  }
  throw new Error("Git for Windows Bash is required to run the checkout shell fixtures");
}

/** Keep supplied tool overrides ahead of Git utilities, with one native PATH key. */
export function bashEnvironment(
  env = process.env,
  { platform = process.platform, executable, pathKeys = [] } = {},
) {
  if (platform !== "win32") return { ...env };
  const tools = win32.dirname(executable ?? bashExecutable({ platform, env }));
  const original = windowsEnvironmentValue("PATH", env) ?? "";
  const prepared = { ...env };
  const paths = new Set(pathKeys.map((key) => key.toLowerCase()));
  for (const key of Object.keys(prepared)) {
    if (["path", "msys"].includes(key.toLowerCase())) delete prepared[key];
    else if (paths.has(key.toLowerCase())) prepared[key] = bashFixturePath(prepared[key], platform);
  }
  // Node workspace resolution needs native symlinks rather than ln's copy fallback.
  prepared.MSYS = [
    ...(windowsEnvironmentValue("MSYS", env) ?? "")
      .split(/\s+/u)
      .filter((option) => option && !/^winsymlinks(?::|$)/iu.test(option)),
    "winsymlinks:nativestrict",
  ].join(" ");
  prepared.PATH = original.split(";").includes(tools)
    ? original
    : original
      ? `${original};${tools}`
      : tools;
  return prepared;
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
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash\n` +
      // The shebang's PATH lookup may itself pass through Git's redirector.
      // Restore owned stand-ins before running the emulated remote command.
      `fixture_dir=$(cd -- "$(dirname -- "$0")" && pwd) || exit 92\n` +
      `export PATH="$fixture_dir:$PATH"\nshift\nexec ${quoted} -c "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "rsync"),
    '#!/usr/bin/env bash\necho "Unexpected transfer in a path-guard fixture" >&2\nexit 91\n',
    { mode: 0o755 },
  );
  const original = windowsEnvironmentValue("PATH") ?? "";
  const base =
    process.platform === "win32"
      ? prependPath(win32.dirname(bashExecutable()), original)
      : original;
  const path = prependPath(directory, base);
  const selected = execFileSync(bashExecutable(), ["-c", "command -v ssh"], {
    env: { ...process.env, PATH: path },
    encoding: "utf8",
  }).trim();
  const same = realpathSync.native(nativeBashPath(selected)) === realpathSync.native(ssh);
  if (!same) throw new Error("The local SSH fixture must shadow every real SSH executable");
  return path;
}
