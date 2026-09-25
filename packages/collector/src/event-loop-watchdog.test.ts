// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watchdog against real processes: a child that spins in synchronous
 * JavaScript is killed with the stack it was stuck in on stderr; a child
 * whose loop keeps turning, or that was suspended, is left alone.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { formatPausedStack, StallJudge } from "./event-loop-watchdog-shared.js";

const WATCHDOG = fileURLToPath(new URL("./event-loop-watchdog.ts", import.meta.url));

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

interface ChildRun {
  signal: NodeJS.Signals | null;
  code: number | null;
  stderr: string;
}

/**
 * Run a child that arms the watchdog, then runs `body`. `onArmed` is called
 * with the child once the watchdog reports itself armed, so a test measures
 * from the moment the watchdog is actually watching.
 */
function runChild(
  body: string,
  onArmed: (child: ChildProcess) => void,
  timeoutMs = 30_000,
): Promise<ChildRun> {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watchdog-test-"));
  const script = join(dir, "child.ts");
  writeFileSync(
    script,
    `import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};\n` +
      `startEventLoopWatchdog({ stallLimitMs: 1_000, heartbeatIntervalMs: 100 });\n` +
      body,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, OMNESIS_LOG_FILE: "", OMNESIS_LOG_LEVEL: "info" },
    });
    let stderr = "";
    let armed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!armed && stderr.includes("Event-loop watchdog armed")) {
        armed = true;
        onArmed(child);
      }
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child still running after ${timeoutMs}ms:\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stderr });
    });
  });
}

const after = (ms: number, then: () => void): void => void setTimeout(then, ms);

describe("the event-loop watchdog", () => {
  test("kills a process stuck in synchronous JavaScript and reports where", async () => {
    const result = await runChild(
      `class PageCursor { constructor(readonly next: number) {} }\n` +
        `function walkPages(): void { let cursor = new PageCursor(0); for (;;) cursor = new PageCursor(cursor.next); }\n` +
        `setTimeout(walkPages, 1_000);\n`,
      () => {},
    );
    expect(result.signal).toBe("SIGKILL");
    expect(result.stderr).toMatch(/Event loop stalled for \d+s; restarting the collector/);
    expect(result.stderr).toContain("Main thread stack:");
    expect(result.stderr).toMatch(/at walkPages \(.*child\.ts:\d+:\d+\)/);
  }, 40_000);

  test("leaves a process whose loop keeps turning alone", async () => {
    const result = await runChild(
      `setInterval(() => { const until = Date.now() + 200; while (Date.now() < until); }, 300);\n`,
      (child) => after(4_000, () => child.kill("SIGTERM")),
    );
    expect(result.signal).toBe("SIGTERM");
    expect(result.stderr).not.toContain("Event loop stalled");
  }, 40_000);

  test("leaves a process alone after it was suspended for longer than the limit", async () => {
    // A sleeping laptop or a stopped process: no thread ran, so nothing stalled.
    const result = await runChild(`setInterval(() => {}, 1_000);\n`, (child) => {
      child.kill("SIGSTOP");
      after(2_500, () => {
        child.kill("SIGCONT");
        after(2_500, () => child.kill("SIGTERM"));
      });
    });
    expect(result.signal).toBe("SIGTERM");
    expect(result.stderr).not.toContain("Event loop stalled");
  }, 40_000);
});

describe("StallJudge", () => {
  // Limit 1000ms, checks every 100ms, a check 300ms late means suspended.
  const judge = (): StallJudge => new StallJudge(1_000, 300, 0n, 0);

  test("reports a heartbeat that stops moving once the limit has passed", () => {
    const j = judge();
    for (let t = 100; t < 1_000; t += 100) expect(j.check(0n, t)).toBeNull();
    expect(j.check(0n, 1_000)).toBe(1_000);
  });

  test("a moving heartbeat restarts the count", () => {
    const j = judge();
    for (let t = 100; t <= 900; t += 100) j.check(0n, t);
    expect(j.check(1n, 1_000)).toBeNull();
    for (let t = 1_100; t < 2_000; t += 100) expect(j.check(1n, t)).toBeNull();
    expect(j.check(1n, 2_000)).toBe(1_000);
  });

  test("time the whole process was suspended is not a stall", () => {
    // A laptop asleep for an hour: the first check after waking sees an
    // unmoved heartbeat and an hour gone, before the main thread has run.
    const j = judge();
    j.check(0n, 100);
    expect(j.check(0n, 3_600_100)).toBeNull();
    for (let t = 3_600_200; t < 3_601_100; t += 100) expect(j.check(0n, t)).toBeNull();
    expect(j.check(0n, 3_601_100)).toBe(1_000);
  });
});

describe("formatPausedStack", () => {
  const frame = (functionName: string, url: string, scriptId = "1") => ({
    functionName,
    url,
    location: { scriptId, lineNumber: 9, columnNumber: 4 },
  });

  test("names each frame innermost first, one-based, resolving script ids", () => {
    const text = formatPausedStack(
      [frame("inner", ""), frame("", "file:///outer.js", "2")],
      new Map([["1", "file:///inner.js"]]),
    );
    expect(text).toBe(
      "  at inner (file:///inner.js:10:5)\n  at <anonymous> (file:///outer.js:10:5)",
    );
  });

  test("says so when a script or the whole stack is unknown", () => {
    expect(formatPausedStack([frame("f", "", "9")], new Map())).toBe("  at f (<unknown>:10:5)");
    expect(formatPausedStack([], new Map())).toBe("  (no frames)");
  });
});
