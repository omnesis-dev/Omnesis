// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const SCRIPT = join(import.meta.dirname, "playwright-chromium.sh");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the script against a fake Playwright command whose `install-deps` exits
 * 100, as apt-get does when a mirror cannot be reached, for its first
 * `failures` calls and then succeeds. Returns every call the fake received.
 */
function run({ failures, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-playwright-chromium-"));
  dirs.push(dir);
  const fake = join(dir, "playwright");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1" = install-deps ]; then
  n=$(cat "${dir}/failed" 2>/dev/null || echo 0)
  if [ "$n" -lt ${failures} ]; then
    echo $((n + 1)) > "${dir}/failed"
    echo "E: Failed to fetch http://mirror.invalid/ubuntu/dists/example/main/binary-amd64/Packages" >&2
    exit 100
  fi
fi
`,
  );
  chmodSync(fake, 0o755);
  const result = spawnSync("sh", [SCRIPT, fake], {
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_DEPS_RETRY_SECONDS: "0", ...env },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return { ...result, calls };
}

describe("installing Playwright's Chromium on a CI runner", () => {
  test("installs the system packages, then the browser", () => {
    const { status, calls } = run({ failures: 0 });
    expect(status).toBe(0);
    expect(calls).toEqual(["install-deps chromium", "install chromium"]);
  });

  test("tries the system packages again while a mirror is unreachable", () => {
    const { status, calls, stderr } = run({ failures: 3 });
    expect(status).toBe(0);
    expect(calls).toEqual([...Array(4).fill("install-deps chromium"), "install chromium"]);
    expect(stderr).toContain("(attempt 1 of 4); retrying in 0s");
    expect(stderr).toContain("(attempt 3 of 4); retrying in 0s");
  });

  test("gives up after the last attempt and never downloads the browser", () => {
    const { status, calls, stderr } = run({ failures: 4 });
    expect(status).toBe(1);
    expect(calls).toEqual(Array(4).fill("install-deps chromium"));
    expect(stderr).toContain("system packages failed 4 times");
  });

  test("the number of attempts is bounded by its setting", () => {
    const { status, calls } = run({ failures: 9, env: { PLAYWRIGHT_DEPS_ATTEMPTS: "2" } });
    expect(status).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

// Each job that installs Playwright's Chromium does it through the
// script, so none fails on the first unreachable mirror.
test("no workflow installs Playwright's system packages without the retry", () => {
  const dir = join(root, ".github", "workflows");
  const direct = [];
  const wrapped = [];
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/u.test(name))) {
    for (const [name, job] of Object.entries(
      parse(readFileSync(join(dir, file), "utf8")).jobs ?? {},
    )) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? "";
        if (/playwright\s+install(-deps|\s+--with-deps)/u.test(run)) direct.push(`${file} ${name}`);
        if (run.includes("scripts/ci/playwright-chromium.sh")) wrapped.push(`${file} ${name}`);
      }
    }
  }
  expect(direct).toEqual([]);
  expect(wrapped.length).toBeGreaterThan(0);
});
