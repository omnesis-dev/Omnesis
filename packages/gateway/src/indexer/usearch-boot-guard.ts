// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boot-time crash safety for the usearch HNSW sidecar.
 *
 * `index.usearch` is a *derivable* sidecar — the durable truth is in
 * `index.db` (chunks + embeddings), and the worker rebuilds the sidecar from
 * it via `backfillFromDb`. But a structurally corrupt sidecar (e.g. left by a
 * source deletion that raced an in-flight backfill) makes the native
 * `usearch` `load()`/`view()` *abort the whole process* on the next boot
 * (SIGABRT: `free(): corrupted unsorted chunks`) — before any TypeScript
 * try/catch can run — which crash-loops the gateway.
 *
 * This guard closes that gap: before the gateway opens the sidecar in-process
 * (read registry on the main thread, write handle in the worker), it probes
 * the file in a throwaway subprocess. If the subprocess aborts or rejects the
 * file, it is quarantined (moved aside) so the in-process open sees no file and
 * rebuilds from `index.db`. The gateway boots instead of dying. One quarantined
 * copy is kept for diagnosis; a graph can be gigabytes, so older ones are deleted.
 */

import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createLogger, resolveSubprocessEntry, type SubprocessEntry } from "@omnesis/core";

const log = createLogger("gateway:usearch").child("boot-guard");

// Generous: a healthy index of millions of vectors loads in seconds. A timeout
// is inconclusive, like every other way of not reaching a verdict.
const VALIDATE_TIMEOUT_MS = 120_000;

/**
 * The validator's "this file is bad" exit status: sysexits' EX_DATAERR, which
 * Node never reports on its own. Exit 1 cannot carry this meaning, because it is
 * also what Node reports for a validator that failed to load.
 */
export const USEARCH_FILE_REJECTED_EXIT_CODE = 65;
export const USEARCH_NATIVE_STAGE_PREFIX = "OMNESIS_USEARCH_NATIVE_V1";

// NTSTATUS reference: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
// Native faults with documented NTSTATUS values. Ordinary CRT exit codes are
// deliberately absent: they need a separately demonstrated runtime contract.
const WINDOWS_NATIVE_FAULTS = new Set([
  0xc0000005, // STATUS_ACCESS_VIOLATION
  0xc000001d, // STATUS_ILLEGAL_INSTRUCTION
  0xc00000fd, // STATUS_STACK_OVERFLOW
  0xc0000374, // STATUS_HEAP_CORRUPTION
  0xc0000409, // STATUS_STACK_BUFFER_OVERRUN
]);

// Node's Windows ABORT() exits directly with kAbort=134, bypassing CRT abort.
// https://github.com/nodejs/node/blob/v24.21.0/src/util.h
// https://github.com/nodejs/node/blob/v24.21.0/src/node_exit_code.h
const WINDOWS_NODE_ABORT = 134;

// How much of the validator's stderr to log; a failed import's stack is long
// and leads with its cause.
const VALIDATOR_OUTPUT_LOG_CHARS = 500;

export type UsearchGuardResult = "ok" | "absent" | "quarantined" | "inconclusive";

// Signals a native abort raises when it dies inside usearch's load()/view().
const CORRUPT_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGTRAP"]);

// A quarantined copy of any generation's graph, plain or from a temp file.
const QUARANTINED_COPY = /\.usearch(?:\.tmp)?\.corrupt-/;

/**
 * Validate the usearch file at `path` (expected dimension `dimensions`) in an
 * isolated subprocess; quarantine it ONLY if the subprocess proves it's
 * corrupt. Returns what happened. Safe to call when the file doesn't exist
 * (`"absent"`).
 *
 * Crucially, "the validator couldn't run to a verdict" (spawn failure, a module
 * that failed to load, OOM-kill, timeout) is NOT treated as corruption —
 * quarantining a healthy multi-GB index because the probe never got to look at
 * it would force an expensive, needless rebuild on every such boot. Those return
 * `"inconclusive"`: the file is left in place and we let the in-process open
 * proceed (it will succeed if the file is in fact fine). An unfinished native
 * open or invalid control response instead throws, preserving the graph while
 * preventing an unverified native open in the gateway.
 *
 * Copies quarantined by earlier boots are pruned whatever this boot finds.
 *
 * `validator` is the process to probe with; tests stand in for the real one to
 * reach the failures it cannot be made to produce on demand.
 */
