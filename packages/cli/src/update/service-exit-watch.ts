// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ServiceLiveness } from "../service/types.js";

/**
 * How many times the service manager may relaunch the gateway during one
 * health wait before the wait calls it a crash loop. A gateway that boots,
 * however slowly, keeps its first process; one relaunch can still be a
 * transient exit, two cannot.
 */
export const CRASH_LOOP_RESTARTS = 2;

/**
 * How long the manager must hold no process, in consecutive readings, before
 * the wait calls the gateway exited. It outlasts the managers' own relaunch
 * delays (systemd `RestartSec=2`, launchd `ThrottleInterval` 10s), so a
 * process between two launches is judged by the restart count instead.
 */
export const DOWN_CONFIRM_MS = 15_000;

/** Readings of a down unit needed besides the time span. */
const DOWN_CONFIRM_READINGS = 3;

/**
 * Decides, from successive liveness readings taken while an update waits for
 * the restarted gateway to answer `/health`, whether the gateway has exited
 * for good, so the update can roll back now instead of waiting out its whole
 * health timeout.
 *
 * Two verdicts end the wait early: the manager relaunched the gateway
 * {@link CRASH_LOOP_RESTARTS} times since the first reading (a crash loop),
 * or it has held no process for {@link DOWN_CONFIRM_MS} across at least three
 * readings (failed, stopped, or waiting to relaunch). A reading of a unit that
 * is not installed, or that the manager could not describe, decides nothing
 * and breaks a down streak. A gateway whose process stays up keeps the full
 * wait however long its boot takes.
 */
export class ServiceExitWatch {
  private baselineStarts: number | null | undefined;
  private downSince: number | null = null;
  private downReadings = 0;

  /** Feed one reading taken at `nowMs`; returns why the gateway exited, or null. */
  observe(reading: ServiceLiveness, nowMs: number): string | null {
    if (!reading.installed) {
      this.downSince = null;
      this.downReadings = 0;
      return null;
    }
    if (this.baselineStarts === undefined) this.baselineStarts = reading.starts;
    if (
      this.baselineStarts !== null &&
      reading.starts !== null &&
      reading.starts - this.baselineStarts >= CRASH_LOOP_RESTARTS
    ) {
      return (
        `the service manager relaunched it ${reading.starts - this.baselineStarts} times ` +
        `while waiting (${reading.detail})`
      );
    }
    if (!reading.down) {
      this.downSince = null;
      this.downReadings = 0;
      return null;
    }
    this.downSince ??= nowMs;
    this.downReadings += 1;
    if (this.downReadings >= DOWN_CONFIRM_READINGS && nowMs - this.downSince >= DOWN_CONFIRM_MS) {
      return (
        `its service has not been running for ${Math.round((nowMs - this.downSince) / 1000)}s ` +
        `(${reading.detail})`
      );
    }
    return null;
  }
}
