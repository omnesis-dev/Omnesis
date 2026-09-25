// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CheckReporter from "./lib/check-reporter.mjs";

let directory;
let destination;
let stderr;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-progress-test-"));
  destination = join(directory, "progress.json");
  vi.stubEnv("OMNESIS_CHECK_PROGRESS_FILE", destination);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const moduleResult = (relativeModuleId, state) => ({ relativeModuleId, state: () => state });
const status = () => JSON.parse(readFileSync(destination, "utf8"));

describe("file progress reporter", () => {
  test("publishes complete atomic progress and counts each module once", () => {
    const reporter = new CheckReporter();
    reporter.onTestRunStart([{}, {}]);
    expect(status()).toMatchObject({ state: "running", total: 2, completed: 0, failed: 0 });
    const passed = moduleResult("sample.test.ts", "passed");
    const failed = moduleResult("broken.test.ts", "failed");
    reporter.onTestModuleEnd(passed);
    expect(status()).toMatchObject({ completed: 1, failed: 0, file: "sample.test.ts" });
    reporter.onTestModuleEnd(failed);
    reporter.onTestRunEnd([passed, failed], [], "failed");
    expect(status()).toMatchObject({ state: "failed", completed: 2, failed: 1 });
    expect(status().updatedAt).toBeGreaterThanOrEqual(status().startedAt);
    expect(status().elapsedMs).toBeGreaterThanOrEqual(0);
    expect(readdirSync(directory)).toEqual(["progress.json"]);
    if (process.platform !== "win32") expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(stderr.mock.calls.map(([line]) => line).join("")).toContain("2/2 files, 1 failed");
  });

  test("a skipped module completes and identical paths in different projects count separately", () => {
    const reporter = new CheckReporter();
    reporter.onTestRunStart([{}, {}]);
    const modules = [
      moduleResult("same.test.ts", "passed"),
      moduleResult("same.test.ts", "skipped"),
    ];
    modules.forEach((module) => reporter.onTestModuleEnd(module));
    reporter.onTestRunEnd(modules, [], "passed");
    expect(status()).toMatchObject({ state: "passed", completed: 2, failed: 0 });
  });

  test("collection and unhandled errors cannot be reported as success", () => {
    const reporter = new CheckReporter();
    reporter.onTestRunStart([{}]);
    reporter.onTestRunEnd([moduleResult("broken.test.ts", "failed")], [], "failed");
    expect(status()).toMatchObject({ state: "failed", completed: 1, failed: 1 });
    reporter.onTestRunStart([]);
    reporter.onTestRunEnd([], [{ message: "private assertion content" }], "passed");
    expect(status()).toMatchObject({ state: "failed", completed: 0, failed: 0 });
    expect(readFileSync(destination, "utf8")).not.toContain("private assertion content");
  });

  test("cancellation preserves partial progress and the next run resets its counters", () => {
    const reporter = new CheckReporter();
    reporter.onTestRunStart([{}, {}]);
    const passed = moduleResult("sample.test.ts", "passed");
    reporter.onTestModuleEnd(passed);
    reporter.onTestRunEnd([passed, moduleResult("queued.test.ts", "queued")], [], "interrupted");
    expect(status()).toMatchObject({ state: "cancelled", total: 2, completed: 1 });
    reporter.onTestRunStart([{}]);
    expect(status()).toMatchObject({ state: "running", total: 1, completed: 0, file: null });
  });

  test("progress paths with missing parents fail explicitly", () => {
    vi.stubEnv("OMNESIS_CHECK_PROGRESS_FILE", join(directory, "missing", "progress.json"));
    expect(() => new CheckReporter().onTestRunStart([])).toThrow(/Cannot write test progress/);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("stderr progress needs no file and escapes line breaks in paths", () => {
    vi.stubEnv("OMNESIS_CHECK_PROGRESS_FILE", "");
    const reporter = new CheckReporter();
    reporter.onTestRunStart([{}]);
    reporter.onTestModuleEnd(moduleResult("line\nbreak.test.ts", "passed"));
    expect(stderr.mock.calls[0][0].split("\n")).toHaveLength(2);
    expect(readdirSync(directory)).toEqual([]);
  });
});
