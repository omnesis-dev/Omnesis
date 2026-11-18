// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killWindowsProcessTree, terminateChildProcess } from "./child-termination.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("owned child termination", () => {
  it("preserves POSIX signals and terminates Windows wrapper descendants", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      descendant.once('spawn', () => process.stdout.write(String(descendant.pid)));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let descendant: number | undefined;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      descendant = await new Promise<number>((resolve, reject) => {
        child.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk))));
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Parent exited before spawning its child")));
      });
      expect(alive(descendant)).toBe(true);
      await terminateChildProcess(child, "SIGTERM");
      await closed;
      if (process.platform === "win32") {
        const deadline = Date.now() + 3_000;
        while (alive(descendant) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(alive(descendant)).toBe(false);
      } else {
        expect(child.signalCode).toBe("SIGTERM");
        expect(alive(descendant)).toBe(true);
      }
      await expect(terminateChildProcess(child)).resolves.toBeUndefined();
    } finally {
      await terminateChildProcess(child, "SIGKILL");
      await closed;
      if (descendant !== undefined && alive(descendant)) process.kill(descendant, "SIGKILL");
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an invalid target PID %s",
    async (pid) => {
      await expect(killWindowsProcessTree(pid)).rejects.toThrow("Invalid child process PID");
    },
  );
});
