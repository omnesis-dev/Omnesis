// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ANDROID_GRADLE,
  IOS_PLISTS,
  IOS_PROJECT,
  NATIVE_VERSION_FILES,
  applyAndroidVersionName,
  applyIosProjectVersion,
  applyPlistShortVersion,
  assertStrictSemver,
  planNativeVersionWrites,
  writeNativeVersions,
} from "./native-versions.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A throwaway tree shaped like the repository's native project files. Version
 * writing is asserted against this, never against the checkout the test runs
 * in: a test that rewrites its own repository would leave a release bump
 * behind on every run.
 */
let fixture;

function writeFixture(version) {
  mkdirSync(join(fixture, "ios"), { recursive: true });
  mkdirSync(join(fixture, "android", "app"), { recursive: true });
  writeFileSync(
    join(fixture, "ios/project.yml"),
    `settings:\n    MARKETING_VERSION: "${version}"\n    CURRENT_PROJECT_VERSION: "243"\n`,
  );
  for (const plist of ["ios/Info.plist", "ios/Info-Demo.plist"]) {
    writeFileSync(
      join(fixture, plist),
      "<key>CFBundleShortVersionString</key>\n\t<string>" +
        version +
        "</string>\n\t<key>CFBundleVersion</key>\n\t<string>243</string>\n",
    );
  }
  writeFileSync(
    join(fixture, "android/app/build.gradle.kts"),
    `        versionCode = 1\n        versionName = "${version}"\n`,
  );
}

const readFixture = (relativePath) => readFileSync(join(fixture, relativePath), "utf8");

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "omnesis-native-versions-"));
  writeFixture("0.4.0");
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

test("rewrites the XcodeGen marketing version and leaves the build counter alone", () => {
  const before = 'settings:\n    MARKETING_VERSION: "0.4.0"\n    CURRENT_PROJECT_VERSION: "243"\n';
  const after = applyIosProjectVersion(before, "1.2.3");
  expect(after).toContain('MARKETING_VERSION: "1.2.3"');
  expect(after).toContain('CURRENT_PROJECT_VERSION: "243"');
});

test("rewrites only the short version string in a plist", () => {
  const before =
    "<key>CFBundleShortVersionString</key>\n\t<string>0.4.0</string>\n" +
    "\t<key>CFBundleVersion</key>\n\t<string>243</string>\n";
  const after = applyPlistShortVersion(before, "1.2.3");
  expect(after).toContain("<string>1.2.3</string>");
  expect(after).toContain("<string>243</string>");
});

test("rewrites the Android version name and leaves the version code alone", () => {
  const before = '        versionCode = 1\n        versionName = "0.4.0"\n';
  const after = applyAndroidVersionName(before, "1.2.3");
  expect(after).toContain('versionName = "1.2.3"');
  expect(after).toContain("versionCode = 1");
});

test("a missing field fails the release instead of silently leaving a stale version", () => {
  expect(() => applyIosProjectVersion("settings: {}\n", "1.2.3")).toThrow(/MARKETING_VERSION/u);
  expect(() => applyPlistShortVersion("<dict/>", "1.2.3")).toThrow(/CFBundleShortVersionString/u);
  expect(() => applyAndroidVersionName("android {}", "1.2.3")).toThrow(/versionName/u);
});

test("an ambiguous field fails rather than rewriting the wrong one", () => {
  const twice = '        versionName = "0.4.0"\n        versionName = "0.4.0"\n';
  expect(() => applyAndroidVersionName(twice, "1.2.3")).toThrow(/2 candidates/u);
});

test("only strict SemVer is accepted", () => {
  expect(assertStrictSemver("1.2.3")).toBe("1.2.3");
  for (const bad of ["v1.2.3", "1.2", "1.2.3-beta.1", "01.2.3", undefined]) {
    expect(() => assertStrictSemver(bad)).toThrow(/strict SemVer/u);
  }
});

test("writes the new version into every native file, and only the version", () => {
  expect(NATIVE_VERSION_FILES).toEqual([IOS_PROJECT, ...IOS_PLISTS, ANDROID_GRADLE]);
  expect(writeNativeVersions(fixture, "1.2.3")).toEqual(NATIVE_VERSION_FILES);
  for (const path of NATIVE_VERSION_FILES) expect(readFixture(path)).toContain("1.2.3");
  expect(readFixture(IOS_PROJECT)).toContain('CURRENT_PROJECT_VERSION: "243"');
  expect(readFixture("ios/Info.plist")).toContain("<string>243</string>");
  expect(readFixture(ANDROID_GRADLE)).toContain("versionCode = 1");
});

test("re-running with the same version is a no-op, which is what makes it idempotent", () => {
  writeNativeVersions(fixture, "1.2.3");
  expect(writeNativeVersions(fixture, "1.2.3")).toEqual([]);
});

test("writes only the files that are behind", () => {
  writeFileSync(
    join(fixture, IOS_PROJECT),
    'settings:\n    MARKETING_VERSION: "1.2.3"\n    CURRENT_PROJECT_VERSION: "243"\n',
  );
  expect(writeNativeVersions(fixture, "1.2.3")).toEqual([
    "ios/Info.plist",
    "ios/Info-Demo.plist",
    ANDROID_GRADLE,
  ]);
});

test("the plan reports each file without touching any of them", () => {
  const writes = planNativeVersionWrites(fixture, "9.9.9");
  expect(writes.map((entry) => entry.path)).toEqual(NATIVE_VERSION_FILES);
  for (const write of writes) {
    expect(write.changed).toBe(true);
    expect(write.after).toContain("9.9.9");
  }
  for (const path of NATIVE_VERSION_FILES) expect(readFixture(path)).toContain("0.4.0");
});

test("the repository's own native files all carry the checked-in product version", () => {
  const productVersion = JSON.parse(
    readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"),
  ).version;
  // Read-only: `changed: false` everywhere is the lockstep guard, restated
  // over the files that changesets does not touch.
  for (const write of planNativeVersionWrites(repoRoot, productVersion)) {
    expect({ path: write.path, changed: write.changed }).toEqual({
      path: write.path,
      changed: false,
    });
  }
});
