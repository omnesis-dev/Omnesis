#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMachOEntitlementSlots } from "./signature-slots.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRODUCT = "OmnesisDesktopUITests-Runner";
const BUNDLE_ID = "dev.omnesis.desktop.uitests.xctrunner";
const RESTRICTED = new Set([
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

export function reduceTestRunnerEntitlements(before) {
  if (before === null || typeof before !== "object" || Array.isArray(before))
    throw new Error("Invalid test-runner entitlements");
  return Object.fromEntries(Object.entries(before).filter(([key]) => !RESTRICTED.has(key)));
}

/** Test-only generated runner: removing an App ID claim never grants another permission. */
export function normalizeDesktopTestRunner(
  products,
  dependencies = {},
  sourceRoot = projectRoot,
  inspectOnly = false,
) {
  const run = dependencies.run ?? spawnSync;
  if ((dependencies.platform ?? process.platform) !== "darwin")
    throw new Error("Test-runner signing requires macOS");
  const expected = join(resolve(sourceRoot), "build/Build/Products/Debug");
  if (resolve(products) !== expected)
    throw new Error("Only this checkout's generated Debug test runner may be normalized");
  const app = join(expected, `${PRODUCT}.app`);
  const owned = (path, kind) => {
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid && info.uid !== process.getuid()) ||
      (kind === "file" && info.nlink !== 1)
    )
      throw new Error("The generated test runner has unsafe ownership or aliases");
  };
  if (realpathSync(sourceRoot) !== resolve(sourceRoot))
    throw new Error("The test checkout root is an unsafe alias");
  let parent = resolve(sourceRoot);
  for (const component of ["build", "Build", "Products", "Debug", `${PRODUCT}.app`, "Contents"]) {
    parent = join(parent, component);
    owned(parent, "directory");
  }
  const infoPath = join(app, "Contents/Info.plist");
  const executable = join(app, "Contents/MacOS", PRODUCT);
  owned(infoPath, "file");
  owned(join(app, "Contents/MacOS"), "directory");
  owned(executable, "file");
  const execute = (command, args, extra = {}) => {
    const result = run(command, args, {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      timeout: 30_000,
      ...extra,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error("The generated UI test runner signature could not be verified or normalized");
    return result.stdout ?? "";
  };
  if (readFileSync(infoPath).length > 64 * 1024)
    throw new Error("Unexpected generated test-runner metadata size");
  const info = JSON.parse(execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath]));
  if (
    info.CFBundleIdentifier !== BUNDLE_ID ||
    info.CFBundleExecutable !== PRODUCT ||
    info.CFBundlePackageType !== "APPL"
  )
    throw new Error("The generated UI test runner identity does not match this target");
  execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const entitlements = () => {
    const xml = execute("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", app]);
    return JSON.parse(
      execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: xml }),
    );
  };
  const before = entitlements();
  if (inspectOnly) {
    if (lstatSync(executable).size > 16 * 1024 * 1024)
      throw new Error("Unexpected generated runner size");
    const bytes = readFileSync(executable);
    return {
      bundleIdentifier: BUNDLE_ID,
      executableSha256: createHash("sha256").update(bytes).digest("hex"),
      restrictedClaimsPresent: Object.keys(before).filter((key) => RESTRICTED.has(key)),
      entitlements: before,
      signatureSlots: dependencies.inspectSlots
        ? dependencies.inspectSlots(bytes)
        : inspectMachOEntitlementSlots(bytes),
      defaultEntitlementDisplay: execute("/usr/bin/codesign", ["-d", "--entitlements", "-", app]),
    };
  }
  const after = reduceTestRunnerEntitlements(before);
  if (before["com.apple.security.get-task-allow"] !== true)
    throw new Error("The generated Debug runner must already permit debugger attachment");
  const temporary = mkdtempSync(join(expected, ".omnesis-test-signature-"));
  try {
    const plist = join(temporary, "entitlements.plist");
    writeFileSync(plist, JSON.stringify(after), { mode: 0o600, flag: "wx" });
    execute("/usr/bin/plutil", ["-convert", "xml1", plist]);
    execute("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--entitlements",
      plist,
      app,
    ]);
    execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const actual = entitlements();
    if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(after)))
      throw new Error("Test-runner normalization changed an unexpected permission");
    return {
      removed: Object.keys(before).filter((key) => RESTRICTED.has(key)),
      addedPermissions: 0,
    };
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (
      process.argv.length !== 4 ||
      !["--products", "--inspect-products"].includes(process.argv[2])
    )
      throw new Error(
        "Usage: normalize-test-runner-signature.mjs --products <generated Debug products>",
      );
    const inspect = process.argv[2] === "--inspect-products";
    if (!inspect) normalizeDesktopTestRunner(process.argv[3]);
    process.stdout.write(
      JSON.stringify({
        testRunnerSignature: normalizeDesktopTestRunner(process.argv[3], {}, projectRoot, true),
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
