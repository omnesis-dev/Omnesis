// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, ".github", "workflows");

/** Every job, in every workflow, that runs the Gradle wrapper. */
const gradleJobs = readdirSync(dir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .flatMap((file) =>
    Object.entries(parse(readFileSync(join(dir, file), "utf8")).jobs ?? {})
      .filter(([, job]) => (job.steps ?? []).some((step) => /\bgradlew\b/u.test(step.run ?? "")))
      .map(([name, job]) => ({ id: `${file} ${name}`, steps: job.steps })),
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
      const cache = steps.find(
        (step) =>
          step.uses?.startsWith("actions/cache@") &&
          /~\/\.gradle\/caches/u.test(step.with?.path ?? ""),
      );
      expect(cache, "no Gradle cache step").toBeTruthy();
      expect(cache.with.key.startsWith(cache.with["restore-keys"])).toBe(true);
      const gradle = steps.findIndex((step) => /\bgradlew\b/u.test(step.run ?? ""));
      expect(steps.indexOf(cache)).toBeLessThan(gradle);
    });
  }
});
