// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execWindowsJob } from "@omnesis/core";
import { beforeAll, describe, test, expect, vi } from "vitest";
import { FreshnessProbe, PROBE_CACHE_TTL_MS, defaultIsProcessRunning } from "./freshness-probe.js";
import type { SourceFreshness } from "@omnesis/source-sdk";

const declared: SourceFreshness = {
  quietPeriodMs: 1000,
  hint: "Open the app.",
  requiresProcess: { processName: "ExampleApp" },
};

/** A source that declares a quiet window but names no process to probe. */
const declaredWithoutProcess: SourceFreshness = {
  quietPeriodMs: 1000,
  hint: "Check your sync service.",
};

function at(t: number) {
  return () => t;
}

describe("FreshnessProbe", () => {
  test("reports a running process", async () => {
    const probe = new FreshnessProbe(at(0), async () => true);
    expect(await probe.probe(declared)).toBe(true);
  });

  test("reports an absent process", async () => {
    const probe = new FreshnessProbe(at(0), async () => false);
    expect(await probe.probe(declared)).toBe(false);
  });

  test("returns undefined when the source declared no freshness at all", async () => {
    const probe = new FreshnessProbe(at(0), async () => true);
    expect(await probe.probe(undefined)).toBeUndefined();
  });

  test("returns undefined when a window is declared but no process names it", async () => {
    const spy = vi.fn(async () => true);
    const probe = new FreshnessProbe(at(0), spy);
    expect(await probe.probe(declaredWithoutProcess)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  // The critical distinction: a probe we could not run is NOT evidence that the
  // app is down. Returning `false` here would let the gateway manufacture a
  // staleness warning out of our own failure to look.
  test("returns undefined — not false — when the probe itself fails", async () => {
    const probe = new FreshnessProbe(at(0), async () => {
      throw new Error("pgrep unavailable");
    });
    expect(await probe.probe(declared)).toBeUndefined();
  });

  test("caches within the TTL so repeated status events don't re-probe", async () => {
    const spy = vi.fn(async () => true);
    let clock = 0;
    const probe = new FreshnessProbe(() => clock, spy);

    await probe.probe(declared);
    clock = PROBE_CACHE_TTL_MS - 1;
    await probe.probe(declared);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("re-probes once the TTL lapses, so the operator sees a reopened app", async () => {
    let running = false;
    const spy = vi.fn(async () => running);
    let clock = 0;
    const probe = new FreshnessProbe(() => clock, spy);

    expect(await probe.probe(declared)).toBe(false);
    running = true;
    clock = PROBE_CACHE_TTL_MS + 1;

    expect(await probe.probe(declared)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // A caller that has just opened the program needs the process table, and
  // every other source fed by that program should then see the same answer.
  test("a fresh reading bypasses the cache and replaces it", async () => {
    let running = false;
    const spy = vi.fn(async () => running);
    const probe = new FreshnessProbe(at(0), spy);

    expect(await probe.probe(declared)).toBe(false);
    running = true;
    expect(await probe.probe(declared, { fresh: true })).toBe(true);
    expect(await probe.probe(declared)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // A failed probe is not cached, so a transient failure doesn't blind the
  // source for a whole TTL window.
  test("does not cache a failure", async () => {
    const spy = vi.fn(async () => {
      throw new Error("transient");
    });
    const probe = new FreshnessProbe(at(0), spy);

    await probe.probe(declared);
    await probe.probe(declared);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// The wrapper tests above inject a stub, so they never exercise the real
// process lookup — yet its exit-code mapping is the highest-consequence logic
// here: invert it and every healthy source is reported stale while every
// stalled one looks fine. These drive the actual `pgrep`.
describe("defaultIsProcessRunning", () => {
  beforeAll(async () => {
    // Native job bootstrap is a prerequisite; each measured process probe keeps its 2s deadline.
    if (process.platform === "win32")
      await execWindowsJob(process.execPath, ["-e", ""], { timeout: 30_000 });
  });
  async function withRunningProcess(check: (name: string) => Promise<void>): Promise<void> {
    const directory =
      process.platform === "win32" ? mkdtempSync(join(tmpdir(), "omnesis-feed-probe-")) : undefined;
    const name = directory ? "omnesis-feed-probe" : "sleep";
    const executable = directory ? join(directory, `${name}.exe`) : "sleep";
    if (directory) copyFileSync(process.execPath, executable);
    const child = spawn(executable, directory ? ["-e", "setInterval(()=>{},1000)"] : ["30"], {
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await once(child, "spawn");
      await check(name);
    } finally {
      child.kill("SIGKILL");
      await closed;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
  test("reports true for a process that is certainly running — one it starts", async () => {
    // A child with a known name, rather than Node itself: a test runner may
    // retitle its own processes, so "node" is not guaranteed to be present.
    await withRunningProcess(async (name) => {
      expect(await defaultIsProcessRunning(name)).toBe(true);
      if (process.platform === "win32")
        expect(await defaultIsProcessRunning(`${name}.EXE`)).toBe(true);
    });
  });

  test("reports false — not an error — for a name that matches nothing", async () => {
    expect(await defaultIsProcessRunning("omnesis-no-such-process-xyz")).toBe(false);
  });

  // `-x` is exact-match: a declared name must not be satisfied by a longer
  // process name that merely contains it, or a source would look healthy
  // because something unrelated happens to be running.
  test("does not match on a prefix of a running process name", async () => {
    await withRunningProcess(async (name) => {
      expect(await defaultIsProcessRunning(name.slice(0, -1))).toBe(false);
    });
  });
});
