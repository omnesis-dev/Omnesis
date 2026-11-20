// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the real journey script from a sandbox checkout whose
 * `synth-gateway.sh` stands in for the gateway: its `start` writes what a
 * gateway that ran leaves in its config dir, then fails, so the script exits
 * through its cleanup without a simulator, an emulator or a real gateway.
 */
function runJourneysWithFailingGateway({ keptProfile }) {
  const sandbox = mkdtempSync(join(tmpdir(), "omnesis-journeys-artifacts-"));
  sandboxes.push(sandbox);
  const scripts = join(sandbox, "checkout", "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    join(root, "scripts/run-mobile-journeys.sh"),
    join(scripts, "run-mobile-journeys.sh"),
  );
  const profileLines = keptProfile
    ? [
        'mkdir -p "$OMNESIS_CONFIG_DIR/diagnostics/stalls"',
        'echo "{}" >"$OMNESIS_CONFIG_DIR/diagnostics/stalls/profile-2026-01-01T00-00-00-000Z.json"',
      ]
    : [];
  writeFileSync(
    join(scripts, "synth-gateway.sh"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == start ]]; then',
      '  mkdir -p "$OMNESIS_CONFIG_DIR/logs"',
      '  echo "gateway ran" >"$OMNESIS_CONFIG_DIR/logs/gateway.log"',
      ...profileLines.map((line) => `  ${line}`),
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(join(scripts, "synth-gateway.sh"), 0o755);
  // A model already on the machine, so nothing is downloaded.
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".config/omnesis/models"), { recursive: true });
  writeFileSync(join(home, ".config/omnesis/models/nomic-embed-text-v1.5.Q8_0.gguf"), "");
  const artifacts = join(sandbox, "artifacts");
  const result = spawnSync("bash", [join(scripts, "run-mobile-journeys.sh"), "android"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OMNESIS_CONFIG_DIR: join(sandbox, "gateway"),
      OMNESIS_GATEWAY_PORT: "17999",
      OMNESIS_JOURNEY_ARTIFACTS: artifacts,
    },
  });
  return { result, artifacts };
}

describe("scripts/run-mobile-journeys.sh artifacts", () => {
  it("keeps the gateway's logs and stall profiles when the run fails", () => {
    const { result, artifacts } = runJourneysWithFailingGateway({ keptProfile: true });
    expect(result.status).toBe(1);
    expect(readdirSync(join(artifacts, "gateway-logs"))).toContain("gateway.log");
    expect(readdirSync(join(artifacts, "gateway-logs/stall-profiles"))).toEqual([
      "profile-2026-01-01T00-00-00-000Z.json",
    ]);
  });

  it("adds no stall-profile directory when the gateway kept none", () => {
    const { result, artifacts } = runJourneysWithFailingGateway({ keptProfile: false });
    expect(result.status).toBe(1);
    expect(readdirSync(join(artifacts, "gateway-logs"))).toContain("gateway.log");
    expect(existsSync(join(artifacts, "gateway-logs/stall-profiles"))).toBe(false);
  });
});

/** Writes an executable script. */
function executable(path, lines) {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
}

/**
 * Stand-ins for the macOS tools the iOS lane calls. `xcodebuild
 * test-without-building` plays one outcome per call from TEST_XCODEBUILD, the
 * way Xcode prints it, records its arguments and the journey configuration it
 * was handed, and refuses an existing result bundle as Xcode does:
 * - `runner`: the UI test runner fails to initialize before any journey starts;
 * - `passed`: the journey passes;
 * - `failed`: the journey fails, on both of xcodebuild's own iterations;
 * - `refused`: xcodebuild rejects its arguments at once (exit 64).
 *
 * `simctl io … recordVideo` is a Node stand-in that, like simctl, ignores
 * SIGINT until it has printed "Recording started", then stops on it.
 */
