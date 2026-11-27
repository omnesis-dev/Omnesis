// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = join(import.meta.dirname, "ios-journey-stall-watch.sh");
const dirs = [];
const watchers = [];

afterEach(async () => {
  // Let each capture and its samplers finish before removing their files.
  for (const finish of watchers.splice(0)) await finish();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A command on PATH that records each call and runs `body`. */
function stub(bin, name, calls, body = "") {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Starts the watcher against stand-ins for the macOS tools it uses: `pgrep`
 * finds one process for each executable path, `sample` attaches to every
 * process but trustd, which only root's `spindump` reaches, and `simctl log
 * show` prints a line.
 */
function watch({ holdNetwork = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-stall-watch-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  stub(
    bin,
    "pgrep",
    calls,
    `case "$2" in
  *trustd) echo 101 ;;
  *securityd) echo 102 ;;
  *OmnesisDemo.app/OmnesisDemo) echo 103 ;;
  *OmnesisDemoUITests-Runner) echo 104 ;;
esac`,
  );
  stub(
    bin,
    "sample",
    calls,
    `[ "$1" = 101 ] && exit 1
echo "stack of $1" > "$5"`,
  );
  stub(bin, "sudo", calls, `[ "$1" = -n ] && shift; "$@"`);
  stub(bin, "spindump", calls, `echo "spindump of $1" > "$4"`);
  const release = join(dir, "release-network");
  const entered = join(dir, "network-entered");
  if (holdNetwork) {
    const file = join(bin, "xcrun");
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, "xcrun " + process.argv.slice(2).join(" ") + "\\n");
fs.writeFileSync(${JSON.stringify(entered)}, "entered");
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    process.stdout.write("trustd: evaluating\\n");
  } else if (Date.now() >= deadline) {
    clearInterval(timer);
    process.exitCode = 1;
  }
}, 10);
`,
    );
    chmodSync(file, 0o755);
  } else {
    stub(bin, "xcrun", calls, `echo "trustd: evaluating"`);
  }
  const log = join(dir, "xcodebuild.log");
  writeFileSync(log, "Testing started\n");
  const out = join(dir, "out");
  const watcher = spawn("bash", [SCRIPT, "SIM-UDID", log, out], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OMNESIS_STALL_WATCH_INTERVAL: "0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  watcher.stdout.resume();
  watcher.stderr.resume();
  const fail = (n) =>
    appendFileSync(
      log,
      `/work/ios/UITests/MobileJourneyUITests.swift:${n}: error: -[MobileJourneyUITests testAsking] : failed\n`,
    );
  let closed = false;
  const exited = new Promise((resolve) =>
    watcher.on("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  const releaseNetwork = () => writeFileSync(release, "release");
  watchers.push(async () => {
    releaseNetwork();
    for (let n = 1; n <= 3 && !closed; n += 1) {
      fail(1000 + n);
      await until(
        () => closed || written(captured(out, n), "trustd: evaluating"),
        `cleanup capture ${n}`,
      );
    }
    await until(() => closed, "watcher and inherited sampler streams to close");
    expect(await exited).toBe(0);
  });
  return { out, calls, fail, exited, entered, releaseNetwork };
}

async function until(condition, what) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const captured = (out, n) => join(out, `failure-${n}`, "simulator-network.log");

function written(path, text) {
  return existsSync(path) && readFileSync(path, "utf8").includes(text);
}

async function assertCapture(out, beforeNetworkRead = () => {}) {
  const dir = join(out, "failure-1");
  // A sampler creates its file before it writes the stack, so each one is
  // read once it holds what it was asked to write.
  await until(
    () => written(join(dir, "sample-securityd-102.txt"), "stack of 102"),
    "securityd's sample",
  );
  await until(() => written(join(dir, "sample-app-103.txt"), "stack of 103"), "the app's sample");
  await until(
    () => written(join(dir, "sample-runner-104.txt"), "stack of 104"),
    "the runner's sample",
  );
  // trustd refuses `sample`; root's spindump takes it instead.
  await until(
    () => written(join(dir, "spindump-trustd-101.txt"), "spindump of 101"),
    "trustd's spindump",
  );
  beforeNetworkRead();
  // Shell redirection creates this file before xcrun writes its output.
  await until(() => written(captured(out, 1), "trustd: evaluating"), "the simulator's network log");
  expect(readFileSync(captured(out, 1), "utf8")).toContain("trustd: evaluating");
}

// The watcher runs on the macOS journey runner; the stand-ins are POSIX scripts.
describe.skipIf(process.platform === "win32")(
  "watching an iOS journey run for network stalls",
  () => {
    test("captures nothing until a journey fails, then samples every process on the connection", async () => {
      const { out, calls, fail } = watch();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(readdirSync(out)).toEqual([]);

      fail(232);
      await until(() => existsSync(captured(out, 1)), "the first capture");
      await until(() => readdirSync(join(out, "failure-1")).length >= 7, "every sample");
      await assertCapture(out);
      // The predicate spans lines, so the recorded call does too.
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("xcrun simctl spawn SIM-UDID log show --last 5m");
      expect(log).toContain('process == "trustd"');
    });

    test("waits for network output even after every sample has been written", async () => {
      const { out, fail, entered, releaseNetwork } = watch({ holdNetwork: true });
      fail(232);
      await until(() => existsSync(entered), "xcrun to enter with its output still empty");
      expect(readFileSync(captured(out, 1), "utf8")).toBe("");
      let networkReadStarted = false;
      let outcome;
      const validation = assertCapture(out, () => {
        networkReadStarted = true;
      }).then(
        () => {
          outcome = "passed";
        },
        (error) => {
          outcome = error;
        },
      );
      try {
        await until(() => networkReadStarted, "all sample contents before the network read");
        expect(outcome).toBeUndefined();
      } finally {
        releaseNetwork();
        await validation;
      }
      expect(outcome).toBe("passed");
      expect(readFileSync(captured(out, 1), "utf8")).toContain("trustd: evaluating");
    });

    test("takes one capture per new failure, at most three, then exits", async () => {
      const { out, fail, exited } = watch();
      for (let n = 1; n <= 4; n += 1) {
        fail(n);
        if (n <= 3) await until(() => existsSync(captured(out, n)), `capture ${n}`);
      }
      await exited;
      expect(readdirSync(out).sort()).toEqual(["failure-1", "failure-2", "failure-3"]);
    });
  },
);
