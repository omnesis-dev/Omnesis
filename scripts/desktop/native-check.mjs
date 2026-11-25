#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../lib/is-entry-script.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function nativeCheckOptions(args, env = process.env) {
  const [lane, ...flags] = args;
  if (
    !["logic", "test"].includes(lane) ||
    flags.some((flag) => flag !== "--build-only") ||
    (flags.length && (lane !== "test" || flags.length !== 1))
  ) {
    throw new Error("Usage: native-check.mjs <logic|test> [--build-only]");
  }
  const host = env.OMNESIS_EPIC_MACOS_HOST;
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(host)) {
    throw new Error("Set OMNESIS_EPIC_MACOS_HOST to your configured macOS build host");
  }
  const worktree = env.OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE;
  if (!worktree || !worktree.startsWith("/") || /[\r\n\0]/.test(worktree)) {
    throw new Error(
      "Set OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE to a dedicated absolute scratch directory",
    );
  }
  return {
    host,
    worktree,
    lane,
    buildOnly: flags.includes("--build-only"),
    output: env.OMNESIS_MACOS_TEST_OUT,
  };
}

const claim = `set -eu
python3 - "$1" <<'PY'
import os, pathlib, sys
p = pathlib.Path(sys.argv[1])
if str(p.resolve()) != str(p) or p == pathlib.Path.home() or str(p) == '/' or '_work' in p.parts:
    raise SystemExit('Refusing an unsafe desktop scratch directory')
if (p / '.omnesis-primary').exists() or (p / '.git').exists():
    raise SystemExit('A checkout cannot be a desktop build scratch directory')
marker = p / '.omnesis-desktop-scratch'
if p.exists() and any(p.iterdir()) and (not marker.is_file() or marker.read_text() != 'desktop-native-v1\\n'):
    raise SystemExit('Existing directory is not owned by desktop native checks')
p.mkdir(mode=0o700, parents=True, exist_ok=True)
if p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
    raise SystemExit('Desktop scratch directory must be private and owned by this user')
marker.write_text('desktop-native-v1\\n')
for name in ('macos', 'ios', 'evidence'):
    if (p / name).is_symlink():
        raise SystemExit('Desktop scratch subdirectories cannot be symbolic links')
    (p / name).mkdir(mode=0o700, exist_ok=True)
PY
`;

const check = `set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$1"
if [ "$2" = logic ]; then
  swift test --package-path macos
else
  cd macos
  xcodegen generate
  action=test
  if [ "$3" = yes ]; then action=build; fi
  result="../evidence/Desktop-$(date +%s)-$$.xcresult"
  xcodebuild -project OmnesisDesktop.xcodeproj -scheme OmnesisDesktop \\
    -configuration Debug -destination 'platform=macOS' -derivedDataPath build \\
    -resultBundlePath "$result" CODE_SIGN_IDENTITY='' CODE_SIGNING_REQUIRED=NO \\
    CODE_SIGNING_ALLOWED=NO "$action"
fi
`;

export function runNativeCheck(options, run = spawnSync, sourceRoot = root) {
  const exec = (command, args, extra = {}) => {
    const result = run(command, args, { cwd: root, stdio: "inherit", ...extra });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Desktop native ${command} failed`);
  };
  const remote = (script, args) =>
    exec("ssh", [options.host, `bash -s -- ${args.map(shellArgument).join(" ")}`], {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  remote(claim, [options.worktree]);
  const exclusions = [
    ".git/",
    ".build/",
    "build/",
    "DerivedData/",
    "*.xcodeproj/",
    "Local.xcconfig",
    "*.p12",
    "*.p8",
    "*.mobileprovision",
    ".DS_Store",
  ];
  for (const directory of options.lane === "logic" ? ["macos"] : ["macos", "ios"]) {
    exec("rsync", [
      "-a",
      "-s",
      "--delete",
      ...exclusions.flatMap((value) => ["--exclude", value]),
      `${join(sourceRoot, directory)}/`,
      `${options.host}:${join(options.worktree, directory)}/`,
    ]);
  }
  let failure;
  try {
    remote(check, [options.worktree, options.lane, options.buildOnly ? "yes" : "no"]);
  } catch (error) {
    failure = error;
  }
  try {
    if (options.output) {
      mkdirSync(options.output, { recursive: true, mode: 0o700 });
      exec("rsync", [
        "-a",
        "-s",
        `${options.host}:${join(options.worktree, "evidence")}/`,
        `${resolve(options.output)}/`,
      ]);
    }
  } catch (error) {
    if (!failure) failure = error;
    else process.stderr.write("Desktop native artifacts could not be retrieved.\n");
  }
  if (failure) throw failure;
}

if (isEntryScript(import.meta.url)) {
  try {
    runNativeCheck(nativeCheckOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Desktop native check failed"}\n`,
    );
    process.exitCode = 1;
  }
}
