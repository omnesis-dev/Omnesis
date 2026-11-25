// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const SCRIPT = join(root, "scripts", "ci", "ios-trust-asset-block.sh");
const UDID = "00000000-0000-4000-8000-000000000001";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// trustd's own messages from a hosted run (#1253), the paths left out: two
// catalog checks and a pinning database update that stopped every TLS
// connection in the simulator for two minutes, and a run with the block.
const UPDATED = [
  "13:47:59.984 Df trustd[39181:17f7b] [com.apple.securityd:OTATrust] Using system trust store 2026040100 instead of asset trust store 0",
  "13:49:25.138 Df trustd[39181:17f85] [com.apple.securityd:OTATrust] begin download of OTATrust asset",
  "13:50:45.525 Df trustd[39181:17f8d] [com.apple.securityd:validupdate] download started at (date)",
  "13:51:10.588 Df trustd[39181:17f88] [com.apple.securityd:pinningDb] Pinning database should update from version 121 to version 131",
  "13:54:03.650 Df trustd[39181:17f88] [com.apple.securityd:OTATrust] updating asset version from 1013 to 1014",
];
const BLOCKED = [
  "13:29:11.827 Df trustd[7605:5858] [com.apple.securityd:OTATrust] Using system trust store 2026040100 instead of asset trust store 0",
  "13:29:33.387 Df trustd[7605:58b2] [com.apple.securityd:OTATrust] begin MobileAsset query for catalog com.apple.MobileAsset.PKITrustSupplementals",
  "13:29:33.401 E  trustd[7605:58b2] [com.apple.securityd:OTATrust] failed to download catalog for asset com.apple.MobileAsset.PKITrustSupplementals: 9",
];

/** Runs `report` with a stand-in `xcrun` whose simulator log holds `lines`. */
function report({ lines, record, baseline, exit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-trust-assets-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const state = join(dir, "ios-trust-assets");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(dir, "log"), lines.map((line) => `2026-11-23 ${line}\n`).join(""));
  writeFileSync(join(dir, "args"), "");
  writeFileSync(
    join(bin, "xcrun"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\ncat "${join(dir, "log")}"\nexit ${exit}\n`,
  );
  chmodSync(join(bin, "xcrun"), 0o755);
  if (record) writeFileSync(join(state, "dns-sink.log"), record.join("\n") + "\n");
  if (baseline !== undefined) writeFileSync(join(state, "baseline"), `${baseline}\n`);
  const result = spawnSync("bash", [SCRIPT, "report"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      OMNESIS_JOURNEY_IOS_UDID: UDID,
    },
    encoding: "utf8",
  });
  return { ...result, args: readFileSync(join(dir, "args"), "utf8").trim().split("\n") };
}

describe("the iOS trust asset report", () => {
  test("warns with trustd's own messages when it updated its trust data", () => {
    const result = report({ lines: UPDATED });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::the simulator's trust service still updated its trust data",
    );
    // The update messages only, not trustd's ordinary ones.
    expect(result.stdout).not.toContain("Using system trust store");
    for (const message of [
      "begin download of OTATrust asset",
      "download started at",
      "Pinning database should update from version 121 to version 131",
      "updating asset version from 1013 to 1014",
    ])
      expect(result.stdout).toContain(message);
    // It reads the named simulator's trustd, from before the journeys began.
    expect(result.args).toEqual(expect.arrayContaining(["spawn", UDID, "--last", "3h"]));
    expect(result.args.join(" ")).toContain('process == "trustd"');
  });

  test("says trustd updated nothing when its catalog checks were refused", () => {
    const result = report({
      lines: BLOCKED,
      record: [
        "13:20:00 DNS query for mesu.apple.com",
        "13:29:33 DNS query for mesu.apple.com",
        "13:29:34 DNS query for GDMF.apple.com",
        "13:41:05 DNS query for mesu.apple.com",
      ],
      baseline: 1,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
    expect(result.stdout).toContain(
      "The simulator's trust service updated none of its trust data.",
    );
    // The block's own probe (before the baseline) is not counted.
    expect(result.stdout).toMatch(/^\s+2 {2}13:29:33 {2}13:41:05 {2}mesu\.apple\.com$/m);
    expect(result.stdout).toMatch(/^\s+1 {2}13:29:34 {2}13:29:34 {2}gdmf\.apple\.com$/m);
  });
});

describe("the iOS trust asset report never claims a quiet trust service it did not read", () => {
  test("when the simulator's log cannot be read", () => {
    const result = report({ lines: ["Invalid device: simulator not booted"], exit: 1 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::could not read the simulator's trust service log: 2026-11-23 Invalid device: simulator not booted",
    );
    expect(result.stdout).not.toContain("updated none");
  });

  test("when trustd logged nothing at all", () => {
    const result = report({ lines: [] });
    expect(result.stdout).toContain(
      "::warning::the simulator's trust service logged nothing about its trust data",
    );
    expect(result.stdout).not.toContain("updated none");
  });
});

describe("the iOS trust asset block", () => {
  test("refuses to run anywhere but macOS", () => {
    if (process.platform === "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "omnesis-trust-assets-"));
    dirs.push(dir);
    const result = spawnSync("bash", [SCRIPT, "block"], {
      env: { ...process.env, RUNNER_TEMP: dir },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS runners only");
  });

  test("is in place before the journeys' simulator boots, and reported after the lane", () => {
    const workflow = parse(
      readFileSync(join(root, ".github", "workflows", "mobile-journeys.yml"), "utf8"),
    );
    const names = workflow.jobs.ios.steps.map((step) => step.name);
    const block = names.indexOf(
      "Keep the simulator's trust service off Apple's trust asset servers",
    );
    const boot = names.indexOf("Prepare iPhone simulator");
    const lane = names.indexOf("lane [ios-journeys]");
    const reported = names.indexOf("Report the simulator's trust asset activity");
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(boot);
    expect(reported).toBeGreaterThan(lane);
    expect(workflow.jobs.ios.steps[block]).toMatchObject({
      id: "trust-assets",
      run: "$GITHUB_WORKSPACE/scripts/ci/ios-trust-asset-block.sh block",
    });
    expect(workflow.jobs.ios.steps[reported]).toMatchObject({
      if: "${{ always() && steps.trust-assets.outcome == 'success' }}",
      run: "$GITHUB_WORKSPACE/scripts/ci/ios-trust-asset-block.sh report",
    });
  });
});