function writeIosTools(bin) {
  executable(join(bin, "xcodebuild"), [
    'if [[ "$1" == build-for-testing ]]; then echo "** TEST BUILD SUCCEEDED **"; exit 0; fi',
    'args=("$@"); bundle=""',
    "for ((i = 0; i < $#; i++)); do",
    '  if [[ "${args[i]}" == -resultBundlePath ]]; then bundle="${args[i + 1]}"; fi',
    "done",
    'attempt="$(( $(grep -c "^xcodebuild " "$TEST_CALLS" 2>/dev/null || true) + 1 ))"',
    'outcome="$(cut -d, -f"$attempt" <<<"$TEST_XCODEBUILD")"',
    'echo "xcodebuild $* => $outcome" >>"$TEST_CALLS"',
    'echo "config $TEST_RUNNER_OMNESIS_JOURNEY_CONFIG" >>"$TEST_CALLS"',
    'if [[ -e "$bundle" ]]; then echo "Existing file at -resultBundlePath $bundle" >&2; exit 64; fi',
    'mkdir -p "$bundle"',
    'case "$outcome" in',
    "  runner)",
    `    echo 'OmnesisDemoUITests-Runner[1:2] [Default] Failed to initialize for UI testing: Error Domain=com.apple.dt.XCTest.XCTFuture Code=1000 "Timed out while loading Accessibility."' >&2`,
    '    echo "Testing failed:"',
    `    printf '\\tOmnesisDemoUITests-Runner (1) encountered an error (The test runner failed to initialize for UI testing. (Underlying Error: Timed out while loading Accessibility.))\\n'`,
    '    echo "** TEST EXECUTE FAILED **"',
    "    exit 65 ;;",
    "  passed)",
    `    echo "Test Case '-[OmnesisDemoUITests.MobileJourneyUITests testAskingTheAgentShowsItsAnswer]' started (Iteration 1 of 2)."`,
    `    echo "Test Case '-[OmnesisDemoUITests.MobileJourneyUITests testAskingTheAgentShowsItsAnswer]' passed (12.000 seconds)."`,
    '    echo "** TEST EXECUTE SUCCEEDED **" ;;',
    "  failed)",
    "    for iteration in 1 2; do",
    `      echo "Test Case '-[OmnesisDemoUITests.MobileJourneyUITests testAskingTheAgentShowsItsAnswer]' started (Iteration $iteration of 2)."`,
    `      echo "MobileJourneyUITests.swift:250: error: -[OmnesisDemoUITests.MobileJourneyUITests testAskingTheAgentShowsItsAnswer] : XCTAssertTrue failed"`,
    `      echo "Test Case '-[OmnesisDemoUITests.MobileJourneyUITests testAskingTheAgentShowsItsAnswer]' failed (60.000 seconds)."`,
    "    done",
    '    echo "** TEST EXECUTE FAILED **"',
    "    exit 65 ;;",
    "  refused)",
    '    echo "xcodebuild: error: Must specify -test-iterations with more than 1 iteration." >&2',
    "    exit 64 ;;",
    "esac",
  ]);
  writeFileSync(
    join(bin, "record-video.mjs"),
    [
      // An interrupt before recording starts is lost, as a background job's
      // inherited SIG_IGN loses it for simctl.
      "const ignore = () => {};",
      'process.on("SIGINT", ignore);',
      "setTimeout(() => {",
      '  console.log("Recording started");',
      '  process.off("SIGINT", ignore);',
      '  process.on("SIGINT", () => {',
      '    console.log("Recording completed. Writing to disk.");',
      "    process.exit(0);",
      "  });",
      "}, 1500);",
      // Never outlives a test that failed to stop it.
      "setTimeout(() => process.exit(1), 120_000);",
      "",
    ].join("\n"),
  );
  // simctl's boot, privacy, recording and log calls succeed silently; the
  // result bundle summarises one passed journey.
  executable(join(bin, "xcrun"), [
    'if [[ "$1 $2" == "simctl io" ]]; then exec node "$(dirname "$0")/record-video.mjs"; fi',
    'if [[ "$1 $2 $3" == "xcresulttool get test-results" ]]; then',
    '  echo \'{"totalTestCount": 1, "passedTests": 1, "skippedTests": 0, "failedTests": 0}\'',
    "fi",
  ]);
  executable(join(bin, "xcodegen"), []);
  executable(join(bin, "openssl"), ['echo "sha256 Fingerprint=AB:CD"']);
  // The gateway's search finds the document the lane waits for.
  executable(join(bin, "curl"), [
    'if [[ "$*" == */search\\ * && "$*" != *search-snapshot* ]]; then',
    '  echo \'{"results": [{"title": "Acme Q3 Planning"}]}\'',
    "fi",
  ]);
}

/**
 * Runs the real iOS journey lane from a sandbox checkout, with the real
 * `xcodebuild-ui-tests.mjs` and stand-ins for the simulator tools, the
 * gateway and the corpus check, so no Mac, simulator or gateway is needed.
 */
