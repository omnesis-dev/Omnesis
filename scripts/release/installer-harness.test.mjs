// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The installer suites share one release remote per list of versions within a
 * test file, and each test works on its own copy of it. These pin that sharing
 * the build never shares what a test does to its copy.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { createFixture, destroyFixture, fixturePath, tagRelease } from "./installer-harness.mjs";

const SHIM = "#!/bin/sh\nexit 0\n";

function tags() {
  return execFileSync("git", ["tag", "--list"], {
    cwd: fixturePath(),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  })
    .trim()
    .split("\n");
}

afterEach(destroyFixture);

describe("installer harness fixtures", () => {
  test("a fixture carries exactly the release tags it asked for", () => {
    createFixture({ name: "harness-tags", versions: ["0.9.0", "0.10.0"], cliShim: SHIM });
    expect(tags()).toEqual(["v0.10.0", "v0.9.0"]);
    expect(existsSync(fixturePath("fake-bin", "npm"))).toBe(true);
  });

  test("a release one test tags is absent from the next test's fixture", () => {
    createFixture({ name: "harness-tags", versions: ["0.9.0", "0.10.0"], cliShim: SHIM });
    const first = fixturePath();
    tagRelease("0.11.0");
    expect(tags()).toContain("v0.11.0");
    destroyFixture();

    createFixture({ name: "harness-tags", versions: ["0.9.0", "0.10.0"], cliShim: SHIM });
    expect(fixturePath()).not.toBe(first);
    expect(tags()).toEqual(["v0.10.0", "v0.9.0"]);
  });

  test("a different list of versions gets its own remote", () => {
    createFixture({ name: "harness-tags", versions: ["0.10.0"], cliShim: SHIM });
    expect(tags()).toEqual(["v0.10.0"]);
  });
});
