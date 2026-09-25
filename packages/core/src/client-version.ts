// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How a gateway judges the build a paired device is running.
 *
 * Every Omnesis client reports its product version in the device-socket
 * hello (and, for clients that never open a socket, at pair time). The
 * gateway records that reading and classifies it here — once, in one
 * function — so the portal, the CLI and the doctor cannot disagree about
 * whether a device is fine, lagging, or past the line.
 *
 * Two facts decide the verdict, and they are not the same thing:
 *
 *   - The **product version** is a lockstep semver shared by every package
 *     and every app build. It says how old a client is. Comparing it to the
 *     gateway's own version yields "behind"; comparing it to a declared
 *     per-kind floor yields "unsupported".
 *   - The **wire protocol number** is the accept-or-reject gate. A hello
 *     whose protocol does not match the gateway's is refused outright, so a
 *     device whose last handshake was on an older protocol can no longer
 *     connect at all — regardless of what its version string says.
 *
 * A missing version is never an error. Clients built before the ledger
 * existed report nothing and must keep connecting; they read as `unknown`,
 * which is a neutral absence of information rather than a fault.
 */

import type { DeviceKind } from "@omnesis/types";

/**
 * The gateway's verdict on one device's build.
 *
 * - `current` — at or ahead of the gateway's own version.
 * - `behind` — older than the gateway but at or above the floor for its
 *   kind. Informational: mobile and harness builds legitimately lag,
 *   because a store release trails the tag it was cut from.
 * - `unsupported` — below the declared floor for its kind, or last seen on
 *   a wire protocol this gateway no longer speaks. The only state that
 *   warrants a warning.
 * - `unknown` — the device has never reported a version.
 */
export type ClientVersionState = "current" | "behind" | "unsupported" | "unknown";

/**
 * The oldest client build of each kind this gateway supports.
 *
 * This is a **policy declaration, not a mirror of the product version**, and
 * it must stay strictly below the current release or every device that has
 * not yet updated would read as unsupported. Lagging is what `behind` is
 * for; this floor marks the line past which a client genuinely cannot be
 * expected to work.
 *
 * It is keyed by kind because the kinds do not travel together. A collector
 * or CLI updates on a host the operator controls, while an iOS, Android or
 * browser build reaches its device through a store queue and so trails the
 * tag it was cut from by however long review takes. The values happen to
 * agree today — every published release supports the one before it — but
 * the shape is what lets a phone keep a lower floor than a server the day
 * they diverge.
 *
 * Raising an entry is the supported way to retire a client build. It makes
 * every device of that kind below the new floor read as `unsupported`, which
 * surfaces as a portal warning and a doctor failure — but it still does not
 * refuse the connection. Only the wire protocol number does that.
 */
export const MINIMUM_CLIENT_VERSIONS: Readonly<Record<DeviceKind, string>> = {
  collector: "0.3.0",
  cli: "0.3.0",
  portal: "0.3.0",
  ios: "0.3.0",
  android: "0.3.0",
  browser: "0.3.0",
  agent: "0.3.0",
  // Third-party code that reports its own version, if any; one it never
  // reports reads as `unknown`, never as unsupported.
  integration: "0.3.0",
};

/** A product version parsed into its comparable numeric triple. */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a lockstep product version (`MAJOR.MINOR.PATCH`), returning null for
 * anything that is not one.
 *
 * A pre-release or build suffix (`0.5.0-rc.1`, `0.5.0+sha`) is accepted and
 * its suffix ignored, so a release candidate compares equal to the release it
 * precedes. That is deliberate: the ledger answers "how old is this build",
 * and treating an rc as a distinct, older version would report a device that
 * is testing the upcoming release as behind.
 */
export function parseProductVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Order two product versions: negative when `a` is older than `b`, zero when
 * they are the same release, positive when `a` is newer. Returns null when
 * either side is not a parseable version, so callers must decide what an
 * uncomparable reading means rather than silently getting `0`.
 */
export function compareProductVersions(a: string, b: string): number | null {
  const left = parseProductVersion(a);
  const right = parseProductVersion(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export interface ClientVersionInput {
  /** The gateway's own lockstep product version. */
  gatewayVersion: string;
  /** The floor for the device's kind — normally `MINIMUM_CLIENT_VERSIONS[kind]`. */
  minimumVersion: string;
  /** What the device reported, or null/undefined if it never has. */
  reportedVersion: string | null | undefined;
  /** The wire protocol number this gateway speaks. */
  gatewayProtocolVersion: number;
  /**
   * The protocol number of the device's last completed handshake, or
   * null/undefined for a device that has never opened a socket (the browser
   * extension pairs and pushes over HTTP only).
   */
  reportedProtocolVersion?: number | null;
}

/**
 * Classify one device's build. Pure; the single source of truth every
 * surface reads.
 *
 * The protocol is checked first because it outranks the version: a device
 * stranded on an older protocol cannot complete a handshake at all, so
 * calling it merely "behind" on the strength of a version string it can no
 * longer deliver would be wrong. A device reporting a protocol *newer* than
 * the gateway's is not flagged here — that direction is the gateway's own
 * upgrade to make, and it shows up as the gateway refusing the hello.
 */
export function computeClientVersionState(input: ClientVersionInput): ClientVersionState {
  const { reportedProtocolVersion, gatewayProtocolVersion } = input;
  if (
    typeof reportedProtocolVersion === "number" &&
    reportedProtocolVersion < gatewayProtocolVersion
  ) {
    return "unsupported";
  }

  const belowFloor = compareProductVersions(input.reportedVersion ?? "", input.minimumVersion);
  if (belowFloor === null) return "unknown";
  if (belowFloor < 0) return "unsupported";

  const behindGateway = compareProductVersions(input.reportedVersion ?? "", input.gatewayVersion);
  // An unparseable gateway version leaves "behind" unanswerable while the
  // floor comparison above already succeeded; report the device as current
  // rather than inventing a fault out of the gateway's own bad metadata.
  if (behindGateway !== null && behindGateway < 0) return "behind";
  return "current";
}

/** Per-state device counts, in the order a summary line reads best. */
export interface FleetVersionSummary {
  current: number;
  behind: number;
  unsupported: number;
  unknown: number;
  /** Every device counted, including revoked ones the caller chose to keep. */
  total: number;
}

/**
 * Fold a fleet's states into counts. Callers filter first — a revoked device
 * is not part of the fleet a version report is about, so it is excluded by
 * whoever assembles the list rather than by a flag here.
 */
export function summarizeFleetVersions(states: readonly ClientVersionState[]): FleetVersionSummary {
  const summary: FleetVersionSummary = {
    current: 0,
    behind: 0,
    unsupported: 0,
    unknown: 0,
    total: states.length,
  };
  for (const state of states) summary[state] += 1;
  return summary;
}

/**
 * The fleet in one line, e.g. `4 current, 1 behind, 1 unknown`. States with
 * no devices are omitted; an empty fleet reads as `no devices`.
 */
export function formatFleetVersionSummary(summary: FleetVersionSummary): string {
  if (summary.total === 0) return "no devices";
  const parts: string[] = [];
  if (summary.current > 0) parts.push(`${summary.current} current`);
  if (summary.behind > 0) parts.push(`${summary.behind} behind`);
  if (summary.unsupported > 0) parts.push(`${summary.unsupported} unsupported`);
  if (summary.unknown > 0) parts.push(`${summary.unknown} unknown`);
  return parts.join(", ");
}
