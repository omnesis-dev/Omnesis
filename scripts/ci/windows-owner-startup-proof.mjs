// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUERY_MARKER = "OMNESIS_OWNER_QUERY_V1";
const DOTNET_TO_FILETIME_TICKS = 504911232000000000n;
const MAX_FILETIME_TICKS = 9223372036854775807n;
const EXPERIMENT_TIMEOUT_MS = 30_000;

function phaseOf(stderr) {
  if (stderr === "" || (Buffer.isBuffer(stderr) && stderr.length === 0)) return "before-query";
  if (
    stderr === QUERY_MARKER ||
    (Buffer.isBuffer(stderr) && stderr.equals(Buffer.from(QUERY_MARKER)))
  )
    return "query";
  return "unknown";
}

function validTicks(ticks) {
  if (typeof ticks !== "string" || !/^[0-9]{1,19}$/u.test(ticks)) return false;
  const birth = BigInt(ticks) - DOTNET_TO_FILETIME_TICKS;
  return birth > 0n && birth <= MAX_FILETIME_TICKS;
}

/** One fresh-process experiment; no production deadline or source is modified. */
export async function measureWindowsOwnerStartup({
  platform = process.platform,
  execute = childProcess.spawnSync,
  now = () => performance.now(),
} = {}) {
  if (platform !== "win32")
    return {
      elapsedMs: 0,
      validIdentity: false,
      phase: "unknown",
      outcome: "unsupported-platform",
    };

  const { windowsProcessStart } = await import("../../packages/platform/src/windows-powershell.ts");
  const original = childProcess.execFileSync;
  let executions = 0;
  let stderr;
  let unavailable;
  let ticks;
  let outcome = "probe-failed";
  const started = now();
  try {
    // Use the production executable/script/own PID exactly. Only this isolated
    // experiment's executor receives the existing 30-second bootstrap budget.
    childProcess.execFileSync = (executable, args, options) => {
      if (++executions !== 1) throw new Error("Multiple owner probes refused");
      const result = execute(executable, args, {
        ...options,
        timeout: EXPERIMENT_TIMEOUT_MS,
        maxBuffer: 65_536,
      });
      stderr = result.stderr;
      if (result.error || result.status !== 0) {
        throw Object.assign(new Error("Owner probe did not complete"), {
          code: result.error?.code,
          status: result.status,
          stderr,
        });
      }
      if (typeof result.stdout !== "string") throw new Error("Invalid owner probe result");
      return result.stdout;
    };
    syncBuiltinESMExports();
    ticks = windowsProcessStart(process.pid, undefined, (reason) => {
      unavailable = reason;
    });
  } catch {
    outcome = "probe-failed";
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }

  const elapsed = now() - started;
  if (!Number.isFinite(elapsed) || elapsed < 0)
    return { elapsedMs: 0, validIdentity: false, phase: "unknown", outcome: "invalid-timing" };
  const elapsedMs = Math.ceil(elapsed);
  const phase = phaseOf(stderr);
  if (executions !== 1)
    outcome = unavailable === "host-executable" ? "host-executable" : "probe-not-executed";
  else if (validTicks(ticks)) outcome = "verified";
  else if (unavailable?.startsWith("timeout:")) outcome = "timeout";
  else if (/^exit:[0-9]{1,10}$/u.test(unavailable ?? "")) outcome = "exit";
  else if (unavailable === "spawn") outcome = "spawn";
  else if (unavailable === "invalid-output" || ticks !== null) outcome = "invalid-identity";
  return { elapsedMs, validIdentity: outcome === "verified", phase, outcome };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let measurement;
  try {
    measurement = await measureWindowsOwnerStartup();
  } catch {
    measurement = { elapsedMs: 0, validIdentity: false, phase: "unknown", outcome: "probe-failed" };
  }
  process.stdout.write(`${JSON.stringify(measurement)}\n`);
  process.exitCode = measurement.validIdentity ? 0 : 1;
}
