// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Memory-aware launcher for the spawned-gateway E2E suite.
 *
 * Each parallel Vitest file may own a real gateway and its native stores.
 * Unbounded file parallelism has caused OOMs, while forcing one file at a
 * time makes the full lane unnecessarily slow on a large runner. Auto mode
 * therefore uses at most two files and only enables the second when both the
 * machine and its current free-memory headroom are comfortably large.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseCLI } from "vitest/node";
import { waitForChild } from "./lib/check-process.mjs";
export { waitForChild, childGroupIsAlive } from "./lib/check-process.mjs";

import { progressArgs, progressEnvironment } from "./lib/check-progress.mjs";

const GIB = 1024 ** 3;
const AUTO_PARALLEL_MIN_TOTAL_BYTES = 32 * GIB;
const AUTO_PARALLEL_MIN_AVAILABLE_BYTES = 16 * GIB;
const AUTO_MAX_WORKERS = 2;
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// Two E2E lanes on one host fail each other: the timing-sensitive suites miss
// their deadlines under a neighbour's load, and the worker budget above is
// sized from what is free at start, not from what a second lane takes a
// minute later. Lanes therefore queue through a ticket directory in the
// temp directory: every lane owns one file named after its pid, and the lane
// whose ticket is earliest among the live ones runs. Nothing ever deletes a
// live lane's ticket — only files whose pid is dead are removed — so two
// lanes can never both decide they hold the lock. The scope is one temp
// directory: users or containers with separate temp directories do not see
// each other.
export const E2E_HOST_LOCK_DIR = join(tmpdir(), "omnesis-e2e-lane.lock.d");
const LOCK_POLL_MS = 5_000;
const LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const SERIAL_E2E_FILES = [
  "packages/collector/src/e2e/search-quality.e2e.test.ts",
  "packages/collector/src/e2e/embedder-swap.e2e.test.ts",
  "packages/collector/src/e2e/search-load-soak.e2e.test.ts",
  "packages/collector/src/e2e/sidecar-encryption.e2e.test.ts",
  // Drives a real headless Chromium with the extension loaded: several hundred
  // MB on top of its gateway, and its capture dwell is wall-clock time that a
  // CPU-starved neighbour can stretch past the suite's waits.
  "packages/collector/src/e2e/browser-extension.e2e.test.ts",
  // Brain Bench suites whose assertions are about TIMING — the cognition
  // virtual clock, day and budget boundaries, debounce and fold windows.
  // Their claims are true of a quiet machine; a neighbour competing for CPU
  // turns a correct behaviour into a red test, so they never share the box.
  "packages/collector/src/e2e/brain-rhythm.e2e.test.ts",
  "packages/collector/src/e2e/brain-engine.e2e.test.ts",
  "packages/collector/src/e2e/brain-verification.e2e.test.ts",
  "packages/collector/src/e2e/brain-waker.e2e.test.ts",
  "packages/collector/src/e2e/brain-loops.e2e.test.ts",
  "packages/collector/src/e2e/brain-bootstrap.e2e.test.ts",
];

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function ticketPid(fileName) {
  const match = /^(\d+)\.json$/.exec(fileName);
  return match ? Number(match[1]) : null;
}

function readTicket(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isFinite(parsed?.startedAt) ? parsed : null;
  } catch {
    return null;
  }
}

// Earlier start wins; the pid breaks a tie in the same millisecond.
function ticketPrecedes(a, b) {
  return a.startedAt < b.startedAt || (a.startedAt === b.startedAt && a.pid < b.pid);
}

function describeTicket(ticket) {
  return `another E2E lane (pid ${ticket.pid}, started ${new Date(ticket.startedAt).toISOString()}, in ${ticket.cwd})`;
}

/**
 * Take the host-wide E2E lane lock.
 *
 * The lane writes its own ticket, then waits until no live ticket precedes
 * it. A ticket whose pid is dead is removed by whoever finds it; a ticket that
 * exists but is not yet written belongs to a lane still taking its number, so
 * it is waited on, not judged. With `wait` false the earliest live lane is
 * named in the error instead. Returns a release function that removes this
 * lane's ticket.
 */
