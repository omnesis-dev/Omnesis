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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./xcodebuild-ui-tests.mjs", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in `xcodebuild` that plays one outcome per call from
 * TEST_XCODEBUILD, the way Xcode prints it, and refuses an existing result
 * bundle as Xcode does:
 * - `runner`: the UI test runner times out waiting for accessibility before
 *   any test starts (exit 65);
 * - `passed`: every test passes (exit 0);
 * - `failed`: a test fails (exit 65);
 * - `runner-mid-run`: a test ran, then the relaunched runner failed to
 *   initialize (exit 65).
 */
const STAND_IN = String.raw`#!/usr/bin/env bash
set -eu
args=("$@")
bundle=""
for ((i = 0; i < ${"$"}{#args[@]}; i++)); do
  if [[ "${"$"}{args[i]}" == -resultBundlePath ]]; then bundle="${"$"}{args[i + 1]}"; fi
done
attempt="$(( $(grep -c '^xcodebuild ' "$TEST_CALLS" 2>/dev/null || true) + 1 ))"
outcome="$(cut -d, -f"$attempt" <<<"$TEST_XCODEBUILD")"
echo "xcodebuild $* => $outcome" >> "$TEST_CALLS"
if [[ -e "$bundle" ]]; then
  echo "xcodebuild: error: Existing file at -resultBundlePath \"$bundle\"" >&2
  exit 64
fi
mkdir -p "$bundle"
echo "attempt $attempt" > "$bundle/attempt"
echo "Touch OmnesisDemoUITests-Runner.app/PlugIns/OmnesisDemoUITests.xctest"
case "$outcome" in
  runner)
    echo "OmnesisDemoUITests-Runner[30456:81197] [Default] Failed to initialize for UI testing: Error Domain=XCTDaemonErrorDomain Code=18 \"Timed out waiting for AX loaded notification\"" >&2
    echo "Testing failed:"
    echo "	OmnesisDemoUITests-Runner (30456) encountered an error (The test runner failed to initialize for UI testing. (Underlying Error: Timed out waiting for AX loaded notification))"
    echo "** TEST FAILED **"
    exit 65 ;;
  passed)
    echo "Test Case '-[OmnesisDemoUITests.CloudPairingInteractionUITests testStatusSteps]' started."
    echo "Test Case '-[OmnesisDemoUITests.CloudPairingInteractionUITests testStatusSteps]' passed (4.210 seconds)."
    echo "** TEST SUCCEEDED **" ;;
  failed)
    echo "Test Case '-[OmnesisDemoUITests.CloudPairingInteractionUITests testStatusSteps]' started."
    echo "CloudPairingInteractionUITests.swift:42: error: -[OmnesisDemoUITests.CloudPairingInteractionUITests testStatusSteps] : XCTAssertTrue failed"
    echo "Test Case '-[OmnesisDemoUITests.CloudPairingInteractionUITests testStatusSteps]' failed (9.120 seconds)."
    echo "** TEST FAILED **"
    exit 65 ;;
  runner-mid-run)
    echo "Test case 'CloudPairingInteractionUITests.testStatusSteps()' started on 'Clone 1 of iPhone 17'"
    echo "Test case 'CloudPairingInteractionUITests.testStatusSteps()' passed on 'Clone 1 of iPhone 17' (4.210 seconds)"
    echo "Testing failed:"
    echo "	OmnesisDemoUITests-Runner (30457) encountered an error (The test runner failed to initialize for UI testing. (Underlying Error: Timed out waiting for AX loaded notification))"
    echo "** TEST FAILED **"
    exit 65 ;;
esac
`;

function run(outcomes) {
  const sandbox = mkdtempSync(join(tmpdir(), "omnesis-xcodebuild-ui-tests-"));
  sandboxes.push(sandbox);
  const bin = join(sandbox, "bin");
  const results = join(sandbox, "results");
  mkdirSync(bin);
  mkdirSync(results);
  writeFileSync(join(bin, "xcodebuild"), STAND_IN);
  chmodSync(join(bin, "xcodebuild"), 0o755);
  const calls = join(sandbox, "calls");
  const log = join(results, "xcodebuild.log");
  const bundle = join(results, "cloud-pairing.xcresult");
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--log",
      log,
      "--",
      "test",
      "-scheme",
      "OmnesisDemoUITests",
      "-resultBundlePath",
      bundle,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_CALLS: calls,
        TEST_XCODEBUILD: outcomes.join(","),
      },
    },
  );
  return {
    ...result,
    calls: readFileSync(calls, "utf8").trim().split("\n"),
    log: readFileSync(log, "utf8"),
    bundle,
    keptBundle: join(results, "cloud-pairing-runner-not-initialized.xcresult"),
  };
}

const ARGS = "test -scheme OmnesisDemoUITests -resultBundlePath";

describe.skipIf(process.platform === "win32")("scripts/ci/xcodebuild-ui-tests.mjs", () => {
  it("runs xcodebuild once with its own arguments and logs what it printed", () => {
    const result = run(["passed", "passed"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([`xcodebuild ${ARGS} ${result.bundle} => passed`]);
    expect(result.stdout).toContain("** TEST SUCCEEDED **");
    expect(result.log).toBe(result.stdout);
  });

  it("runs once more when the UI test runner never initialized, keeping both result bundles", () => {
    const result = run(["runner", "passed"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.map((call) => call.split(" => ")[1])).toEqual(["runner", "passed"]);
    expect(result.stderr).toContain("failed to initialize before any test ran");
    expect(readFileSync(join(result.keptBundle, "attempt"), "utf8")).toBe("attempt 1\n");
    expect(readFileSync(join(result.bundle, "attempt"), "utf8")).toBe("attempt 2\n");
    expect(result.log).toContain("Timed out waiting for AX loaded notification");
    expect(result.log).toContain("running xcodebuild once more");
    expect(result.log).toContain("** TEST SUCCEEDED **");
  });

  it("fails when the UI test runner fails to initialize a second time", () => {
    const result = run(["runner", "runner", "passed"]);
    expect(result.status).toBe(65);
    expect(result.calls.map((call) => call.split(" => ")[1])).toEqual(["runner", "runner"]);
    expect(result.stderr).toContain("failed to initialize again; not retrying");
  });

  it("does not retry a test failure", () => {
    const result = run(["failed", "passed"]);
    expect(result.status).toBe(65);
    expect(result.calls.map((call) => call.split(" => ")[1])).toEqual(["failed"]);
    expect(existsSync(result.keptBundle)).toBe(false);
    expect(result.stdout).toContain("XCTAssertTrue failed");
  });

  it("does not retry a runner that failed after a test had started", () => {
    const result = run(["runner-mid-run", "passed"]);
    expect(result.status).toBe(65);
    expect(result.calls.map((call) => call.split(" => ")[1])).toEqual(["runner-mid-run"]);
  });

  it("refuses to run without a log file and xcodebuild arguments", () => {
    const result = spawnSync(process.execPath, [script, "--", "test"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});
