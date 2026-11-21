// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/install-e2e/colima-up.sh");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes an executable shell stand-in for `name` into `bin`. */
function stub(bin, name, body) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/**
 * A runner stand-in: an x86_64 macOS host with 4 CPUs and 14 GiB, a `colima` whose
 * start fails as many times as `failingStarts` says, and every call to colima
 * and sudo recorded in `calls`.
 */
function host({ failingStarts = 0, arch = "x86_64" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "colima-up-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  const calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(join(home, ".colima/_lima/colima"), { recursive: true });
  writeFileSync(
    join(home, ".colima/_lima/colima/ha.stderr.log"),
    '{"level":"fatal","msg":"did not receive an event with the running status"}\n',
  );
  writeFileSync(join(root, "starts-left-to-fail"), String(failingStarts));
  stub(bin, "uname", `[ "$1" = -m ] && echo ${arch} || echo Darwin`);
  stub(bin, "sysctl", `case "$2" in hw.ncpu) echo 4 ;; hw.memsize) echo 15032385536 ;; esac`);
  stub(
    bin,
    "colima",
    `echo "colima $*" >>"${calls}"
if [ "$1" = start ]; then
  left="$(cat "${root}/starts-left-to-fail")"
  if [ "$left" -gt 0 ]; then
    echo $((left - 1)) >"${root}/starts-left-to-fail"
    echo 'level=fatal msg="error starting docker"' >&2
    exit 1
  fi
fi
[ "$1" = status ] && echo "colima is not running"
exit 0`,
  );
  stub(bin, "limactl", `echo "NAME STATUS"; echo "colima Broken"`);
  stub(bin, "docker", `[ "$1 $2" = "context show" ] && echo colima; exit 0`);
  stub(bin, "sudo", `echo "sudo $*" >>"${calls}"`);
  stub(bin, "sleep", "exit 0");
  const run = (command) =>
    spawnSync("bash", [SCRIPT, command], {
      env: {
        ...process.env,
        CI: "true",
        E2E_WORK: join(root, "work"),
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
  const recorded = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { bin, run, recorded };
}

describe("colima-up.sh start", () => {
  it("leaves the Mac one CPU and 4 GiB, and starts once when the VM comes up", () => {
    const { run, recorded } = host();
    const result = run("start");
    expect(result.status).toBe(0);
    expect(recorded()).toBe(
      "colima start --runtime docker --arch x86_64 --vm-type vz --mount-type virtiofs --cpus 3 --memory 10\n",
    );
    expect(result.stdout).toContain(
      "Docker answers through Colima (context colima, 3 CPUs, 10 GiB)",
    );
  });

  it("prints what a failed start left, deletes the instance and starts once more", () => {
    const { run, recorded } = host({ failingStarts: 1 });
    const result = run("start");
    expect(result.status).toBe(0);
    const calls = recorded().trim().split("\n");
    expect(calls.map((call) => call.split(" --")[0])).toEqual([
      "colima start",
      "colima status",
      "colima delete",
      "colima start",
    ]);
    expect(calls[2]).toBe("colima delete --force --data");
    expect(result.stdout).toContain("::group::Colima after a failed start");
    expect(result.stdout).toContain("colima Broken");
    expect(result.stdout).toContain("--- the last lines of ha.stderr.log");
    expect(result.stdout).toContain("did not receive an event with the running status");
    expect(result.stdout).toContain("attempt 2 of 2");
  });

  it("ends the lane after a second failed start, without a third", () => {
    const { run, recorded } = host({ failingStarts: 2 });
    const result = run("start");
    expect(result.status).not.toBe(0);
    expect(recorded().match(/^colima start /gmu)).toHaveLength(2);
    expect(result.stderr).toContain("Colima's VM failed to start in 2 attempts");
  });

  it("refuses a Mac that cannot start a VM, and a machine that is not CI", () => {
    const appleSilicon = host({ arch: "arm64" }).run("start");
    expect(appleSilicon.status).not.toBe(0);
    expect(appleSilicon.stderr).toContain("nested virtualization");

    const env = { ...process.env, E2E_WORK: mkdtempSync(join(tmpdir(), "colima-up-")) };
    roots.push(env.E2E_WORK);
    delete env.CI;
    const outside = spawnSync("bash", [SCRIPT, "start"], { env, encoding: "utf8" });
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain("runs on CI machines only");
  });
});

describe("colima-up.sh install", () => {
  it("refuses a download that is not the pinned bytes, before installing anything", () => {
    const { bin, run, recorded } = host();
    // Every download "succeeds" with bytes that are not the release's.
    stub(
      bin,
      "curl",
      `while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo tampered >"$2"; exit 0; }; shift; done; exit 1`,
    );
    const result = run("install");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/docker-29\.\d+\.\d+\.tgz has SHA-256 \w+, expected \w+/u);
    expect(recorded()).toBe("");
  });
});