function runIosJourneys(outcomes, env = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "omnesis-ios-journeys-"));
  sandboxes.push(sandbox);
  const checkout = join(sandbox, "checkout");
  const scripts = join(checkout, "scripts");
  mkdirSync(join(scripts, "ci"), { recursive: true });
  mkdirSync(join(checkout, "ios"));
  for (const file of ["run-mobile-journeys.sh", "ci/xcodebuild-ui-tests.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(scripts, file));
  }
  executable(join(scripts, "ci/resolve-ios-packages.sh"), []);
  executable(join(scripts, "ios-resolved-bundle-id.sh"), ["echo dev.example.demo"]);
  executable(join(scripts, "synth-gateway.sh"), [
    'if [[ "$1" == start ]]; then',
    '  mkdir -p "$OMNESIS_CONFIG_DIR/tls"',
    '  echo journey-token >"$OMNESIS_CONFIG_DIR/token"',
    '  echo certificate >"$OMNESIS_CONFIG_DIR/tls/cert.pem"',
    "fi",
  ]);
  chmodSync(join(scripts, "run-mobile-journeys.sh"), 0o755);
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  writeIosTools(bin);
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".config/omnesis/models"), { recursive: true });
  writeFileSync(join(home, ".config/omnesis/models/nomic-embed-text-v1.5.Q8_0.gguf"), "");
  const artifacts = join(sandbox, "artifacts");
  const calls = join(sandbox, "calls");
  const result = spawnSync("bash", [join(scripts, "run-mobile-journeys.sh"), "ios"], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      OMNESIS_CONFIG_DIR: join(sandbox, "gateway"),
      OMNESIS_GATEWAY_PORT: "17999",
      OMNESIS_JOURNEY_ARTIFACTS: artifacts,
      OMNESIS_JOURNEY_IOS_UDID: "00000000-0000-0000-0000-000000000000",
      OMNESIS_JOURNEY_ONLY: "MobileJourneyUITests/testAskingTheAgentShowsItsAnswer",
      TEST_CALLS: calls,
      TEST_XCODEBUILD: outcomes.join(","),
      ...env,
    },
    // A recorder the lane fails to stop would hold it forever.
    timeout: 60_000,
  });
  const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return {
    result,
    artifacts,
    outcomes: lines
      .filter((line) => line.startsWith("xcodebuild "))
      .map((line) => line.split(" => ")[1]),
    calls: lines,
  };
}

describe.skipIf(process.platform === "win32")(
  "scripts/run-mobile-journeys.sh ios",
  { timeout: 90_000 },
  () => {
    it("runs the journeys once more when the UI test runner never initialized", () => {
      const { result, artifacts, outcomes, calls } = runIosJourneys(["runner", "passed"]);
      expect(result.status, result.stderr).toBe(0);
      expect(outcomes).toEqual(["runner", "passed"]);
      expect(result.stderr).toContain("failed to initialize before any test ran");
      expect(result.stdout).toContain("✓ iOS journeys passed.");
      // Both attempts get the journey's gateway configuration and its own
      // result bundle; the first is kept for the artifacts.
      for (const line of calls.filter((call) => call.startsWith("config "))) {
        expect(JSON.parse(line.slice("config ".length))).toEqual({
          gatewayURL: "https://localhost:17999",
          token: "journey-token",
          fingerprint: "abcd",
        });
      }
      expect(readdirSync(artifacts)).toEqual(
        expect.arrayContaining([
          "ios-journeys.xcresult",
          "ios-journeys-runner-not-initialized.xcresult",
        ]),
      );
      const log = readFileSync(join(artifacts, "xcodebuild.log"), "utf8");
      expect(log).toContain("Timed out while loading Accessibility.");
      expect(log).toContain("** TEST EXECUTE SUCCEEDED **");
    });

    it("leaves a failed journey to xcodebuild's own retry and fails the lane", () => {
      const { result, outcomes, calls } = runIosJourneys(["failed", "passed"]);
      expect(result.status).toBe(65);
      expect(outcomes).toEqual(["failed"]);
      expect(calls[0]).toContain("-retry-tests-on-failure -test-iterations 2");
      expect(calls[0]).toContain(
        "-only-testing:OmnesisDemoUITests/MobileJourneyUITests/testAskingTheAgentShowsItsAnswer",
      );
      expect(result.stderr).not.toContain("running xcodebuild once more");
      expect(result.stderr).toContain("✗ iOS journeys failed (xcodebuild exit 65)");
    });

    it("passes no retry flags when journey retries are turned off", () => {
      const { result, outcomes, calls } = runIosJourneys(["passed"], {
        OMNESIS_JOURNEY_RETRIES: "0",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(outcomes).toEqual(["passed"]);
      expect(calls[0]).not.toContain("-retry-tests-on-failure");
      expect(calls[0]).not.toContain("-test-iterations");
    });

    it("stops the screen recording when xcodebuild fails before it has started", () => {
      const { result, artifacts } = runIosJourneys(["refused"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(64);
      expect(readFileSync(join(artifacts, "recorder.log"), "utf8")).toContain(
        "Recording completed. Writing to disk.",
      );
    });
  },
);
