// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireUpdateLock } from "@omnesis/core";
import { createCliUpdater } from "./self-update.js";

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === "win32")("Windows collector update containment", () => {
  test.each([false, true])(
    "joins descendants after wrapper exit and preserves an unverifiable fence: %s",
    async (unverified) => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-self-update-job-"));
      scratch.push(dir);
      const lock = acquireUpdateLock(dir, { owner: "synthetic collector update" });
      const marker = join(dir, "descendant.pid");
      const wrapperMarker = join(dir, "wrapper.pid");
      const cli = join(dir, "updater.cjs");
      writeFileSync(
        cli,
        `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(wrapperMarker)}, String(process.pid));
      const script = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
      require("node:child_process").spawn(process.execPath, ["-e", script, ${JSON.stringify(marker)}], { stdio: "inherit", detached: true }).unref();
    `,
      );
      // Trigger the genuine product deadline only after both processes have run.
      // Add-Type startup time does not decide whether containment is exercised.
      const deadlineMs = 137_219;
      let expire: (() => void) | undefined;
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === deadlineMs) expire = () => callback(...args);
        return realSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
      let settled = false;
      const run = createCliUpdater({
        cliPath: cli,
        configDir: dir,
        deadlineMs,
        stopGraceMs: 1000,
      }).run({ version: "0.5.0", lockId: lock.id });
      void run.then(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 30_000 });
        const pid = Number(readFileSync(marker, "utf8"));
        const wrapperPid = Number(readFileSync(wrapperMarker, "utf8"));
        expect(pid).toBeGreaterThan(0);
        await vi.waitFor(() => expect(alive(wrapperPid)).toBe(false), { timeout: 10_000 });
        expect(alive(pid)).toBe(true);
        expect(settled).toBe(false);
        lock.setProcessGroup(unverified ? process.pid : pid);
        if (unverified) {
          const ownerPath = join(dir, "update.lock", "owner.json");
          const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
          owner.processGroupStart = "synthetic-wrong-birth";
          writeFileSync(ownerPath, JSON.stringify(owner));
        }
        expect(expire).toBeTypeOf("function");
        expire!();
        const result = await run;
        expect(result.state).toBe("failed");
        expect(result.retainLock).toBe(unverified ? true : undefined);
        await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
        expect(alive(process.pid)).toBe(true);
      } finally {
        if (!settled) expire?.();
        try {
          await run;
        } finally {
          lock.release();
        }
      }
    },
    60_000,
  );
});
