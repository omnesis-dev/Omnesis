// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const script = fileURLToPath(new URL("./prepare-hardened-runner.sh", import.meta.url));
let scratch;
let env;
let calls;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-runner-disk-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  calls = join(scratch, "calls");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    GITHUB_WORKSPACE: scratch,
    FIXTURE_CALLS: calls,
    FIXTURE_DOCKER_ROOT: scratch,
    FIXTURE_FREE_KB: "33554432",
  };
  const stub = (name, body) =>
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\nset -eu\nprintf '%s\\n' '${name}' "$@" >> "$FIXTURE_CALLS"\n${body}\n`,
      { mode: 0o755 },
    );
  // Every privileged/deletion command is recorded, never executed.
  stub("sudo", 'exit "${FIXTURE_CLEANUP_EXIT:-0}"');
  stub(
    "docker",
    'if [[ "$1" == info ]]; then exit_code="${FIXTURE_DOCKER_EXIT:-0}"; [[ "$exit_code" == 0 ]] || exit "$exit_code"; echo "$FIXTURE_DOCKER_ROOT"; else echo "fixture docker usage"; fi',
  );
  stub(
    "df",
    'if [[ "${FIXTURE_DF_INVALID:-0}" == 1 ]]; then echo unavailable; exit 0; fi; printf "filesystem 1024-blocks used available capacity mounted on\\nfixture 67108864 1 %s 1%% /\\n" "$FIXTURE_FREE_KB"',
  );
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));
const run = (overrides = {}) =>
  spawnSync("bash", [script], { env: { ...env, ...overrides }, encoding: "utf8" });
const log = () => {
  try {
    return readFileSync(calls, "utf8");
  } catch {
    return "";
  }
};

// The script prepares GitHub-hosted Linux Docker storage and Linux SDK paths.
describe.skipIf(process.platform === "win32")("hardened hosted-runner disk preparation", () => {
  test.each([
    { GITHUB_ACTIONS: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_ENVIRONMENT: "" },
    { RUNNER_OS: "macOS" },
    { RUNNER_OS: "Windows" },
  ])("refuses unsupported environments without executing commands: %j", (overrides) => {
    const result = run(overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub-hosted Linux");
    expect(log()).toBe("");
  });

  test("reclaims only the two unused SDK directories and reports measured free space", () => {
    const result = run();
    expect(result.status).toBe(0);
    const commands = log()
      .split("sudo\n")
      .slice(1)
      .map((s) => s.split("\n").slice(0, 4));
    expect(commands).toEqual([
      ["rm", "-rf", "--", "/usr/local/lib/android"],
      ["rm", "-rf", "--", "/usr/share/dotnet"],
    ]);
    expect(log()).not.toContain("prune");
    expect(log().match(/system\ndf/g)).toHaveLength(2);
    expect(result.stdout).toContain("33554432 KiB available");
  });

  test("warns about limited capacity without inventing a hardened-lane minimum", () => {
    const result = run({ FIXTURE_FREE_KB: "20971520" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("not a measured minimum for this lane");
  });

  test("stops on cleanup failure before reporting preparation complete", () => {
    const result = run({ FIXTURE_CLEANUP_EXIT: "42" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("preparation complete");
    expect(log().split("sudo\n")).toHaveLength(2);
  });

  test("rejects unreadable free-space output", () => {
    const result = run({ FIXTURE_DF_INVALID: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not measure");
  });

  test.each(["", "relative-directory", "/nonexistent/omnesis-fixture-docker-root"])(
    "rejects an invalid Docker storage root before deleting SDKs: %j",
    (dockerRoot) => {
      const result = run({ FIXTURE_DOCKER_ROOT: dockerRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Could not locate Docker storage");
      expect(log()).not.toContain("sudo");
    },
  );

  test("rejects an unavailable Docker storage root before deleting SDKs", () => {
    const result = run({ FIXTURE_DOCKER_EXIT: "1" });
    expect(result.status).not.toBe(0);
    expect(log()).not.toContain("sudo");
  });

  test("only the hardened-systemd job prepares hosted disk before its lane", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/docker-e2e.yml", import.meta.url),
      "utf8",
    );
    const [scenarios, hardened] = workflow.split("  hardened-systemd:");
    expect(scenarios).not.toContain("prepare-hardened-runner.sh");
    expect(hardened.indexOf("prepare-hardened-runner.sh")).toBeGreaterThan(0);
    expect(hardened.indexOf("prepare-hardened-runner.sh")).toBeLessThan(
      hardened.indexOf("lane [docker-hardened-systemd]"),
    );
  });
});
