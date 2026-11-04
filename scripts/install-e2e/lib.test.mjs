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
