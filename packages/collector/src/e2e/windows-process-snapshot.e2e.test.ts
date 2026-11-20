// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { WindowsProcessTree } from "@omnesis/core";
import {
  spawnE2ESubprocess,
  getOwnedE2EProcess,
  type OwnedE2EProcess,
} from "./e2e-owned-process.js";

async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.runIf(process.platform === "win32")(
  "captures owned descendants while eight leaders exit, retaining native failure diagnostics",
  async () => {
    const childProgram = "process.send('ready'); setInterval(() => {}, 1000);";
    const leaderProgram = [
      "const { spawn } = require('node:child_process');",
      "void import('@omnesis/core').then(({ installParentShutdownHandler }) => {",
      "installParentShutdownHandler(() => process.exit(0));",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "child.once('message', () => process.stdout.write('READY\\n'));",
      "setInterval(() => {}, 1000);",
      "});",
    ].join("");
    for (let iteration = 0; iteration < 8; iteration++) {
      const proc = spawnE2ESubprocess(process.execPath, ["--import", "tsx", "-e", leaderProgram], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const owned = getOwnedE2EProcess(proc)!;
      const failures: unknown[] = [];
      const helpers: OwnedE2EProcess[] = [];
      try {
        const ready = new Promise<void>((resolve) => {
          let output = "";
          proc.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("READY\n")) resolve();
          });
        });
        await bounded(Promise.all([owned.ready, ready]), 5000, "Owned fixture was not ready");
        const tree = new WindowsProcessTree(owned.applicationPid!, {
          rootIsAlive: () => owned.applicationExit === undefined,
        });
        await tree.refresh();
        expect(tree.alive).toBe(true);
        // The second arm adds short-lived brokered helpers to the same exit overlap.
        if (iteration >= 4) {
          for (let helper = 0; helper < 2; helper++) {
            const churn = spawnE2ESubprocess(process.execPath, ["-e", ""], {
              stdio: "ignore",
            });
            helpers.push(getOwnedE2EProcess(churn)!);
          }
        }
        // Snapshot and graceful leader exit overlap, while its descendant stays live.
        const [, accepted] = await Promise.all([tree.refresh(), owned.requestShutdown()]);
        expect(accepted).toBe(true);
        await tree.kill();
        expect(tree.alive).toBe(false);
        await bounded(owned.joined, 2000, "The observed process tree did not drain naturally");
        await bounded(
          Promise.all(helpers.map((helper) => helper.joined)),
          5000,
          "Short-lived owned helpers did not drain naturally",
        );
      } catch (error) {
        failures.push(error);
      }
      // The kernel Job remains the final owner even if metadata capture fails.
      try {
        await owned.stop({ initialSignal: "SIGKILL" });
      } catch (error) {
        failures.push(error);
      }
      const helperCleanup = await Promise.allSettled(
        helpers.map((helper) => helper.stop({ initialSignal: "SIGKILL" })),
      );
      for (const result of helperCleanup)
        if (result.status === "rejected") failures.push(result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Windows snapshot reproduction and cleanup failed");
    }
  },
  60_000,
);
