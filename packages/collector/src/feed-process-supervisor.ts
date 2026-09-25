// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@omnesis/core";
import { FreshnessProbe } from "./freshness-probe.js";
import type { FeedProcessLaunch, SourceFreshness } from "@omnesis/source-sdk";

const execFileAsync = promisify(execFile);
const log = createLogger("collector:feed-process");

/**
 * How long each launch must wait after the one before it while the program
 * keeps failing to stay up, by how many such launches there have been. The
 * first launch after a settled run is immediate — that is the whole point —
 * and every later one waits longer, holding at the last rung, so a program
 * that is broken or that keeps getting quit is reopened once a day rather
 * than once a sync.
 */
export const LAUNCH_BACKOFF_LADDER_MS = [
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/**
 * A launch counts as having worked only once the program is still seen running
 * this long afterwards. The immediate re-probe after `open` proves nothing — a
 * program that crashes ten seconds into its launch would otherwise reset the
 * ladder every time and be relaunched every sync.
 */
export const LAUNCH_SETTLE_MS = 30 * 60 * 1000;

/**
 * The ladder alone cannot bound a program that stays up just long enough to
 * settle and then dies — every launch of it is a first launch. This is the
 * outer bound the ladder sits inside: at most `LAUNCHES_PER_WINDOW` launches
 * of one program in any rolling `LAUNCH_WINDOW_MS`, settled or not.
 */
export const LAUNCH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LAUNCHES_PER_WINDOW = 6;

/**
 * Consecutive unsettled launches after which the source is told to show its
 * `failedHint`: the collector has evidently tried more than once and the
 * program is not staying up, so the operator has to look at the app itself.
 * Hitting the window cap says the same thing and shows the same hint.
 */
export const LAUNCH_FAILING_AFTER = 3;

/** Bound on one `open` call; Launch Services answers in well under a second. */
const LAUNCH_TIMEOUT_MS = 15_000;

/** What the supervisor found, and did, about a source's feed program. */
export interface FeedProcessReading {
  /** As `FreshnessProbe.probe` reports it, re-read after a launch. */
  running: boolean | undefined;
  /**
   * The collector has tried repeatedly to open the program and it is not
   * running: `LAUNCH_FAILING_AFTER` unsettled launches in a row, or the
   * window cap reached. Only ever true beside `running === false`.
   */
  launchFailing: boolean;
}

/**
 * What the supervisor remembers about one program. All times are wall-clock
 * from the injected `now`, so a host asleep with the program open counts the
 * sleep as uptime; that errs toward relaunching less, never more.
 */
interface Program {
  /** Launches since the program was last seen settled. */
  unsettled: number;
  /** When the most recent launch happened. */
  lastLaunchAt: number;
  /** Every launch still inside the rolling window, oldest first. */
  launches: number[];
}

/**
 * Keeps a source's feed program running, within reason.
 *
 * Wraps `FreshnessProbe`: it takes the same reading the probe does, and when
 * that reading is a definite "not running" for a source whose declaration says
 * how to open the program, it opens it. Everything else about the probe's
 * contract holds — an unknown reading is never acted on, and the supervisor
 * learns nothing about which source or program it is serving beyond the
 * declaration it is handed.
 *
 * State is kept per program, not per source, exactly as the probe caches per
 * program: two sources fed by one app must not race to open it twice. It lives
 * in memory only — a collector restart starts the ladder over, which costs one
 * extra launch and nothing else.
 *
 * Only macOS collectors launch anything. Elsewhere the declaration is read and
 * ignored, so a source can carry it unconditionally.
 */
export class FeedProcessSupervisor {
  private readonly programs = new Map<string, Program>();

  constructor(
    private readonly probe: FreshnessProbe = new FreshnessProbe(),
    private readonly now: () => number = Date.now,
    private readonly launch: (declaration: FeedProcessLaunch) => Promise<void> = launchMacApp,
    private readonly canLaunch: boolean = process.platform === "darwin",
  ) {}

  async observe(freshness: SourceFreshness | undefined): Promise<FeedProcessReading> {
    const required = freshness?.requiresProcess;
    const running = await this.probe.probe(freshness);
    if (!required) return { running, launchFailing: false };

    const program = this.programs.get(required.processName);
    if (running === true) {
      // Seen up long enough after the last launch to count as staying up.
      if (program && this.now() - program.lastLaunchAt >= LAUNCH_SETTLE_MS) program.unsettled = 0;
      return { running, launchFailing: false };
    }
    // Unknown is not "down": nothing is opened on a guess.
    if (running === undefined) return { running, launchFailing: false };
    if (!required.launch || !this.canLaunch) return { running, launchFailing: false };

    // Everything from here to the launch itself is synchronous. Sources
    // sharing a program can be synced concurrently, and the second to arrive
    // must find the record the first wrote before it ever gets to `open`.
    const now = this.now();
    const record = program ?? { unsettled: 0, lastLaunchAt: -Infinity, launches: [] };
    record.launches = record.launches.filter((at) => now - at < LAUNCH_WINDOW_MS);
    const capped = record.launches.length >= LAUNCHES_PER_WINDOW;
    const failing = capped || record.unsettled >= LAUNCH_FAILING_AFTER;
    const wait =
      record.unsettled === 0
        ? 0
        : LAUNCH_BACKOFF_LADDER_MS[Math.min(record.unsettled, LAUNCH_BACKOFF_LADDER_MS.length) - 1];
    if (capped || now < record.lastLaunchAt + wait) {
      this.programs.set(required.processName, record);
      return { running, launchFailing: failing };
    }

    record.unsettled += 1;
    record.lastLaunchAt = now;
    record.launches.push(now);
    this.programs.set(required.processName, record);
    try {
      await this.launch(required.launch);
      log.info(
        `Opened ${required.processName} (unsettled launch ${record.unsettled}, ${record.launches.length} in the last day)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `Could not open ${required.processName} (unsettled launch ${record.unsettled}): ${msg}`,
      );
    }

    const after = await this.probe.probe(freshness, { fresh: true });
    if (after === false) log.warn(`${required.processName} is not running after opening it`);
    const nowFailing =
      record.unsettled >= LAUNCH_FAILING_AFTER || record.launches.length >= LAUNCHES_PER_WINDOW;
    return { running: after, launchFailing: after === false && nowFailing };
  }
}

/**
 * Opens an app by bundle identifier through Launch Services, hidden (`-j`) and
 * without bringing it to the foreground (`-g`), so a launch from the collector
 * never interrupts whoever is using the machine. `open` returns once the app
 * has launched, so a probe taken right after it sees the process. An app that
 * is not installed makes `open` exit non-zero, which surfaces here as a throw.
 */
async function launchMacApp(declaration: FeedProcessLaunch): Promise<void> {
  await execFileAsync("open", ["-g", "-j", "-b", declaration.macosBundleId], {
    timeout: LAUNCH_TIMEOUT_MS,
  });
}
