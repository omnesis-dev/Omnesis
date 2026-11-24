// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const SCRIPT = join(import.meta.dirname, "apt-get-bounded.sh");
const HELPER = "scripts/docker/apt-get-bounded.sh";
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the script with a fake `apt-get` first on PATH. `behaviour` is a list of
 * what each successive call does: "ok", "hang" (never returns, as apt-get does
 * on a mirror that keeps the request open) or an exit status. Calls past the
 * end of the list succeed. Returns every argument list the fake received.
 */
function run(args, behaviour, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-apt-get-bounded-"));
  dirs.push(dir);
  const steps = behaviour.map((step) =>
    step === "ok" ? "exit 0" : step === "hang" ? "exec sleep 60" : `exit ${step}`,
  );
  const cases = steps.map((step, index) => `  ${index + 1}) ${step} ;;`).join("\n");
  const fake = join(dir, "apt-get");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
n=$(wc -l < "${dir}/calls")
case "$n" in
${cases}
  *) exit 0 ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  const result = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      APT_BOUNDED_SECONDS: "1",
      ...env,
    },
  });
  const file = join(dir, "calls");
  const calls = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  return { ...result, calls };
}

// The script runs inside the Debian and Ubuntu build images, with GNU timeout.
describe.skipIf(process.platform !== "linux")("apt-get with bounded downloads", () => {
  test("a download that finishes runs once", () => {
    const { status, calls } = run(["update"], ["ok"]);
    expect(status).toBe(0);
    expect(calls).toEqual(["update"]);
  });

  test("a download that stops making progress is stopped and tried again", () => {
    const { status, calls, stderr } = run(["update"], ["hang", "ok"]);
    expect(status).toBe(0);
    expect(calls).toEqual(["update", "update"]);
    expect(stderr).toContain("apt-get update did not finish within 1s (attempt 1 of 3)");
  });

  test("a mirror that never finishes fails after the last attempt, naming the cause", () => {
    const { status, calls, stderr } = run(["update"], ["hang", "hang"], {
      APT_BOUNDED_ATTEMPTS: "2",
    });
    expect(status).toBe(124);
    expect(calls).toEqual(["update", "update"]);
    expect(stderr).toContain(
      "did not finish within 1s, 2 times; the package mirror is not answering",
    );
  });

  test("apt-get's own failure is reported as is, without another attempt", () => {
    const { status, calls } = run(["update"], [100]);
    expect(status).toBe(100);
    expect(calls).toEqual(["update"]);
  });

  test.each(["install", "upgrade"])(
    "%s downloads under the bound, then installs from the cache",
    (command) => {
      const { status, calls } = run([command, "-y", "curl"], ["hang", "ok", "ok"]);
      expect(status).toBe(0);
      expect(calls).toEqual([
        `${command} -y curl --download-only`,
        `${command} -y curl --download-only`,
        `${command} -y curl`,
      ]);
    },
  );

  test("packages are never installed when their download fails", () => {
    const { status, calls } = run(["install", "-y", "curl"], [100]);
    expect(status).toBe(100);
    expect(calls).toEqual(["install -y curl --download-only"]);
  });
});

describe("Dockerfiles", () => {
  const dockerfiles = execFileSync("git", ["ls-files", "*Dockerfile*"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  /** Every RUN instruction of a Dockerfile, its continuation lines joined. */
  function runs(path) {
    const text = readFileSync(join(root, path), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n")
      .replaceAll(/\\\n/gu, " ");
    return text.split("\n").filter((line) => /^RUN\s/u.test(line));
  }

  test("the repository's Dockerfiles are found", () => {
    expect(dockerfiles).toContain("Dockerfile");
    expect(dockerfiles.length).toBeGreaterThanOrEqual(6);
  });

  test.each(dockerfiles)("%s downloads packages only through the bounded apt-get", (path) => {
    for (const run of runs(path)) {
      expect(run, "apt-get called directly").not.toMatch(
        /(?<![\w.-])(?:\S*\/)?apt-get\s+(?:(?:-\S+|\S+::\S+)\s+)*(?:update|install|upgrade|dist-upgrade|full-upgrade)\b/u,
      );
      if (run.includes("/tmp/apt-get-bounded.sh"))
        expect(run).toContain(`--mount=type=bind,source=${HELPER},target=/tmp/apt-get-bounded.sh`);
    }
  });
});
