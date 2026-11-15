// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The helper program's own Go checks, run as part of the unit lane: gofmt,
 * go vet and go test. The Go toolchain is a required dependency in CI; a
 * development machine without it skips with a notice.
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const hasGo = spawnSync("go", ["version"]).status === 0;
if (!hasGo && process.env.CI) {
  throw new Error("The Go toolchain is missing; the unit job must set it up (see ci.yml).");
}
if (!hasGo)
  console.warn(
    "packages/tailnet-helper: the Go toolchain is not installed — skipping its Go checks.",
  );

/** @param {string[]} args */
function go(args) {
  const result = spawnSync("go", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GOFLAGS: "-mod=readonly" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(!hasGo)("the Tailscale helper (Go)", () => {
  test("is gofmt-formatted", () => {
    const unformatted = spawnSync("gofmt", ["-l", "."], { cwd: dir, encoding: "utf8" });
    expect(unformatted.status, unformatted.stderr).toBe(0);
    expect(unformatted.stdout.trim(), "run gofmt -w on these files").toBe("");
  });

  test("passes go vet", () => {
    const { status, output } = go(["vet", "./..."]);
    expect(status, output).toBe(0);
  }, 600_000);

  test("passes its Go tests", () => {
    const { status, output } = go(["test", "-count=1", "./..."]);
    expect(status, output).toBe(0);
  }, 600_000);
});
