// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The briefs virtual clock — the "injected decision time" half of the
 * backtest infrastructure (mirror-gateway bridge + injected clock).
 *
 * The briefs subsystem is clock-disciplined end-to-end: every decision
 * (recency gate, decay back-off, run-queue folding, feed ranking) is a
 * pure function of an injected `now`, threaded through the `rq.clock`
 * seam in `feature-gate.ts`. Production never sets that seam, so it
 * falls back to the wall clock. A replay must not: when a bridge feeds
 * historical documents, the engine has to believe "now" is the replay
 * cursor — otherwise the recency gate rejects every datum as stale and
 * nothing wakes.
 *
 * `createMutableClock` is that replay clock: a callable `Clock` with a
 * `set()` the bridge drives forward through virtual time (via the
 * `/admin/brain/clock` route). It is wired ONLY when the gateway was
 * started with `OMNESIS_BRIEFS_VIRTUAL_CLOCK=1` — a deliberately loud,
 * boot-time opt-in so a live gateway can never have its clock moved.
 * Setting the clock BACKWARD is allowed (a replay being restarted), but
 * the intended use is monotonic forward movement.
 */

import type { Clock } from "./storage/types.js";

/** A `Clock` whose "now" is program-settable (the replay time cursor). */
export type MutableClock = Clock & {
  /** Move virtual now to an absolute unix-ms instant. */
  set(nowMs: number): void;
  /** Marks the clock as virtual for capability checks and status routes. */
  readonly virtual: true;
};

/** Create a settable clock, starting at `initialMs` (default: wall now). */
export function createMutableClock(initialMs?: number): MutableClock {
  let now = initialMs ?? Date.now();
  const clock = (() => now) as MutableClock;
  Object.defineProperties(clock, {
    set: {
      value: (nowMs: number) => {
        if (!Number.isFinite(nowMs)) throw new Error(`virtual clock: not a finite ms: ${nowMs}`);
        now = nowMs;
      },
    },
    virtual: { value: true },
  });
  return clock;
}

/** Narrow a wired `Clock` back to its settable form, when it is one. */
export function asMutableClock(clock: Clock | undefined): MutableClock | null {
  if (clock && (clock as MutableClock).virtual === true) return clock as MutableClock;
  return null;
}

/**
 * The boot-time opt-in: a `MutableClock` when the environment asks for
 * one, `null` otherwise (the seam then stays unset and every consumer
 * falls back to the wall clock — the production path, byte-identical to
 * before this module existed).
 */
export function resolveBriefsVirtualClock(env: NodeJS.ProcessEnv): MutableClock | null {
  return env.OMNESIS_BRIEFS_VIRTUAL_CLOCK === "1" ? createMutableClock() : null;
}
