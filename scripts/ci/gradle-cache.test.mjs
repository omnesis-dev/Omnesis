// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, ".github", "workflows");

/** A Gradle cache step: `actions/cache` restores and saves, `actions/cache/restore` only restores. */
const isGradleCache = (step) =>
  /^actions\/cache(\/restore)?@/u.test(step.uses ?? "") &&
  /~\/\.gradle\/caches/u.test(step.with?.path ?? "");
const runsGradle = (step) => /\bgradlew\b/u.test(step.run ?? "");

/**
 * Every job, in every workflow, that runs the Gradle wrapper or restores a
 * Gradle cache (a job can run Gradle through a script, as the Android
 * live-gateway E2E does).
 */
const gradleJobs = readdirSync(dir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .flatMap((file) =>
    Object.entries(parse(readFileSync(join(dir, file), "utf8")).jobs ?? {})
      .filter(([, job]) =>
        (job.steps ?? []).some((step) => runsGradle(step) || isGradleCache(step)),
      )
      .map(([name, job]) => ({ id: `${file} ${name}`, runsOn: job["runs-on"], steps: job.steps })),
  );

// A job without a Gradle cache downloads Gradle and every dependency on each
// run, and a cache keyed only on the build files starts empty whenever one of
// them changes (a release bumps the app version in one). Either way a slow or
// rate-limiting download host fails the build before anything is tested.
describe("every job that runs Gradle restores the closest Gradle cache", () => {
  test("there are Gradle jobs to check", () => {
    expect(gradleJobs.length).toBeGreaterThan(1);
  });
  for (const { id, steps } of gradleJobs) {
    test(id, () => {
      const java = steps.find((step) => step.uses?.startsWith("actions/setup-java@"));
      expect(java?.with?.cache, "setup-java's own cache has no fallback key").toBeUndefined();
      const cache = steps.find(isGradleCache);
      expect(cache, "no Gradle cache step").toBeTruthy();
      expect(cache.with.key).toMatch(/hashFiles\('android\/\*\*\/\*\.gradle\*'/u);
      expect(cache.with.key.startsWith(cache.with["restore-keys"])).toBe(true);
      const gradle = steps.findIndex(runsGradle);
      if (gradle >= 0) expect(steps.indexOf(cache)).toBeLessThan(gradle);
    });
  }
});

// A saved cache entry is never replaced: the first job to save a key decides
// what every later run restores under it. Jobs that share a key resolve
// different dependencies, so only the one that resolves the most may save it.
// An entry saved first by a job that resolves fewer leaves the others
// downloading the rest again on every run.
describe("each Gradle cache entry has one job that saves it", () => {
  const savers = new Map();
  for (const { id, runsOn, steps } of gradleJobs) {
    const cache = steps.find(isGradleCache);
    if (!cache) continue; // reported by the test above
    const entry = `${JSON.stringify(runsOn)} ${cache.with.key}`;
    if (!savers.has(entry)) savers.set(entry, []);
    if (cache.uses.startsWith("actions/cache@")) savers.get(entry).push(id);
  }
  for (const [entry, ids] of savers) {
    test(entry, () => {
      expect(ids).toHaveLength(1);
    });
  }
  test("the Android lane's build-and-test job saves the Linux entry", () => {
    const linux = [...savers].filter(([entry]) => entry.startsWith('"ubuntu-latest" '));
    expect(linux.map(([, ids]) => ids)).toEqual([["android.yml build-and-test"]]);
  });
});

// Online, Gradle checks again before its first task every dependency result it
// cached more than a day ago that it may not keep forever, so a slow repository
// can hold a lane silent for many minutes even on an exact cache hit (#1228).
// The entry build-and-test saves was saved by a run that resolved everything,
// and its key covers every input that decides what the lanes resolve, so on an
// exact hit the lanes resolve offline.
describe("build-and-test resolves offline from an exact Gradle cache entry", () => {
  const job = gradleJobs.find(({ id }) => id === "android.yml build-and-test");
  const cache = job.steps.find(isGradleCache);

  test("the key covers the build files, gradle.properties and the lanes' command lines", () => {
    for (const input of [
      "android/**/*.gradle*",
      "android/gradle/libs.versions.toml",
      "android/gradle/wrapper/gradle-wrapper.properties",
      "android/gradle.properties",
      ".github/workflows/android.yml",
    ]) {
      expect(cache.with.key).toContain(`'${input}'`);
    }
  });

  test("every job that restores the Linux entry names the same key", () => {
    const linux = gradleJobs.filter(({ runsOn }) => runsOn === "ubuntu-latest");
    expect(linux.length).toBeGreaterThan(1);
    for (const { steps } of linux) expect(steps.find(isGradleCache).with.key).toBe(cache.with.key);
  });

  test("an exact hit, and only an exact hit, switches the lanes offline", () => {
    const offline = job.steps.find((step) => /OMNESIS_GRADLE_OFFLINE=true/u.test(step.run ?? ""));
    expect(offline?.if).toBe(`steps.${cache.id}.outputs.cache-hit == 'true'`);
    expect(job.steps.indexOf(offline)).toBeGreaterThan(job.steps.indexOf(cache));
    const lanes = job.steps.filter(runsGradle);
    expect(lanes.length).toBeGreaterThan(0);
    for (const step of lanes) {
      expect(job.steps.indexOf(step)).toBeGreaterThan(job.steps.indexOf(offline));
      for (const line of step.run.split("\n").filter((l) => /\bgradlew\b/u.test(l))) {
        expect(line.trim()).toMatch(/^\$GITHUB_WORKSPACE\/scripts\/ci\/gradlew\.sh /u);
      }
    }
  });
});
