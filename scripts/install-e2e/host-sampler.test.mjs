// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

/** Writes an executable shell stand-in for `name` into `bin`. */
function stub(bin, name, body) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

const PS_ONE = `case "$*" in
  *-M*) printf 'header\\nthread\\n' ;;
  *) printf '  4242 999999  12.5 fixture-tool\\n' ;;
esac`;

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
    stub(bin, "ps", PS_ONE);
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

  it("on macOS records Spotlight's indexing state and the busiest process beside the largest", () => {
    const root = mkdtempSync(join(tmpdir(), "host-sampler-"));
    const work = join(root, "work");
    const bin = join(root, "bin");
    // Twelve large idle processes and one small busy one: the busy one is
    // outside the largest twelve, so only the CPU ranking can list it.
    const rows = Array.from(
      { length: 12 },
      (_, i) => `  ${1000 + i} ${900000 - i}   0.1 large-idle-${i}`,
    );
    rows.push("  2000   4096 187.0 busy-indexer");
    stub(
      bin,
      "ps",
      `case "$*" in
  *-M*) printf 'header\\nthread\\n' ;;
  *) printf '%s\\n' ${rows.map((row) => `'${row}'`).join(" ")} ;;
esac`,
    );
    // The sampler only asks `uname -s`.
    stub(bin, "uname", "echo Darwin");
    stub(
      bin,
      "sysctl",
      `case "$2" in
  vm.loadavg) echo '{ 21.50 18.25 12.00 }' ;;
  vm.swapusage) echo 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)' ;;
esac`,
    );
    stub(bin, "memory_pressure", "echo 'System-wide memory free percentage: 80%'");
    stub(bin, "vm_stat", "echo 'Pages free: 10.'");
    stub(bin, "launchctl", "printf 'PID\\tStatus\\tLabel\\n'");
    stub(bin, "mdutil", `printf '%s:\\n\\tIndexing disabled. \\n' "$2"`);
    const env = { HOST_SAMPLER_INTERVAL: "1", PATH: `${bin}:${process.env.PATH}` };

    expect(sampler(work, "start", env).status).toBe(0);
    waitFor(() => readFileSync(join(work, "host-samples.log"), "utf8").includes("busy-indexer"));
    const printed = sampler(work, "print", env);

    expect(printed.status).toBe(0);
    expect(printed.stdout).toMatch(/^== \d\d:\d\d:\d\d load \{ 21.50 18.25 12.00 \}$/m);
    expect(printed.stdout).toMatch(
      /^spotlight \/=Indexing disabled\. \/System\/Volumes\/Data=Indexing disabled\.$/m,
    );
    expect(printed.stdout).toMatch(/2000 +4096KiB cpu=187.0 .*busy-indexer/);
    const sample = printed.stdout.split(/^== /m)[1];
    expect(sample.match(/large-idle-0$/gm)).toHaveLength(1);
    expect(sample.match(/busy-indexer$/gm)).toHaveLength(1);
  });
});
