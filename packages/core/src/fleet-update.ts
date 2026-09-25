// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which devices a gateway may tell to update themselves, and which it must
 * leave to the operator.
 *
 * A fleet update carries no code: the gateway sends a version, and the
 * device runs its own local `omnesis update` against its own remote. That
 * only works where Omnesis was installed on a host the operator controls —
 * so the decision is made once, here, and every surface (the admin route,
 * the portal button, `omnesis update --fleet`) reads the same verdict rather
 * than each deciding for itself which rows get a button.
 *
 * Two refusals are safety rules rather than capability facts, and they are
 * the reason this is a function and not a lookup table:
 *
 *   - A device that has never reported a version is never commanded. The
 *     gateway would be telling a build it knows nothing about to replace
 *     itself, and a client old enough to omit its version is old enough to
 *     predate the command as well.
 *   - A device below the floor for its kind is never commanded either. It is
 *     past the line where this gateway still expects it to work, so the one
 *     thing it must not be asked to do is run an unattended self-replacement.
 *
 * Both say the same thing to the operator: update that one by hand.
 */

import { assertNever } from "./utils.js";
import { compareProductVersions, type ClientVersionState } from "./client-version.js";
import type { DeviceKind, DeviceUpdateState } from "@omnesis/types";

/** Why a device is not commanded, as a code a UI can branch on. */
export type FleetUpdateRefusalCode =
  /** The pairing is revoked; nothing runs on it. */
  | "revoked"
  /** An app build that reaches the device through a store. */
  | "store-managed"
  /** No daemon here for the gateway to command; the host owns the update. */
  | "host-managed"
  /** A commit target requires a daemon that can attest its source checkout. */
  | "not-source"
  /** The device has never said what it is running. */
  | "version-unknown"
  /** The device is below the oldest build this gateway supports. */
  | "version-unsupported"
  /** The build the device runs answered that it does not implement the command. */
  | "command-unsupported";

/** What a gateway will do about one device in a fleet update. */
export type FleetUpdateDisposition =
  /** Commandable, and not there yet. */
  | { readonly kind: "update" }
  /** Commandable, and already at the target (or ahead of it). */
  | { readonly kind: "current" }
  /** Not commandable; `reason` is the sentence an operator reads. */
  | { readonly kind: "refused"; readonly code: FleetUpdateRefusalCode; readonly reason: string };

/** The device facts the disposition is computed from. */
export interface FleetUpdateCandidate {
  readonly deviceKind: DeviceKind;
  /** The gateway's verdict on this device's build (`deviceVersionState`). */
  readonly versionState: ClientVersionState;
  /** What the device last reported, or null if it never has. */
  readonly reportedVersion: string | null;
  /** Exact completed source commit reported by this running daemon, if any. */
  readonly sourceCommit?: string | null;
  readonly revoked: boolean;
  /** Where the device's last update request stands, or null if none was made. */
  readonly updateState?: DeviceUpdateState | null;
  /** For an agent device, the harness its plugin runs in. */
  readonly harness?: string | null;
}

/**
 * The commands an operator runs on a device's own machine to update it by
 * hand, in order.
 *
 * A harness plugin is packed from the Omnesis install on its host, so that
 * install moves first; the refresh then reinstalls the plugin from it, and the
 * harness only loads the new plugin once it restarts. A collector's own
 * update restarts the collector itself.
 */
export function localDeviceUpdateCommands(harness?: string | null): string[] {
  return harness
    ? ["omnesis update", `omnesis connect ${harness} --refresh`, `${harness} gateway restart`]
    : ["omnesis update"];
}

/**
 * Whether a device of this kind self-updates on a host, updates through an
 * app store, or is updated by whoever runs its host directly.
 *
 * `collector` and `agent` are the two kinds that run as a supervised daemon
 * beside a CLI on a machine the operator installed Omnesis on, which is
 * exactly what the update command needs.
 */
export function deviceUpdateChannel(kind: DeviceKind): "command" | "store" | "host" {
  switch (kind) {
    case "collector":
    case "agent":
      return "command";
    case "ios":
    case "android":
    case "browser":
      return "store";
    case "cli":
    case "portal":
    case "integration":
      return "host";
    default:
      return assertNever(kind);
  }
}

/**
 * Decide what a gateway on `targetVersion` does about one device. Pure; the
 * one place the two safety refusals are spelled out.
 */
