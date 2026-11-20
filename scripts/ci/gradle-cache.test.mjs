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
