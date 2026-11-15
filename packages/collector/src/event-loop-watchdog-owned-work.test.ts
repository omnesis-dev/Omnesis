// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { spawnWindowsJob } from "@omnesis/platform/windows-job";
import { expect, test } from "vitest";

const watchdog = new URL("./event-loop-watchdog.ts", import.meta.url).href;

async function stallWithOwnedWork(
  held: boolean,
): Promise<{ code: number | null; output: string; diagnostics: string }> {
  // This fixture owns no external process or private file operation. The shared
  // bit represents ownership that a real producer must publish before launch.
  const script = `
    import { writeSync } from 'node:fs';
    import { startEventLoopWatchdog } from ${JSON.stringify(watchdog)};
    const exitHold = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(exitHold, 0, ${held ? 1 : 0});
    startEventLoopWatchdog({ stallLimitMs: 1000, heartbeatIntervalMs: 100, exitHold });
    // Start only after the real worker reports its armed state through the logger.
    const originalWrite = process.stderr.write.bind(process.stderr);
    let started = false;
    process.stderr.write = function(chunk, ...args) {
      const result = originalWrite(chunk, ...args);
      if (!started && String(chunk).includes('Event-loop watchdog armed')) {
        started = true;
        setImmediate(() => {
          const until = performance.now() + 3000;
          while (performance.now() < until) {}
          writeSync(1, 'owned-work-finished');
          process.exit(23);
        });
      }
      return result;
    };
  `;
  const args = ["--import", "tsx", "--input-type=module", "--eval", script];
  const options = { env: { ...process.env, OMNESIS_LOG_FILE: "", OMNESIS_LOG_LEVEL: "info" } };
  const job =
    process.platform === "win32" ? spawnWindowsJob(process.execPath, args, options) : null;
  const child = job ?? spawn(process.execPath, args, { ...options, stdio: "pipe" });
  let output = "",
    diagnostics = "";
  child.stdout?.on("data", (bytes: Buffer) => (output += bytes.toString()));
  child.stderr?.on("data", (bytes: Buffer) => (diagnostics += bytes.toString()));
  const rawClose = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const proofs = await Promise.allSettled([rawClose, ...(job ? [job.jobClosed] : [])]);
    const failures = proofs.filter((proof) => proof.status === "rejected");
    if (failures.length > 0)
      throw Object.assign(
        new AggregateError(
          failures.map((proof) => proof.reason),
          "Watchdog fixture did not join",
        ),
        { cleanupFailure: undefined },
      );
    return {
      code: (proofs[0] as PromiseFulfilledResult<number | null>).value,
      output,
      diagnostics,
    };
  } finally {
    clearTimeout(guard);
  }
}

test("watchdog retains a stalled process while owned work prevents exit", async () => {
  const result = await stallWithOwnedWork(true);
  expect(result.diagnostics).toContain("Event-loop watchdog armed");
  expect(result.output).toBe("owned-work-finished");
  expect(result.code).toBe(23);
}, 40_000);

test("watchdog still restarts a stalled process without owned work", async () => {
  const result = await stallWithOwnedWork(false);
  expect(result.diagnostics).toContain("Event-loop watchdog armed");
  expect(result.diagnostics).toContain("restarting the collector");
  expect(result.output).toBe("");
  expect(result.code).not.toBe(23);
}, 40_000);