export async function acquireE2EHostLock({
  lockDir = E2E_HOST_LOCK_DIR,
  wait = true,
  pollMs = LOCK_POLL_MS,
  timeoutMs = LOCK_WAIT_TIMEOUT_MS,
  heartbeatMs = HEARTBEAT_MS,
  signal,
  validate = () => {},
  onStatus = () => {},
  holder = { pid: process.pid, cwd: process.cwd() },
  isAlive = processIsAlive,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  mkdirSync(lockDir, { recursive: true });
  try {
    // Like /tmp itself: anyone may add a ticket, only its owner may remove it.
    chmodSync(lockDir, 0o1777);
  } catch {
    // Not ours to chmod; creating a ticket below says whether it is usable.
  }
  const ticketPath = join(lockDir, `${holder.pid}.json`);
  // A leftover ticket under this pid is from an earlier process that had it.
  try {
    unlinkSync(ticketPath);
  } catch {
    // Nothing to clear.
  }
  const fd = openSync(ticketPath, "wx");
  const ticket = { pid: holder.pid, startedAt: now(), cwd: holder.cwd };
  writeSync(fd, JSON.stringify(ticket));
  closeSync(fd);

  const deadline = now() + timeoutMs;
  const announced = new Set();
  const undeletable = new Set();
  let lastHeartbeat = now();
  try {
    for (;;) {
      signal?.throwIfAborted();
      validate();
      let queuePosition = 1;
      let blocker = null;
      let settling = false;
      for (const name of readdirSync(lockDir)) {
        const pid = ticketPid(name);
        if (pid === null || pid === holder.pid) continue;
        const path = join(lockDir, name);
        if (!isAlive(pid)) {
          try {
            unlinkSync(path);
          } catch (error) {
            if (error?.code !== "ENOENT" && !undeletable.has(path)) {
              undeletable.add(path);
              log(
                `Ignoring a dead lane's ticket that cannot be removed (${path}): ${error.message}`,
              );
            }
          }
          continue;
        }
        const other = readTicket(path);
        if (!other) {
          // Still being written by a live lane; its number is not known yet.
          settling = true;
          continue;
        }
        if (ticketPrecedes(other, ticket)) queuePosition += 1;
        if (ticketPrecedes(other, ticket) && (!blocker || ticketPrecedes(other, blocker))) {
          blocker = other;
        }
      }
      if (!blocker && !settling) {
        onStatus({ state: "running", queuePosition: 0, elapsedMs: now() - ticket.startedAt });
        log(
          `E2E lane acquired (pid ${holder.pid}) after ${Math.round((now() - ticket.startedAt) / 1000)}s`,
        );
        break;
      }
      onStatus({ state: "queued", queuePosition, blocker, elapsedMs: now() - ticket.startedAt });
      if (now() - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = now();
        log(
          `E2E queued for ${Math.round((now() - ticket.startedAt) / 1000)}s, position ${queuePosition}; ${blocker ? describeTicket(blocker) : "waiting for a ticket to settle"}`,
        );
      }
      if (blocker && !wait) {
        release();
        throw new Error(
          `${describeTicket(blocker)} holds the lane; not waiting (OMNESIS_E2E_LOCK_WAIT=0)`,
        );
      }
      if (now() >= deadline) {
        release();
        throw new Error(
          `gave up waiting for ${blocker ? describeTicket(blocker) : "a lane still taking its ticket"} after ${Math.round(timeoutMs / 60_000)} min`,
        );
      }
      if (blocker && !announced.has(blocker.pid)) {
        announced.add(blocker.pid);
        log(`Waiting for ${describeTicket(blocker)} to finish before starting this one`);
      }
      await sleep(pollMs, undefined, { signal });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }

  function release() {
    try {
      unlinkSync(ticketPath);
    } catch {
      // Already gone.
    }
  }
}

export function effectiveMemoryBudget({ hostTotalBytes, constrainedBytes, availableBytes }) {
  const effectiveConstraint =
    Number.isFinite(constrainedBytes) && constrainedBytes > 0 ? constrainedBytes : hostTotalBytes;
  const effectiveTotalBytes = Math.min(hostTotalBytes, effectiveConstraint);
  return {
    totalBytes: effectiveTotalBytes,
    availableBytes: Math.min(availableBytes, effectiveTotalBytes),
  };
}

export function selectE2EWorkers({ override, totalBytes, availableBytes, cpuCount }) {
  if (override !== undefined && override !== "") {
    if (!/^[12]$/.test(override)) {
      throw new Error(`OMNESIS_E2E_WORKERS must be 1 or 2, got '${override}'`);
    }
    return Number(override);
  }

  if (
    cpuCount < 4 ||
    totalBytes < AUTO_PARALLEL_MIN_TOTAL_BYTES ||
    availableBytes < AUTO_PARALLEL_MIN_AVAILABLE_BYTES
  ) {
    return 1;
  }
  return AUTO_MAX_WORKERS;
}

function currentMemoryBudget() {
  return effectiveMemoryBudget({
    hostTotalBytes: totalmem(),
    constrainedBytes: process.constrainedMemory(),
    availableBytes: process.availableMemory(),
  });
}

export function hasSafeExplicitWorkerArg(args) {
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    const separated = arg === "--maxWorkers" || arg === "--max-workers";
    if (!separated && !arg.startsWith("--maxWorkers=") && !arg.startsWith("--max-workers=")) {
      continue;
    }
    const value = separated
      ? args[index + 1]
      : arg.startsWith("--maxWorkers=")
        ? arg.slice("--maxWorkers=".length)
        : arg.slice("--max-workers=".length);
    found = true;
    if (value === undefined || !/^[12]$/.test(value)) {
      throw new Error(`CLI max workers must be 1 or 2, got '${value ?? "missing"}'`);
    }
  }
  return found;
}

function appendBeforeDoubleDash(args, ...launcherArgs) {
  const delimiterIndex = args.indexOf("--");
  if (delimiterIndex === -1) return [...args, ...launcherArgs];
  return [...args.slice(0, delimiterIndex), ...launcherArgs, ...args.slice(delimiterIndex)];
}

function requestsVitestInformation(args) {
  for (const arg of args) {
    if (arg === "--") return false;
    const longMatch = /^(?:--help|--version)(?:=(.*))?$/.exec(arg);
    if (longMatch && longMatch[1] !== "false") return true;
    const shortMatch = /^-([hv]+)(?:=(.*))?$/.exec(arg);
    if (shortMatch && (shortMatch[1].length > 1 || shortMatch[2] !== "false")) return true;
  }
  return false;
}

function requestsWholeSuiteSelection(args) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (
      arg === "--related" ||
      arg.startsWith("--related=") ||
      arg === "--changed" ||
      arg.startsWith("--changed=") ||
      arg === "--shard" ||
      arg.startsWith("--shard=")
    ) {
      return true;
    }
  }
  return false;
}

