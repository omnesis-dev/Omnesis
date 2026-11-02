// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Resolve `gateway.stalls` to milliseconds, applying the defaults. */

import { parseDuration } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

import type { FlightRecorderPolicy } from "./stall-protocol.js";

export interface StallSettings {
  enabled: boolean;
  thresholdMs: number;
  warnMs: number;
  /** Null when the flight recorder is off. */
  profile: FlightRecorderPolicy | null;
}

/** Mirrored in `CONFIG_DEFAULTS.gateway.stalls`; the cross-check test pins the two together. */
export const DEFAULT_STALL_SETTINGS = {
  enabled: true,
  threshold: "250ms",
  warn: "1s",
  profile: {
    enabled: true,
    minStall: "1s",
    stallCount: 3,
    window: "2m",
    duration: "60s",
    cooldown: "15m",
    keep: 5,
  },
} as const;

/**
 * The watchdog samples a stall only once the heartbeat is two intervals
 * (100 ms) overdue, so a shorter threshold would record stalls it can never
 * attribute.
 */
const MIN_THRESHOLD_MS = 100;
/** Longest capture: a profile held in memory until it stops. */
const MAX_PROFILE_DURATION_MS = 10 * 60_000;

export function resolveStallSettings(config: OmnesisConfig | undefined): StallSettings {
  const s = config?.gateway?.stalls;
  const d = DEFAULT_STALL_SETTINGS;
  const p = s?.profile;
  const profileEnabled = p?.enabled ?? d.profile.enabled;
  return {
    enabled: s?.enabled ?? d.enabled,
    thresholdMs: Math.max(MIN_THRESHOLD_MS, parseDuration(s?.threshold ?? d.threshold)),
    warnMs: parseDuration(s?.warn ?? d.warn),
    profile: profileEnabled
      ? {
          minStallMs: parseDuration(p?.minStall ?? d.profile.minStall),
          stallCount: p?.stallCount ?? d.profile.stallCount,
          windowMs: parseDuration(p?.window ?? d.profile.window),
          durationMs: Math.min(
            MAX_PROFILE_DURATION_MS,
            parseDuration(p?.duration ?? d.profile.duration),
          ),
          cooldownMs: parseDuration(p?.cooldown ?? d.profile.cooldown),
          keep: p?.keep ?? d.profile.keep,
        }
      : null,
  };
}
