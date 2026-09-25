// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Experimental-feature gating.
 *
 * Some capabilities — new sources, half-baked subsystems, anything not yet
 * battle-tested — should ship in the tree but stay invisible until the user
 * deliberately opts in. The single knob is the `OMNESIS_EXPERIMENTAL`
 * environment variable, and it is a simple on/off switch:
 *
 *   - unset / "0" / "false" / "off" / "no" → experimental mode is OFF (default)
 *   - "1" / "true" / "on" / "yes" / "all"  → experimental mode is ON
 *
 * There is no per-feature granularity: experimental mode is either fully on or
 * fully off. When on, every experimental surface (sources marked experimental,
 * Watches, Briefs, …) becomes visible and usable; when off, none of them are
 * discoverable on any client.
 *
 * This helper is available to any process (collector, gateway, CLI). The
 * collector reads it to gate experimental sources; the gateway reads it to
 * advertise an `experimental` capability to clients (portal / iOS / Android)
 * and to gate experimental routes. Any other subsystem can gate a code path on
 * it the same way with `experimentalEnabled()`.
 *
 * The env var is read fresh on every call (never cached) so a process can
 * toggle it — chiefly tests, which set/unset `process.env.OMNESIS_EXPERIMENTAL`
 * between cases.
 */

export const EXPERIMENTAL_ENV_VAR = "OMNESIS_EXPERIMENTAL";

// Any of these (case-insensitive) flips experimental mode on. Anything else —
// including unset, "0", "false", or unrecognized junk — leaves it off, so an
// operator never enables experimental features by accident.
const ON_SENTINELS = new Set(["1", "true", "all", "*", "yes", "on"]);

/**
 * Whether experimental mode is on, per `OMNESIS_EXPERIMENTAL`. Off by default.
 */
export function experimentalEnabled(): boolean {
  const raw = process.env[EXPERIMENTAL_ENV_VAR]?.trim().toLowerCase();
  if (!raw) return false;
  return ON_SENTINELS.has(raw);
}

/**
 * Whether the process is running against a synthetic corpus (`OMNESIS_SYNTHETIC=1`)
 * — i.e. the demo gateway or a test harness, not a real user's data. Used to relax
 * heuristics that exist only to suppress noise on real data so demos can showcase a
 * feature on curated fixtures (e.g. the merge-candidate head-interaction gate).
 */
export function syntheticEnabled(): boolean {
  return process.env.OMNESIS_SYNTHETIC === "1";
}

/**
 * Whether experimental surfaces should be *visible* in the current process.
 *
 * This is `experimentalEnabled()` with one extra escape hatch: synthetic mode
 * (`OMNESIS_SYNTHETIC=1`) exposes experimental features unconditionally so
 * tests and demos exercise them without setting `OMNESIS_EXPERIMENTAL`. It is
 * the check the gateway advertises to clients and uses to gate experimental
 * routes, and the basis for hiding experimental sources from the picker.
 */
export function experimentalVisible(): boolean {
  return experimentalEnabled() || syntheticEnabled();
}

export const DEV_MODE_ENV_VAR = "OMNESIS_DEV_MODE";

/**
 * Whether developer mode is on, per `OMNESIS_DEV_MODE`. Off by default.
 *
 * Developer mode is a separate switch from experimental mode. It gates the
 * "developer annotations" channel — a hidden affordance in the portal and the
 * mobile apps for the operator to attach data-quality notes to entities (documents,
 * loops, briefs, temporal annotations, agent runs, …) for later review by the
 * engineer, not by the Omnesis agent. Kept distinct from experimental so it
 * stays invisible even when experimental features are on. The gateway reads it
 * to advertise a `developer` capability on `GET /status` and to gate the
 * `/dev/annotations` routes; clients read the advertised flag to reveal the
 * capture affordance.
 *
 * Parsed leniently and read fresh on every call, exactly like
 * `experimentalEnabled()`.
 */
export function devModeEnabled(): boolean {
  const raw = process.env[DEV_MODE_ENV_VAR]?.trim().toLowerCase();
  if (!raw) return false;
  return ON_SENTINELS.has(raw);
}
