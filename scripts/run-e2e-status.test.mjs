// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn,
}));

let root;
let statusDir;
let statusPath;
let launcher;
let heartbeat;
let stderr;
let clearInterval;
let children;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omnesis-e2e-status-test-"));
  // run-e2e computes its lock directory at import time. Each test owns a fresh
  // directory and module instance, never the host's actual E2E lane directory.
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("TMP", root);
  vi.stubEnv("TEMP", root);
  vi.resetModules();
  launcher = await import("./run-e2e.mjs");
  expect(launcher.E2E_HOST_LOCK_DIR).toBe(join(root, "omnesis-e2e-lane.lock.d"));
  statusDir = join(root, "sidecar");
  mkdirSync(statusDir);
  statusPath = join(statusDir, "status.json");
  children = [];
  spawn.mockReset();
  spawn.mockImplementation(() => {
    // No pid or spawnfile: the production supervisor cannot signal a real
    // process, while its child event subscription and settlement stay live.
    const child = new EventEmitter();
    children.push(child);
    return child;
  });
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    heartbeat = callback;
    return 123;
  });
  clearInterval = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const readStatus = () => JSON.parse(readFileSync(statusPath, "utf8"));
const start = () =>
  launcher.runE2E([], {
    OMNESIS_E2E_STATUS_FILE: statusPath,
    OMNESIS_CHECK_PROGRESS_FILE: join(root, "progress.json"),
    OMNESIS_E2E_WORKERS: "1",
  });
async function spawned(count) {
  // Admission and phase transitions use promises without a real subprocess.
  for (let attempt = 0; attempt < 20 && children.length < count; attempt++) await Promise.resolve();
  expect(children).toHaveLength(count);
}
const tickets = () => readdirSync(launcher.E2E_HOST_LOCK_DIR);

describe("E2E lifecycle status artifact", () => {
  test.each([0, 7])(
    "persists all phase progress and final exit %i, then releases its isolated ticket",
    async (firstExit) => {
      const result = start();
      await spawned(1);
      expect(readStatus()).toMatchObject({
        state: "running",
        phase: "independent E2E files",
        pid: process.pid,
      });
      expect(tickets()).toEqual([`${process.pid}.json`]);
      children[0].emit("exit", firstExit, null);
      await spawned(2);
      expect(readStatus()).toMatchObject({
        state: "running",
        phase: "resource-sensitive E2E files (serial)",
      });
      children[1].emit("exit", 0, null);
      await expect(result).resolves.toBe(firstExit);
      expect(readStatus()).toMatchObject({
        state: firstExit === 0 ? "passed" : "failed",
        exitCode: firstExit,
      });
      expect(readStatus().finishedAt).toBeGreaterThanOrEqual(readStatus().startedAt);
      expect(tickets()).toEqual([]);
      expect(readdirSync(statusDir)).toEqual(["status.json"]);
      expect(clearInterval).toHaveBeenCalledWith(123);
    },
  );

  test("an unwritable heartbeat warns once and keeps supervising until both children exit", async () => {
    const result = start();
    let settled = false;
    result.finally(() => {
      settled = true;
    });
    await spawned(1);
    rmSync(statusDir, { recursive: true });
    writeFileSync(statusDir, "parent path is now a file");
    expect(() => heartbeat()).not.toThrow();
    expect(() => heartbeat()).not.toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(children[0].listenerCount("exit")).toBe(1);
    expect(tickets()).toEqual([`${process.pid}.json`]);
    expect(
      stderr.mock.calls.filter(([line]) => line.includes("Cannot refresh E2E status")),
    ).toHaveLength(1);
    rmSync(statusDir);
    mkdirSync(statusDir);
    heartbeat();
    expect(readStatus().state).toBe("running");
    children[0].emit("exit", 0, null);
    await spawned(2);
    children[1].emit("exit", 0, null);
    await expect(result).resolves.toBe(0);
    expect(readStatus().state).toBe("passed");
    expect(tickets()).toEqual([]);
    expect(clearInterval).toHaveBeenCalledWith(123);
  });
});
