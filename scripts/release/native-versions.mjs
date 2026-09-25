// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The four native version fields that carry the product version into the
 * mobile builds: the XcodeGen project's `MARKETING_VERSION`, the short
 * version string in both iOS Info plists, and the Android `versionName`.
 *
 * Changesets bumps every `package.json`, `sync-plugin-versions.mjs` bumps the
 * plugin manifests, and this module bumps what is left — so a release never
 * depends on someone remembering to hand-edit an Xcode setting.
 *
 * The build counters next to these fields (`CURRENT_PROJECT_VERSION`,
 * `CFBundleVersion`, `versionCode`) are deliberately untouched: they are
 * per-upload store counters that advance independently of the product
 * version, and the store pipeline owns them.
 *
 * Every transform is a pure string rewrite that throws when the field it
 * targets is absent, so a renamed key fails the release rather than silently
 * leaving a stale version behind.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const IOS_PROJECT = "ios/project.yml";
export const IOS_PLISTS = ["ios/Info.plist", "ios/Info-Demo.plist"];
export const ANDROID_GRADLE = "android/app/build.gradle.kts";

/** Every file a `release version` run rewrites, in the order it rewrites them. */
export const NATIVE_VERSION_FILES = [IOS_PROJECT, ...IOS_PLISTS, ANDROID_GRADLE];

export function assertStrictSemver(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    throw new Error(`Product version must be strict SemVer X.Y.Z, got: ${version}`);
  }
  return version;
}

function replaceOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (!matches || matches.length === 0) throw new Error(`Could not find ${label}`);
  if (matches.length > 1) throw new Error(`Found ${matches.length} candidates for ${label}`);
  return text.replace(pattern, replacement);
}

/** `MARKETING_VERSION: "0.4.0"` in the XcodeGen project spec. */
export function applyIosProjectVersion(text, version) {
  return replaceOnce(
    text,
    /(MARKETING_VERSION:\s*)(["']?)[^"'\s]+\2/u,
    `$1"${version}"`,
    `${IOS_PROJECT} MARKETING_VERSION`,
  );
}

/** `<key>CFBundleShortVersionString</key><string>0.4.0</string>` in an Info plist. */
export function applyPlistShortVersion(text, version, label = "Info.plist") {
  return replaceOnce(
    text,
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/u,
    `$1${version}$2`,
    `${label} CFBundleShortVersionString`,
  );
}

/** `versionName = "0.4.0"` in the Android app module. */
export function applyAndroidVersionName(text, version) {
  return replaceOnce(
    text,
    /(versionName\s*=\s*")[^"]+(")/u,
    `$1${version}$2`,
    `${ANDROID_GRADLE} versionName`,
  );
}

function transformFor(relativePath) {
  if (relativePath === IOS_PROJECT) return applyIosProjectVersion;
  if (relativePath === ANDROID_GRADLE) return applyAndroidVersionName;
  return (text, version) => applyPlistShortVersion(text, version, relativePath);
}

/**
 * What writing `version` into the native project files would change, without
 * changing anything. `changed: false` on every entry means the tree already
 * carries this version — which is what makes `release version` re-runnable.
 */
export function planNativeVersionWrites(root, version) {
  assertStrictSemver(version);
  return NATIVE_VERSION_FILES.map((relativePath) => {
    const before = readFileSync(join(root, relativePath), "utf8");
    const after = transformFor(relativePath)(before, version);
    return { path: relativePath, before, after, changed: before !== after };
  });
}

/** Apply the plan above. Returns the paths that actually changed on disk. */
export function writeNativeVersions(root, version) {
  const writes = planNativeVersionWrites(root, version);
  for (const write of writes) {
    if (write.changed) writeFileSync(join(root, write.path), write.after);
  }
  return writes.filter((write) => write.changed).map((write) => write.path);
}
