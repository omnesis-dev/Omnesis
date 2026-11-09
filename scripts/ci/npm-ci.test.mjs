// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const SCRIPT = join(import.meta.dirname, "npm-ci.sh");
const dirs = [];

/**
 * Run the wrapper in a scratch directory against a fake `npm`. Each entry of
 * `installs` scripts one `npm ci`: "ok" leaves ffmpeg-static in place, "dropped"
 * exits 0 without it, the way npm treats a failed optional install, and "fail"
 * exits 1.
 */
function run({ installs, args = [], env = {}, lockfile = '{"node_modules/ffmpeg-static":{}}' }) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-npm-ci-"));
  dirs.push(dir);
  if (lockfile !== null) writeFileSync(join(dir, "package-lock.json"), lockfile);
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh
echo "$*" >> calls
n=$(wc -l < calls)
rm -rf node_modules
case "$(sed -n "\${n}p" script)" in
  ok) mkdir -p node_modules/ffmpeg-static; echo '{}' > node_modules/ffmpeg-static/package.json ;;
  dropped) mkdir -p node_modules ;;
  fail) exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, "npm"), 0o755);
  writeFileSync(join(dir, "script"), `${installs.join("\n")}\n`);
  const result = spawnSync("sh", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NPM_CI_RETRY_SECONDS: "0", ...env },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return { status: result.status, stderr: result.stderr, calls };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("npm-ci.sh", () => {
  test("a clean install runs once", () => {
    const { status, calls, stderr } = run({ installs: ["ok"] });
    expect(status).toBe(0);
    expect(calls).toEqual(["ci"]);
    expect(stderr).toBe("");
  });

  test("installs again when ffmpeg-static was dropped, and stops once it is back", () => {
    const { status, calls, stderr } = run({ installs: ["dropped", "dropped", "ok"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("dropped ffmpeg-static");
    expect(stderr).not.toContain("::warning::");
  });

  test("warns and carries on when ffmpeg-static stays dropped", () => {
    const { status, calls, stderr } = run({ installs: ["dropped", "dropped", "dropped"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("::warning::npm ci dropped ffmpeg-static");
  });

  test("fails a build that requires ffmpeg-static when it stays dropped", () => {
    const { status, calls, stderr } = run({
      installs: ["dropped", "dropped", "dropped"],
      env: { NPM_CI_REQUIRE_FFMPEG: "1" },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("this build requires it");
    expect(stderr).not.toContain("::warning::");
  });

  test("a build that requires ffmpeg-static passes once it is back", () => {
    const { status, calls } = run({
      installs: ["dropped", "ok"],
      env: { NPM_CI_REQUIRE_FFMPEG: "1" },
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test("still fails when npm ci keeps failing", () => {
    const { status, calls, stderr } = run({ installs: ["fail", "fail", "fail"] });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("npm ci failed after 3 attempts");
  });

  test("recovers from a failed install followed by a good one", () => {
    const { status, calls } = run({ installs: ["fail", "ok"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test.each([["--ignore-scripts"], ["--omit=optional"], ["--no-optional"]])(
    "does not look for ffmpeg-static with %s, which leaves it out on purpose",
    (flag) => {
      const { status, calls, stderr } = run({ installs: ["dropped"], args: [flag] });
      expect(status).toBe(0);
      expect(calls).toEqual([`ci ${flag}`]);
      expect(stderr).toBe("");
    },
  );

  test("does not look for ffmpeg-static when the lockfile does not list it", () => {
    for (const lockfile of ["{}", null]) {
      const { status, calls } = run({ installs: ["dropped"], lockfile });
      expect(status).toBe(0);
      expect(calls).toEqual(["ci"]);
    }
  });
});

describe("published images", () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = (name) =>
    parse(readFileSync(join(root, ".github", "workflows", name), "utf8")).jobs;
  const stepsOf = (jobs) => Object.values(jobs).flatMap((job) => job.steps ?? []);

  test("the image's dependency stage reads the requirement", () => {
    const stage = readFileSync(join(root, "Dockerfile"), "utf8")
      .split(/^FROM /mu)
      .find((text) => text.startsWith("base AS runtime-dependencies"));
    expect(stage).toMatch(/^ARG NPM_CI_REQUIRE_FFMPEG=0$/mu);
    expect(stage).toMatch(/sh scripts\/ci\/npm-ci\.sh/u);
  });

  test.each(["release.yml", "docker-publish.yml"])("%s requires ffmpeg-static", (name) => {
    const steps = stepsOf(workflow(name));
    const pushes = steps.filter((step) => /docker\/build-push-action/u.test(step.uses ?? ""));
    expect(pushes.length).toBeGreaterThan(0);
    for (const step of pushes) expect(step.with["build-args"]).toBe("NPM_CI_REQUIRE_FFMPEG=1");
    for (const step of steps.filter((s) => /docker buildx build/u.test(s.run ?? "")))
      expect(step.run).toContain("--build-arg NPM_CI_REQUIRE_FFMPEG=1");
  });
});
