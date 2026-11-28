#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { prepareNodeTestFixture } from "./prepare-node-test-fixture.mjs";
import { prepareCodexBackendTestFixture } from "./codex-backend-test-fixture.mjs";
import { prepareCodexKeychainTestFixture } from "./prepare-codex-keychain-test-fixture.mjs";
import { prepareAnalyticsNativeFixture } from "./analytics-native-fixture.mjs";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { preparePackageFixture } from "./package-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function nativeCheckOptions(args, env = process.env) {
  const [lane, ...flags] = args;
  const filteredLogic =
    lane === "logic" &&
    flags.length === 2 &&
    flags[0] === "--filter" &&
    typeof flags[1] === "string" &&
    /^[A-Za-z_][A-Za-z0-9_.]*(?:\/[A-Za-z_][A-Za-z0-9_]*)?$/.test(flags[1]);
  const filteredHosted =
    lane === "test" &&
    flags.length === 3 &&
    flags[0] === "--hosted-only" &&
    flags[1] === "--filter" &&
    typeof flags[2] === "string" &&
    !/[\r\n\0]/u.test(flags[2]) &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\/test[A-Za-z0-9_]{0,124})?$/.test(flags[2]);
  const compileTests =
    lane === "test" &&
    flags.length === 2 &&
    flags.includes("--build-only") &&
    flags.includes("--compile-tests");
  const testFlags =
    compileTests ||
    filteredHosted ||
    flags.length === 0 ||
    (flags.length === 1 && ["--build-only", "--hosted-only"].includes(flags[0])) ||
    (flags.length === 2 &&
      new Set(flags).size === 2 &&
      flags.includes("--build-only") &&
      flags.includes("--package"));
  if (
    !["logic", "test"].includes(lane) ||
    (lane === "logic" ? flags.length > 0 && !filteredLogic : !testFlags)
  ) {
    throw new Error(
      "Usage: native-check.mjs logic [--filter SuiteName/testName] | test [--build-only [--package|--compile-tests]|--hosted-only [--filter SuiteName[/testName]]]",
    );
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
    compileTests,
    hostedOnly: flags.includes("--hosted-only"),
    package: flags.includes("--package"),
    filter: filteredLogic ? flags[1] : filteredHosted ? flags[2] : undefined,
    output: env.OMNESIS_MACOS_TEST_OUT,
  };
}

const claim = `set -eu
python3 - "$1" <<'PY'
import os, pathlib, stat, sys
p = pathlib.Path(sys.argv[1])
if str(p.resolve()) != str(p) or p == pathlib.Path.home() or str(p) == '/' or '_work' in p.parts:
    raise SystemExit('Refusing an unsafe desktop scratch directory')
if (p / '.omnesis-primary').exists() or (p / '.git').exists():
    raise SystemExit('A checkout cannot be a desktop build scratch directory')
marker = p / '.omnesis-desktop-scratch'
if p.exists() and (p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077):
    raise SystemExit('Desktop scratch directory must be private and owned by this user')
if marker.exists() or marker.is_symlink():
    fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or os.read(fd, 64) != b'desktop-native-v1\\n':
            raise SystemExit('Existing directory is not owned by desktop native checks')
    finally:
        os.close(fd)
elif p.exists() and any(p.iterdir()):
    raise SystemExit('Existing directory is not owned by desktop native checks')
else:
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, b'desktop-native-v1\\n')
    finally:
        os.close(fd)
for name in ('macos', 'ios', 'evidence', 'package-source', 'package-cache'):
    if (p / name).is_symlink():
        raise SystemExit('Desktop scratch subdirectories cannot be symbolic links')
    (p / name).mkdir(mode=0o700, exist_ok=True)
PY
`;

