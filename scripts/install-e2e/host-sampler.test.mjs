// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SAMPLER = resolve("scripts/install-e2e/host-sampler.sh");

function sampler(work, command, env = {}) {
  return spawnSync("bash", [SAMPLER, command], {
    env: { ...process.env, E2E_WORK: work, ...env },
    encoding: "utf8",
  });
}

/** Waits, without sleeping the test thread on a timer, until `check` holds. */
function waitFor(check, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting for the sampler");
    spawnSync("sleep", ["0.2"]);
  }
}

describe("host-sampler.sh", () => {
  it("prints a notice and succeeds when nothing was sampled", () => {
    const work = mkdtempSync(join(tmpdir(), "host-sampler-"));
    const result = sampler(work, "print");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no host samples");
  });

  it("samples in the background, records no arguments, and stops on print", () => {
    const root = mkdtempSync(join(tmpdir(), "host-sampler-"));
    const work = join(root, "work");
    // A `ps` stand-in, so the sampled process and its figures are known.
    const bin = join(root, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/sh
case "$*" in
  *-M*) printf 'header\\nthread\\n' ;;
  *) printf '  4242 999999  12.5 fixture-tool\\n' ;;
esac
`,
    );
    chmodSync(join(bin, "ps"), 0o755);
    const env = { HOST_SAMPLER_INTERVAL: "1", PATH: `${bin}:${process.env.PATH}` };

    const started = sampler(work, "start", env);
    expect(started.status).toBe(0);
    const pid = Number(readFileSync(join(work, "host-sampler.pid"), "utf8"));
    waitFor(() => readFileSync(join(work, "host-samples.log"), "utf8").includes("fixture-tool"));

    const printed = sampler(work, "print", env);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toMatch(/^== \d\d:\d\d:\d\d load /m);
    expect(printed.stdout).toMatch(/4242 +999999KiB cpu= 12.5 .*fixture-tool/);
    expect(printed.stdout).toContain("::group::Host samples");
    expect(existsSync(join(work, "host-sampler.pid"))).toBe(false);
    waitFor(() => spawnSync("kill", ["-0", String(pid)]).status !== 0);
  });
});
