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
 * the file in a throwaway subprocess. If the subprocess aborts / exits
 * non-zero, the file is quarantined (moved aside) so the in-process open sees
 * no file and rebuilds from `index.db`. The gateway boots instead of dying.
 */

import { existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createLogger, resolveSubprocessEntry } from "@omnesis/core";

const log = createLogger("gateway:usearch").child("boot-guard");

// Generous: a healthy index of millions of vectors loads in seconds, so a
// timeout means the load is wedged (treat as corrupt). Erring toward
// quarantine is safe — the sidecar always rebuilds from index.db.
const VALIDATE_TIMEOUT_MS = 120_000;

export type UsearchGuardResult = "ok" | "absent" | "quarantined" | "inconclusive";

// Signals a native abort raises when it dies inside usearch's load()/view().
const CORRUPT_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"]);
// Their 128+n exit-code equivalents, for when a wrapper (tsx/node) reports the
// crash as an exit status rather than a signal.
// 128+signal. Signal *numbers* differ by OS — SIGBUS is 7 on Linux (135) but
// 10 on macOS (138); SIGTRAP (5 → 133) can also surface a native abort.
const CORRUPT_EXIT_CODES = new Set([132, 133, 134, 135, 138, 139]);

/**
 * Validate the usearch file at `path` (expected dimension `dimensions`) in an
 * isolated subprocess; quarantine it ONLY if the subprocess proves it's
 * corrupt. Returns what happened. Safe to call when the file doesn't exist
 * (`"absent"`).
 *
 * Crucially, "the validator couldn't run to a verdict" (spawn failure,
 * OOM-kill, timeout) is NOT treated as corruption — quarantining a healthy
 * multi-GB index because `npx` was missing or the OOM killer reaped the probe
 * would force an expensive, needless rebuild on every such boot. Those return
 * `"inconclusive"`: the file is left in place and we let the in-process open
 * proceed (it will succeed if the file is in fact fine).
 */
export function quarantineCorruptUsearch(path: string, dimensions: number): UsearchGuardResult {
  if (!existsSync(path)) return "absent";

  const entry = resolveSubprocessEntry("./usearch-validate-subprocess.ts", import.meta.url);
  const result = spawnSync(entry.command, [...entry.args, path, String(dimensions)], {
    timeout: VALIDATE_TIMEOUT_MS,
    stdio: "ignore",
  });

  if (result.status === 0 && !result.signal && !result.error) {
    log.info(`usearch sidecar ${path} validated (dim ${dimensions})`);
    return "ok";
  }

  // Corrupt iff the validator actually ran and reported the file bad: exit 1
  // (a catchable load error / wrong dimension) or a crash (native abort by
  // signal or its 128+n exit code). Everything else — spawn error, SIGKILL
  // (OOM), SIGTERM (timeout), exit 2 (bad args) — is inconclusive.
  const crashedNatively =
    (result.signal != null && CORRUPT_SIGNALS.has(result.signal)) ||
    (result.status != null && CORRUPT_EXIT_CODES.has(result.status));
  const catchableFailure = result.status === 1;
  const isCorrupt = !result.error && (crashedNatively || catchableFailure);

  if (!isCorrupt) {
    const why = result.error
      ? `spawn failed: ${result.error.message}`
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.status}`;
    log.warn(
      `usearch sidecar ${path} could not be validated (${why}); leaving it in place — the gateway will open it as-is`,
    );
    return "inconclusive";
  }

  const reason = result.signal
    ? `native abort (${result.signal})`
    : result.status != null && CORRUPT_EXIT_CODES.has(result.status)
      ? `native abort (exit ${result.status})`
      : `invalid file (exit ${result.status})`;
  const quarantinePath = `${path}.corrupt-${fsSafeTimestamp()}`;
  try {
    renameSync(path, quarantinePath);
    log.warn(
      `usearch sidecar ${path} failed validation (${reason}); moved to ${quarantinePath} — rebuilding from index.db`,
    );
  } catch (err) {
    // Move failed (file vanished, permissions). We've logged loudly; the
    // in-process open may still abort, but there's nothing more to do here.
    log.error(
      `usearch sidecar ${path} failed validation (${reason}) and could not be quarantined: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return "quarantined";
}

/** Filesystem-safe UTC timestamp: `YYYYMMDDTHHMMSS`. */
function fsSafeTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
}
