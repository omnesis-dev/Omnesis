// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ownedProcessCleanupReceipt, spawnWindowsJob } from "@omnesis/core";

/** The result ends one command; closed proves its deliberately retained subtree joined. */
export function startRetainedWindowsFixture(command, args, options = {}) {
  if (process.platform !== "win32") throw new Error("These fixtures require Windows");
  const timeout = options.timeout ?? 30_000;
  const deadline = Date.now() + timeout;
  const directory = mkdtempSync(join(tmpdir(), "omnesis-retained-fixture-"));
  const path = join(directory, "result.json");
  const driver = fileURLToPath(
    new URL("../test-fixtures/retained-command-driver.mjs", import.meta.url),
  );
  let child;
  try {
    child = spawnWindowsJob(
      process.execPath,
      [
        driver,
        JSON.stringify({
          command,
          args,
          cwd: options.cwd,
          timeout,
          maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
          result: path,
        }),
      ],
      {
        cwd: options.cwd,
        env: options.env,
        startupTimeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())),
      },
    );
  } catch (error) {
    // Bootstrap uncertainty can still own native work; preserve its inputs.
    if (!ownedProcessCleanupReceipt(error)) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  child.stdout.resume();
  child.stderr.resume();
  let stopped = false;
  let failed = false;
  let failure;
  const processClosed = new Promise((resolve) =>
    child.once("close", () => {
      stopped = true;
      resolve();
    }),
  );
  void child.jobClosed.catch((error) => {
    failed = true;
    failure = error;
  });
  const result = (async () => {
    await child.jobReady;
    while (!existsSync(path)) {
      if (failed) throw failure;
      if (stopped) throw new Error("Retained fixture exited without a command result");
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error("Retained fixture did not report its command result");
      }
      await sleep(20);
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !["number", "string"].includes(typeof value.code) ||
      typeof value.stdout !== "string" ||
      typeof value.stderr !== "string"
    )
      throw new Error("Invalid retained fixture command result");
    return value;
  })();
  void result.catch(() => {});
  const closed = Promise.all([processClosed, child.jobClosed]).then(async () => {
    // Retire the observer too before removing its inputs. On uncertainty this
    // continuation never runs, leaving both native owner and inputs retained.
    await result.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  void closed.catch(() => {});
  return { child, result, closed, directory };
}
