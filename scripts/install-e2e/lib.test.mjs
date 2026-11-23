// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function mintFixture(fail, verbose = false) {
  const root = mkdtempSync(join(tmpdir(), "install-mint-"));
  const bin = join(root, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const token = "omn_fixture_abcdefghijklmnopqrstuvwxyz";
  writeFileSync(
    join(bin, "omnesis"),
    `#!/bin/bash
if [ "$1" = whoami ]; then printf '{"deviceId":"fixture-device"}'; exit 0; fi
printf '  Token: ${token}\\n'
${verbose ? "printf '%05000d\\n' 0 >&2" : ""}
printf 'failure detail: Bearer ${token}\\n' >&2
exit ${fail ? 7 : 0}
`,
    { mode: 0o700 },
  );
  const work = join(root, "work");
  const result = spawnSync(
    "bash",
    [
      "-c",
      'set -e; source "$1"; mint_probe_token',
      "fixture",
      resolve("scripts/install-e2e/lib.sh"),
    ],
    {
      env: { ...process.env, HOME: root, E2E_WORK: work },
      encoding: "utf8",
    },
  );
  return { root, work, token, result };
}

describe("install probe token diagnostics", () => {
  it("prints redacted failure stderr while keeping minted stdout private", () => {
    const fixture = mintFixture(true);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("failure detail: Bearer ***");
      expect(fixture.result.stderr).toContain("could not mint the probe token");
      expect(fixture.result.stdout + fixture.result.stderr).not.toContain(fixture.token);
      expect(readFileSync(join(fixture.work, "probe-token.stderr"), "utf8")).toContain(
        "failure detail:",
      );
      expect(statSync(join(fixture.work, "probe-token.stderr")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("bounds the redacted error output", () => {
    const fixture = mintFixture(true, true);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr.length).toBeLessThan(4200);
      expect(fixture.result.stderr).toContain("failure detail: Bearer ***");
      expect(fixture.result.stderr).not.toContain(fixture.token);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps successful token parsing and suppresses command stderr", () => {
    const fixture = mintFixture(false);
    try {
      expect(fixture.result.status).toBe(0);
      expect(readFileSync(join(fixture.work, "probe-token"), "utf8").trim()).toBe(fixture.token);
      expect(fixture.result.stderr).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

/** A launcher whose `doctor --json` prints the given reports in turn, then the last again. */
function doctorFixture(reports) {
  const root = mkdtempSync(join(tmpdir(), "install-doctor-"));
  const bin = join(root, ".local/bin");
  mkdirSync(bin, { recursive: true });
  reports.forEach((report, i) => writeFileSync(join(root, `report-${i}.json`), report));
  writeFileSync(
    join(bin, "omnesis"),
    `#!/bin/bash
n=$(cat "${root}/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "${root}/count"
last=${reports.length - 1}
[ "$n" -gt "$last" ] && n=$last
cat "${root}/report-$n.json"
`,
    { mode: 0o700 },
  );
  const out = join(root, "doctor.json");
  const result = spawnSync(
    "bash",
    [
      "-c",
      'set -e; source "$1"; sleep() { :; }; doctor_json "$2"',
      "fixture",
      resolve("scripts/install-e2e/lib.sh"),
      out,
    ],
    { env: { ...process.env, HOME: root, E2E_WORK: join(root, "work") }, encoding: "utf8" },
  );
  const reads = Number(readFileSync(join(root, "count"), "utf8"));
  return { root, out, reads, result };
}

const report = (...ids) => JSON.stringify({ checks: ids.map(([id, status]) => ({ id, status })) });

describe("doctor reports in snapshots", () => {
  it("reads the doctor again until no section is unread", () => {
    const fixture = doctorFixture([
      "",
      report(["index.unavailable", "warn"], ["service.gateway", "pass"]),
      report(["index.model", "fail"], ["service.gateway", "pass"]),
    ]);
    try {
      expect(fixture.result.status).toBe(0);
      expect(fixture.reads).toBe(3);
      expect(JSON.parse(readFileSync(fixture.out, "utf8")).checks[0].id).toBe("index.model");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a complete first report without reading again", () => {
    const fixture = doctorFixture([
      report(["index.model", "fail"], ["gateway.config-revision", "pass"]),
    ]);
    try {
      expect(fixture.reads).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("gives up after three reads and says which sections stayed unread", () => {
    const fixture = doctorFixture([report(["models.unavailable", "warn"])]);
    try {
      expect(fixture.result.status).toBe(0);
      expect(fixture.reads).toBe(3);
      expect(fixture.result.stdout).toContain(
        "doctor could not read every section: models.unavailable",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

/**
 * A runner whose registry is out for the first `failures` calls of `curl`
 * and `docker pull`, each failing with `failure` (curl's message by default),
 * with `uname`, `scutil`, `dig`, `sudo` and `lsof` stand-ins, running `script`
 * after sourcing lib.sh. `before`, when given, is the resolver configuration
 * colima-up.sh saved before Colima started; `scutil` prints `now`.
 */
function outageFixture({
  script = "await_registry ghcr.io",
  failures,
  failure = "curl: (28) Resolving timed out after 10002 milliseconds",
  status = 28,
  waitSeconds = 600,
  before,
  now = "nameserver[0] : 192.0.2.53",
}) {
  const root = mkdtempSync(join(tmpdir(), "install-registry-"));
  const bin = join(root, "bin");
  const work = join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
  if (before !== undefined) writeFileSync(join(work, "resolver-before-colima"), `${before}\n`);
  writeFileSync(join(root, "failures-left"), String(failures));
  const stub = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const outage = `echo "$0 $*" >>"${root}/calls"
left="$(cat "${root}/failures-left")"
if [ "$left" -gt 0 ]; then
  echo $((left - 1)) >"${root}/failures-left"
  echo '${failure}' >&2
  exit ${status}
fi
exit 0`;
  stub("curl", outage);
  stub("docker", outage);
  stub("uname", "echo Darwin");
  stub("scutil", `echo "${now}"`);
  stub(
    "dig",
    'for a; do case "$a" in @*) server="$a" ;; esac; done; echo ";; no servers could be reached ($server)"; exit 9',
  );
  stub("sudo", 'shift; exec "$@"');
  stub("lsof", 'echo "limactl 4242 runner 12u IPv4 TCP *:53 (LISTEN)"');
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -e; source "$1"; sleep() { :; }; ${script}`,
      "fixture",
      resolve("scripts/install-e2e/lib.sh"),
    ],
    {
      env: {
        ...process.env,
        E2E_WORK: work,
        PATH: `${bin}:${process.env.PATH}`,
        REGISTRY_WAIT_SECONDS: String(waitSeconds),
      },
      encoding: "utf8",
    },
  );
  let calls = [];
  try {
    calls = readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((call) => call.replace(`${bin}/`, ""));
  } catch {
    // nothing was called
  }
  rmSync(root, { recursive: true, force: true });
  return { result, calls };
}

const DIAGNOSTICS = "::group::Name resolution while ghcr.io does not answer";

describe("await_registry", () => {
  it("returns at once when the registry answers, asking it the way the installer does", () => {
    const { result, calls } = outageFixture({ failures: 0 });
    expect(result.status).toBe(0);
    expect(calls).toEqual(["curl -sS -o /dev/null --max-time 10 https://ghcr.io/v2/"]);
    expect(result.stdout).toContain("[install-e2e] reaching ghcr.io succeeded\n");
    expect(result.stdout).not.toContain(DIAGNOSTICS);
  });

  it("outlasts an outage longer than the installer's four registry attempts", () => {
    const { result, calls } = outageFixture({
      failures: 6,
      before: "nameserver[0] : 192.0.2.53",
    });
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(7);
    // The diagnostics are taken once, while the outage lasts.
    expect(result.stdout.split(DIAGNOSTICS)).toHaveLength(2);
    expect(result.stdout).toContain(
      "reaching ghcr.io failed (curl: (28) Resolving timed out after 10002 milliseconds); waiting up to 600s for ghcr.io to answer",
    );
    expect(result.stdout).toContain(
      "--- the resolver configuration is as it was before Colima started",
    );
    expect(result.stdout).toMatch(
      /@1\.1\.1\.1: dig exit 9: ;; no servers could be reached \(@1\.1\.1\.1\)/u,
    );
    expect(result.stdout).toContain("limactl 4242 runner 12u IPv4 TCP *:53 (LISTEN)");
    expect(result.stdout).toMatch(/reaching ghcr\.io still fails after \d+s/u);
    expect(result.stdout).toMatch(/reaching ghcr\.io succeeded, after ghcr\.io was out for \d+s/u);
  });

  it("fails the lane with the diagnostics when the registry never answers in time", () => {
    const { result, calls } = outageFixture({
      failures: 1000,
      waitSeconds: 0,
      before: "nameserver[0] : 192.0.2.53",
      now: "nameserver[0] : 127.0.0.1",
    });
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(2);
    expect(result.stdout.split(DIAGNOSTICS)).toHaveLength(3);
    expect(result.stdout).toContain("--- the resolver configuration changed since Colima started");
    expect(result.stdout).toContain("-nameserver[0] : 192.0.2.53");
    expect(result.stdout).toContain("+nameserver[0] : 127.0.0.1");
    expect(result.stderr).toMatch(
      /::error::reaching ghcr\.io failed for \d+s \(curl: \(28\) Resolving timed out after 10002 milliseconds\)/u,
    );
  });
});

describe("pull_image", () => {
  const ref = "ghcr.io/omnesis-dev/omnesis-combined:1.2.3";
  const lookupTimeout = `Error response from daemon: failed to resolve reference "${ref}": failed to do request: Head "https://ghcr.io/v2/omnesis-dev/omnesis-combined/manifests/1.2.3": dial tcp: lookup ghcr.io on 192.0.2.1:53: read udp 192.0.2.1:35027->192.0.2.1:53: i/o timeout`;

  it("pulls again while the daemon cannot look the registry up, past the installer's three pulls", () => {
    const { result, calls } = outageFixture({
      script: `pull_image ghcr.io ${ref}`,
      failures: 5,
      failure: lookupTimeout,
      status: 1,
    });
    expect(result.status).toBe(0);
    expect(calls).toEqual(Array(6).fill(`docker pull --quiet ${ref}`));
    expect(result.stdout.split(DIAGNOSTICS)).toHaveLength(2);
    expect(result.stdout).toMatch(
      new RegExp(
        `pulling ${ref.replaceAll(".", "\\.")} succeeded, after ghcr\\.io was out for \\d+s`,
        "u",
      ),
    );
  });

  it("ends the lane at once on a pull failure that is not a lookup", () => {
    const { result, calls } = outageFixture({
      script: `pull_image ghcr.io ${ref}`,
      failures: 5,
      failure: `Error response from daemon: manifest unknown`,
      status: 1,
    });
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(1);
    expect(result.stdout).not.toContain(DIAGNOSTICS);
    expect(result.stderr).toContain(
      `::error::pulling ${ref} failed (Error response from daemon: manifest unknown)`,
    );
  });
});
