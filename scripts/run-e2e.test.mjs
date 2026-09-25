// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireE2EHostLock,
  buildE2EPhases,
  childGroupIsAlive,
  effectiveMemoryBudget,
  hasSafeExplicitWorkerArg,
  inspectE2ELanes,
  parseLauncherArgs,
  selectE2EWorkers,
  waitForChild,
} from "./run-e2e.mjs";

const GIB = 1024 ** 3;

describe("memory-aware E2E worker selection", () => {
  test("uses two workers only with ample machine and free-memory headroom", () => {
    expect(
      selectE2EWorkers({
        totalBytes: 64 * GIB,
        availableBytes: 24 * GIB,
        cpuCount: 8,
      }),
    ).toBe(2);
  });

  test.each([
    { totalBytes: 8 * GIB, availableBytes: 6 * GIB, cpuCount: 8 },
    { totalBytes: 64 * GIB, availableBytes: 8 * GIB, cpuCount: 8 },
    { totalBytes: 64 * GIB, availableBytes: 24 * GIB, cpuCount: 2 },
  ])("falls back to one worker on a constrained host: %o", (host) => {
    expect(selectE2EWorkers(host)).toBe(1);
  });

  test("accepts a bounded explicit override and rejects unsafe values", () => {
    expect(
      selectE2EWorkers({
        override: "2",
        totalBytes: 8 * GIB,
        availableBytes: 2 * GIB,
        cpuCount: 2,
      }),
    ).toBe(2);
    expect(() =>
      selectE2EWorkers({
        override: "3",
        totalBytes: 64 * GIB,
        availableBytes: 32 * GIB,
        cpuCount: 8,
      }),
    ).toThrow(/must be 1 or 2/);
  });

  test("honors a process constraint instead of host-wide memory", () => {
    expect(
      effectiveMemoryBudget({
        hostTotalBytes: 128 * GIB,
        constrainedBytes: 8 * GIB,
        availableBytes: 6 * GIB,
      }),
    ).toEqual({ totalBytes: 8 * GIB, availableBytes: 6 * GIB });
  });

  test("accepts only safe CLI worker overrides", () => {
    expect(hasSafeExplicitWorkerArg(["--maxWorkers=2"])).toBe(true);
    expect(hasSafeExplicitWorkerArg(["--max-workers", "1"])).toBe(true);
    expect(hasSafeExplicitWorkerArg([])).toBe(false);
    expect(() => hasSafeExplicitWorkerArg(["--maxWorkers=64"])).toThrow(/must be 1 or 2/);
    expect(() => hasSafeExplicitWorkerArg(["--max-workers", "50%"])).toThrow(/must be 1 or 2/);
    expect(() => hasSafeExplicitWorkerArg(["--maxWorkers"])).toThrow(/got 'missing'/);
    expect(hasSafeExplicitWorkerArg(["--", "--maxWorkers=64"])).toBe(false);
  });

  test("keeps shared-resource and timing-sensitive suites in a serial phase", () => {
    const phases = buildE2EPhases("/vitest.mjs", ["--fileParallelism"], ["--maxWorkers=2"]);

    expect(phases).toHaveLength(2);
    expect(phases[0].args).toContain("--maxWorkers=2");
    expect(phases[0].args).toContain(
      "--exclude=packages/collector/src/e2e/search-quality.e2e.test.ts",
    );
    expect(phases[0].args).toContain(
      "--exclude=packages/collector/src/e2e/embedder-swap.e2e.test.ts",
    );
    expect(phases[0].args).toContain(
      "--exclude=packages/collector/src/e2e/search-load-soak.e2e.test.ts",
    );
    expect(phases[0].args).toContain(
      "--exclude=packages/collector/src/e2e/sidecar-encryption.e2e.test.ts",
    );
    expect(phases[1].args).toContain("--no-file-parallelism");
    expect(phases[1].args).toContain("packages/collector/src/e2e/search-quality.e2e.test.ts");
    expect(phases[1].args).toContain("packages/collector/src/e2e/embedder-swap.e2e.test.ts");
    expect(phases[1].args).toContain("packages/collector/src/e2e/search-load-soak.e2e.test.ts");
    expect(phases[1].args).toContain("packages/collector/src/e2e/sidecar-encryption.e2e.test.ts");
    expect(phases[1].args.slice(-2)).toEqual(["--fileParallelism", "--no-file-parallelism"]);
  });

  test("runs exact selected files under the whole-suite resource policy", () => {
    const independent = "packages/collector/src/e2e/golden-corpus.e2e.test.ts";
    const sensitive = "packages/collector/src/e2e/search-quality.e2e.test.ts";
    const phases = buildE2EPhases("/vitest.mjs", [independent, sensitive], ["--maxWorkers=2"]);

    expect(phases).toEqual([
      {
        label: "selected independent E2E files",
        args: ["/vitest.mjs", "run", independent, "--maxWorkers=2"],
      },
      {
        label: "selected resource-sensitive E2E files (serial)",
        args: ["/vitest.mjs", "run", sensitive, "--no-file-parallelism"],
      },
    ]);
  });

  test("keeps a fuzzy positional filter serial and bounded", () => {
    const phases = buildE2EPhases("/vitest.mjs", ["golden-corpus"], ["--maxWorkers=2"]);
    expect(phases).toEqual([
      {
        label: "selected E2E files (serial)",
        args: ["/vitest.mjs", "run", "golden-corpus", "--no-file-parallelism"],
      },
    ]);
  });

  test("keeps noncanonical paths serial so sensitive suites cannot bypass the list", () => {
    const file = "./packages/collector/src/e2e/search-quality.e2e.test.ts";
    const phases = buildE2EPhases("/vitest.mjs", [file], ["--maxWorkers=2"]);
    expect(phases).toEqual([
      {
        label: "selected E2E files (serial)",
        args: ["/vitest.mjs", "run", file, "--no-file-parallelism"],
      },
    ]);
  });

  test("keeps multiple explicit files in one bounded selection", () => {
    const filters = [
      "packages/collector/src/e2e/golden-corpus.e2e.test.ts",
      "packages/collector/src/e2e/search-quality.e2e.test.ts",
    ];
    const phases = buildE2EPhases(
      "/vitest.mjs",
      ["--reporter", "verbose", ...filters],
      ["--maxWorkers=2"],
    );

    expect(phases).toEqual([
      {
        label: "selected E2E files (serial)",
        args: ["/vitest.mjs", "run", "--reporter", "verbose", ...filters, "--no-file-parallelism"],
      },
    ]);
  });

  test.each([
    ["--reporter=json"],
    ["--reporter", "junit"],
    ["--outputFile=timings.json"],
    ["--output-file", "timings.json"],
    ["--outputFile.junit=timings.xml"],
    ["--output-file.tap=timings.tap"],
    ["--coverage"],
    ["--coverage.enabled=true"],
  ])("uses one serial Vitest process for an aggregate report: %o", (...args) => {
    const phases = buildE2EPhases("/vitest.mjs", args, ["--maxWorkers=2"]);

    expect(phases).toHaveLength(1);
    expect(phases[0].args).toContain("--no-file-parallelism");
    expect(phases[0].args).not.toContain("--maxWorkers=2");
    expect(phases[0].args.at(-1)).toBe("--no-file-parallelism");
  });

  test.each([
    ["--related", "packages/gateway/src/index.ts"],
    ["--related=packages/collector/src/index.ts"],
    ["--changed"],
    ["--changed=main"],
    ["--shard", "1/2"],
    ["--shard=2/2"],
  ])("applies a global file selector to the E2E corpus only once: %o", (...args) => {
    const phases = buildE2EPhases("/vitest.mjs", args, ["--maxWorkers=2"]);

    expect(phases).toEqual([
      {
        label: "E2E files (serial whole-suite mode)",
        args: ["/vitest.mjs", "run", ".e2e.test.ts", ...args, "--no-file-parallelism"],
      },
    ]);
  });

  test("inserts serial safety options before the literal option delimiter", () => {
    const phases = buildE2EPhases("/vitest.mjs", ["--reporter=json", "--"], ["--maxWorkers=2"]);

    expect(phases).toEqual([
      {
        label: "E2E files (serial whole-suite mode)",
        args: [
          "/vitest.mjs",
          "run",
          ".e2e.test.ts",
          "--reporter=json",
          "--no-file-parallelism",
          "--",
        ],
      },
    ]);
  });

  test("ignores option-like tokens after the literal option delimiter", () => {
    const phases = buildE2EPhases(
      "/vitest.mjs",
      ["--", "--help", "--reporter=json"],
      ["--maxWorkers=2"],
    );

    expect(phases).toHaveLength(2);
    expect(phases[0].label).toBe("independent E2E files");
    expect(phases[1].args.slice(-4)).toEqual([
      "--no-file-parallelism",
      "--",
      "--help",
      "--reporter=json",
    ]);
  });

  test.each([
    ["--version"],
    ["--help"],
    ["-v"],
    ["-h"],
    ["--version=true"],
    ["--help=true"],
    ["-v=true"],
    ["-h=true"],
    ["--version=verbose"],
    ["--help=all"],
    ["-vh"],
    ["-hv"],
    ["-vh=false"],
    ["-hv=false"],
    ["-vv=false"],
  ])("forwards Vitest information flags without starting a test run: %o", (...args) => {
    const phases = buildE2EPhases("/vitest.mjs", args, ["--maxWorkers=2"]);

    expect(phases).toEqual([{ label: "Vitest information", args: ["/vitest.mjs", ...args] }]);
  });

  test("information flags bypass unrelated worker validation", () => {
    const stdout = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "run-e2e.mjs"), "--version", "--maxWorkers=64"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );

    expect(stdout.trim()).toMatch(/^vitest\/\d/);
  });

  test.each(["-vh", "-hv", "-vh=false", "-hv=false", "-vv=false"])(
    "runs a combined information alias in one Vitest invocation: %s",
    (alias) => {
      const direct = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "..", "node_modules", "vitest", "vitest.mjs"), alias],
        { encoding: "utf8" },
      );
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "run-e2e.mjs"), alias],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("E2E file workers");
      expect(result.stderr).not.toContain("Running independent E2E files");
      expect(result.stdout).toBe(direct.stdout);
    },
  );

  test("forwards termination to Vitest and waits for its exit", async () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.unref = () => {};
    const signals = new EventEmitter();
    const forwarded = [];
    const result = waitForChild(child, {
      signalEmitter: signals,
      signalFn: (_child, signal) => forwarded.push(signal),
      termGraceMs: 100,
      killGraceMs: 100,
    });

    signals.emit("SIGTERM");
    child.emit("exit", null, "SIGTERM");

    await expect(result).rejects.toThrow(/terminated after SIGTERM/);
    expect(forwarded).toEqual(["SIGTERM"]);
  });

  test("escalates termination to SIGKILL after a bounded grace period", async () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.unref = () => {};
    const signals = new EventEmitter();
    const forwarded = [];
    const result = waitForChild(child, {
      signalEmitter: signals,
      signalFn: (_child, signal) => {
        forwarded.push(signal);
        if (signal === "SIGKILL") child.emit("exit", null, signal);
      },
      termGraceMs: 1,
      killGraceMs: 100,
    });

    signals.emit("SIGTERM");

    await expect(result).rejects.toThrow(/terminated after SIGTERM/);
    expect(forwarded).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test.skipIf(process.platform === "win32")(
    "cancellation drains detached descendants even when an inner supervisor outlives its grace",
    async () => {
      const helper = new URL("./lib/check-process.mjs", import.meta.url).href;
      const inner = `
      import { spawn } from 'node:child_process';
      import { waitForChild } from ${JSON.stringify(helper)};
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
      try { await waitForChild(child, { termGraceMs: 1000 }); } catch {}
    `;
      const supervisor = spawn(process.execPath, ["--input-type=module", "-e", inner], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const signals = new EventEmitter();
      const waiting = waitForChild(supervisor, {
        signalEmitter: signals,
        termGraceMs: 20,
        killGraceMs: 10,
      });
      // Attach the rejection handler before the child can exit.
      const outcome = waiting.catch((error) => error);
      let descendant;
      try {
        descendant = await new Promise((resolve, reject) => {
          supervisor.stdout.once("data", (data) => resolve(Number(data.toString().trim())));
          supervisor.once("error", reject);
        });
        signals.emit("SIGTERM");
        expect(await outcome).toMatchObject({ message: "Check terminated after SIGTERM" });
        expect(childGroupIsAlive({ spawnfile: process.execPath, pid: descendant })).toBe(false);
      } finally {
        for (const pid of [descendant, supervisor.pid]) {
          if (pid)
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* Already drained. */
            }
        }
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "drains an actual orphaned descendant before releasing ownership",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      descendant.once('message', () => process.exit(0));
    `,
        ],
        { detached: true, stdio: "ignore" },
      );
      const code = await waitForChild(child, { termGraceMs: 20, killGraceMs: 10 });
      expect(code).toBe(0);
      expect(childGroupIsAlive(child)).toBe(false);
    },
  );

  test("retains ownership after Vitest exits until its descendants stop", async () => {
    const child = new EventEmitter();
    const signals = new EventEmitter();
    const forwarded = [];
    let alive = true;
    let settled = false;
    const result = waitForChild(child, {
      signalEmitter: signals,
      groupIsAlive: () => alive,
      signalFn: (_child, signal) => forwarded.push(signal),
      termGraceMs: 1,
      killGraceMs: 1,
    });
    result.then(() => {
      settled = true;
    });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(forwarded).toContain("SIGTERM");
    expect(forwarded).toContain("SIGKILL");
    alive = false;
    await expect(result).resolves.toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("retains ownership while an unresponsive child has not exited", async () => {
    const child = new EventEmitter();
    const signals = new EventEmitter();
    let settled = false;
    const result = waitForChild(child, {
      signalEmitter: signals,
      signalFn: () => {},
      termGraceMs: 1,
      killGraceMs: 1,
    });
    result.catch(() => {
      settled = true;
    });
    signals.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    child.emit("exit", null, "SIGKILL");
    await expect(result).rejects.toThrow(/terminated after SIGTERM/);
  });

  test("keeps informational stdout machine-readable", () => {
    const stdout = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "run-e2e.mjs"), "--version"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );

    expect(stdout.trim()).toMatch(/^vitest\/\d/);
  });

  test("the package E2E command stays routed through the guarded launcher", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.scripts["test:e2e"]).toBe("node scripts/run-check.mjs e2e");
  });

  test("the developer-script smoke suite runs outside the bulk unit workers", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.scripts["test:unit:raw"]).toContain("npm run test:unit:smoke");
    expect(pkg.scripts["test:unit:vitest"]).toBe("node scripts/run-check.mjs unit");
    expect(pkg.scripts["test:unit:smoke"]).toBe("node scripts/run-check.mjs smoke");
  });

  test("the no-gateway lane is the full one minus exactly the lanes that boot a gateway", () => {
    // What the macOS CI job runs. Two scripts describing one set is how they
    // drift: a lane added to `test:unit` and forgotten here would silently
    // never run on darwin, and a lane removed from `test:unit` would leave
    // this one running something the full lane no longer does.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    const lanes = (script) => script.split("&&").map((part) => part.trim());
    const spawnsAGateway = new Set(["npm run test:unit:smoke", "npm run test:openclaw"]);

    expect(lanes(pkg.scripts["test:unit:no-gateway"])).toEqual(
      lanes(pkg.scripts["test:unit:raw"]).filter((lane) => !spawnsAGateway.has(lane)),
    );
    for (const lane of spawnsAGateway) {
      expect(pkg.scripts["test:unit:raw"], `${lane} is no longer part of the full lane`).toContain(
        lane,
      );
    }
  });
});

describe("host-wide E2E lane lock", () => {
  let dir;
  const noLog = () => {};
  const ticketsIn = (lockDir) => readdirSync(lockDir).sort();
  const liveOnly =
    (...pids) =>
    (pid) =>
      pids.includes(pid);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-e2e-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an unopposed lane takes its ticket at once and removes it on release", async () => {
    const release = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001),
      now: () => 500,
      log: noLog,
    });
    expect(JSON.parse(readFileSync(join(dir, "1001.json"), "utf8"))).toEqual({
      pid: 1001,
      startedAt: 500,
      cwd: "/lane/a",
    });
    release();
    expect(ticketsIn(dir)).toEqual([]);
  });

  test("of two live lanes, only the earlier ticket proceeds, and the later one follows its release", async () => {
    let clock = 100;
    const now = () => clock++;
    const lines = [];
    const first = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001, 1002),
      now,
      log: noLog,
    });
    let secondHeld = false;
    const second = acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1002, cwd: "/lane/b" },
      isAlive: liveOnly(1001, 1002),
      now,
      pollMs: 10,
      log: (l) => lines.push(l),
    }).then((release) => {
      secondHeld = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(secondHeld).toBe(false);
    expect(lines).toEqual([
      "Waiting for another E2E lane (pid 1001, started 1970-01-01T00:00:00.100Z, in /lane/a) to finish before starting this one",
    ]);
    first();
    const release = await second;
    expect(secondHeld).toBe(true);
    // The first lane's ticket is gone and only the second's remains.
    expect(ticketsIn(dir)).toEqual(["1002.json"]);
    release();
  });

  test("a live lane never has its ticket removed by another lane, even one that arrived first in time", async () => {
    // Lane B holds a ticket; lane A arrives and takes a LATER number; B's file is untouched.
    writeFileSync(
      join(dir, "1002.json"),
      JSON.stringify({ pid: 1002, startedAt: 50, cwd: "/lane/b" }),
    );
    let clock = 200;
    await expect(
      acquireE2EHostLock({
        lockDir: dir,
        holder: { pid: 1001, cwd: "/lane/a" },
        isAlive: liveOnly(1001, 1002),
        now: () => (clock += 20),
        pollMs: 5,
        timeoutMs: 100,
        log: noLog,
      }),
    ).rejects.toThrow(/gave up waiting for another E2E lane \(pid 1002/);
    expect(JSON.parse(readFileSync(join(dir, "1002.json"), "utf8")).pid).toBe(1002);
    // The waiter that gave up left no ticket of its own behind.
    expect(ticketsIn(dir)).toEqual(["1002.json"]);
  });

  test("a ticket whose lane is dead is removed and does not block", async () => {
    writeFileSync(
      join(dir, "424242.json"),
      JSON.stringify({ pid: 424242, startedAt: 10, cwd: "/lane/dead" }),
    );
    const release = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001),
      now: () => 500,
      log: noLog,
    });
    expect(ticketsIn(dir)).toEqual(["1001.json"]);
    release();
  });

  test("a dead lane's ticket that cannot be removed is reported once and ignored, never spun on", async () => {
    // A directory cannot be unlinked, standing in for a file another user owns on a sticky /tmp.
    mkdirSync(join(dir, "424242.json"));
    const lines = [];
    const release = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001),
      now: () => 500,
      pollMs: 5,
      log: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Ignoring a dead lane's ticket that cannot be removed/);
    release();
  });

  test("a live lane still taking its number is waited on, then ordered by its number", async () => {
    // An empty ticket file: created, not yet written.
    writeFileSync(join(dir, "1002.json"), "");
    let clock = 300;
    const now = () => clock++;
    setTimeout(
      () =>
        writeFileSync(
          join(dir, "1002.json"),
          JSON.stringify({ pid: 1002, startedAt: 900, cwd: "/lane/b" }),
        ),
      30,
    );
    const release = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001, 1002),
      now,
      pollMs: 10,
      log: noLog,
    });
    // 1002's number (900) is later than ours (300), so we proceed once it is known.
    expect(ticketsIn(dir)).toEqual(["1001.json", "1002.json"]);
    release();
  });

  test("never bypasses an old ticket whose owner is still alive", async () => {
    writeFileSync(
      join(dir, "1002.json"),
      JSON.stringify({ pid: 1002, startedAt: 0, cwd: "/lane/old" }),
    );
    await expect(
      acquireE2EHostLock({
        lockDir: dir,
        holder: { pid: 1001, cwd: dir },
        isAlive: () => true,
        now: () => 10 * 60 * 60 * 1000,
        wait: false,
        log: noLog,
      }),
    ).rejects.toThrow(/holds the lane/);
  });

  test("cancelling a queued lane removes its ticket promptly", async () => {
    writeFileSync(
      join(dir, "1002.json"),
      JSON.stringify({ pid: 1002, startedAt: 0, cwd: "/lane/first" }),
    );
    const controller = new AbortController();
    const pending = acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: dir },
      isAlive: () => true,
      pollMs: 60_000,
      log: noLog,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(ticketsIn(dir)).toEqual(["1002.json"]);
  });

  test("rejects a removed queued worktree and removes its own ticket", async () => {
    writeFileSync(
      join(dir, "1002.json"),
      JSON.stringify({ pid: 1002, startedAt: 0, cwd: "/lane/first" }),
    );
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    const statuses = [];
    const pending = acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: worktree },
      isAlive: () => true,
      pollMs: 5,
      log: noLog,
      onStatus: (status) => statuses.push(status),
      validate: () => {
        if (!existsSync(worktree)) throw new Error("worktree disappeared");
      },
    });
    rmSync(worktree, { recursive: true });
    await expect(pending).rejects.toThrow(/worktree disappeared/);
    expect(existsSync(join(dir, "1001.json"))).toBe(false);
    expect(statuses[0]).toMatchObject({ state: "queued", queuePosition: 2 });
  });

  test("inspects live tickets in order without deleting dead tickets", () => {
    for (const [pid, startedAt] of [
      [1001, 100],
      [1002, 50],
      [1003, 1],
    ]) {
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({ pid, startedAt, cwd: "/lane/example" }),
      );
    }
    expect(
      inspectE2ELanes({ lockDir: dir, isAlive: liveOnly(1001, 1002), now: () => 200 }),
    ).toEqual([
      { pid: 1002, startedAt: 50, cwd: "/lane/example", elapsedMs: 150, position: 1 },
      { pid: 1001, startedAt: 100, cwd: "/lane/example", elapsedMs: 100, position: 2 },
    ]);
    expect(ticketsIn(dir)).toHaveLength(3);
  });

  test("parses launcher status options without swallowing Vitest reporter flags", () => {
    expect(parseLauncherArgs(["--status-file", "status.json", "--reporter=json"])).toMatchObject({
      statusFile: "status.json",
      vitestArgs: ["--reporter=json"],
    });
    expect(parseLauncherArgs(["--who", "--json"])).toMatchObject({ who: true, json: true });
    expect(() => parseLauncherArgs(["--status-file"])).toThrow(/requires a path/);
  });

  test("names the earlier live lane when told not to wait, leaving no ticket behind", async () => {
    writeFileSync(
      join(dir, "1002.json"),
      JSON.stringify({ pid: 1002, startedAt: 50, cwd: "/lane/b" }),
    );
    await expect(
      acquireE2EHostLock({
        lockDir: dir,
        holder: { pid: 1001, cwd: "/lane/a" },
        isAlive: liveOnly(1001, 1002),
        now: () => 200,
        wait: false,
        log: noLog,
      }),
    ).rejects.toThrow(
      /another E2E lane \(pid 1002, started 1970-01-01T00:00:00.050Z, in \/lane\/b\) holds the lane; not waiting/,
    );
    expect(ticketsIn(dir)).toEqual(["1002.json"]);
  });

  test("a leftover ticket under this lane's own pid is replaced, not treated as a rival", async () => {
    writeFileSync(
      join(dir, "1001.json"),
      JSON.stringify({ pid: 1001, startedAt: 1, cwd: "/lane/previous" }),
    );
    const release = await acquireE2EHostLock({
      lockDir: dir,
      holder: { pid: 1001, cwd: "/lane/a" },
      isAlive: liveOnly(1001),
      now: () => 700,
      log: noLog,
    });
    expect(JSON.parse(readFileSync(join(dir, "1001.json"), "utf8")).startedAt).toBe(700);
    release();
  });

  test("information flags leave no ticket behind", () => {
    const lockDir = join(dir, "info");
    execFileSync(process.execPath, [join(import.meta.dirname, "run-e2e.mjs"), "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TMPDIR: dir },
    });
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(join(dir, "omnesis-e2e-lane.lock.d"))).toBe(false);
  });
});
