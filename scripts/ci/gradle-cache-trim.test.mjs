// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = join(import.meta.dirname, "gradle-cache-trim.sh");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Gradle user home laid out as Gradle 8.11 leaves it after an Android build. */
const KEPT = [
  "caches/modules-2/files-2.1/org.robolectric/android-all-instrumented/1/a.jar",
  "caches/modules-2/metadata-2.107/descriptors/x.bin",
  "caches/jars-9/abc/plugin.jar",
  "caches/journal-1/file-access.bin",
  "caches/8.11.1/kotlin-dsl/scripts/abc/classes/Build.class",
  "caches/8.11.1/generated-gradle-jars/gradle-api-8.11.1.jar",
  "wrapper/dists/gradle-8.11.1-bin/abc/gradle-8.11.1/lib/gradle.jar",
];
const REMOVED = [
  "caches/build-cache-1/0123456789abcdef",
  "caches/8.11.1/transforms/abc/transformed/classes.dex",
  "caches/transforms-4/abc/transformed/classes.jar",
  "caches/modules-2/modules-2.lock",
  "caches/modules-2/gc.properties",
];

function gradleHome() {
  const home = mkdtempSync(join(tmpdir(), "omnesis-gradle-trim-"));
  dirs.push(home);
  for (const file of [...KEPT, ...REMOVED]) {
    mkdirSync(join(home, dirname(file)), { recursive: true });
    writeFileSync(join(home, file), "x".repeat(4096));
  }
  return home;
}

function trim(home) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GRADLE_USER_HOME: home },
  });
}

describe("scripts/ci/gradle-cache-trim.sh", () => {
  test("keeps the downloads and removes what a build recreates without the network", () => {
    const home = gradleHome();
    const result = trim(home);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const file of KEPT) expect(existsSync(join(home, file)), file).toBe(true);
    for (const file of REMOVED) expect(existsSync(join(home, file)), file).toBe(false);
  });

  test("prints what the cache holds before and after trimming", () => {
    const result = trim(gradleHome());
    const before = result.stdout.indexOf("before trimming");
    const after = result.stdout.indexOf("Saved after trimming");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(before);
    expect(result.stdout.slice(before, after)).toContain("caches/build-cache-1");
    expect(result.stdout.slice(after)).not.toContain("caches/build-cache-1");
    expect(result.stdout.slice(after)).toContain("caches/modules-2");
    expect(result.stdout.slice(after)).toContain("wrapper/dists/gradle-8.11.1-bin");
    expect(result.stdout.slice(before, after)).toContain("caches/8.11.1/transforms");
    expect(result.stdout.slice(after)).toContain("caches/8.11.1/kotlin-dsl");
    expect(result.stdout.slice(after)).not.toContain("caches/8.11.1/transforms");
  });

  test("does nothing when no Gradle cache was restored or written", () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-gradle-trim-"));
    dirs.push(home);
    const result = trim(home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to trim");
  });
});