export function planDeviceUpdate(
  candidate: FleetUpdateCandidate,
  targetVersion: string,
): FleetUpdateDisposition {
  if (candidate.revoked) {
    return {
      kind: "refused",
      code: "revoked",
      reason: "This device is revoked. Pair it again before updating it.",
    };
  }

  const channel = deviceUpdateChannel(candidate.deviceKind);
  if (channel === "store") {
    return {
      kind: "refused",
      code: "store-managed",
      reason: "Update the app on the device; its store delivers the new build.",
    };
  }
  if (channel === "host") {
    return {
      kind: "refused",
      code: "host-managed",
      reason:
        candidate.deviceKind === "portal"
          ? "The portal is served by the gateway and updates with it."
          : "Run `omnesis update` on that host — there is no daemon here to command.",
    };
  }

  if (candidate.versionState === "unknown") {
    return {
      kind: "refused",
      code: "version-unknown",
      reason:
        "This device has never reported its version, so the gateway will not command it. " +
        "Run `omnesis update` on that host.",
    };
  }
  if (candidate.versionState === "unsupported") {
    return {
      kind: "refused",
      code: "version-unsupported",
      reason:
        "This build is below the oldest one this gateway supports, so it is not commanded. " +
        "Run `omnesis update` on that host.",
    };
  }

  const behind = compareProductVersions(candidate.reportedVersion ?? "", targetVersion);
  // An unreadable reading reached `unknown` above, so this can only be null
  // when the gateway's own version is malformed. Say "current" rather than
  // command a fleet on the strength of metadata the gateway cannot parse.
  if (behind === null || behind >= 0) return { kind: "current" };
  // Recorded when this device answered a previous command, and cleared as
  // soon as it reports another version — so it always describes the build
  // the device runs now, and asking that build again would get the same no.
  if (candidate.updateState === "unsupported") {
    return {
      kind: "refused",
      code: "command-unsupported",
      reason:
        "This build cannot be updated remotely: it does not accept update commands. " +
        `On that machine run ${localDeviceUpdateCommands(candidate.harness)
          .map((command) => `\`${command}\``)
          .join(", then ")}.`,
    };
  }
  return { kind: "update" };
}

/** Decide whether a source-managed daemon should move to an exact commit. */
export function planDeviceCommitUpdate(
  candidate: FleetUpdateCandidate,
  targetCommit: string,
): FleetUpdateDisposition {
  if (candidate.revoked) {
    return {
      kind: "refused",
      code: "revoked",
      reason: "This device is revoked. Pair it again before updating it.",
    };
  }
  const channel = deviceUpdateChannel(candidate.deviceKind);
  if (channel === "store") {
    return {
      kind: "refused",
      code: "store-managed",
      reason: "Update the app on the device; its store delivers the new build.",
    };
  }
  if (channel === "host") {
    return {
      kind: "refused",
      code: "host-managed",
      reason:
        candidate.deviceKind === "portal"
          ? "The portal is served by the gateway and updates with it."
          : "Run `omnesis update` on that host — there is no daemon here to command.",
    };
  }
  if (candidate.versionState === "unknown") {
    return {
      kind: "refused",
      code: "version-unknown",
      reason:
        "This device has never reported its version, so the gateway will not command it. Run `omnesis update` on that host.",
    };
  }
  if (candidate.versionState === "unsupported") {
    return {
      kind: "refused",
      code: "version-unsupported",
      reason:
        "This build is below the oldest one this gateway supports, so it is not commanded. Run `omnesis update` on that host.",
    };
  }
  if (candidate.sourceCommit === targetCommit) return { kind: "current" };
  if (candidate.updateState === "unsupported") {
    return {
      kind: "refused",
      code: "command-unsupported",
      reason:
        "This build cannot be updated remotely: it does not accept update commands. Run `omnesis update` on that machine.",
    };
  }
  if (!candidate.sourceCommit) {
    return {
      kind: "refused",
      code: "not-source",
      reason:
        "This daemon is not running from a verified source checkout. Run `omnesis update --commit` on that host.",
    };
  }
  return { kind: "update" };
}

/**
 * One device's row in the plan an operator confirms before anything runs.
 *
 * Declared here rather than in the gateway that serves it or the CLI that
 * reads it, so the two cannot describe the same response differently.
 */
export interface FleetUpdateEntry {
  id: string;
  name: string;
  kind: string;
  /** What the device last reported, or null if it never has. */
  version: string | null;
  online: boolean;
  disposition: FleetUpdateDisposition;
  /** Internal release or exact-commit target key still owed, or null when nothing is. */
  desiredVersion: string | null;
  updateState: string | null;
  updateDetail: string | null;
}

/** Release plan from GET, or CLI-only exact-commit plan from POST `/admin/fleet/update/plan`. */
export interface FleetUpdatePlan {
  /** The running gateway's product version (and the release target when no commit is set). */
  targetVersion: string;
  /** Exact source target for a CLI-only commit update. */
  targetCommit?: string;
  devices: FleetUpdateEntry[];
}

/** What asking one device produced — one row of `POST /admin/fleet/update`. */
export interface FleetUpdateOutcome {
  id: string;
  name: string;
  /** `refused` means the gateway would not ask; the device was never contacted. */
  state: string;
  detail?: string;
}