function requestsSingleRunReport(args) {
  const machineReporters = new Set(["blob", "json", "junit", "tap", "tap-flat"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (
      arg === "--coverage" ||
      arg.startsWith("--coverage=") ||
      arg.startsWith("--coverage.") ||
      arg === "--outputFile" ||
      arg === "--output-file" ||
      arg.startsWith("--outputFile=") ||
      arg.startsWith("--output-file=") ||
      arg.startsWith("--outputFile.") ||
      arg.startsWith("--output-file.")
    ) {
      return true;
    }
    const reporter =
      arg === "--reporter"
        ? args[index + 1]
        : arg.startsWith("--reporter=")
          ? arg.slice("--reporter=".length)
          : undefined;
    if (reporter?.split(",").some((name) => machineReporters.has(name))) {
      return true;
    }
  }
  return false;
}

export function buildE2EPhases(vitestEntry, args, workerArgs) {
  if (requestsVitestInformation(args)) {
    return [{ label: "Vitest information", args: [vitestEntry, ...args] }];
  }
  const selectedFilters = parseCLI(["vitest", "run", ...args]).filter;
  if (selectedFilters.length > 0) {
    // Managed bundles pass only exact file paths. Apply the same two-phase
    // resource policy as a whole-suite run instead of serializing every file.
    if (
      args.length === selectedFilters.length &&
      args.every(
        (file) => file.startsWith("packages/") && file.endsWith(".e2e.test.ts") && existsSync(file),
      )
    ) {
      const independent = args.filter((file) => !SERIAL_E2E_FILES.includes(file));
      const sensitive = args.filter((file) => SERIAL_E2E_FILES.includes(file));
      return [
        ...(independent.length
          ? [
              {
                label: "selected independent E2E files",
                args: [vitestEntry, "run", ...independent, ...workerArgs],
              },
            ]
          : []),
        ...(sensitive.length
          ? [
              {
                label: "selected resource-sensitive E2E files (serial)",
                args: [vitestEntry, "run", ...sensitive, "--no-file-parallelism"],
              },
            ]
          : []),
      ];
    }
    return [
      {
        label: "selected E2E files (serial)",
        args: [vitestEntry, "run", ...appendBeforeDoubleDash(args, "--no-file-parallelism")],
      },
    ];
  }
  if (requestsSingleRunReport(args) || requestsWholeSuiteSelection(args)) {
    return [
      {
        label: "E2E files (serial whole-suite mode)",
        args: [
          vitestEntry,
          "run",
          ".e2e.test.ts",
          ...appendBeforeDoubleDash(args, "--no-file-parallelism"),
        ],
      },
    ];
  }

  return [
    {
      label: "independent E2E files",
      args: [
        vitestEntry,
        "run",
        ".e2e.test.ts",
        ...SERIAL_E2E_FILES.map((file) => `--exclude=${file}`),
        ...workerArgs,
        ...args,
      ],
    },
    {
      label: "resource-sensitive E2E files (serial)",
      args: [
        vitestEntry,
        "run",
        ...SERIAL_E2E_FILES,
        ...appendBeforeDoubleDash(args, "--no-file-parallelism"),
      ],
    },
  ];
}

async function runVitest(vitestArgs, env) {
  const child = spawn(process.execPath, vitestArgs, {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  return await waitForChild(child);
}

/** Read-only inspection: never starts a test or removes another process's ticket. */
export function inspectE2ELanes({
  lockDir = E2E_HOST_LOCK_DIR,
  isAlive = processIsAlive,
  now = Date.now,
} = {}) {
  if (!existsSync(lockDir)) return [];
  return readdirSync(lockDir)
    .flatMap((name) => {
      const pid = ticketPid(name);
      if (pid === null || !isAlive(pid)) return [];
      const ticket = readTicket(join(lockDir, name));
      return [
        {
          ...(ticket ?? { pid, cwd: null, startedAt: null }),
          elapsedMs: ticket ? now() - ticket.startedAt : null,
        },
      ];
    })
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.pid - b.pid)
    .map((ticket, index) => ({ ...ticket, position: index + 1 }));
}

export function parseLauncherArgs(args, env = {}) {
  const vitestArgs = [];
  let who = false;
  let json = false;
  let statusFile = env.OMNESIS_E2E_STATUS_FILE;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      vitestArgs.push(...args.slice(index));
      break;
    }
    if (arg === "--who") who = true;
    else if (arg === "--json") json = true;
    else if (arg === "--status-file" || arg.startsWith("--status-file=")) {
      statusFile = arg === "--status-file" ? args[++index] : arg.slice("--status-file=".length);
      if (!statusFile || statusFile.startsWith("--"))
        throw new Error("--status-file requires a path");
    } else vitestArgs.push(arg);
  }
  if (json && !who)
    throw new Error("--json requires --who; use --reporter=json for Vitest results");
  return { who, json, statusFile, vitestArgs };
}

