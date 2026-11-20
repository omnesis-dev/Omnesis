// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Runs `xcodebuild` for UI tests, printing its output and keeping a copy in a
// log file, and runs it once more only when XCTest's UI test runner failed to
// start. Before the first UI test, the runner app waits for the simulator's
// accessibility system to report that it has loaded; on a loaded hosted
// simulator that wait can time out, and xcodebuild then fails the run (exit
// 65, "The test runner failed to initialize for UI testing") without running
// a single test. That failure says nothing about the tests, so it earns one
// more attempt on the now-warm simulator. A test failure, any other error, or
// a second failure to initialize ends the run with xcodebuild's own status.
//
// Usage: node scripts/ci/xcodebuild-ui-tests.mjs --log <file> -- <xcodebuild arguments>
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** xcodebuild's exit status when testing failed. */
const TESTS_FAILED = 65;
const RUNNER_NOT_INITIALIZED =
  /failed to initialize for UI testing|Timed out waiting for AX loaded notification/;
/** XCTest's line for each test case it starts or finishes, serial or parallel. */
const TEST_CASE = /^\s*Test [Cc]ase '[^']+' (?:started|passed|failed|skipped)/;

/** Reads one output stream line by line, across chunk boundaries. */
function lineScanner(onLine) {
  let partial = "";
  return {
    feed(chunk) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) onLine(line);
    },
    end() {
      if (partial) onLine(partial);
      partial = "";
    },
  };
}

/**
 * One xcodebuild run. Resolves with its exit status and whether its runner
 * failed to initialize before any test case started.
 */
function attempt(command, args, sinks) {
  return new Promise((resolveAttempt, reject) => {
    let runnerNotInitialized = false;
    let testCaseStarted = false;
    const onLine = (line) => {
      if (TEST_CASE.test(line)) testCaseStarted = true;
      else if (RUNNER_NOT_INITIALIZED.test(line)) runnerNotInitialized = true;
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward).on("SIGTERM", forward);
    const scanners = [child.stdout, child.stderr].map((stream) => {
      const scanner = lineScanner(onLine);
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        for (const sink of sinks) sink.write(chunk);
        scanner.feed(chunk);
      });
      return scanner;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      process.off("SIGINT", forward).off("SIGTERM", forward);
      for (const scanner of scanners) scanner.end();
      resolveAttempt({
        status: code ?? 128 + (constants.signals[signal] ?? 0),
        runnerNotInitialized: code === TESTS_FAILED && runnerNotInitialized && !testCaseStarted,
      });
    });
  });
}

/** Runs xcodebuild with at most one more attempt when its UI test runner never started. */
export async function runXcodebuildUITests({
  args,
  logPath,
  command = "xcodebuild",
  output = process.stdout,
  report = (text) => process.stderr.write(`${text}\n`),
}) {
  const log = createWriteStream(logPath);
  try {
    let result = await attempt(command, args, [output, log]);
    if (result.runnerNotInitialized) {
      const bundleIndex = args.indexOf("-resultBundlePath");
      const bundle = bundleIndex >= 0 ? args[bundleIndex + 1] : undefined;
      // xcodebuild will not overwrite a result bundle; keep the failed one beside
      // the next, for the artifacts, in place of any left by an earlier run.
      if (bundle && existsSync(bundle)) {
        const kept = bundle.replace(/(\.xcresult)?$/, "-runner-not-initialized$1");
        rmSync(kept, { recursive: true, force: true });
        renameSync(bundle, kept);
      }
      const notice =
        "→ The UI test runner failed to initialize before any test ran; running xcodebuild once more.";
      report(notice);
      log.write(`\n${notice}\n\n`);
      result = await attempt(command, args, [output, log]);
      if (result.runnerNotInitialized) {
        report("✗ The UI test runner failed to initialize again; not retrying.");
      }
    }
    return result.status;
  } finally {
    await new Promise((done) => log.end(done));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  if (argv[0] !== "--log" || !argv[1] || separator !== 2 || separator === argv.length - 1) {
    process.stderr.write(
      "usage: node scripts/ci/xcodebuild-ui-tests.mjs --log <file> -- <xcodebuild arguments>\n",
    );
    process.exit(2);
  }
  try {
    process.exitCode = await runXcodebuildUITests({
      args: argv.slice(separator + 1),
      logPath: argv[1],
    });
  } catch (error) {
    process.stderr.write(`xcodebuild could not run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
