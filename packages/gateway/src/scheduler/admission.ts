// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Automatic admission control: while a real interactive user is present,
 * defer NEW background work so the machine goes to the human.
 *
 * A user-priority HTTP request calls {@link AdmissionController.begin} on
 * entry and releases its hold on exit. The first hold engages a *soft*
 * scheduler pause (distinct from the benchmark hard-pause); the last hold
 * releases it. The soft pause gates only non-starved background dispatch —
 * the scheduler's anti-starvation floor keeps firing, so background is
 * deferred, never permanently starved.
 *
 * Two safety properties matter:
 *  - A single long-lived request (an SSE/WS stream, a minutes-long agent
 *    turn) cannot pin the pause: each hold auto-releases after `maxHoldMs`
 *    even if the request is still running. Fresh short requests re-engage
 *    for their own duration, so a continuously-busy user still holds it.
 *  - A pump watchdog gives runners a dispatch opportunity each interval
 *    while engaged, so the starvation floor can drain an aged background
 *    task even when no natural dispatch trigger (enqueue/completion) occurs
 *    under an idle-but-held pause.
 */

export interface AdmissionHold {
  /** Release exactly once (call from `finally`). Idempotent and safe even
   *  after the max-hold timer has already released this hold. */
  release(): void;
}

export interface AdmissionControllerOptions {
  enabled: boolean;
  /** Per-request cap: a single long-lived request releases its hold after
   *  this many ms even if still running, so it can't pin the pause. */
  maxHoldMs: number;
  /** Watchdog cadence while engaged. Keep strictly below the scheduler's
   *  STARVATION_MIN_INTERVAL_MS so a pump tick never phase-aliases with the
   *  once-per-interval starvation release and halves the floor. */
  pumpIntervalMs: number;
}

/** The scheduler capabilities the controller drives. */
export interface AdmissionSink {
  setAdmissionPaused(paused: boolean): void;
  pumpBackground(): void;
}

/**
 * Single source of truth for the admission defaults. Referenced by the config
 * resolver (`runtime-settings.ts`) and the `Scheduler` constructor fallbacks so
 * the two can't silently drift. `pumpIntervalMs` MUST stay strictly below the
 * scheduler's `STARVATION_MIN_INTERVAL_MS` (1000) — see the pump-cadence note
 * on {@link AdmissionControllerOptions.pumpIntervalMs}.
 */
export const DEFAULT_ADMISSION: AdmissionControllerOptions = {
  enabled: true,
  maxHoldMs: 1_500,
  pumpIntervalMs: 900,
};

const NOOP_HOLD: AdmissionHold = { release() {} };

export class AdmissionController {
  private holds = 0;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: AdmissionSink,
    private readonly opts: AdmissionControllerOptions,
  ) {}

  /** Call at the start of a user-priority request. Refcounted; returns a
   *  handle whose `release()` decrements the count. Disabled → a no-op hold. */
  begin(): AdmissionHold {
    if (!this.opts.enabled) return NOOP_HOLD;
    this.acquire();
    let released = false;
    const finish = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.releaseOne();
    };
    // Backstop: a client-aborted connection can leave the request's own
    // `finally` unreached forever; the timer guarantees the hold is dropped.
    const timer = setTimeout(finish, this.opts.maxHoldMs);
    if (typeof timer.unref === "function") timer.unref();
    return { release: finish };
  }

  private acquire(): void {
    this.holds += 1;
    if (this.holds === 1) {
      this.sink.setAdmissionPaused(true);
      this.startPump();
    }
  }

  private releaseOne(): void {
    if (this.holds === 0) return; // defensive floor
    this.holds -= 1;
    if (this.holds === 0) {
      this.stopPump();
      this.sink.setAdmissionPaused(false); // drains piled-up background
    }
  }

  private startPump(): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setInterval(() => this.sink.pumpBackground(), this.opts.pumpIntervalMs);
    if (typeof this.pumpTimer.unref === "function") this.pumpTimer.unref();
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  /** Called from Scheduler.dispose() before the core disposes. */
  dispose(): void {
    this.stopPump();
    this.holds = 0;
  }

  /** Introspection for tests/metrics. */
  activeHolds(): number {
    return this.holds;
  }
}
