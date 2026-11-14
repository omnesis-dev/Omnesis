// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@omnesis/core";
import { windowsIsProcessRunning } from "./windows-process-probe.js";
import type { SourceFreshness } from "@omnesis/source-sdk";

const execFileAsync = promisify(execFile);
const log = createLogger("collector:freshness");

/**
 * How long a probe result is reused before the process table is consulted
 * again. Results are cached per process NAME, not per source, so several
 * sources fed by the same program share one process-table query. An app does
 * not come and go on a second-by-second basis, so a window this size costs
 * nothing in accuracy.
 */
export const PROBE_CACHE_TTL_MS = 30_000;

/**
 * Timeout for a single local process-table query. A hung probe must never
 * wedge the status pipeline; reaching this bound leaves the reading unknown.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Probes whether the process a source declared as its data feed is currently
 * running on this host.
 *
 * Deliberately knows nothing about any particular source or program — it is
 * handed a process name from a source's `SourceFreshness` declaration and
 * reports a boolean, so all app-specific knowledge stays in the provider
 * package that owns it.
 *
 * The three-valued return is the crux. `undefined` means *could not determine*
 * — no process was declared or the probe failed — and is emphatically not the
 * same as `false`. The gateway only ever
 * warns on a definite `false`, so an environment we can't inspect stays silent
 * rather than accusing a healthy source of being stale.
 */
export class FreshnessProbe {
  private readonly cache = new Map<string, { running: boolean; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly isProcessRunning: (name: string) => Promise<boolean> = defaultIsProcessRunning,
  ) {}

  /**
   * `true` / `false` when the declared process's state is known, `undefined`
   * when it can't be determined (see the class doc — never conflate the two).
   *
   * `fresh` skips the cache for this one reading. A caller that has just
   * changed the answer — opened the program — needs the process table, not
   * the reading it took before doing so.
   */
  async probe(
    freshness: SourceFreshness | undefined,
    opts: { fresh?: boolean } = {},
  ): Promise<boolean | undefined> {
    const processName = freshness?.requiresProcess?.processName;
    if (!processName) return undefined;

    const cached = opts.fresh ? undefined : this.cache.get(processName);
    if (cached && this.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.running;

    try {
      const running = await this.isProcessRunning(processName);
      this.cache.set(processName, { running, at: this.now() });
      return running;
    } catch (err) {
      // An unusable probe must not be reported as "not running" — that would
      // manufacture a staleness warning out of our own failure. Report
      // "unknown" and let the gateway stay quiet.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Could not probe for process ${processName}: ${msg}`);
      return undefined;
    }
  }
}

/**
 * Query exact executable names without a shell. Windows uses the native image
 * name (case-insensitive, optional .exe suffix); POSIX uses pgrep -x. A failed
 * query throws so the caller reports unknown rather than inventing absence.
 */
export async function defaultIsProcessRunning(name: string): Promise<boolean> {
  if (process.platform === "win32") return windowsIsProcessRunning(name, PROBE_TIMEOUT_MS);
  try {
    await execFileAsync("pgrep", ["-x", name], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 1) return false;
    throw err;
  }
}