export async function runE2E(args = process.argv.slice(2), env = process.env) {
  const options = parseLauncherArgs(args, env);
  args = options.vitestArgs;
  if (options.who) {
    const lanes = inspectE2ELanes();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(lanes)}\n`
        : lanes.length
          ? `${lanes.map((lane) => `Position ${lane.position}: pid ${lane.pid}, ${lane.cwd ?? "ticket settling"}, elapsed ${Math.round((lane.elapsedMs ?? 0) / 1000)}s`).join("\n")}\n`
          : "No active E2E lanes\n",
    );
    return 0;
  }
  const require = createRequire(import.meta.url);
  const vitestEntry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  if (requestsVitestInformation(args)) {
    const [{ args: informationArgs }] = buildE2EPhases(vitestEntry, args, []);
    return await runVitest(informationArgs, env);
  }
  const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
  const validate = () => {
    if (
      !existsSync(join(cwd, "package.json")) ||
      !existsSync(join(cwd, "scripts", "run-e2e.mjs"))
    ) {
      throw new Error(`E2E worktree disappeared: ${cwd}`);
    }
  };
  const startedAt = Date.now();
  let status = { pid: process.pid, cwd, startedAt, state: "queued" };
  const update = (next) => {
    status = { ...status, ...next, elapsedMs: Date.now() - startedAt, updatedAt: Date.now() };
    if (options.statusFile) {
      const temporary = `${options.statusFile}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
        renameSync(temporary, options.statusFile);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          /* Already renamed. */
        }
      }
    }
  };
  let releaseLock;
  let heartbeat;
  let heartbeatWriteFailed = false;
  try {
    validate();
    hasSafeExplicitWorkerArg(args);
    // Validate selection before admission; recompute its resource budget after admission.
    buildE2EPhases(vitestEntry, args, []);
    const lockTimeout = Number(env.OMNESIS_E2E_LOCK_TIMEOUT_MS);
    const queuedAbort = new AbortController();
    const cancelQueued = () => queuedAbort.abort();
    for (const signal of TERMINATION_SIGNALS) process.on(signal, cancelQueued);
    try {
      releaseLock = await acquireE2EHostLock({
        signal: queuedAbort.signal,
        wait: env.OMNESIS_E2E_LOCK_WAIT !== "0",
        holder: { pid: process.pid, cwd },
        validate,
        onStatus: update,
        ...(Number.isFinite(lockTimeout) && lockTimeout > 0 ? { timeoutMs: lockTimeout } : {}),
      });
    } finally {
      for (const signal of TERMINATION_SIGNALS) process.removeListener(signal, cancelQueued);
    }
    const memory = currentMemoryBudget();
    const workers = selectE2EWorkers({
      override: env.OMNESIS_E2E_WORKERS,
      ...memory,
      cpuCount: availableParallelism(),
    });
    const explicitWorkerArg = hasSafeExplicitWorkerArg(args);
    const phases = buildE2EPhases(
      vitestEntry,
      args,
      explicitWorkerArg ? [] : [`--maxWorkers=${workers}`],
    );
    process.stderr.write(
      `E2E file workers: ${explicitWorkerArg ? "explicit CLI override" : workers} (effective memory ${Math.floor(memory.availableBytes / GIB)} GiB available / ${Math.floor(memory.totalBytes / GIB)} GiB total)\n`,
    );
    heartbeat = setInterval(() => {
      try {
        update({});
      } catch (error) {
        // Keep supervising the child even if the optional sidecar becomes unwritable.
        if (!heartbeatWriteFailed)
          process.stderr.write(`Cannot refresh E2E status: ${error.message}\n`);
        heartbeatWriteFailed = true;
      }
      process.stderr.write(
        `E2E running ${status.phase}; elapsed ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
      );
    }, HEARTBEAT_MS);
    const progressEnv = progressEnvironment(env);
    let exitCode = 0;
    for (const phase of phases) {
      validate();
      update({ state: "running", phase: phase.label, phaseStartedAt: Date.now() });
      process.stderr.write(`Running ${phase.label}\n`);
      const [entry, command, ...testArgs] = phase.args;
      const phaseExitCode = await runVitest([entry, command, ...progressArgs(testArgs)], {
        ...progressEnv,
        OMNESIS_CHECK_PHASE: phase.label,
      });
      if (exitCode === 0 && phaseExitCode !== 0) exitCode = phaseExitCode;
    }
    update({ state: exitCode === 0 ? "passed" : "failed", exitCode, finishedAt: Date.now() });
    return exitCode;
  } catch (error) {
    update({
      state:
        error.name === "AbortError" || /terminated after/.test(error.message)
          ? "cancelled"
          : "failed",
      error: error.message,
      finishedAt: Date.now(),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    releaseLock?.();
  }
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
  try {
    process.exitCode = await runE2E();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