export function quarantineCorruptUsearch(
  path: string,
  dimensions: number,
  validator: SubprocessEntry = resolveSubprocessEntry(
    "./usearch-validate-subprocess.ts",
    import.meta.url,
  ),
): UsearchGuardResult {
  pruneQuarantinedCopies(path);
  if (!existsSync(path)) return "absent";

  const nonce = randomBytes(16).toString("hex");
  const begin = `${USEARCH_NATIVE_STAGE_PREFIX}:${nonce}:begin\n`;
  const complete = `${begin}${USEARCH_NATIVE_STAGE_PREFIX}:${nonce}:complete\n`;
  const result = spawnSync(
    validator.command,
    [...validator.args, path, String(dimensions), nonce],
    {
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: 65_536,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
    throw new Error("Truncated usearch validation output; refusing in-process open");
  }
  const control = result.stdout ?? "";
  if (control !== "" && control !== begin && control !== complete) {
    throw new Error("Invalid usearch validation control response; refusing in-process open");
  }
  const enteredNative = control === begin;
  const completedNative = control === complete;
  if (result.status === 0 && !result.signal && !result.error) {
    if (control !== complete) {
      throw new Error("Missing usearch validation completion; refusing in-process open");
    }
    log.info(`usearch sidecar ${path} validated (dim ${dimensions})`);
    return "ok";
  }

  const validatorSaid = summarizeValidatorOutput(result.stderr);

  // Corrupt iff the validator actually ran and reported the file bad: its
  // rejection status (a catchable load error / wrong dimension) or a native
  // abort. Pre-open startup failures remain inconclusive; failure after a
  // reported native open must prevent the gateway from opening the same file.
  // Node's OOM handler uses the same ABORT() code; resource exhaustion is not
  // evidence that a derivable graph is corrupt.
  const nodeOutOfMemory =
    /^FATAL ERROR: [^\r\n]*Allocation failed - (?:JavaScript heap|process) out of memory\b/imu.test(
      result.stderr ?? "",
    );
  const signedStatus = result.status;
  const windowsFault =
    process.platform === "win32" &&
    enteredNative &&
    signedStatus !== null &&
    Number.isInteger(signedStatus) &&
    signedStatus >= -0x80000000 &&
    signedStatus <= 0xffffffff &&
    (WINDOWS_NATIVE_FAULTS.has(signedStatus >>> 0) ||
      (signedStatus === WINDOWS_NODE_ABORT && !nodeOutOfMemory));
  // POSIX prebuilt bindings release allocations at process exit. A native
  // destructor can therefore still expose corruption after the frame.
  const crashedNatively =
    (result.signal != null && CORRUPT_SIGNALS.has(result.signal)) || windowsFault;
  const rejected = result.status === USEARCH_FILE_REJECTED_EXIT_CODE;
  const isCorrupt = !result.error && !nodeOutOfMemory && (crashedNatively || rejected);
  if (completedNative && !isCorrupt) {
    throw new Error("Usearch validator failed after native completion; refusing in-process open");
  }
  if (enteredNative && !isCorrupt) {
    throw new Error("Usearch native validation did not complete; refusing in-process open");
  }

  if (!isCorrupt) {
    const why = result.error
      ? `spawn failed: ${result.error.message}`
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.status}`;
    log.warn(
      `usearch sidecar ${path} could not be validated (${why}${validatorSaid}); leaving it in place — the gateway will open it as-is`,
    );
    return "inconclusive";
  }

  const reason = `${result.signal ? `native abort (${result.signal})` : windowsFault ? `native abort (Windows status ${result.status})` : "invalid file"}${validatorSaid}`;
  const quarantinePath = `${path}.corrupt-${fsSafeTimestamp()}`;
  try {
    renameSync(path, quarantinePath);
    log.warn(
      `usearch sidecar ${path} failed validation (${reason}); moved to ${quarantinePath} — rebuilding from index.db`,
    );
    pruneQuarantinedCopies(path);
  } catch (err) {
    // Move failed (file vanished, permissions). We've logged loudly; the
    // in-process open may still abort, but there's nothing more to do here.
    log.error(
      `usearch sidecar ${path} failed validation (${reason}) and could not be quarantined: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new Error("Cannot quarantine corrupt usearch sidecar; refusing in-process open", {
      cause: err,
    });
  }
  return "quarantined";
}

/** The validator's stderr as a one-line clause to append to a log reason. */
function summarizeValidatorOutput(stderr: string | null): string {
  const output = stderr?.trim().replace(/\s*\n\s*/g, " | ");
  return output ? `: ${output.slice(0, VALIDATOR_OUTPUT_LOG_CHARS)}` : "";
}

/**
 * Keep only the newest quarantined copy of the sidecar at `path`, and none of
 * any other generation's, which nothing can come back to. The names' timestamps
 * sort chronologically. Failure is logged and left for the next boot: disk
 * usage should not stop the gateway from starting.
 */
function pruneQuarantinedCopies(path: string): void {
  const dir = dirname(path);
  let copies: string[];
  try {
    copies = readdirSync(dir).filter((name) => QUARANTINED_COPY.test(name));
  } catch {
    return; // No directory, so nothing to prune.
  }
  const ownPrefix = `${basename(path)}.corrupt-`;
  const kept = copies
    .filter((name) => name.startsWith(ownPrefix))
    .sort()
    .at(-1);
  for (const name of copies) {
    if (name === kept) continue;
    try {
      rmSync(join(dir, name), { force: true });
      log.info(`removed older quarantined usearch sidecar ${name}`);
    } catch (err) {
      log.warn(
        `could not remove quarantined usearch sidecar ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Filesystem-safe UTC timestamp: `YYYYMMDDTHHMMSS`. */
function fsSafeTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
}
