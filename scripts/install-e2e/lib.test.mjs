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
