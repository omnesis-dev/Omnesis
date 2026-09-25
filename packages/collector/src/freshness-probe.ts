// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@omnesis/core";
import type { SourceFreshness } from "@omnesis/source-sdk";

const execFileAsync = promisify(execFile);
const log = createLogger("collector:freshness");

/**
 * How long a probe result is reused before the process table is consulted
 * again. Results are cached per process NAME, not per source, so several
 * sources fed by the same program share one `pgrep`. An app does not come and
 * go on a second-by-second basis, so a window this size costs nothing in
 * accuracy.
 */
export const PROBE_CACHE_TTL_MS = 30_000;

/**
 * Timeout for a single probe. `pgrep` against a local process table returns in
 * single-digit milliseconds; anything approaching this bound means the host is
 * in trouble, and a hung probe must never wedge the status pipeline.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether this platform can be asked which processes are running. Evaluated
 * once: on an unsupported platform every probe would otherwise fail identically
 * and log identically, once per source per sync, forever.
 */
const PROCESS_PROBING_SUPPORTED = process.platform !== "win32";

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
 * — no process was declared, the platform has no `pgrep`, or the probe itself
 * failed — and is emphatically not the same as `false`. The gateway only ever
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
    if (!PROCESS_PROBING_SUPPORTED) return undefined;

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
 * `pgrep -x` matches the executable name exactly, so a declared process name
 * cannot be satisfied by an unrelated process that merely contains the string.
 * Argument vector (never a shell string) so a process name can't be read as
 * shell syntax. Callers gate on `PROCESS_PROBING_SUPPORTED`; there is no
 * `pgrep` on Windows, and a source declaring a process dependency there needs a
 * `tasklist` branch rather than a wrong answer.
 *
 * Exit code 1 is `pgrep`'s documented "no process matched" — a definite answer,
 * not an error. Any other non-zero exit throws and surfaces as "unknown".
 */
export async function defaultIsProcessRunning(name: string): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", name], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 1) return false;
    throw err;
  }
}