// A successful Xcode command can select no tests. Qualify only the selected subset.
const filteredHostedReceipt = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const [result, selector] = process.argv.slice(1);
const directory = result + '.filtered-hosted';
mkdirSync(directory, { mode: 0o700 });
const receipt = { scope: 'filtered-hosted-subset', selector, qualified: false, reason: 'summary-tool-failed' };
const tool = spawnSync('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', result], {
  stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 30000,
});
if (tool.stdout?.length) writeFileSync(directory + '/summary.json', tool.stdout.subarray(0, 1024 * 1024), { mode: 0o600, flag: 'wx' });
if (tool.stderr?.length) writeFileSync(directory + '/tool-stderr.txt', tool.stderr.subarray(0, 65536), { mode: 0o600, flag: 'wx' });
if (!tool.error && tool.status === 0 && tool.stdout.length <= 1024 * 1024) {
  receipt.reason = 'invalid-summary';
  try {
    const summary = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(tool.stdout));
    const keys = ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests'];
    if (summary && typeof summary === 'object' && !Array.isArray(summary) && keys.every(key =>
      Object.hasOwn(summary, key) && Number.isSafeInteger(summary[key]) && summary[key] >= 0 && summary[key] <= 1000000)) {
      const [total, passed, failed, skipped] = keys.map(key => summary[key]);
      receipt.counts = { total, passed, failed, skipped };
      if (total === passed + failed + skipped) {
        receipt.qualified = total > 0 && passed > 0 && failed === 0 && skipped < total;
        receipt.reason = receipt.qualified ? 'selected-tests-passed' : 'selected-tests-not-passed';
      }
    }
  } catch { /* Invalid external summary remains a failed qualification. */ }
}
writeFileSync(directory + '/receipt.json', JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
if (!receipt.qualified) {
  process.stderr.write('Filtered hosted subset qualification failed: ' + receipt.reason + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Filtered hosted subset executed: ' + receipt.counts.passed + ' passed; ' + receipt.counts.skipped + ' skipped.\n');
}
`;

const check = `set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$1"
if [ "$2" = logic ]; then
  if [ -n "\${6-}" ]; then
    swift test --package-path macos --filter "$6"
  else
    swift test --package-path macos
  fi
else
  cd macos
  xcodegen generate
  action=test
  configuration=Debug
  if [ "$3" = yes ]; then
    action=build
    configuration=Release
  elif [ "$3" = compile-tests ]; then
    action=compile-tests
  fi
  signing_allowed=YES
  signing_required=YES
  signing_identity=-
  if [ "$action" = build ]; then
    signing_allowed=NO
    signing_required=NO
    signing_identity=''
  fi
  result="../evidence/Desktop-$(date +%s)-$$.xcresult"
  started=$(date +%s)
  collect_screenshots() {
    status=$?
    trap - EXIT
    if [ "$action" = test ] && [ -x .node-fixture/node ] && [ -d build/Build/Products/Debug/OmnesisDesktopUITests-Runner.app ]; then
      .node-fixture/node Tests/Support/normalize-test-runner-signature.mjs --inspect-products "$PWD/build/Build/Products/Debug" \\
        > ../evidence/test-runner-signature-after.json || true
      cat ../evidence/test-runner-signature-after.json
    fi
    python3 - "$started" "../evidence/snapshots" <<'PYSCREEN' || true
import pathlib, shutil, sys
source = pathlib.Path('/tmp/omnesis-macos-snapshots')
target = pathlib.Path(sys.argv[2])
for path in source.iterdir() if source.is_dir() else []:
    if path.suffix in ['.png', '.txt'] and path.is_file() and not path.is_symlink() and path.stat().st_mtime >= int(sys.argv[1]):
        target.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(path, target / path.name)
PYSCREEN
    exit "$status"
  }
  trap collect_screenshots EXIT
  desktop_xcodebuild() {
    xcodebuild -project OmnesisDesktop.xcodeproj -scheme OmnesisDesktop \\
    -configuration "$configuration" -destination 'platform=macOS' -derivedDataPath build \\
    -parallel-testing-enabled NO \\
    CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM='' \\
    CODE_SIGN_IDENTITY="$signing_identity" CODE_SIGNING_REQUIRED="$signing_required" \\
    CODE_SIGNING_ALLOWED="$signing_allowed" CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES "$@"
  }
  if [ "$action" = build ]; then
    desktop_xcodebuild -resultBundlePath "$result" build
    # Package preparation builds, verifies and qualifies the engine in its actual runtime stage.
    if [ "$5" != yes ]; then
      .node-fixture/node .analytics-build-fixture/scripts/desktop/build-analytics.mjs \\
        --cache "$PWD/../evidence/desktop-analytics" --sources "$PWD/.analytics-build-fixture/sources"
    fi
  elif [ "$action" = compile-tests ]; then
    desktop_xcodebuild -resultBundlePath "$result" build-for-testing
    python3 Tests/Support/capture-generated-test-schema.py --products build/Build/Products --evidence ../evidence/readiness-diagnostics >/dev/null 2>&1 || true
    (umask 077; set -C; printf '%s\\n' 'format=1' 'scope=debug-test-compilation' \\
      'requestedProducts=application,hosted-tests,external-ui-tests' \\
      'buildForTestingReturned=true' 'testsExecuted=false' > "$result.compilation.txt")
    printf '%s\\n' 'Debug test products compiled; application tests were not executed.'
  else
    desktop_xcodebuild build-for-testing
    python3 Tests/Support/capture-generated-test-schema.py --products build/Build/Products --evidence ../evidence/readiness-diagnostics >/dev/null 2>&1 || true
    .node-fixture/node Tests/Support/normalize-test-runner-signature.mjs --products "$PWD/build/Build/Products/Debug"
    if [ "$4" = yes ]; then
      if [ -n "\${6-}" ]; then
        printf 'Scope: FILTERED hosted application subset OmnesisDesktopTests/%s; NOT the complete hosted/Core/external-UI gate\\n' "$6"
        desktop_xcodebuild -resultBundlePath "$result" "-only-testing:OmnesisDesktopTests/$6" test-without-building
        .node-fixture/node --input-type=module --eval ${shellArgument(filteredHostedReceipt)} -- "$result" "$6"
      else
        printf '%s\\n' 'Scope: hosted application integration; external UI runner is a separate check'
        desktop_xcodebuild -resultBundlePath "$result" -only-testing:OmnesisDesktopTests test-without-building
      fi
    else
      desktop_xcodebuild -resultBundlePath "$result" test-without-building
    fi
  fi
fi
`;

/** Runs inside the admitted native operation, before synchronizing build inputs; never inside tests. */
export async function prepareNativeNodeFixture(
  options,
  { run = spawnSync, prepare = prepareNodeTestFixture } = {},
  sourceRoot = root,
) {
  const result = run("ssh", [options.host, "uname -sm"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("The native Node fixture architecture could not be determined");
  const match = /^Darwin (arm64|x86_64)$/.exec(String(result.stdout).trim());
  if (!match) throw new Error("Desktop native checks require a supported macOS build host");
  return prepare({
    architecture: match[1] === "arm64" ? "arm64" : "x64",
    output: join(sourceRoot, "macos/.node-fixture"),
    cache: join(homedir(), ".cache", "omnesis-desktop-node-test"),
  });
}

export async function prepareNativeCodexFixture(
  options,
  {
    run = spawnSync,
    prepare = prepareCodexKeychainTestFixture,
    prepareBackend = prepareCodexBackendTestFixture,
  } = {},
  sourceRoot = root,
) {
  const result = run("ssh", [options.host, "uname -sm"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  const match =
    result.status === 0 ? /^Darwin (arm64|x86_64)$/.exec(String(result.stdout).trim()) : null;
  if (!match) throw new Error("The native Codex test architecture could not be determined");
  const sdk = await prepare({
    architecture: match[1] === "arm64" ? "arm64" : "x64",
    output: join(sourceRoot, "macos/.codex-keychain-fixture"),
    cache: join(homedir(), ".cache", "omnesis-codex-keychain-test"),
  });
  await prepareBackend({ output: join(sourceRoot, "macos/.codex-backend-fixture") });
  return sdk;
}

export function runNativeCheck(options, run = spawnSync, sourceRoot = root) {
  const exec = (command, args, extra = {}) => {
    const result = run(command, args, {
      cwd: root,
      stdio: "inherit",
      ...(command === "rsync" ? { env: { ...process.env, RSYNC_OLD_ARGS: "1" } } : {}),
      ...extra,
    });
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
    process.stdout.write(`Synchronizing native build inputs: ${directory}\n`);
    exec("rsync", [
      "-a",
      "--protocol=29",
      "--numeric-ids",
      "--delete",
      ...exclusions.flatMap((value) => ["--exclude", value]),
      `${join(sourceRoot, directory)}/`,
      `${options.host}:${shellArgument(join(options.worktree, directory) + "/")}`,
    ]);
  }
  if (options.package) {
    process.stdout.write("Extracting verified public package build fixture\n");
    remote(
      `set -eu\ncd "$1"\nexec macos/.node-fixture/node macos/.package-build-fixture/extract.mjs --fixture macos/.package-build-fixture --out package-source/source\n`,
      [options.worktree],
    );
  }
  let failure;
  try {
    remote(check, [
      options.worktree,
      options.lane,
      options.compileTests ? "compile-tests" : options.buildOnly ? "yes" : "no",
      options.hostedOnly ? "yes" : "no",
      options.package ? "yes" : "no",
      ...(options.filter && (options.lane === "logic" || options.hostedOnly)
        ? [options.filter]
        : []),
    ]);
    if (options.package) {
      remote(
        `set -eu\ncd "$1"\nexec macos/.node-fixture/node package-source/source/scripts/desktop/native-package.mjs --scratch "$PWD"\n`,
        [options.worktree],
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (options.output) {
      mkdirSync(options.output, { recursive: true, mode: 0o700 });
      exec("rsync", [
        "-a",
        `${options.host}:${shellArgument(join(options.worktree, "evidence") + "/")}`,
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
    const options = nativeCheckOptions(process.argv.slice(2));
    await prepareNativeNodeFixture(options);
    await prepareNativeCodexFixture(options);
    if (options.buildOnly && !options.compileTests)
      await prepareAnalyticsNativeFixture({
        output: join(root, "macos/.analytics-build-fixture"),
        cache: join(homedir(), ".cache", "omnesis-desktop-analytics-sources"),
      });
    if (options.package)
      await preparePackageFixture({
        source: root,
        output: join(root, "macos/.package-build-fixture"),
      });
    runNativeCheck(options);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Desktop native check failed"}\n`,
    );
    process.exitCode = 1;
  }
}
