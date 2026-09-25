// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PLUGIN_MANIFESTS,
  PRODUCT_VERSION_CONTRACTS,
  YAML_PLUGIN_MANIFESTS,
} from "./sync-plugin-versions.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..", "..");

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function capture(text, pattern, label) {
  const value = text.match(pattern)?.[1];
  if (!value) throw new Error(`Could not read ${label}`);
  return value;
}

export function checkProductVersion(root = defaultRoot, expectedTag) {
  const productVersion = readJson(root, "packages/cli/package.json").version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(productVersion)) {
    throw new Error(`Product version is not strict SemVer: ${productVersion}`);
  }
  if (!expectedTag) throw new Error("Expected release tag is required (vX.Y.Z)");
  const lock = readJson(root, "package-lock.json");
  const rootManifest = readJson(root, "package.json");
  const mismatches = [];

  const workspaceDirectories = rootManifest.workspaces.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent))
      .map((entry) => `${parent}/${entry}`)
      .filter((directory) => existsSync(join(root, directory, "package.json")));
  });
  for (const directory of workspaceDirectories) {
    const manifest = readJson(root, `${directory}/package.json`);
    if (manifest.private) continue;
    const locked = lock.packages[directory];
    if (!locked) {
      mismatches.push(`${directory}: missing from package-lock.json`);
    } else if (manifest.version !== productVersion || locked.version !== productVersion) {
      mismatches.push(`${directory}: manifest=${manifest.version}, lock=${locked.version}`);
    }
  }
  for (const path of PLUGIN_MANIFESTS) {
    const version = readJson(root, path).version;
    if (version !== productVersion) mismatches.push(`${path}: ${version}`);
  }
  for (const path of YAML_PLUGIN_MANIFESTS) {
    const manifest = readFileSync(join(root, path), "utf8");
    const version = capture(manifest, /^version:\s*(\S+)/mu, `${path} version`);
    if (version !== productVersion) mismatches.push(`${path}: ${version}`);
  }
  for (const path of PRODUCT_VERSION_CONTRACTS) {
    const version = readJson(root, path).productVersion;
    if (version !== productVersion) mismatches.push(`${path}: ${version}`);
  }
  // The extension is private to npm, but its package version is part of the
  // store artifact contract and must advance with the product.
  const extensionVersion = readJson(root, "extension/package.json").version;
  const lockedExtensionVersion = lock.packages.extension?.version;
  if (extensionVersion !== productVersion || lockedExtensionVersion !== productVersion) {
    mismatches.push(
      `extension/package.json: manifest=${extensionVersion}, lock=${lockedExtensionVersion}`,
    );
  }

  const project = readFileSync(join(root, "ios/project.yml"), "utf8");
  const iosVersion = capture(
    project,
    /MARKETING_VERSION:\s*["']?([^"'\s]+)/,
    "iOS marketing version",
  );
  const iosBuild = capture(project, /CURRENT_PROJECT_VERSION:\s*["']?(\d+)/, "iOS build number");
  for (const path of ["ios/Info.plist", "ios/Info-Demo.plist"]) {
    const plist = readFileSync(join(root, path), "utf8");
    const shortVersion = capture(
      plist,
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
      `${path} short version`,
    );
    const build = capture(
      plist,
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
      `${path} build number`,
    );
    if (shortVersion !== productVersion) mismatches.push(`${path}: ${shortVersion}`);
    if (path === "ios/Info.plist" && build !== iosBuild) {
      mismatches.push(`${path} build=${build}, project=${iosBuild}`);
    }
    if (!/^\d{1,4}$/.test(build) || Number(build) < 1)
      mismatches.push(`${path}: invalid build ${build}`);
  }
  if (!/^\d{1,4}$/.test(iosBuild) || Number(iosBuild) < 1)
    mismatches.push(`invalid iOS build ${iosBuild}`);
  if (iosVersion !== productVersion) mismatches.push(`ios/project.yml: ${iosVersion}`);

  const android = readFileSync(join(root, "android/app/build.gradle.kts"), "utf8");
  const androidVersion = capture(android, /versionName\s*=\s*"([^"]+)"/, "Android version name");
  const androidCode = capture(android, /versionCode\s*=\s*(\d+)/, "Android version code");
  if (androidVersion !== productVersion) mismatches.push(`Android versionName=${androidVersion}`);
  if (Number(androidCode) < 1 || Number(androidCode) > 2_100_000_000)
    mismatches.push(`invalid Android versionCode ${androidCode}`);

  if (expectedTag !== `v${productVersion}`) {
    mismatches.push(`tag=${expectedTag}, product=v${productVersion}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Product version ${productVersion} is not in lockstep:\n- ${mismatches.join("\n- ")}`,
    );
  }
  return productVersion;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = checkProductVersion(defaultRoot, process.argv[2]);
  process.stdout.write(`Product version ${version} is consistent.\n`);
}
